import { createPowerHandle } from './power.js';
import { TaskRefCounter, deriveState } from './state.js';
import { BACKGROUND_RUN_SETTINGS_NAMESPACE, BackgroundRunSettingsSchema, normalizeSettings } from './config.js';
import { NetworkMonitor } from './network.js';
import { BackgroundRunStatusController } from './status-controller.js';
export const name = 'background-run';
export const inject = [
    'settings'
];
function trackRunningAgents(counter, running) {
    return {
        onRunning: (id)=>{
            if (running.has(id)) return;
            running.add(id);
            counter.taskStarted();
        },
        onIdle: (id)=>{
            if (!running.delete(id)) return;
            counter.taskEnded();
        }
    };
}
export function apply(ctx) {
    try {
        const scope = ctx.settings.register(BACKGROUND_RUN_SETTINGS_NAMESPACE, BackgroundRunSettingsSchema);
        return onSettingsScope(ctx, scope);
    } catch (error) {
        ctx.logger.warn(`background-run: settings 命名空间注册失败，开关将不可用：${String(error)}`);
    }
}
async function onSettingsScope(ctx, scope) {
    const readEnabled = ()=>{
        try {
            return normalizeSettings(scope.get()).backgroundRunEnabled;
        } catch (error) {
            ctx.logger.warn(`background-run: 读取配置失败，使用安全默认值 false：${String(error)}`);
            return false;
        }
    };
    let enabled = readEnabled();
    let lastError;
    let backendNote;
    const { handle: power, loadError } = createPowerHandle((message)=>{
        lastError = message;
        try {
            ctx.logger.warn(`background-run: ${message}`);
        } catch  {}
    });
    if (loadError) backendNote = loadError;
    const counter = new TaskRefCounter({
        acquirePower: ()=>{
            if (!enabled) return false;
            const result = power.acquire();
            if (!result.ok) {
                lastError = result.error;
                return false;
            }
            lastError = undefined;
            return true;
        },
        releasePower: ()=>{
            const result = power.release();
            if (!result.ok) lastError = result.error;
        }
    });
    const runningAgents = new Set();
    const agentTracker = trackRunningAgents(counter, runningAgents);
    const runningJobs = new Set();
    let networkOnline = true;
    const monitor = new NetworkMonitor((online)=>{
        networkOnline = online;
        publishSnapshot();
    }, (message)=>{
        try {
            ctx.logger.warn(`background-run: ${message}`);
        } catch  {}
    });
    const service = {
        snapshot: ()=>{
            const state = deriveState({
                enabled,
                powerHeld: counter.powerHeld,
                activeTasks: counter.activeTasks,
                networkOnline,
                hasError: lastError !== undefined
            });
            return {
                state,
                enabled,
                powerHeld: counter.powerHeld,
                activeTasks: counter.activeTasks,
                runningAgents: runningAgents.size,
                runningJobs: runningJobs.size,
                networkOnline,
                ...lastError !== undefined ? {
                    lastError
                } : {},
                ...backendNote !== undefined ? {
                    backendNote
                } : {}
            };
        }
    };
    ctx.provide('backgroundRun', service);
    ctx.provide('backgroundRunSettings', ctx.settings);
    let controllerFiber;
    try {
        controllerFiber = ctx.plugin(BackgroundRunStatusController);
    } catch (error) {
        ctx.logger.warn(`background-run: 状态查询通道挂载失败，设置页将无实时状态：${String(error)}`);
        controllerFiber = {
            await: async ()=>undefined
        };
    }
    const log = (message)=>{
        try {
            ctx.logger.info(`background-run: ${message}`);
        } catch  {}
    };
    const stopWatch = scope.watch((next)=>{
        const wasEnabled = enabled;
        enabled = normalizeSettings(next).backgroundRunEnabled;
        if (wasEnabled && !enabled) {
            counter.reset();
            runningAgents.clear();
            runningJobs.clear();
            log('开关已关闭，释放全部电源保持请求。');
        } else if (!wasEnabled && enabled) {
            lastError = undefined;
            log('开关已开启。');
            reconcileAgents();
            reconcileJobs();
        }
        publishSnapshot();
    });
    function reconcileAgents() {
        try {
            const agents = ctx.get('agents')?.list?.();
            if (!Array.isArray(agents)) return;
            const seen = new Set();
            for (const agent of agents){
                let id;
                try {
                    id = String(agent.id);
                } catch  {
                    continue;
                }
                seen.add(id);
                let status;
                try {
                    status = agent.status;
                } catch  {
                    continue;
                }
                if (status === 'running') agentTracker.onRunning(id);
            }
            for (const id of [
                ...runningAgents
            ]){
                if (!seen.has(id)) agentTracker.onIdle(id);
            }
        } catch  {}
    }
    function reconcileJobs() {
        try {
            const jobs = ctx.get('jobs')?.list?.();
            if (!Array.isArray(jobs)) return;
            const live = new Map();
            for (const job of jobs)live.set(String(job.id), job);
            for (const [id, job] of live){
                if ((job.status === 'running' || job.status === 'stopping') && !runningJobs.has(id)) {
                    runningJobs.add(id);
                    counter.taskStarted();
                }
            }
            for (const id of [
                ...runningJobs
            ]){
                const job = live.get(id);
                if (!job || job.status !== 'running' && job.status !== 'stopping') {
                    runningJobs.delete(id);
                    counter.taskEnded();
                }
            }
        } catch  {}
    }
    function publishSnapshot() {
        try {
            ctx.emit('background-run/status', service.snapshot());
        } catch  {}
    }
    const stopAgentStatus = ctx.on('agent/status', (payload)=>{
        if (!enabled) return;
        let id;
        try {
            id = String(payload.agent.id);
        } catch  {
            return;
        }
        if (payload.status === 'running') {
            const before = counter.activeTasks;
            agentTracker.onRunning(id);
            if (counter.activeTasks !== before) log(`任务开始（agent ${id}），电源保持${counter.powerHeld ? '已生效' : '申请失败'}。`);
        } else {
            const before = counter.activeTasks;
            agentTracker.onIdle(id);
            if (counter.activeTasks !== before) log(`任务结束（agent ${id}），剩余 ${counter.activeTasks} 个活跃任务。`);
        }
        publishSnapshot();
    });
    let stopJobsChanged;
    let stopJobDone;
    try {
        const jobs = ctx.get('jobs');
        if (jobs) {
            stopJobsChanged = jobs.onJobsChanged(()=>{
                if (!enabled) return;
                reconcileJobs();
                publishSnapshot();
            });
            stopJobDone = jobs.onJobDone((snapshot)=>{
                const id = String(snapshot.id);
                if (runningJobs.delete(id)) {
                    counter.taskEnded();
                    log(`后台任务结束（${id}，${snapshot.status}），剩余 ${counter.activeTasks} 个活跃任务。`);
                    publishSnapshot();
                }
            });
        }
    } catch (error) {
        ctx.logger.warn(`background-run: jobs 服务订阅失败，后台任务将无法单独计数：${String(error)}`);
    }
    let cleaned = false;
    function cleanup(reason) {
        if (cleaned) return;
        cleaned = true;
        try {
            stopAgentStatus();
        } catch  {}
        try {
            stopJobsChanged?.();
        } catch  {}
        try {
            stopJobDone?.();
        } catch  {}
        try {
            stopWatch?.();
        } catch  {}
        monitor.stop();
        counter.reset();
        runningAgents.clear();
        runningJobs.clear();
        log(`已清理（${reason}）：电源保持已释放，监测器已停止。`);
    }
    const onProcessExit = ()=>{
        cleanup('进程退出');
    };
    const onUncaught = (error)=>{
        try {
            ctx.logger.warn(`background-run: 未捕获异常，释放电源保持后继续抛出：${String(error)}`);
        } catch  {}
        cleanup('未捕获异常');
    };
    try {
        process.once('exit', onProcessExit);
        process.once('uncaughtException', onUncaught);
    } catch  {}
    monitor.start();
    if (enabled) {
        reconcileAgents();
        reconcileJobs();
    }
    log(`插件已加载（平台 ${process.platform}，电源后端 ${power.kind}）。`);
    ctx.effect(()=>{
        return async ()=>{
            try {
                process.removeListener('exit', onProcessExit);
                process.removeListener('uncaughtException', onUncaught);
            } catch  {}
            cleanup('插件卸载');
        };
    }, 'background-run.lifecycle()');
    await controllerFiber.await();
}
