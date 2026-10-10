import dns from 'node:dns/promises';
const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_PROBE_HOST = 'api.deepseek.com';
export class NetworkMonitor {
    intervalMs;
    timeoutMs;
    probeHost;
    onChange;
    onLog;
    timer;
    online = true;
    stopped = false;
    constructor(onChange, onLog, options){
        this.onChange = onChange;
        this.onLog = onLog;
        this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
        this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.probeHost = options?.probeHost ?? DEFAULT_PROBE_HOST;
    }
    get isOnline() {
        return this.online;
    }
    start() {
        if (this.timer || this.stopped) return;
        this.timer = setInterval(()=>{
            void this.probeOnce();
        }, this.intervalMs);
        this.timer.unref?.();
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    async probeOnce() {
        let next;
        try {
            await dns.lookup(this.probeHost, {
                signal: AbortSignal.timeout(this.timeoutMs)
            });
            next = 'online';
        } catch  {
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
