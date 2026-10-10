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
  /**
   * 探测实现（默认 `node:dns/promises` 的 lookup）。
   *
   * 可注入是为了让超时语义可回归：注入一个永不 settle 的实现，
   * 断言 `probeOnce()` 在 `timeoutMs` 内返回 `offline`（需求 §4 B12）。
   */
  lookup?: (host: string) => Promise<unknown>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_HOST = 'api.deepseek.com';

/**
 * 带显式超时的 DNS 探测。
 *
 * 为什么不用 `dns.lookup(host, { signal })`：`signal` 不在 Node 的
 * `LookupOptions` 里（`@types/node` 全文无 `signal` 字段），运行时也被忽略 ——
 * 实测预先 abort 的 signal 仍会正常 resolve，8s 超时保护等于不存在。
 * 因此改为 `Promise.race` + 显式定时器，超时语义真实生效且可测试。
 */
export async function lookupWithTimeout(
  host: string,
  timeoutMs: number,
  lookup: (host: string) => Promise<unknown>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      lookup(host).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`DNS 探测超时（${timeoutMs} ms）`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class NetworkMonitor {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly probeHost: string;
  private readonly lookup: (host: string) => Promise<unknown>;
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
    this.lookup = options?.lookup ?? ((host: string) => dns.lookup(host));
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
      await lookupWithTimeout(this.probeHost, this.timeoutMs, this.lookup);
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
