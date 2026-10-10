/**
 * Typert host descriptor for the backgroundRunStatus Remote namespace.
 *
 * DSH's api-gateway can dispatch a Remote service only after its descriptor is
 * registered by dsh-typert-loader. This strict artifact is the supported
 * external-plugin path, matching the installed dsh-myrules plugin.
 *
 * 方法（declaration order = wire order，需与 status-controller.ts 的
 * markRemote 顺序一致）：
 * - status：只读快照（电源保持 / 当前任务 / 网络状态）；
 * - getSettings：读开关真实值（客户端 configForms 不可用时的兜底）；
 * - updateSettings：写开关（走宿主 settings.update(ns, patch)，与 configForms 同一落盘位置）。
 *
 * 0.2.0 适配：删除 `__diag` 输入字段（配套的 TEMP-DIAG 回传链路已按需求 §4 B11 移除）；
 * status 快照新增三个只读打点字段（agentStatusEvents / jobEvents / settingsBound），
 * 供目标宿主验证 agent/status 的 scope 投递、jobs 订阅与本插件的条目绑定状态。
 * 三个方法名与顺序未变，因此 status-controller.ts 的 markRemote 列表与客户端的
 * REMOTE_CONTRIBUTION 仍逐字对齐。
 */
import { z } from 'zod';

const emptyInput = z.object({}).strict();

const statusSchema = z.object({
  state: z.enum(['disabled', 'enabled-idle', 'active', 'network-interrupted', 'error']),
  enabled: z.boolean(),
  powerHeld: z.boolean(),
  activeTasks: z.number().int().nonnegative(),
  runningAgents: z.number().int().nonnegative(),
  runningJobs: z.number().int().nonnegative(),
  networkOnline: z.boolean(),
  lastError: z.string().optional(),
  backendNote: z.string().optional(),
  agentStatusEvents: z.number().int().nonnegative(),
  jobEvents: z.number().int().nonnegative(),
  settingsBound: z.boolean(),
}).strict();

const settingsValueSchema = z.object({
  backgroundRunEnabled: z.boolean(),
}).strict();

const settingsResultSchema = z.object({
  ok: z.boolean(),
  value: settingsValueSchema,
  writable: z.boolean(),
}).strict();

const updateResultSchema = z.object({
  ok: z.boolean(),
  value: settingsValueSchema,
  writable: z.boolean(),
  error: z.object({ message: z.string() }).optional(),
}).strict();

const updateInputSchema = z.object({
  field: z.string().optional(),
  value: z.boolean().optional(),
  backgroundRunEnabled: z.boolean().optional(),
}).strict();

/**
 * Materialize a strict-codec schema lazily, once per codec.
 *
 * rc.7+ requires every strict codec to expose `create()`; the loader calls it
 * at validation time and the registry caches the returned schema. Building the
 * zod object eagerly at module scope would also make the schema instances be
 * shared across the process boundary in a way the generated descriptors do not,
 * so mirror the generated shape: hand back a factory that builds on first use.
 */
function memoizeSchema(build: () => z.ZodTypeAny) {
  let cached: z.ZodTypeAny | undefined;
  return () => (cached ??= build());
}

function invocation(id: string, method: string, parameterSchema: () => z.ZodTypeAny, resultSchema: () => z.ZodTypeAny) {
  return {
    id: `@gjs27/dsh-plugin-background-run#backgroundRunStatus/${method}`,
    service: 'backgroundRunStatus',
    namespace: 'backgroundRunStatus',
    method,
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'input',
      wire: 'input',
      source: 'json',
      codec: {
        mode: 'strict',
        typeSymbol: `@gjs27/dsh-plugin-background-run/types#${id}`,
        create: parameterSchema,
      },
    }],
    result: {
      mode: 'strict',
      typeSymbol: `@gjs27/dsh-plugin-background-run/types#BackgroundRun${method[0]?.toUpperCase()}${method.slice(1)}Result`,
      create: resultSchema,
    },
  };
}

export const TYPERT = {
  package: '@gjs27/dsh-plugin-background-run',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('EmptyInput', 'status', memoizeSchema(() => emptyInput), memoizeSchema(() => statusSchema)),
    invocation('EmptyInput', 'getSettings', memoizeSchema(() => emptyInput), memoizeSchema(() => settingsResultSchema)),
    invocation('UpdateInput', 'updateSettings', memoizeSchema(() => updateInputSchema), memoizeSchema(() => updateResultSchema)),
  ],
  model: { services: [], events: [], objects: [] },
};

export default TYPERT;
