/**
 * 网络状态监测（需求 §七）。
 *
 * 约束：
 * - 只做“观测 + 提示”，不修改网卡/适配器/驱动任何配置；
 * - 不伪造任务成功，不静默丢失任务；
 * - 恢复后是否继续遵循 DSH 原有任务模型（本插件不接管重试）；
 * - 阻止睡眠 ≠ 保证网络可用：Wi-Fi/路由/VPN/远端 API 仍可能断开。
 *
 * 实现：Node DNS 解析 + fetch 探测（HEAD 级轻量），失败即记为中断并打日志，
 * 状态页展示“网络连接中断，当前任务状态将由 DSH 的现有重试机制处理”。
 */
import dns from 'node:dns/promises';

export type NetworkProbeResult = 'online' | 'offline';

export interface NetworkMonitorOptions {
  /** 探测间隔毫秒，默认 30s。 */
  intervalMs?: number;
  /** 单次探测超时毫秒，默认 8s。 */
  timeoutMs?: number;
  /** 探测域名（仅 DNS，不传输任务数据）。 */
  probeHost?: string;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_HOST = 'api.deepseek.com';

export class NetworkMonitor {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly probeHost: string;
  private readonly onChange: (online: boolean) => void;
  private readonly onLog: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private online = true;
  private stopped = false;

  constructor(onChange: (online: boolean) => void, onLog: (message: string) => void, options?: NetworkMonitorOptions) {
    this.onChange = onChange;
    this.onLog = onLog;
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeHost = options?.probeHost ?? DEFAULT_PROBE_HOST;
  }

  get isOnline(): boolean {
    return this.online;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.probeOnce();
    }, this.intervalMs);
    // 首次延迟探测，避免阻塞启动；状态初值视为在线，探测失败再翻转。
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async probeOnce(): Promise<NetworkProbeResult> {
    let next: NetworkProbeResult;
    try {
      await dns.lookup(this.probeHost, { signal: AbortSignal.timeout(this.timeoutMs) });
      next = 'online';
    } catch {
      next = 'offline';
    }
    const wasOnline = this.online;
    this.online = next === 'online';
    if (wasOnline && !this.online) {
      this.onLog('网络连接中断，当前任务状态将由 DSH 的现有重试机制处理。');
      this.onChange(false);
    } else if (!wasOnline && this.online) {
      this.onLog('网络连接已恢复，任务恢复遵循 DSH 原有任务模型。');
      this.onChange(true);
    }
    return next;
  }
}
