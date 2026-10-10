/**
 * 设置命名空间与 schema（需求 §四、§十）。
 *
 * - 命名空间：background-run（小写连字符，符合 DSH 规范）；
 * - backgroundRunEnabled：总开关，默认 false；
 * - 类型严格 boolean，旧配置缺字段按 false 处理（schema default）；
 * - 无凭据字段：状态文件与日志永不写入 API Key / Token。
 */
import z from '@deepseek-ai/schemastery';

export const BACKGROUND_RUN_SETTINGS_NAMESPACE = 'background-run';

export interface BackgroundRunSettings {
  /** 允许 DSH 后台运行：任务期间阻止系统睡眠，允许显示器关闭。 */
  backgroundRunEnabled: boolean;
}

export const BackgroundRunSettingsSchema: z<BackgroundRunSettings> = z.object({
  backgroundRunEnabled: z.boolean().default(false),
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
