import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { BACKGROUND_RUN_SETTINGS_NAMESPACE } from './config.js';
export class BackgroundRunStatusController extends TypertRemoteService {
    constructor(ctx){
        super(ctx, 'backgroundRunStatus', {
            namespace: 'backgroundRunStatus'
        });
        runRemoteMarks(this);
    }
    async status(_input = {}) {
        try {
            const diag = _input?.__diag;
            if (typeof diag === 'string' && diag.length > 0 && diag.length < 4000) {
                const { appendFileSync } = await import('node:fs');
                appendFileSync('D:/DSHData/home/background-run-diag.log', `${new Date().toISOString()} ${diag}\n`);
            }
        } catch  {}
        void _input;
        const service = this.ctx.get('backgroundRun');
        if (!service) {
            return {
                state: 'disabled',
                enabled: false,
                powerHeld: false,
                activeTasks: 0,
                runningAgents: 0,
                runningJobs: 0,
                networkOnline: true,
                lastError: '后台运行服务未加载。'
            };
        }
        return service.snapshot();
    }
    async getSettings(_input = {}) {
        void _input;
        const service = this.ctx.get('backgroundRun');
        const enabled = service ? service.snapshot().enabled === true : false;
        return {
            ok: true,
            value: {
                backgroundRunEnabled: enabled
            },
            writable: true
        };
    }
    async updateSettings(_input = {}) {
        const input = _input ?? {};
        let next;
        if (input.field !== undefined) {
            if (input.field !== 'backgroundRunEnabled') {
                return {
                    ok: false,
                    value: {
                        backgroundRunEnabled: false
                    },
                    writable: true,
                    error: {
                        message: `未知字段：${String(input.field)}`
                    }
                };
            }
            next = input.value === true;
        } else {
            next = input.backgroundRunEnabled === true;
        }
        const scope = this.ctx.get('backgroundRunSettings');
        if (!scope) {
            return {
                ok: false,
                value: {
                    backgroundRunEnabled: false
                },
                writable: false,
                error: {
                    message: '后台运行设置通道未就绪。'
                }
            };
        }
        try {
            await scope.update(BACKGROUND_RUN_SETTINGS_NAMESPACE, {
                backgroundRunEnabled: next
            });
        } catch (error) {
            return {
                ok: false,
                value: {
                    backgroundRunEnabled: next === false
                },
                writable: true,
                error: {
                    message: String(error)
                }
            };
        }
        const service = this.ctx.get('backgroundRun');
        const enabled = service ? service.snapshot().enabled === true : next;
        return {
            ok: true,
            value: {
                backgroundRunEnabled: enabled
            },
            writable: true
        };
    }
}
const remoteMarks = [];
function markRemote(proto, method) {
    const context = {
        kind: 'method',
        name: method,
        private: false,
        static: false,
        addInitializer (fn) {
            remoteMarks.push({
                proto,
                method,
                fn
            });
        }
    };
    Remote(method)(proto[method], context);
}
function runRemoteMarks(instance) {
    const proto = Object.getPrototypeOf(instance);
    for (const mark of remoteMarks){
        if (mark.proto === proto) mark.fn.call(instance);
    }
}
for (const method of [
    'status',
    'getSettings',
    'updateSettings'
]){
    markRemote(BackgroundRunStatusController.prototype, method);
}
export default BackgroundRunStatusController;
