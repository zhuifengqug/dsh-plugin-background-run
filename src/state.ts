/**
 * 后台运行状态机（需求 §六）。
 *
 * 状态：
 * - disabled：开关关闭，不申请任何电源保持；
 * - enabled-idle：开关开启但无任务，不持有电源保持；
 * - active：有任务运行，已申请并持有电源保持；
 * - network-interrupted：网络中断（仍持有电源保持，任务去留交由 DSH 原有机制）；
 * - error：电源 API 不可用或调用失败（真实状态，非伪装成功）。
 *
 * 引用计数规则：
 * - 任务开始 -> +1；任务结束/失败/取消/超时 -> -1；
 * - 计数到 0 -> 释放电源保持；
 * - 钳制在 >= 0，防止重复释放与负数泄漏。
 */

export type BackgroundRunState =
  | 'disabled'
  | 'enabled-idle'
  | 'active'
  | 'network-interrupted'
  | 'error';

export interface BackgroundRunStatusSnapshot {
  state: BackgroundRunState;
  /** 开关是否打开（用户配置）。 */
  enabled: boolean;
  /** 是否真实持有 Windows 电源保持请求。 */
  powerHeld: boolean;
  /** 当前活跃任务引用计数。 */
  activeTasks: number;
  /** 运行中的 agent 会话数。 */
  runningAgents: number;
  /** 运行中的后台 job 数。 */
  runningJobs: number;
  /** 网络是否连通（基于最近一次探测）。 */
  networkOnline: boolean;
  /** 最近一条面向用户的错误（已脱敏，不含凭据），无错误时为 undefined。 */
  lastError?: string;
  /** 电源后端不可用时的原因说明。 */
  backendNote?: string;
}

export interface RefCountDriver {
  acquirePower(): boolean;
  releasePower(): void;
}

/**
 * 引用计数核心：纯逻辑，可单元测试。电源调用成��与否由 driver 回报，
 * 计数本身不受 API 成败影响（失败只影响 powerHeld 展示与 state）。
 */
export class TaskRefCounter {
  private count = 0;
  private held = false;
  private readonly driver: RefCountDriver;

  constructor(driver: RefCountDriver) {
    this.driver = driver;
  }

  get activeTasks(): number {
    return this.count;
  }

  get powerHeld(): boolean {
    return this.held;
  }

  /** 任务开始。返回持有状态。 */
  taskStarted(): boolean {
    this.count += 1;
    if (!this.held) {
      this.held = this.driver.acquirePower();
    }
    return this.held;
  }

  /** 任务结束（含完成/失败/取消/超时）。返回持有状态。 */
  taskEnded(): boolean {
    // 钳制：重复结束同一任务不产生负数。
    if (this.count > 0) this.count -= 1;
    if (this.count === 0 && this.held) {
      this.driver.releasePower();
      this.held = false;
    }
    return this.held;
  }

  /** 强制复位（插件卸载 / DSH 退出 / 开关关闭时）。 */
  reset(): void {
    this.count = 0;
    if (this.held) {
      this.driver.releasePower();
      this.held = false;
    }
  }
}

/** 由开关/计数/网络/错误派生对外展示状态。纯函数，可测试。 */
export function deriveState(args: {
  enabled: boolean;
  powerHeld: boolean;
  activeTasks: number;
  networkOnline: boolean;
  hasError: boolean;
}): BackgroundRunState {
  if (!args.enabled) return 'disabled';
  if (args.hasError && !args.powerHeld && args.activeTasks > 0) return 'error';
  if (!args.networkOnline) return 'network-interrupted';
  if (args.activeTasks > 0) return args.powerHeld ? 'active' : 'error';
  return 'enabled-idle';
}
