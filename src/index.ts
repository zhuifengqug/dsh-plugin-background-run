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
 * ## 0.2.0 适配要点（对齐 DSH 0.2.0-rc.2 实测 API）
 *
 * 1. **设置面**：`ctx.settings.register(ns, schema)` 已删除。改为入口导出 `Config`
 *    （见 ./config.js 的说明）+ 从 Loader/configEditor 条目读实时 `options.config`
 *    + `ctx.settings.configure({ auto: true }, ctx.fiber)` 注册页面策略。
 *    配置持久化位置随之变为 profile 的 `cordis.patch.yml` 中该 entry 的 `config`。
 * 2. **任务检测**：`ctx.jobs.onJobsChanged/onJobDone` 与 `JobSnapshot` 在 0.2.0-rc.2
 *    全库无命中。目标宿主 dsh-jobs-local 的真实事件入口是
 *    `jobs.events.subscribe(filter, listener)`（hub 内部绑定注册上下文），
 *    插件优先走该入口，仅在没有 events 入口时回退旧形状 `jobs.subscribe(ctx, ...)`
 *    （T3-JOBS-EVENTS-SUBSCRIBE）；`jobs.list()` 快照差分仍是唯一可信兜底，
 *    并按 `status` 判定活跃态。
 * 3. **诊断**：删除向 `D:/DSHData/home/background-run-diag.log` 的硬编码写入，
 *    改用 `ctx.logger`；并新增只读打点（agentStatusEvents/jobEvents/settingsBound）
 *    供目标宿主验证 scope 投递与 jobs 事件是否真的到达。
 *
 * 任务检测（需求 §八，复用现有事件，不扫描日志）：
 * - 当前任务：agent/status（idle ⇄ running，含流式请求与工具调用全程）；
 * - 后台任务：jobs 订阅 + list() 快照差分；
 * - 定时任务：dsh-schedule 触发后走 agent turn（已被 agent/status 覆盖），
 *   本插件不再单独计数，避免重复；限制见 README/最终报告。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-settings';
import { createPowerHandle } from './power.js';
import { TaskRefCounter, deriveState, type BackgroundRunState, type BackgroundRunStatusSnapshot } from './state.js';
import {
  BACKGROUND_RUN_SETTINGS_NAMESPACE,
  DEFAULT_BACKGROUND_RUN_SETTINGS,
  normalizeSettings,
  type BackgroundRunSettings,
} from './config.js';
import { NetworkMonitor } from './network.js';
import { BackgroundRunStatusController } from './status-controller.js';

export const name = 'background-run';

/**
 * 宿主 `dsh-settings` 读的是 `entry.fiber.runtime.Config`，也就是**本模块的导出对象**。
 * 少了这一行，宿主拿到 undefined → `describe()` 跳过整个条目 → 设置页没有入口、
 * 命名空间不被服务（表现为「设置里没有卡片」+「当前配置不可写」）。
 */
export { Config } from './config.js';

/**
 * 依赖声明。
 *
 * - `settings`：设置服务就绪后再跑 apply（读取 Loader 条目 config、注册页面策略）；
 * - `configEditor`：提供 `entries()` 与配置写入通道；显式声明以保证 apply 同步执行时
 *   就能查到自己的条目（settings 自身也 inject 了 configEditor，这里只是把依赖写明）。
 *
 * 重要：BackgroundRunStatusController 是独立 Service（独立 fiber），而
 * gateway 按 strict 取 receiver（fiber.state 必须为 2/active）。子 fiber
 * 的激活是异步的（依赖满足 → _reload → state=2），apply 同步返回时它还
 * 没 active。若 gateway 在此窗口调用就会报 service unavailable。
 * 因此 apply 尾部必须 await controller fiber（return promise），让 loader
 * 的 entry 纤程等它就绪后再标 active，gateway 之后才可见。
 */
export const inject = ['settings', 'configEditor'];

export interface BackgroundRunSnapshot extends BackgroundRunStatusSnapshot {}

/** 供 remote 状态通道读取的实时快照源（单例挂在 ctx 上，client 经 controller 读取）。 */
export interface BackgroundRunService {
  snapshot(): BackgroundRunSnapshot;
}

/** Loader 条目结构（不 import loader 包，避免新增 peerDependency）。 */
interface SettingsConfigEntry {
  options?: { id?: string; config?: unknown };
}

/** 宿主 settings 服务里本插件用到的子集（describe/configure/update）。 */
interface SettingsSurfaceLike {
  describe?: () => readonly { ns?: unknown }[];
  configure?: (presentation: { auto?: boolean }, owner?: unknown) => (() => void) | undefined;
  update?: (ns: string, patch: Record<string, unknown>) => Promise<unknown>;
}

/** 宿主 settings 写入通道的形状（update(ns, patch, expectedRevision)）。 */
export interface BackgroundRunSettingsWriter {
  update(ns: string, patch: Record<string, unknown>): Promise<unknown>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    backgroundRun?: BackgroundRunService;
    /** 宿主 settings 写入通道（供 backgroundRunStatus.updateSettings 兜底写开关）。 */
    backgroundRunSettings?: BackgroundRunSettingsWriter;
  }
  /**
   * 本插件自定义事件：状态快照广播（`publishSnapshot()` 派发）。
   *
   * 必须在此声明，`ctx.emit()` / `ctx.on()` 才是类型安全的
   * （cordis 的签名是 `emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>)`）。
   * 不加声明就只能用 `as never` 绕过检查，而那会连带把负载类型一起丢掉。
   */
  interface Events {
    'background-run/status'(snapshot: BackgroundRunStatusSnapshot): void;
  }
}

/**
 * 目标宿主 dsh-jobs-local 的 job 视图（结构化镜像）。
 *
 * 不再 import `JobSnapshot`：该类型（连同 onJobsChanged/onJobDone）在 0.2.0-rc.2
 * 全库无命中，且本插件只需要 status/id 两个字段。
 */
export interface JobView {
  id: string;
  status: string;
  kind?: string;
  label?: string;
  owner?: unknown;
  startedAt?: number;
  finishedAt?: number;
}

/** dsh-jobs-local 的 JobEventHub 事件类型。 */
export type JobEventType = 'registered' | 'stopping' | 'output' | 'progress' | 'settled' | 'removed';

export interface JobEvent {
  type: JobEventType;
  job: JobView;
}

/**
 * jobs 注册表探针（目标宿主：`events.subscribe(filter, listener)` + `list`；
 * 旧宿主/兼容形态可能只有 `subscribe(ctx, filter, listener)` 或只有 `list`）。
 *
 * dsh-jobs-local@0.2.0-rc.2 的真实入口是 `ctx.jobs.events.subscribe(filter, listener)`，
 * **没有** `jobs.subscribe(ctx, ...)`（T3-JOBS-EVENTS-SUBSCRIBE）。events hub 内部已绑定
 * 注册上下文：从未 scoped 的插件 fiber 调用时，非 `{ owners: 'scope' }` 的 filter 会落到
 * hub 的 unscoped 集合，收到所有 owner 的事件（宿主源码 JobEventHub.subscribe/emit）。
 */
export interface JobsRegistryLike {
  list?(caller?: unknown): unknown;
  events?: {
    subscribe(filter: unknown, listener: (event: JobEvent) => void): () => void;
  };
  /** 兼容旧宿主/未发现 events 入口时的旧形状（目标宿主 0.2.0-rc.2 无此方法）。 */
  subscribe?(ctx: unknown, filter: unknown, listener: (event: JobEvent) => void): () => void;
}

/** dsh-jobs-local `events.subscribe(filter, listener)` 的 filter 形状。 */
export interface JobsEventFilter {
  owners?: 'all' | 'scope';
  owner?: string;
}

/** 活跃态判定（与 dsh-jobs-local 的 isTerminal 互补：completed/killed/failed 为终止态）。 */
export function isActiveJobStatus(status: unknown): boolean {
  return status === 'running' || status === 'stopping';
}

/** 开关状态的兜底同步周期（Loader 条目 config 没有变更事件）。 */
export const SETTINGS_SYNC_MS = 5_000;
/** 条目热替换（hot reload 换 fiber）的重绑周期。 */
export const SETTINGS_ENTRY_REBIND_MS = 30_000;

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
  // 开关的唯一真相来源 = Loader 条目上的实时 config；查不到条目时用安全默认值 false。
  let currentSource: () => BackgroundRunSettings = () => ({ ...DEFAULT_BACKGROUND_RUN_SETTINGS });
  let settingsEntry = findOwnConfigEntry();
  let settingsBound = false;

  function findOwnConfigEntry(): SettingsConfigEntry | undefined {
    try {
      const editor = ctx.get('configEditor' as never) as
        | { entries?: () => readonly SettingsConfigEntry[] }
        | undefined;
      const rows = editor?.entries?.();
      if (Array.isArray(rows)) {
        const own = rows.find((row) => row?.options?.id === BACKGROUND_RUN_SETTINGS_NAMESPACE);
        if (own !== undefined) return own;
      }
    } catch { /* configEditor 缺失/未就绪 → 回落到 loader */ }
    try {
      const loader = ctx.get('loader' as never) as { entries?: () => Iterable<SettingsConfigEntry> } | undefined;
      for (const row of loader?.entries?.() ?? []) {
        if (row?.options?.id === BACKGROUND_RUN_SETTINGS_NAMESPACE) return row;
      }
    } catch { /* loader 不可用 → 保持安全默认值 */ }
    return undefined;
  }

  /** 把 currentSource 指向 Loader 条目上的实时配置。 */
  function bindConfigFromEntry(): void {
    const entry = settingsEntry;
    if (entry === undefined) {
      settingsBound = false;
      return;
    }
    currentSource = () => normalizeSettings(entry.options?.config ?? {});
    settingsBound = true;
  }

  bindConfigFromEntry();

  // 条目热替换（配置热重载会换 fiber，options.config 随之换对象）→ 定期重绑。
  try {
    const rebindTimer = setInterval(() => {
      const next = findOwnConfigEntry();
      if (next !== undefined && next !== settingsEntry) {
        settingsEntry = next;
        bindConfigFromEntry();
      }
    }, SETTINGS_ENTRY_REBIND_MS);
    (rebindTimer as unknown as { unref?: () => void }).unref?.();
    ctx.effect(() => () => clearInterval(rebindTimer), 'background-run: settings entry watcher');
  } catch { /* 非标准宿主忽略 */ }

  const stopSettings = registerSettingsSection(ctx);
  ctx.effect(() => stopSettings ?? (() => undefined), 'background-run: settings surface');

  return onSettingsReady(ctx, () => currentSource(), () => settingsBound);
}

/**
 * 注册设置页策略。
 *
 * DSH 0.2.0-rc.2 起 `configure()` 对同一 fiber 重复注册直接抛错
 * （"Settings presentation is already configured for this plugin instance"），
 * 且 presentations 强引用 fiber，因此必须把 disposer 交给 `ctx.effect`。
 * 失败只记 warn 不抛异常，绝不拖垮整机 boot。
 */
function registerSettingsSection(ctx: Context): (() => void) | undefined {
  try {
    const settings = ctx.settings as unknown as SettingsSurfaceLike | undefined;
    if (settings === undefined || typeof settings.configure !== 'function') {
      warn(ctx, 'ctx.settings.configure 不可用；设置页降级为 Loader 条目配置。');
      return undefined;
    }
    return settings.configure({ auto: true }, ctx.fiber) ?? undefined;
  } catch (error) {
    warn(ctx, `设置页注册失败（${String(error)}）；降级为 Loader 条目配置。`);
    return undefined;
  }
}

function warn(ctx: Context, message: string): void {
  try { ctx.logger.warn(`background-run: ${message}`); } catch { /* logger 不可用时吞掉，避免崩溃 */ }
}

async function onSettingsReady(
  ctx: Context,
  readConfig: () => BackgroundRunSettings,
  isBound: () => boolean,
): Promise<void> {
  const warnHere = (message: string): void => warn(ctx, message);
  const log = (message: string): void => {
    try { ctx.logger.info(`background-run: ${message}`); } catch { /* ignore */ }
  };

  // 开关状态机：唯一真相来源是 Loader 条目 config（readConfig），
  // updateSettings Remote 方法只负责写，写完等下一轮 syncEnabled 观察到。
  let enabled = false;
  try {
    enabled = readConfig().backgroundRunEnabled === true;
  } catch (error) {
    warnHere(`读取配置失败，使用安全默认值 false：${String(error)}`);
  }

  let lastError: string | undefined;
  let backendNote: string | undefined;
  const { handle: power, loadError } = createPowerHandle((message) => {
    lastError = message;
    warnHere(message);
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
  /** 只读打点：供目标宿主验证 agent/status 的 scope 投递与 jobs 事件是否真的到达。 */
  let agentStatusEvents = 0;
  let jobEvents = 0;

  const monitor = new NetworkMonitor(
    (online) => {
      networkOnline = online;
      publishSnapshot();
    },
    (message) => warnHere(message),
  );

  const service: BackgroundRunService = {
    snapshot: (): BackgroundRunSnapshot => {
      // 每次读快照前先与配置对账：开关被外部写入（设置页）后，这里能及时释放/申请保持。
      syncEnabled();
      // 再与 jobs 注册表现状对账：事件订阅漏投/缺失时，list() 是唯一可信兜底，
      // 让读数（设置页状态、Remote status()）不必等 5s 周期定时器就自愈。
      if (enabled) reconcileJobs();
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
        agentStatusEvents,
        jobEvents,
        settingsBound: isBound(),
        ...(lastError !== undefined ? { lastError } : {}),
        ...(backendNote !== undefined ? { backendNote } : {}),
      };
    },
  };
  ctx.provide('backgroundRun', service);
  // updateSettings 写入通道：把宿主 settings 服务挂出来供 controller 用。
  // 0.2.0-rc.2 的 SettingsForms.update(ns, patch) 走 configEditor 的持久化写入队列，
  // 写入的是 profile 的 cordis.patch.yml 里该 entry 的 config。
  ctx.provide('backgroundRunSettings', {
    update: async (ns: string, patch: Record<string, unknown>): Promise<unknown> => {
      const settings = ctx.settings as unknown as SettingsSurfaceLike | undefined;
      if (settings === undefined || typeof settings.update !== 'function') {
        throw new Error('宿主 settings.update 不可用（设置服务未就绪或宿主版本过旧）');
      }
      return settings.update(ns, patch);
    },
  });

  /**
   * 与 Loader 条目 config 对账：开关翻转时做进入/退出处理。
   * 由 snapshot()、事件回调与周期定时器共同驱动（条目 config 没有变更事件）。
   */
  function syncEnabled(): void {
    let next = enabled;
    try {
      next = readConfig().backgroundRunEnabled === true;
    } catch {
      return;
    }
    if (next === enabled) return;
    const wasEnabled = enabled;
    enabled = next;
    if (wasEnabled && !enabled) {
      // 需求 §六：关闭开关立即释放全部保持。
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
  }

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

  /** 以 jobs 注册表现状为准，对账 job 计数（订阅缺失或漏事件时的唯一可信兜底）。 */
  function reconcileJobs(): void {
    try {
      const jobs = (ctx.get('jobs' as never) as JobsRegistryLike | undefined)?.list?.();
      if (!Array.isArray(jobs)) return;
      const live = new Map<string, JobView>();
      for (const job of jobs as JobView[]) {
        if (job === null || typeof job !== 'object') continue;
        live.set(String(job.id), job);
      }
      for (const [id, job] of live) {
        if (isActiveJobStatus(job.status) && !runningJobs.has(id)) {
          runningJobs.add(id);
          counter.taskStarted();
        }
      }
      for (const id of [...runningJobs]) {
        const job = live.get(id);
        // 终止态与「从 list 中消失」都视为结束（removed 事件的兜底）。
        if (job === undefined || !isActiveJobStatus(job.status)) {
          runningJobs.delete(id);
          counter.taskEnded();
        }
      }
    } catch { /* 对账失败不影响主流程 */ }
  }

  function publishSnapshot(): void {
    try {
      ctx.emit('background-run/status', service.snapshot());
    } catch { /* 无监听时忽略 */ }
  }

  // —— 当前任务：agent/status（需求 §八.当前任务）——
  // 订阅置于 effect 内，随插件卸载自动清理。
  const stopAgentStatus = ctx.on('agent/status' as never, ((payload: { agent: Agent; status: 'idle' | 'running' }) => {
    agentStatusEvents += 1;
    syncEnabled();
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
  // 目标 dsh-jobs-local@0.2.0-rc.2 的事件入口是 `jobs.events.subscribe(filter, listener)`
  // （hub 内部已绑定注册上下文，从未 scoped 的插件 fiber 上用非 'scope' filter 即可收到
  // 所有 owner 的事件）。仅当目标对象**没有** events.subscribe 时才回退到旧形状
  // `jobs.subscribe(ctx, filter, listener)`；两者都没有时由 5s 周期 list() 对账兜底。
  let stopJobs: (() => void) | undefined;
  let jobsEventChannel: 'events' | 'legacy' | 'none' = 'none';
  try {
    const jobs = ctx.get('jobs' as never) as JobsRegistryLike | undefined;
    const onJobEvent = (event: JobEvent): void => {
      jobEvents += 1;
      syncEnabled();
      if (!enabled) return;
      const job = event?.job;
      if (job === undefined || job === null || job.id === undefined) {
        reconcileJobs();
        publishSnapshot();
        return;
      }
      const id = String(job.id);
      if (event.type === 'removed') {
        // removed 也要收口，否则「记录被移除但计数泄漏」。
        if (runningJobs.delete(id)) {
          counter.taskEnded();
          log(`后台任务移除（${id}），剩余 ${counter.activeTasks} 个活跃任务。`);
        }
      } else if (isActiveJobStatus(job.status)) {
        if (!runningJobs.has(id)) {
          runningJobs.add(id);
          counter.taskStarted();
          log(`后台任务开始（${id}），电源保持${counter.powerHeld ? '已生效' : '申请失败'}。`);
        }
      } else if (runningJobs.delete(id)) {
        counter.taskEnded();
        log(`后台任务结束（${id}，${String(job.status)}），剩余 ${counter.activeTasks} 个活跃任务。`);
      }
      publishSnapshot();
    };
    if (jobs && jobs.events !== undefined && typeof jobs.events.subscribe === 'function') {
      // 目标形态：全局 filter（非 'scope'）→ hub 的 unscoped 集合 → 收到所有 owner 的事件。
      const filter: JobsEventFilter = { owners: 'all' };
      stopJobs = jobs.events.subscribe(filter, onJobEvent);
      jobsEventChannel = 'events';
    } else if (jobs && typeof jobs.subscribe === 'function') {
      stopJobs = jobs.subscribe(ctx, { owners: 'all' }, onJobEvent);
      jobsEventChannel = 'legacy';
    }
  } catch (error) {
    warnHere(`jobs 事件订阅失败，后台任务将退化为 list() 轮询对账：${String(error)}`);
  }

  // —— 周期对账（需求 §八 兜底）——
  // 1) 同步开关（Loader 条目 config 无变更事件）；
  // 2) 以 list() 差分对账 agent/job 计数（订阅缺失或漏事件时仍正确）。
  let stopSync: (() => void) | undefined;
  try {
    const syncTimer = setInterval(() => {
      try {
        syncEnabled();
        if (!enabled) return;
        const beforeTasks = counter.activeTasks;
        const beforeAgents = runningAgents.size;
        const beforeJobs = runningJobs.size;
        reconcileAgents();
        reconcileJobs();
        if (counter.activeTasks !== beforeTasks || runningAgents.size !== beforeAgents || runningJobs.size !== beforeJobs) {
          publishSnapshot();
        }
      } catch { /* 对账失败不影响主流程 */ }
    }, SETTINGS_SYNC_MS);
    (syncTimer as unknown as { unref?: () => void }).unref?.();
    stopSync = () => clearInterval(syncTimer);
  } catch { /* 非标准宿主忽略 */ }

  // —— 进程级清理（需求 §六/§十一）——
  let cleaned = false;
  function cleanup(reason: string): void {
    if (cleaned) return;
    cleaned = true;
    try { stopAgentStatus(); } catch { /* ignore */ }
    try { stopJobs?.(); } catch { /* ignore */ }
    try { stopSync?.(); } catch { /* ignore */ }
    monitor.stop();
    counter.reset();
    runningAgents.clear();
    runningJobs.clear();
    log(`已清理（${reason}）：电源保持已释放，监测器已停止。`);
  }

  const onProcessExit = (): void => { cleanup('进程退出'); };
  const onUncaught = (error: unknown): void => {
    warnHere(`未捕获异常，释放电源保持后继续抛出：${String(error)}`);
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
  log(`插件已加载（平台 ${process.platform}，电源后端 ${power.kind}，设置条目${isBound() ? '已绑定' : '未绑定（使用默认值 false）'}）。`);

  ctx.effect(() => {
    return async () => {
      try {
        process.removeListener('exit', onProcessExit);
        process.removeListener('uncaughtException', onUncaught);
      } catch { /* ignore */ }
      cleanup('插件卸载');
    };
  }, 'background-run.lifecycle()');

  // —— 状态查询通道（独立 Service fiber）——
  const controllerFiber = mountStatusController(ctx, warnHere);
  // 等 controller 纤程 active 后再让本 entry 就绪（见顶部 inject 注释）。
  await controllerFiber.await();
}

/** 挂载 BackgroundRunStatusController；失败只降级不抛错。 */
function mountStatusController(ctx: Context, warnHere: (message: string) => void): { await(): Promise<unknown> } {
  try {
    return ctx.plugin(BackgroundRunStatusController) as unknown as { await(): Promise<unknown> };
  } catch (error) {
    warnHere(`状态查询通道挂载失败，设置页将无实时状态：${String(error)}`);
    return { await: async () => undefined };
  }
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
