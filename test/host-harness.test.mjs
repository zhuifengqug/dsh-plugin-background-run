/* 宿主 harness 集成测试：在真实 @deepseek-ai/cordis Context 上加载 lib/index.js，
 * 用最小官方兼容 stub 提供 settings/jobs/agents/logger/effect，验证：
 * 注册命名空间 → 提供快照服务 → 开关打开后 agent/status 驱动计数 → 开关关闭释放。
 * 在真实 profile 目录下运行（可解析 @deepseek-ai/cordis 与 @gjs27/dsh-plugin-background-run）。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const { Context } = await import('@deepseek-ai/cordis');
const plugin = await import('@gjs27/dsh-plugin-background-run');

function makeSettingsStub() {
  let value = { backgroundRunEnabled: false };
  const watchers = new Set();
  let scope = null;
  return {
    registered: [],
    register(ns, schema) {
      this.registered.push({ ns, schema });
      scope = {
        get: () => ({ ...value }),
        watch: (cb) => { watchers.add(cb); return () => { watchers.delete(cb); }; },
      };
      return scope;
    },
    _open() { const prev = value; value = { backgroundRunEnabled: true }; for (const w of watchers) w({ ...value }, prev); },
    _close() { const prev = value; value = { backgroundRunEnabled: false }; for (const w of watchers) w({ ...value }, prev); },
  };
}

describe('host harness（真实 cordis + lib/index.js）', () => {
  let ctx; let settings;
  before(async () => {
    ctx = new Context();
    settings = makeSettingsStub();
    ctx.provide('settings', settings);
    ctx.provide('agents', { list: () => [] });
    ctx.provide('jobs', {
      onJobsChanged: () => () => {},
      onJobDone: () => () => {},
      list: () => [],
    });
    await ctx.plugin(plugin.default ?? plugin.apply);
  });

  it('注册 background-run 设置命名空间', () => {
    assert.ok(settings.registered.some((r) => r.ns === 'background-run'));
  });

  it('提供 backgroundRun 快照服务，默认 disabled', () => {
    const svc = ctx.get('backgroundRun');
    assert.ok(svc);
    const snap = svc.snapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.state, 'disabled');
    assert.equal(snap.powerHeld, false);
    assert.equal(snap.activeTasks, 0);
  });

  it('开关关闭时 agent/status 不计数、不申请电源', () => {
    const svc = ctx.get('backgroundRun');
    ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'running' });
    const snap = svc.snapshot();
    assert.equal(snap.activeTasks, 0);
    assert.equal(snap.powerHeld, false);
  });

  it('开关打开后 running→idle 驱动计数与释放', () => {
    const svc = ctx.get('backgroundRun');
    settings._open();
    assert.equal(svc.snapshot().enabled, true);
    ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'running' });
    const running = svc.snapshot();
    assert.equal(running.activeTasks, 1);
    ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'idle' });
    const idle = svc.snapshot();
    assert.equal(idle.activeTasks, 0);
    assert.equal(idle.powerHeld, false);
  });

  it('多 agent 并行：单个 idle 不提前清零', () => {
    const svc = ctx.get('backgroundRun');
    ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'running' });
    ctx.emit('agent/status', { agent: { id: 'a2' }, status: 'running' });
    ctx.emit('agent/status', { agent: { id: 'a1' }, status: 'idle' });
    assert.equal(svc.snapshot().activeTasks, 1);
    ctx.emit('agent/status', { agent: { id: 'a2' }, status: 'idle' });
    assert.equal(svc.snapshot().activeTasks, 0);
  });

  it('开关关闭立即清零（释放全部保持）', () => {
    const svc = ctx.get('backgroundRun');
    ctx.emit('agent/status', { agent: { id: 'a9' }, status: 'running' });
    assert.equal(svc.snapshot().activeTasks, 1);
    settings._close();
    const snap = svc.snapshot();
    assert.equal(snap.enabled, false);
    assert.equal(snap.state, 'disabled');
    assert.equal(snap.activeTasks, 0);
    assert.equal(snap.powerHeld, false);
  });
});
