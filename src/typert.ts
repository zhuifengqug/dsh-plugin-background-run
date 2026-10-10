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
 * - getSettings：读开关真实值（浏览器 settingsScope 看不见外部命名空间时的兜底）；
 * - updateSettings：写开关（走宿主 scope.update()，与 watch 同一数据源）。
 */
import { z } from 'zod';

const emptyInput = z.object({
  // TEMP-DIAG: 允许客户端捎带诊断串（status 是只读方法，字段仅用于日志回传）
  __diag: z.string().max(4000).optional(),
}).strict();

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
