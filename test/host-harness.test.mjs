/* 宿主 harness 集成测试（DSH 0.2.0-rc.2 契约）：在真实 @deepseek-ai/cordis Context
 * 上加载 lib/index.js，用最小官方兼容 stub 提供 settings / configEditor / jobs /
 * agents / logger，验证：
 * 绑定 Loader 条目 config → 提供 backgroundRun 快照服务 → 开关开启后 agent/status
 * 驱动计数与电源保持 → jobs 订阅（registered/settled/removed）计数 → 开关关闭释放。
 *
 * 0.2.0 关键差异（相对旧版 harness，本文件同时是「stub 形状 = 目标宿主契约」的回归）：
 * - 不再有 `settings.register(ns, schema)`：改为 configEditor 里 id 为 background-run
 *   的条目 + `settings.configure()`；
 * - 不再有 `jobs.onJobsChanged / onJobDone`：改为 `jobs.subscribe(ctx, filter, listener)`；
 * - 设置值来自 Loader 条目的 `options.config`（不是 settings.yaml）。
 *
 * 运行：`pnpm test:host`（需先在本插件目录 `pnpm install`，使 @deepseek-ai/* 可解析）。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const { Context } = await import('@deepseek-ai/cordis');
const plugin = await import('@gjs27/dsh-plugin-background-run');

const NS = 'background-run';

/** 最小 configEditor stub：一个 id = background-run 的 Loader 条目。 */
function makeConfigEditor(config) {
  const entry = { options: { id: NS, config } };
  return { entry, entries: () => [entry] };
}

/** 最小 settings stub（0.2.0-rc.2 SettingsForms 子集：configure / describe / update）。 */
function makeSettings() {
  const presentations = [];
  const writes = [];
  return {
    writes,
    presentations,
    configure(presentation, owner) {
      if (presentations.length > 0) {
        throw new Error('Settings presentation is already configured for this plugin instance');
      }
      presentations.push({ presentation, owner });
      return () => { presentations.length = 0; };
    },
    describe: () => [{ ns: NS, revision: 0 }],
    async update(ns, patch) { writes.push({ ns, patch }); },
  };
}

/**
 * 最小 jobs stub —— 严格镜像目标 dsh-jobs-local@0.2.0-rc.2 的两条事实：
 * ① 事件入口是 `events.subscribe(filter, listener)`（hub 内部绑定注册上下文，
 *    **没有** `jobs.subscribe(ctx, ...)`）；
 * ② 事件是「通知」，`list()` 是「注册表现状」——两者必须自洽：注册入表、终态更新记录、
 *    removed 删表。若 stub 只投事件不更新 list()，就会与真实宿主语义不符。
 */
function makeJobs() {
  const listeners = new Set();
  const store = new Map();
  const isTerminal = (status) => status === 'completed' || status === 'killed' || status === 'failed';
  return {
    list: () => [...store.values()].map((job) => ({ ...job })),
    events: {
      subscribe(filter, listener) {
        const sub = { filter: filter || {}, listener };
        listeners.add(sub);
        return () => { listeners.delete(sub); };
      },
    },
    _emit(type, job) {
      const id = String(job.id);
      // 先推进「注册表现状」（与真实 registry 的 store 变更同步），再投事件。
      if (type === 'removed') store.delete(id);
      else store.set(id, { ...job });
      for (const sub of [...listeners]) sub.listener({ type, job: { ...job } });
    },
    _set(next) {
      store.clear();
      for (const job of next) store.set(String(job.id), { ...job });
    },
    _listenerCount: () => listeners.size,
    _isTerminal: isTerminal,
  };
}

/** 旧形状 stub（只有 `subscribe(ctx, filter, listener)`）——用于兼容分支回归。 */
function makeLegacyJobs() {
  const listeners = new Set();
  const store = new Map();
  return {
    list: () => [...store.values()].map((job) => ({ ...job })),
    subscribe(_ctx, _filter, listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    _emit(type, job) {
      const id = String(job.id);
      if (type === 'removed') store.delete(id);
      else store.set(id, { ...job });
      for (const listener of [...listeners]) listener({ type, job: { ...job } });
    },
    _set(next) {
      store.clear();
      for (const job of next) store.set(String(job.id), { ...job });
    },
    _listenerCount: () => listeners.size,
  };
}

async function makeHost({ config = { backgroundRunEnabled: false }, withSubscribe = true } = {}) {
  const ctx = new Context();
  const settings = makeSettings();
  const editor = makeConfigEditor(config);
  const jobs = makeJobs();
  ctx.provide('settings', settings);
  ctx.provide('configEditor', editor);
  ctx.provide('agents', { list: () => [] });
  ctx.provide('jobs', withSubscribe ? jobs : { list: jobs.list });
  await ctx.plugin(plugin.apply);
  return { ctx, settings, editor, jobs };
}

describe('host harness：设置面（Loader/Config 触点，0.2.0-rc.2 契约）', () => {
  let host;
  before(async () => { host = await makeHost(); });

  it('绑定 id=background-run 的 Loader 条目并注册设置页策略', () => {
    const svc = host.ctx.get('backgroundRun');
    assert.ok(svc, 'backgroundRun 服务必须已提供');
    assert.equal(svc.snapshot().settingsBound, true, '必须绑定到 Loader 条目（否则设置页写入无效）');
    assert.equal(host.settings.presentations.length, 1, 'settings.configure 必须被调用一次');
    assert.equal(host.settings.presentations[0].presentation.auto, true);
  });

  it('导出 Config 且默认关闭（safe default）', () => {
    assert.ok(plugin.Config, '入口模块必须导出 Config');
    const snap = host.ctx.get('backgroundRun').snapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.state, 'disabled');
    assert.equal(snap.activeTasks, 0);
    assert.equal(snap.powerHeld, false);
  });

  it('开关关闭时 agent/status 不计数、不申请电源，但事件打点仍增长', () => {
    const svc = host.ctx.get('backgroundRun');
    const before = svc.snapshot().agentStatusEvents;
    host.ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'running' });
    const snap = svc.snapshot();
    assert.equal(snap.activeTasks, 0);
    assert.equal(snap.powerHeld, false);
    assert.equal(snap.agentStatusEvents, before + 1, '订阅必须仍然收到事件（B8 判据）');
  });

  it('开关打开后 running→idle 驱动计数与电源保持', () => {
    const svc = host.ctx.get('backgroundRun');
    host.editor.entry.options.config.backgroundRunEnabled = true;
    assert.equal(svc.snapshot().enabled, true, '条目 config 变更必须被 syncEnabled 观察到');

    host.ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'running' });
    const running = svc.snapshot();
    assert.equal(running.activeTasks, 1);
    assert.equal(running.powerHeld, true);
    assert.equal(running.state, 'active');

    host.ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'idle' });
    const idle = svc.snapshot();
    assert.equal(idle.activeTasks, 0);
    assert.equal(idle.powerHeld, false);
    assert.equal(idle.state, 'enabled-idle');
  });

  it('多 agent 并行：单个 idle 不提前清零', () => {
    const svc = host.ctx.get('backgroundRun');
    host.ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'running' });
    host.ctx.emit('agent/status', { agent: { id: 'a2' }, status: 'running' });
    host.ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'idle' });
    assert.equal(svc.snapshot().activeTasks, 1);
    host.ctx.emit('agent/status', { agent: { id: 'a2' }, status: 'idle' });
    assert.equal(svc.snapshot().activeTasks, 0);
  });

  it('开关关闭立即清零（释放全部保持）', () => {
    const svc = host.ctx.get('backgroundRun');
    host.ctx.emit('agent/status', { agent: { id: 'a9' }, status: 'running' });
    assert.equal(svc.snapshot().activeTasks, 1);
    host.editor.entry.options.config.backgroundRunEnabled = false;
    const snap = svc.snapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.state, 'disabled');
    assert.equal(snap.activeTasks, 0);
    assert.equal(snap.powerHeld, false);
  });

  it('updateSettings 兜底通道写入宿主 settings.update(ns, patch)', async () => {
    const writer = host.ctx.get('backgroundRunSettings');
    assert.ok(writer && typeof writer.update === 'function');
    await writer.update(NS, { backgroundRunEnabled: true });
    assert.equal(host.settings.writes.length, 1);
    assert.equal(host.settings.writes[0].ns, NS);
    assert.equal(host.settings.writes[0].patch.backgroundRunEnabled, true);
    host.editor.entry.options.config.backgroundRunEnabled = false;
  });
});

describe('host harness：jobs 订阅计数（任务触点，0.2.0-rc.2 subscribe 契约）', () => {
  let host;
  before(async () => { host = await makeHost({ config: { backgroundRunEnabled: true } }); });

  it('订阅已建立', () => {
    assert.equal(host.jobs._listenerCount(), 1, '必须建立一条 jobs 订阅');
  });

  it('registered(running) 计数 +1，settled(completed) 计数 −1', () => {
    const svc = host.ctx.get('backgroundRun');
    host.jobs._emit('registered', { id: 'job-1', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 1);
    assert.equal(svc.snapshot().activeTasks, 1);
    host.jobs._emit('settled', { id: 'job-1', status: 'completed' });
    assert.equal(svc.snapshot().runningJobs, 0);
    assert.equal(svc.snapshot().activeTasks, 0);
  });

  it('removed 也收口（防止「记录被移除但计数泄漏」）', () => {
    const svc = host.ctx.get('backgroundRun');
    host.jobs._emit('registered', { id: 'job-2', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 1);
    host.jobs._emit('removed', { id: 'job-2', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 0, 'removed 必须减计数');
    assert.equal(svc.snapshot().activeTasks, 0);
  });

  it('stopping 仍算活跃，killed 视为结束', () => {
    const svc = host.ctx.get('backgroundRun');
    host.jobs._emit('stopping', { id: 'job-3', status: 'stopping' });
    assert.equal(svc.snapshot().runningJobs, 1);
    host.jobs._emit('settled', { id: 'job-3', status: 'killed' });
    assert.equal(svc.snapshot().runningJobs, 0);
  });

  it('jobEvents 打点增长（订阅确实接通）', () => {
    assert.ok(host.ctx.get('backgroundRun').snapshot().jobEvents >= 5);
  });
});

describe('host harness：无 subscribe 时退化为 list() 对账', () => {
  it('开启瞬间以 list() 种子补计数（订阅缺失也不漏计数）', async () => {
    const host = await makeHost({
      config: { backgroundRunEnabled: false },
      withSubscribe: false,
    });
    host.jobs._set([{ id: 'seed-1', status: 'running' }]);
    const svc = host.ctx.get('backgroundRun');
    assert.equal(svc.snapshot().runningJobs, 0, '关闭状态下不计数');
    host.editor.entry.options.config.backgroundRunEnabled = true;
    const snap = svc.snapshot();
    assert.equal(snap.enabled, true);
    assert.equal(snap.runningJobs, 1, '开启时必须以 list() 现状补计数');
    assert.equal(snap.activeTasks, 1);
  });

  it('list() 中消失的 job 由对账收口（不依赖事件）', async () => {
    const host = await makeHost({ config: { backgroundRunEnabled: false }, withSubscribe: false });
    host.jobs._set([{ id: 'gone-1', status: 'running' }]);
    const svc = host.ctx.get('backgroundRun');
    host.editor.entry.options.config.backgroundRunEnabled = true;
    assert.equal(svc.snapshot().activeTasks, 1);
    host.jobs._set([]);  // 记录被移除
    assert.equal(svc.snapshot().activeTasks, 0, 'list() 消失必须收口');
  });
});

describe('host harness：jobs.events.subscribe(filter, listener) 新入口（T3-JOBS-EVENTS-SUBSCRIBE）', () => {
  it('使用目标入口 events.subscribe，且没有调用旧 jobs.subscribe', async () => {
    const ctx = new Context();
    const settings = makeSettings();
    const editor = makeConfigEditor({ backgroundRunEnabled: true });
    const jobs = makeJobs();
    let legacyCalls = 0;
    // 旧形状同时存在：必须优先走 events 入口，不得走兼容分支。
    jobs.subscribe = () => { legacyCalls += 1; return () => {}; };
    ctx.provide('settings', settings);
    ctx.provide('configEditor', editor);
    ctx.provide('agents', { list: () => [] });
    ctx.provide('jobs', jobs);
    await ctx.plugin(plugin.apply);

    assert.equal(jobs._listenerCount(), 1, '必须经 events.subscribe 建立一条订阅');
    assert.equal(legacyCalls, 0, '存在 events 入口时不得调用旧 jobs.subscribe');
  });

  it('events 事件驱动计数：registered +1、stopping 活跃、settled/killed −1', async () => {
    const host = await makeHost({ config: { backgroundRunEnabled: true } });
    const svc = host.ctx.get('backgroundRun');
    host.jobs._emit('registered', { id: 'e1', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 1);
    assert.equal(svc.snapshot().activeTasks, 1);
    host.jobs._emit('stopping', { id: 'e1', status: 'stopping' });
    assert.equal(svc.snapshot().runningJobs, 1, 'stopping 仍算活跃');
    host.jobs._emit('settled', { id: 'e1', status: 'killed' });
    assert.equal(svc.snapshot().runningJobs, 0);
    assert.equal(svc.snapshot().activeTasks, 0);
  });

  it('events removed 收口，disposer 可注销订阅', async () => {
    const host = await makeHost({ config: { backgroundRunEnabled: true } });
    const svc = host.ctx.get('backgroundRun');
    host.jobs._emit('registered', { id: 'e2', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 1);
    host.jobs._emit('removed', { id: 'e2', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 0, 'removed 必须减计数');
    assert.equal(jobs_listener_count(host), 1, '订阅仍持有');
  });

  it('旧形状回退：只有 jobs.subscribe(ctx, filter, listener) 时仍能计数', async () => {
    const ctx = new Context();
    const settings = makeSettings();
    const editor = makeConfigEditor({ backgroundRunEnabled: true });
    const legacy = makeLegacyJobs();
    ctx.provide('settings', settings);
    ctx.provide('configEditor', editor);
    ctx.provide('agents', { list: () => [] });
    ctx.provide('jobs', legacy);
    await ctx.plugin(plugin.apply);
    const svc = ctx.get('backgroundRun');
    assert.equal(legacy._listenerCount(), 1, '旧形状必须走兼容分支');
    legacy._emit('registered', { id: 'l1', status: 'running' });
    assert.equal(svc.snapshot().runningJobs, 1);
    legacy._emit('settled', { id: 'l1', status: 'completed' });
    assert.equal(svc.snapshot().runningJobs, 0);
  });
});

/** 读取 stub 当前的订阅数（两种 stub 同形）。 */
function jobs_listener_count(host) {
  return host.jobs._listenerCount();
}
