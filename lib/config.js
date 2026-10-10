import z from '@deepseek-ai/schemastery';
export const BACKGROUND_RUN_SETTINGS_NAMESPACE = 'background-run';
export const BackgroundRunSettingsSchema = z.object({
    backgroundRunEnabled: z.boolean().default(false)
});
export const DEFAULT_BACKGROUND_RUN_SETTINGS = {
    backgroundRunEnabled: false
};
export function normalizeSettings(raw) {
    if (typeof raw !== 'object' || raw === null) return {
        ...DEFAULT_BACKGROUND_RUN_SETTINGS
    };
    const record = raw;
    return {
        backgroundRunEnabled: record['backgroundRunEnabled'] === true
    };
}
