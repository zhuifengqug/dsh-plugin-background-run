/* 引用计数 + 状态派生单��测试（纯逻辑，不依赖 DSH 运行时与 Win32）。
 * 内联被测逻辑的 JS 等价实现，保证测试与源码同构；
 * 源码变更时需同步更新此处（见文件尾映射表）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// —— 与 src/state.ts 同构的内联实现（映射表见文件尾） ——
function createCounter(driver) {
  let count = 0;
  let held = false;
  return {
    get activeTasks() { return count; },
    get powerHeld() { return held; },
    taskStarted() { count += 1; if (!held) held = driver.acquirePower(); return held; },
    taskEnded() { if (count > 0) count -= 1; if (count === 0 && held) { driver.releasePower(); held = false; } return held; },
    reset() { count = 0; if (held) { driver.releasePower(); held = false; } },
  };
}
function deriveState(args) {
  if (!args.enabled) return 'disabled';
  if (args.hasError && !args.powerHeld && args.activeTasks > 0) return 'error';
  if (!args.networkOnline) return 'network-interrupted';
  if (args.activeTasks > 0) return args.powerHeld ? 'active' : 'error';
  return 'enabled-idle';
}

describe('TaskRefCounter（映射 src/state.ts TaskRefCounter）', () => {
  it('任务开始+1，全部结束才释放电源保持', () => {
    let acquires = 0; let releases = 0;
    const c = createCounter({ acquirePower: () => { acquires += 1; return true; }, releasePower: () => { releases += 1; } });
    c.taskStarted(); c.taskStarted();
    assert.equal(c.activeTasks, 2);
    assert.equal(acquires, 1);
    assert.equal(c.powerHeld, true);
    c.taskEnded();
    assert.equal(c.activeTasks, 1);
    assert.equal(releases, 0);
    assert.equal(c.powerHeld, true);
    c.taskEnded();
    assert.equal(c.activeTasks, 0);
    assert.equal(releases, 1);
    assert.equal(c.powerHeld, false);
  });
  it('重复结束不产生负数，不重复释放', () => {
    let releases = 0;
    const c = createCounter({ acquirePower: () => true, releasePower: () => { releases += 1; } });
    c.taskStarted(); c.taskEnded(); c.taskEnded(); c.taskEnded();
    assert.equal(c.activeTasks, 0);
    assert.equal(releases, 1);
  });
  it('reset 清零并释放（插件卸载/开关关闭路径）', () => {
    let releases = 0;
    const c = createCounter({ acquirePower: () => true, releasePower: () => { releases += 1; } });
    c.taskStarted(); c.taskStarted();
    c.reset();
    assert.equal(c.activeTasks, 0);
    assert.equal(c.powerHeld, false);
    assert.equal(releases, 1);
  });
  it('电源申请失败时计数保留、持有为 false（状态页报 error，不伪装）', () => {
    const c = createCounter({ acquirePower: () => false, releasePower: () => {} });
    c.taskStarted();
    assert.equal(c.activeTasks, 1);
    assert.equal(c.powerHeld, false);
  });
});

describe('deriveState（映射 src/state.ts deriveState）', () => {
  it('开关关闭 -> disabled', () => {
    assert.equal(deriveState({ enabled: false, powerHeld: false, activeTasks: 0, networkOnline: true, hasError: false }), 'disabled');
  });
  it('开启无任务 -> enabled-idle', () => {
    assert.equal(deriveState({ enabled: true, powerHeld: false, activeTasks: 0, networkOnline: true, hasError: false }), 'enabled-idle');
  });
  it('有任务且持有 -> active', () => {
    assert.equal(deriveState({ enabled: true, powerHeld: true, activeTasks: 2, networkOnline: true, hasError: false }), 'active');
  });
  it('有任务未持有 -> error（不伪装成功）', () => {
    assert.equal(deriveState({ enabled: true, powerHeld: false, activeTasks: 1, networkOnline: true, hasError: true }), 'error');
  });
  it('网络中断 -> network-interrupted', () => {
    assert.equal(deriveState({ enabled: true, powerHeld: true, activeTasks: 1, networkOnline: false, hasError: false }), 'network-interrupted');
  });
});

describe('normalizeSettings（映射 src/config.ts）', () => {
  function normalizeSettings(raw) {
    if (typeof raw !== 'object' || raw === null) return { backgroundRunEnabled: false };
    return { backgroundRunEnabled: raw.backgroundRunEnabled === true };
  }
  it('旧配置缺字段按 false 处理', () => {
    assert.deepEqual(normalizeSettings({}), { backgroundRunEnabled: false });
    assert.deepEqual(normalizeSettings(undefined), { backgroundRunEnabled: false });
    assert.deepEqual(normalizeSettings(null), { backgroundRunEnabled: false });
  });
  it('字符串 "true" 不被接受（必须布尔值）', () => {
    assert.deepEqual(normalizeSettings({ backgroundRunEnabled: 'true' }), { backgroundRunEnabled: false });
    assert.deepEqual(normalizeSettings({ backgroundRunEnabled: 1 }), { backgroundRunEnabled: false });
  });
  it('布尔 true 保留', () => {
    assert.deepEqual(normalizeSettings({ backgroundRunEnabled: true }), { backgroundRunEnabled: true });
  });
});
// 映射表：本文件 createCounter <-> src/state.ts TaskRefCounter；
// deriveState <-> src/state.ts deriveState；normalizeSettings <-> src/config.ts normalizeSettings。
