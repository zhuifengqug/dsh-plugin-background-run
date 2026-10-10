/**
 * 设置命名空间与 Config schema（需求 §四、§十）。
 *
 * - 命名空间：background-run（小写连字符，符合 DSH 规范）；
 * - backgroundRunEnabled：总开关，默认 false；
 * - 类型严格 boolean，旧配置缺字段按 false 处理（schema default）；
 * - 无凭据字段：状态文件与日志永不写入 API Key / Token。
 *
 * ## 0.2.0 适配：从 `settings.register(ns, schema)` 改为“导出 Config”
 *
 * DSH 0.1.7 起 `ctx.settings.register()` 已被删除（宿主 dsh-settings 只剩
 * describe/update/replace/mutate/write/configure/invalidate/writable 等）。
 * 设置面的权威形态改为：**插件入口模块导出 Cordis `Config`** + Loader 条目上的
 * `config` 字段 + `ctx.settings.configure({ auto: true }, ctx.fiber)` 注册页面策略。
 *
 * 宿主 dsh-settings 的 `schema(entry)` 读的是 `entry.fiber.runtime.Config`，
 * 也就是**本包主入口模块的导出对象**；因此 `src/index.ts` 必须把本模块的
 * `Config` 再导出一遍，否则宿主拿到 undefined → `describe()` 跳过整个条目 →
 * 设置页没有入口、命名空间不被服务。这个坑在姊妹插件 dsh-value-router 上栽过两次。
 *
 * ## `.volatile()` 的两条硬规则（同为姊妹插件的实测教训，别再犯）
 *
 * 1. **普通 `.default()` 字段会被宿主丢掉**：`volatileForm()` 只保留标记 volatile
 *    的字段，`Object.keys(dict).length === 0` 时整个条目被 `describe()` 跳过。
 * 2. **volatile 只能落在固定对象路径、且不能被外层 volatile 包住**。本插件只有
 *    一个顶层布尔字段，直接标在顶层即可。
 *
 * 另外：不要写 `z<BackgroundRunSettings>` 类型标注。volatile 字段的输出类型是
 * `Volatile<T>`，与手写的普通类型冲突（tsc TS2322）；宿主侧消费方按普通结构读即可。
 */
import z from '@deepseek-ai/schemastery';

export const BACKGROUND_RUN_SETTINGS_NAMESPACE = 'background-run';

export interface BackgroundRunSettings {
  /** 允许 DSH 后台运行：任务期间阻止系统睡眠，允许显示器关闭。 */
  backgroundRunEnabled: boolean;
}

/**
 * 插件 Config（Loader 条目 `config` 的 schema）。
 *
 * 顶层唯一字段标 `.volatile()`：宿主据此判断该条目是否有可在线编辑的字段，
 * 也据此放行 `mutate([{ op:'set', path:['backgroundRunEnabled'], … }])`。
 */
export const Config = z.object({
  backgroundRunEnabled: z.boolean().default(false).volatile(),
});

/** 配置损坏/缺失时的安全默认值。 */
export const DEFAULT_BACKGROUND_RUN_SETTINGS: BackgroundRunSettings = {
  backgroundRunEnabled: false,
};

/** 兼容性归一化：旧配置缺字段、类型错误一律按 false 处理。 */
export function normalizeSettings(raw: unknown): BackgroundRunSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_BACKGROUND_RUN_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    backgroundRunEnabled: record['backgroundRunEnabled'] === true,
  };
}
