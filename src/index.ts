/**
 * DSH Windows 后台运行插件（宿主侧，Node.js）。
 *
 * 目标（需求 §一）：显示器关闭但系统保持唤醒时，DSH 任务继续执行；
 * 任务期间阻止系统自动睡眠；任务结束释放电源保持。
 * 明确不支持：睡眠/休眠后继续执行任务。
 *
 * 架构判断（需求 §三.1）：
 * - DSH Web 插件运行在浏览器端，无法调用 Win32 API；
 * - 因此采用“前后端配套”：本文件为 Node.js 宿主侧（电源保持 + 任务检测），
 *   client/ 为浏览器侧（设置开关 + 真实状态展示）；
 * - 无第三方电源依赖：使用 DSH 自带的 koffi（dsh-win32-process 同款 FFI）
 *   直调 kernel32.SetThreadExecutionState；
 * - 不装 Windows 服务、不写注册表、不改电源计划、不改网卡配置。
 *
 * 任务检测（需求 §八，复用现有事件，不扫描日志）：
 * - 当前任务：agent/status（idle ⇄ running，含流式请求与工具调用全程）；
 * - 后台任务：ctx.jobs.onJobsChanged/onJobDone + list() 快照差分；
 * - 定时任务：dsh-schedule 触发后走 agent turn（已被 agent/status 覆盖），
 *   本插件不再单独计数，避免重复；限制见 README/最终报告。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs';
import { createPowerHandle, type PowerHandle } from './power.js';
import { TaskRefCounter, deriveState, type BackgroundRunState, type BackgroundRunStatusSnapshot } from './state.js';
import {
  BACKGROUND_RUN_SETTINGS_NAMESPACE,
  BackgroundRunSettingsSchema,
  normalizeSettings,
} from './config.js';
import { NetworkMonitor } from './network.js';
import { BackgroundRunStatusController } from './status-controller.js';

export const name = 'background-run';

/**
 * 对齐 dsh-at-file / pixel-skin：声明对 settings 的依赖，
 * loader 等 settings 服务就绪后才跑 apply，apply 内同步 register。
 * （之前无 inject 声明时 apply 跑太早，ctx.settings 不可用，
 * 命名空间从未注册，设置页自然没有入口。）
 *
 * 重要：BackgroundRunStatusController 是独立 Service（独立 fiber），而
 * gateway 按 strict 取 receiver（fiber.state 必须为 2/active）。子 fiber
 * 的激活是异步的（依赖满足 → _reload → state=2），apply 同步返回时它还
 * 没 active。若 gateway 在此窗口调用就会报 service unavailable。
 * 因此 apply 尾部必须 await controller fiber（return promise），让 loader
 * 的 entry 纤程等它就绪后再标 active，gateway 之后才可见。
 * （require 进 gateway 的调用一定晚于 entry active，这就够了。）
 */
export const inject = ['settings'];

export interface BackgroundRunSnapshot extends BackgroundRunStatusSnapshot {}

/** 供 remote 状态通道读取的实时快照源（单例挂在 ctx 上，client 经 controller 读取）。 */
export interface BackgroundRunService {
  snapshot(): BackgroundRunSnapshot;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    backgroundRun?: BackgroundRunService;
    /** 宿主 settings 服务（供 backgroundRunStatus.updateSettings 写入开关）。 */
    backgroundRunSettings?: {
      update(ns: string, patch: Record<string, unknown>): Promise<unknown>;
    };
  }
}

/** agent.id（session 维度）-> 是否计过数。防止同一 agent 重复 +1。 */
function trackRunningAgents(counter: TaskRefCounter, running: Set<string>): { onRunning: (id: string) => void; onIdle: (id: string) => void } {
  return {
    onRunning: (id: string) => {
      if (running.has(id)) return;
      running.add(id);
      counter.taskStarted();
    },
    onIdle: (id: string) => {
      if (!running.delete(id)) return;
      counter.taskEnded();
    },
  };
}

export function apply(ctx: Context): void | Promise<void> {
  // settings 由上面的 inject 保证就绪：同步 register 即可
  // （dsh-at-file 官方就是 apply 内直接 ctx.settings.register）。
  // 失败只记 warn 不抛异常，绝不拖垮整机 boot。
  try {
    const scope = ctx.settings.register(BACKGROUND_RUN_SETTINGS_NAMESPACE, BackgroundRunSettingsSchema);
    return onSettingsScope(ctx, scope);
  } catch (error) {
    ctx.logger.warn(`background-run: settings 命名空间注册失败，开关将不可用：${String(error)}`);
  }
}

interface SettingsScope {
  get(): unknown;
  update(patch: Record<string, unknown>): Promise<unknown>;
  watch(cb: (next: unknown, prev: unknown) => void): () => void;
}

async function onSettingsScope(
  ctx: Context,
  scope: SettingsScope,
): Promise<void> {
  // 开关状态机：唯一真相来源是 scope.get()，updateSettings  Remote 方法
  // 只负责写，写完等 watch 回放（不做本地乐观赋值，避免与回放打架）。
  const readEnabled = (): boolean => {
    try {
      return normalizeSettings(scope.get()).backgroundRunEnabled;
    } catch (error) {
      ctx.logger.warn(`background-run: 读取配置失败，使用安全默认值 false：${String(error)}`);
      return false;
    }
  };
  let enabled = readEnabled();

  let lastError: string | undefined;
  let backendNote: string | undefined;
  const { handle: power, loadError } = createPowerHandle((message) => {
    lastError = message;
    try {
      ctx.logger.warn(`background-run: ${message}`);
    } catch { /* logger 不可用时吞掉，避免崩溃 */ }
  });
  if (loadError) backendNote = loadError;

  const counter = new TaskRefCounter({
    acquirePower: () => {
      if (!enabled) return false;
      const result = power.acquire();
      if (!result.ok) {
        lastError = result.error;
        return false;
      }
      lastError = undefined;
      return true;
    },
    releasePower: () => {
      const result = power.release();
      if (!result.ok) lastError = result.error;
    },
  });
  const runningAgents = new Set<string>();
  const agentTracker = trackRunningAgents(counter, runningAgents);
  const runningJobs = new Set<string>();
  let networkOnline = true;

  const monitor = new NetworkMonitor(
    (online) => {
      networkOnline = online;
      publishSnapshot();
    },
    (message) => {
      try {
        ctx.logger.warn(`background-run: ${message}`);
      } catch { /* ignore */ }
    },
  );

  const service: BackgroundRunService = {
    snapshot: (): BackgroundRunSnapshot => {
      const state: BackgroundRunState = deriveState({
        enabled,
        powerHeld: counter.powerHeld,
        activeTasks: counter.activeTasks,
        networkOnline,
        hasError: lastError !== undefined,
      });
      return {
        state,
        enabled,
        powerHeld: counter.powerHeld,
        activeTasks: counter.activeTasks,
        runningAgents: runningAgents.size,
        runningJobs: runningJobs.size,
        networkOnline,
        ...(lastError !== undefined ? { lastError } : {}),
        ...(backendNote !== undefined ? { backendNote } : {}),
      };
    },
  };
  ctx.provide('backgroundRun', service);
  // updateSettings 写入通道：把宿主 settings 服务挂出来供 controller 用
  // （scope.update 只改内存，settings.update(ns, patch) 才走持久化写入队列）。
  ctx.provide('backgroundRunSettings', ctx.settings);
  // 关键：BackgroundRunStatusController 是独立 fiber 的 Service，而 gateway
  // 按 strict 取 receiver（providing fiber state 必须为 2/active）。
  // 子 fiber 的激活是异步的（构造 → _reload → state=2），apply 同步返回时
  // 它还没 active；若 gateway 在此窗口调用就会报 service unavailable。
  // 因此这里 await controller fiber，让 loader 的 entry 纤程等它就绪后
  // 再标 active——此后 gateway 的调用一定晚于 entry active，这就够了。
  let controllerFiber: { await(): Promise<unknown> };
  try {
    controllerFiber = ctx.plugin(BackgroundRunStatusController) as unknown as { await(): Promise<unknown> };
  } catch (error) {
    ctx.logger.warn(`background-run: 状态查询通道挂载失败，设置页将无实时状态：${String(error)}`);
    controllerFiber = { await: async () => undefined };
  }

  const log = (message: string): void => {
    try {
      ctx.logger.info(`background-run: ${message}`);
    } catch { /* ignore */ }
  };

  /** 设置变更 -> 开关关闭时立即释放所有保持（需求 §六）。 */
  const stopWatch: (() => void) | undefined = scope.watch((next) => {
    const wasEnabled = enabled;
    enabled = normalizeSettings(next).backgroundRunEnabled;
    if (wasEnabled && !enabled) {
      counter.reset();
      runningAgents.clear();
      runningJobs.clear();
      log('开关已关闭，释放全部电源保持请求。');
    } else if (!wasEnabled && enabled) {
      lastError = undefined;
      log('开关已开启。');
      // 开启瞬间若已有运行中任务（热加载场景），以快照为准补计数。
      reconcileAgents();
      reconcileJobs();
    }
    publishSnapshot();
  });

  /** 以 agents 注册表现状为准，对账 agent 计数（热加载/竞态兜底）。 */
  function reconcileAgents(): void {
    try {
      const agents = (ctx.get('agents' as never) as { list?: () => Agent[] } | undefined)?.list?.();
      if (!Array.isArray(agents)) return;
      const seen = new Set<string>();
      for (const agent of agents) {
        let id: string;
        try {
          id = String(agent.id);
        } catch { continue; }
        seen.add(id);
        let status: string;
        try {
          status = agent.status;
        } catch { continue; }
        if (status === 'running') agentTracker.onRunning(id);
      }
      for (const id of [...runningAgents]) {
        if (!seen.has(id)) agentTracker.onIdle(id);
      }
    } catch { /* 对账失败不影响主流程 */ }
  }

  /** 以 jobs 注册表现状为��，对账 job 计数。 */
  function reconcileJobs(): void {
    try {
      const jobs = (ctx.get('jobs' as never) as { list?: () => JobSnapshot[] } | undefined)?.list?.();
      if (!Array.isArray(jobs)) return;
      const live = new Map<string, JobSnapshot>();
      for (const job of jobs) live.set(String(job.id), job);
      for (const [id, job] of live) {
        if ((job.status === 'running' || job.status === 'stopping') && !runningJobs.has(id)) {
          runningJobs.add(id);
          counter.taskStarted();
        }
      }
      for (const id of [...runningJobs]) {
        const job = live.get(id);
        if (!job || (job.status !== 'running' && job.status !== 'stopping')) {
          runningJobs.delete(id);
          counter.taskEnded();
        }
      }
    } catch { /* 对账失败不影响主流程 */ }
  }

  function publishSnapshot(): void {
    try {
      ctx.emit('background-run/status' as never, service.snapshot() as never);
    } catch { /* 无监听时忽略 */ }
  }

  // —— 当前任务：agent/status（需求 §八.当前任务）——
  // 订阅置于 effect 内，随插件卸载自动清理。
  const stopAgentStatus = ctx.on('agent/status' as never, ((payload: { agent: Agent; status: 'idle' | 'running' }) => {
    if (!enabled) return;
    let id: string;
    try {
      id = String(payload.agent.id);
    } catch { return; }
    if (payload.status === 'running') {
      const before = counter.activeTasks;
      agentTracker.onRunning(id);
      if (counter.activeTasks !== before) log(`任务开始（agent ${id}），电源保持${counter.powerHeld ? '已生效' : '申请失败'}。`);
    } else {
      const before = counter.activeTasks;
      agentTracker.onIdle(id);
      if (counter.activeTasks !== before) log(`任务结束（agent ${id}），剩余 ${counter.activeTasks} 个活跃任务。`);
    }
    publishSnapshot();
  }) as never);

  // —— 后台任务：jobs 注册表（需求 §八.后台任务）——
  let stopJobsChanged: (() => void) | undefined;
  let stopJobDone: (() => void) | undefined;
  try {
    const jobs = ctx.get('jobs' as never) as
      | { onJobsChanged(cb: (owner: unknown) => void): () => void; onJobDone(cb: (snapshot: JobSnapshot) => void): () => void; list(): JobSnapshot[] }
      | undefined;
    if (jobs) {
      stopJobsChanged = jobs.onJobsChanged(() => {
        if (!enabled) return;
        reconcileJobs();
        publishSnapshot();
      });
      stopJobDone = jobs.onJobDone((snapshot) => {
        const id = String(snapshot.id);
        if (runningJobs.delete(id)) {
          counter.taskEnded();
          log(`后台任务结束（${id}，${snapshot.status}），剩余 ${counter.activeTasks} 个活跃任务。`);
          publishSnapshot();
        }
      });
    }
  } catch (error) {
    ctx.logger.warn(`background-run: jobs 服务订阅失败，后台任务将无法单独计数：${String(error)}`);
  }

  // —— 进程级清理（需求 §六/§十一）——
  let cleaned = false;
  function cleanup(reason: string): void {
    if (cleaned) return;
    cleaned = true;
    try { stopAgentStatus(); } catch { /* ignore */ }
    try { stopJobsChanged?.(); } catch { /* ignore */ }
    try { stopJobDone?.(); } catch { /* ignore */ }
    try { stopWatch?.(); } catch { /* ignore */ }
    monitor.stop();
    counter.reset();
    runningAgents.clear();
    runningJobs.clear();
    log(`已清理（${reason}）：电源保持已释放，监测器已停止。`);
  }

  const onProcessExit = (): void => { cleanup('进程退出'); };
  const onUncaught = (error: unknown): void => {
    try {
      ctx.logger.warn(`background-run: 未捕获异常，释放电源保持后继续抛出：${String(error)}`);
    } catch { /* ignore */ }
    cleanup('未捕获异常');
  };
  try {
    process.once('exit', onProcessExit);
    process.once('uncaughtException', onUncaught);
  } catch { /* 非标准宿主忽略 */ }

  monitor.start();
  if (enabled) {
    reconcileAgents();
    reconcileJobs();
  }
  log(`插件已加载（平台 ${process.platform}，电源后端 ${power.kind}）。`);

  ctx.effect(() => {
    return async () => {
      try {
        process.removeListener('exit', onProcessExit);
        process.removeListener('uncaughtException', onUncaught);
      } catch { /* ignore */ }
      cleanup('插件卸载');
    };
  }, 'background-run.lifecycle()');

  // 等 controller 纤程 active 后再让本 entry 就绪（见顶部 inject 注释）。
  await controllerFiber.await();
}

/**
 * 注意：不要 `export default apply`。
 * cordis-plugin-loader 的 unwrapExports() 优先取 exports.default —— 一旦默认导出
 * apply 函数，模块顶层的 `inject` 数组（如 ['settings']）就会被丢弃，loader 启动
 * fiber 时拿不到注入声明：apply 会在依赖未就绪时立刻执行，ctx.settings 访问触发
 * cordis 守卫「cannot get property "settings" without inject」，被 apply 的
 * try/catch 吞掉后插件静默变成空壳 —— 远端所有 backgroundRunStatus/* 调用随即报
 * 「active Service "backgroundRunStatus" is unavailable」。
 * 保持与官方插件（如 dsh-llm-retry）一致的纯命名导出形态即可。
 */

