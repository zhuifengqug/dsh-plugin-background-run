/**
 * 浏览器侧开关读写 + 状态读取通道（Typert Remote）。
 *
 * 开关写入优先走标准 settings 通道（浏览器 settingsScope -> remote.settings.mutate）。
 * 但实测浏览器 settingsScope 只 serve 白名单命名空间，外部插件命名空间在浏览器侧
 * 不可见（image-gen 的 scope 是宿主直连特例，不可复制）。因此本控制器额外暴露
 * getSettings / updateSettings 两个薄方法（at-file 同款 Remote 直连模式），
 * 作为设置页面的读写兜底：读宿主侧真实值，写宿主侧 scope.update()。
 * status() 仍是只读快照，供页面展示电源保持 / 当前任务 / 网络状态。
 *
 * Remote 注册用 myrules 同款 markRemote() 写法：plain-JS，无装饰器，
 * 与当前 @deepseek-ai/dsh-typert-protocol 的 markers 表直接兼容。
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import type { BackgroundRunSnapshot } from './index.js';
import { BACKGROUND_RUN_SETTINGS_NAMESPACE } from './config.js';

export interface BackgroundRunStatusWire extends BackgroundRunSnapshot {}

export interface BackgroundRunSettingsValue {
  backgroundRunEnabled: boolean;
}

export interface BackgroundRunSettingsResult {
  ok: boolean;
  value: BackgroundRunSettingsValue;
  writable: boolean;
}

export interface BackgroundRunUpdateResult extends BackgroundRunSettingsResult {
  error?: { message: string };
}

export class BackgroundRunStatusController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'backgroundRunStatus', { namespace: 'backgroundRunStatus' });
    runRemoteMarks(this);
  }

  async status(_input: Record<string, unknown> = {}): Promise<BackgroundRunStatusWire> {
    // TEMP-DIAG: 客户端诊断回传（只读副作用：仅写日志文件，不改任何状态）
    try {
      const diag = (_input as { __diag?: unknown } | undefined)?.__diag;
      if (typeof diag === 'string' && diag.length > 0 && diag.length < 4000) {
        const { appendFileSync } = await import('node:fs');
        appendFileSync('D:/DSHData/home/background-run-diag.log', `${new Date().toISOString()} ${diag}\n`);
      }
    } catch { /* 诊断失败不影响主流程 */ }
    void _input;
    const service = this.ctx.get('backgroundRun' as never) as
      | { snapshot(): BackgroundRunSnapshot }
      | undefined;
    if (!service) {
      return {
        state: 'disabled',
        enabled: false,
        powerHeld: false,
        activeTasks: 0,
        runningAgents: 0,
        runningJobs: 0,
        networkOnline: true,
        lastError: '后台运行服务未加载。',
      };
    }
    return service.snapshot();
  }

  /** 读宿主侧开关真实值（浏览器 settingsScope 不可见外部命名空间时的兜底）。 */
  async getSettings(_input: Record<string, unknown> = {}): Promise<BackgroundRunSettingsResult> {
    void _input;
    const service = this.ctx.get('backgroundRun' as never) as
      | { snapshot(): BackgroundRunSnapshot }
      | undefined;
    const enabled = service ? service.snapshot().enabled === true : false;
    return { ok: true, value: { backgroundRunEnabled: enabled }, writable: true };
  }

  /** 写宿主侧开关（走宿主 scope.update()，与设置页 watch 同一数据源）。 */
  async updateSettings(_input: Record<string, unknown> = {}): Promise<BackgroundRunUpdateResult> {
    const input = (_input ?? {}) as { field?: unknown; value?: unknown; backgroundRunEnabled?: unknown };
    // 兼容两种调用形状：{ field, value }（at-file 同款）或 { backgroundRunEnabled }。
    let next: boolean;
    if (input.field !== undefined) {
      if (input.field !== 'backgroundRunEnabled') {
        return {
          ok: false,
          value: { backgroundRunEnabled: false },
          writable: true,
          error: { message: `未知字段：${String(input.field)}` },
        };
      }
      next = input.value === true;
    } else {
      next = input.backgroundRunEnabled === true;
    }
    const scope = this.ctx.get('backgroundRunSettings' as never) as
      | { update(ns: string, patch: Record<string, unknown>): Promise<unknown> }
      | undefined;
    if (!scope) {
      return {
        ok: false,
        value: { backgroundRunEnabled: false },
        writable: false,
        error: { message: '后台运行设置通道未就绪。' },
      };
    }
    try {
      // settings.update(ns, patch)：走持久化写入队列，watch 回调会同步 enabled。
      await scope.update(BACKGROUND_RUN_SETTINGS_NAMESPACE, { backgroundRunEnabled: next });
    } catch (error) {
      return {
        ok: false,
        value: { backgroundRunEnabled: next === false },
        writable: true,
        error: { message: String(error) },
      };
    }
    const service = this.ctx.get('backgroundRun' as never) as
      | { snapshot(): BackgroundRunSnapshot }
      | undefined;
    const enabled = service ? service.snapshot().enabled === true : next;
    return { ok: true, value: { backgroundRunEnabled: enabled }, writable: true };
  }
}

// —— myrules 同款 Remote 标记（plain-JS，无装饰器）——
// Remote(method)(fn, context)：context 只需 { kind:'method', name, private:false,
// static:false, addInitializer(fn) }；initializer 在构造时执行，把标记写入
// protocol 内部 markers 表。declaration order = wire order。
const remoteMarks: Array<{ proto: object; method: string; fn: (this: unknown) => void }> = [];
function markRemote(proto: object, method: string): void {
  const context = {
    kind: 'method',
    name: method,
    private: false,
    static: false,
    addInitializer(fn: (this: unknown) => void) {
      remoteMarks.push({ proto, method, fn });
    },
  };
  (Remote as (method: string) => (fn: unknown, ctx: unknown) => void)(method)(
    (proto as Record<string, unknown>)[method],
    context,
  );
}

function runRemoteMarks(instance: unknown): void {
  const proto = Object.getPrototypeOf(instance);
  for (const mark of remoteMarks) {
    if (mark.proto === proto) mark.fn.call(instance);
  }
}

for (const method of ['status', 'getSettings', 'updateSettings']) {
  markRemote(BackgroundRunStatusController.prototype, method);
}

export default BackgroundRunStatusController;
