/**
 * 浏览器侧开关读写 + 状态读取通道（Typert Remote）。
 *
 * 开关写入的**主通道**是客户端的 `ctx.configForms.get('background-run')`
 * （DSH 0.1.7-rc.2 起 `settingsScope` 更名为 `configForms`，见 client/client.js）；
 * 本控制器额外暴露 getSettings / updateSettings 两个薄方法（at-file 同款 Remote
 * 直连模式），作为设置页面的**兜底**通道：读宿主侧真实值，写宿主侧
 * `settings.update(ns, patch)`（0.2.0-rc.2 的 SettingsForms 命名空间级写入，
 * 落盘到 profile 的 cordis.patch.yml 里该 entry 的 config）。
 * status() 仍是只读快照，供页面展示电源保持 / 当前任务 / 网络状态。
 *
 * Remote 注册用 myrules 同款 markRemote() 写法：plain-JS，无装饰器，
 * 与当前 @deepseek-ai/dsh-typert-protocol 的 markers 表直接兼容。
 *
 * 0.2.0 适配：删除原 TEMP-DIAG 分支（它把客户端字符串无条件追加写进
 * `D:/DSHData/home/background-run-diag.log`，属写宿主目录的硬编码路径，需求 §4 B11）。
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
        agentStatusEvents: 0,
        jobEvents: 0,
        settingsBound: false,
        lastError: '后台运行服务未加载。',
      };
    }
    return service.snapshot();
  }

  /** 读宿主侧开关真实值（客户端 configForms 不可用时的兜底）。 */
  async getSettings(_input: Record<string, unknown> = {}): Promise<BackgroundRunSettingsResult> {
    void _input;
    const service = this.ctx.get('backgroundRun' as never) as
      | { snapshot(): BackgroundRunSnapshot }
      | undefined;
    const enabled = service ? service.snapshot().enabled === true : false;
    return { ok: true, value: { backgroundRunEnabled: enabled }, writable: true };
  }

  /** 写宿主侧开关（走宿主 settings.update(ns, patch)，与设置页 configForms 同一落盘位置）。 */
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
      // settings.update(ns, patch)：走宿主持久化写入队列（profile 的 cordis.patch.yml
      // 里该 entry 的 config），插件侧下一次 syncEnabled 对账即读到新值。
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
