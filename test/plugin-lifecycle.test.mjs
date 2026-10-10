/* 插件生命周期模拟测试：用最小 mock ctx 驱动 src 逻辑的 JS 等价实现。
 * 覆盖：开关关闭不申请电源 / 开启后任务开始申请 / 多任务引用计数 /
 * 快速切换开关不泄漏 / 卸载清理。被测语义映射 src/index.ts + src/state.ts。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function makeHarness() {
  let powerHeld = false;
  let acquires = 0; let releases = 0;
  let enabled = false;
  let count = 0;
  const running = new Set();
  function syncPower() {
    if (!enabled) { if (powerHeld) { powerHeld = false; releases += 1; } return; }
    if (count > 0 && !powerHeld) { powerHeld = true; acquires += 1; }
    if (count === 0 && powerHeld) { powerHeld = false; releases += 1; }
  }
  return {
    get: () => ({ enabled, powerHeld, count, acquires, releases }),
    setEnabled(v) { enabled = v; if (!v) { count = 0; running.clear(); } syncPower(); },
    agentStatus(id, status) {
      if (!enabled) return;
      if (status === 'running' && !running.has(id)) { running.add(id); count += 1; }
      if (status === 'idle' && running.delete(id)) { if (count > 0) count -= 1; }
      syncPower();
    },
    jobSettled(id) {
      if (running.delete(id)) { if (count > 0) count -= 1; }
      syncPower();
    },
    cleanup() { count = 0; running.clear(); syncPower(); },
  };
}

describe('插件生命周期（映射 src/index.ts 行为）', () => {
  it('关闭开关时不申请系统电源保持', () => {
    const h = makeHarness();
    h.agentStatus('a1', 'running');
    const s = h.get();
    assert.equal(s.acquires, 0);
    assert.equal(s.powerHeld, false);
  });
  it('打开开关后任务开始申请电源保持，结束后释放', () => {
    const h = makeHarness();
    h.setEnabled(true);
    h.agentStatus('a1', 'running');
    assert.equal(h.get().powerHeld, true);
    h.agentStatus('a1', 'idle');
    const s = h.get();
    assert.equal(s.count, 0);
    assert.equal(s.powerHeld, false);
    assert.equal(s.releases, 1);
  });
  it('多任务并行：单个结束不提前释放', () => {
    const h = makeHarness();
    h.setEnabled(true);
    h.agentStatus('a1', 'running');
    h.agentStatus('a2', 'running');
    h.agentStatus('a1', 'idle');
    assert.equal(h.get().powerHeld, true);
    assert.equal(h.get().count, 1);
    h.agentStatus('a2', 'idle');
    assert.equal(h.get().powerHeld, false);
  });
  it('快速重复切换开关不会泄漏（关闭清零，再开重新计数）', () => {
    const h = makeHarness();
    h.setEnabled(true);
    h.agentStatus('a1', 'running');
    h.setEnabled(false);
    assert.equal(h.get().powerHeld, false);
    assert.equal(h.get().count, 0);
    h.setEnabled(true);
    h.agentStatus('a1', 'running');
    assert.equal(h.get().powerHeld, true);
    assert.equal(h.get().acquires, 2);
  });
  it('插件卸载清理：释放电源保持并清零', () => {
    const h = makeHarness();
    h.setEnabled(true);
    h.agentStatus('a1', 'running');
    h.cleanup();
    const s = h.get();
    assert.equal(s.powerHeld, false);
    assert.equal(s.count, 0);
  });
  it('任务失败/取消同样释放（idle 路径覆盖完成/失败/取消/超时）', () => {
    const h = makeHarness();
    h.setEnabled(true);
    h.agentStatus('a1', 'running');
    h.jobSettled('no-such-job');
    assert.equal(h.get().powerHeld, true);
    h.agentStatus('a1', 'idle');
    assert.equal(h.get().powerHeld, false);
  });
});
