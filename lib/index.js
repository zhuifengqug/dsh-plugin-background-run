import { createPowerHandle } from './power.js';
import { TaskRefCounter, deriveState } from './state.js';
import { BACKGROUND_RUN_SETTINGS_NAMESPACE, DEFAULT_BACKGROUND_RUN_SETTINGS, normalizeSettings } from './config.js';
import { NetworkMonitor } from './network.js';
import { BackgroundRunStatusController } from './status-controller.js';
export const name = 'background-run';
export { Config } from './config.js';
export const inject = [
    'settings',
    'configEditor'
];
export function isActiveJobStatus(status) {
    return status === 'running' || status === 'stopping';
}
export const SETTINGS_SYNC_MS = 5_000;
export const SETTINGS_ENTRY_REBIND_MS = 30_000;
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
    let currentSource = ()=>({
            ...DEFAULT_BACKGROUND_RUN_SETTINGS
        });
    let settingsEntry = findOwnConfigEntry();
    let settingsBound = false;
    function findOwnConfigEntry() {
        try {
            const editor = ctx.get('configEditor');
            const rows = editor?.entries?.();
            if (Array.isArray(rows)) {
                const own = rows.find((row)=>row?.options?.id === BACKGROUND_RUN_SETTINGS_NAMESPACE);
                if (own !== undefined) return own;
            }
        } catch  {}
        try {
            const loader = ctx.get('loader');
            for (const row of loader?.entries?.() ?? []){
                if (row?.options?.id === BACKGROUND_RUN_SETTINGS_NAMESPACE) return row;
            }
        } catch  {}
        return undefined;
    }
    function bindConfigFromEntry() {
        const entry = settingsEntry;
        if (entry === undefined) {
            settingsBound = false;
            return;
        }
        currentSource = ()=>normalizeSettings(entry.options?.config ?? {});
        settingsBound = true;
    }
    bindConfigFromEntry();
    try {
        const rebindTimer = setInterval(()=>{
            const next = findOwnConfigEntry();
            if (next !== undefined && next !== settingsEntry) {
                settingsEntry = next;
                bindConfigFromEntry();
            }
        }, SETTINGS_ENTRY_REBIND_MS);
        rebindTimer.unref?.();
        ctx.effect(()=>()=>clearInterval(rebindTimer), 'background-run: settings entry watcher');
    } catch  {}
    const stopSettings = registerSettingsSection(ctx);
    ctx.effect(()=>stopSettings ?? (()=>undefined), 'background-run: settings surface');
    return onSettingsReady(ctx, ()=>currentSource(), ()=>settingsBound);
}
function registerSettingsSection(ctx) {
    try {
        const settings = ctx.settings;
        if (settings === undefined || typeof settings.configure !== 'function') {
            warn(ctx, 'ctx.settings.configure 不可用；设置页降级为 Loader 条目配置。');
            return undefined;
        }
        return settings.configure({
            auto: true
        }, ctx.fiber) ?? undefined;
    } catch (error) {
        warn(ctx, `设置页注册失败（${String(error)}）；降级为 Loader 条目配置。`);
        return undefined;
    }
}
function warn(ctx, message) {
    try {
        ctx.logger.warn(`background-run: ${message}`);
    } catch  {}
}
async function onSettingsReady(ctx, readConfig, isBound) {
    const warnHere = (message)=>warn(ctx, message);
    const log = (message)=>{
        try {
            ctx.logger.info(`background-run: ${message}`);
        } catch  {}
    };
    let enabled = false;
    try {
        enabled = readConfig().backgroundRunEnabled === true;
    } catch (error) {
        warnHere(`读取配置失败，使用安全默认值 false：${String(error)}`);
    }
    let lastError;
    let backendNote;
    const { handle: power, loadError } = createPowerHandle((message)=>{
        lastError = message;
        warnHere(message);
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
    let agentStatusEvents = 0;
    let jobEvents = 0;
    const monitor = new NetworkMonitor((online)=>{
        networkOnline = online;
        publishSnapshot();
    }, (message)=>warnHere(message));
    const service = {
        snapshot: ()=>{
            syncEnabled();
            if (enabled) reconcileJobs();
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
                agentStatusEvents,
                jobEvents,
                settingsBound: isBound(),
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
    ctx.provide('backgroundRunSettings', {
        update: async (ns, patch)=>{
            const settings = ctx.settings;
            if (settings === undefined || typeof settings.update !== 'function') {
                throw new Error('宿主 settings.update 不可用（设置服务未就绪或宿主版本过旧）');
            }
            return settings.update(ns, patch);
        }
    });
    function syncEnabled() {
        let next = enabled;
        try {
            next = readConfig().backgroundRunEnabled === true;
        } catch  {
            return;
        }
        if (next === enabled) return;
        const wasEnabled = enabled;
        enabled = next;
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
    }
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
            for (const job of jobs){
                if (job === null || typeof job !== 'object') continue;
                live.set(String(job.id), job);
            }
            for (const [id, job] of live){
                if (isActiveJobStatus(job.status) && !runningJobs.has(id)) {
                    runningJobs.add(id);
                    counter.taskStarted();
                }
            }
            for (const id of [
                ...runningJobs
            ]){
                const job = live.get(id);
                if (job === undefined || !isActiveJobStatus(job.status)) {
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
        agentStatusEvents += 1;
        syncEnabled();
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
    let stopJobs;
    let jobsEventChannel = 'none';
    try {
        const jobs = ctx.get('jobs');
        const onJobEvent = (event)=>{
            jobEvents += 1;
            syncEnabled();
            if (!enabled) return;
            const job = event?.job;
            if (job === undefined || job === null || job.id === undefined) {
                reconcileJobs();
                publishSnapshot();
                return;
            }
            const id = String(job.id);
            if (event.type === 'removed') {
                if (runningJobs.delete(id)) {
                    counter.taskEnded();
                    log(`后台任务移除（${id}），剩余 ${counter.activeTasks} 个活跃任务。`);
                }
            } else if (isActiveJobStatus(job.status)) {
                if (!runningJobs.has(id)) {
                    runningJobs.add(id);
                    counter.taskStarted();
                    log(`后台任务开始（${id}），电源保持${counter.powerHeld ? '已生效' : '申请失败'}。`);
                }
            } else if (runningJobs.delete(id)) {
                counter.taskEnded();
                log(`后台任务结束（${id}，${String(job.status)}），剩余 ${counter.activeTasks} 个活跃任务。`);
            }
            publishSnapshot();
        };
        if (jobs && jobs.events !== undefined && typeof jobs.events.subscribe === 'function') {
            const filter = {
                owners: 'all'
            };
            stopJobs = jobs.events.subscribe(filter, onJobEvent);
            jobsEventChannel = 'events';
        } else if (jobs && typeof jobs.subscribe === 'function') {
            stopJobs = jobs.subscribe(ctx, {
                owners: 'all'
            }, onJobEvent);
            jobsEventChannel = 'legacy';
        }
    } catch (error) {
        warnHere(`jobs 事件订阅失败，后台任务将退化为 list() 轮询对账：${String(error)}`);
    }
    let stopSync;
    try {
        const syncTimer = setInterval(()=>{
            try {
                syncEnabled();
                if (!enabled) return;
                const beforeTasks = counter.activeTasks;
                const beforeAgents = runningAgents.size;
                const beforeJobs = runningJobs.size;
                reconcileAgents();
                reconcileJobs();
                if (counter.activeTasks !== beforeTasks || runningAgents.size !== beforeAgents || runningJobs.size !== beforeJobs) {
                    publishSnapshot();
                }
            } catch  {}
        }, SETTINGS_SYNC_MS);
        syncTimer.unref?.();
        stopSync = ()=>clearInterval(syncTimer);
    } catch  {}
    let cleaned = false;
    function cleanup(reason) {
        if (cleaned) return;
        cleaned = true;
        try {
            stopAgentStatus();
        } catch  {}
        try {
            stopJobs?.();
        } catch  {}
        try {
            stopSync?.();
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
        warnHere(`未捕获异常，释放电源保持后继续抛出：${String(error)}`);
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
    log(`插件已加载（平台 ${process.platform}，电源后端 ${power.kind}，设置条目${isBound() ? '已绑定' : '未绑定（使用默认值 false）'}）。`);
    ctx.effect(()=>{
        return async ()=>{
            try {
                process.removeListener('exit', onProcessExit);
                process.removeListener('uncaughtException', onUncaught);
            } catch  {}
            cleanup('插件卸载');
        };
    }, 'background-run.lifecycle()');
    const controllerFiber = mountStatusController(ctx, warnHere);
    await controllerFiber.await();
}
function mountStatusController(ctx, warnHere) {
    try {
        return ctx.plugin(BackgroundRunStatusController);
    } catch (error) {
        warnHere(`状态查询通道挂载失败，设置页将无实时状态：${String(error)}`);
        return {
            await: async ()=>undefined
        };
    }
}
