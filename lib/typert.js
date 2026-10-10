import { z } from 'zod';
const emptyInput = z.object({}).strict();
const statusSchema = z.object({
    state: z.enum([
        'disabled',
        'enabled-idle',
        'active',
        'network-interrupted',
        'error'
    ]),
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
    settingsBound: z.boolean()
}).strict();
const settingsValueSchema = z.object({
    backgroundRunEnabled: z.boolean()
}).strict();
const settingsResultSchema = z.object({
    ok: z.boolean(),
    value: settingsValueSchema,
    writable: z.boolean()
}).strict();
const updateResultSchema = z.object({
    ok: z.boolean(),
    value: settingsValueSchema,
    writable: z.boolean(),
    error: z.object({
        message: z.string()
    }).optional()
}).strict();
const updateInputSchema = z.object({
    field: z.string().optional(),
    value: z.boolean().optional(),
    backgroundRunEnabled: z.boolean().optional()
}).strict();
function memoizeSchema(build) {
    let cached;
    return ()=>cached ??= build();
}
function invocation(id, method, parameterSchema, resultSchema) {
    return {
        id: `@gjs27/dsh-plugin-background-run#backgroundRunStatus/${method}`,
        service: 'backgroundRunStatus',
        namespace: 'backgroundRunStatus',
        method,
        invocation: {
            kind: 'direct'
        },
        parameters: [
            {
                name: 'input',
                wire: 'input',
                source: 'json',
                codec: {
                    mode: 'strict',
                    typeSymbol: `@gjs27/dsh-plugin-background-run/types#${id}`,
                    create: parameterSchema
                }
            }
        ],
        result: {
            mode: 'strict',
            typeSymbol: `@gjs27/dsh-plugin-background-run/types#BackgroundRun${method[0]?.toUpperCase()}${method.slice(1)}Result`,
            create: resultSchema
        }
    };
}
export const TYPERT = {
    package: '@gjs27/dsh-plugin-background-run',
    face: 'host',
    schemas: [],
    invocations: [
        invocation('EmptyInput', 'status', memoizeSchema(()=>emptyInput), memoizeSchema(()=>statusSchema)),
        invocation('EmptyInput', 'getSettings', memoizeSchema(()=>emptyInput), memoizeSchema(()=>settingsResultSchema)),
        invocation('UpdateInput', 'updateSettings', memoizeSchema(()=>updateInputSchema), memoizeSchema(()=>updateResultSchema))
    ],
    model: {
        services: [],
        events: [],
        objects: []
    }
};
export default TYPERT;
