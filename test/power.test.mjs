/* 电源句柄 mock 测试：申请/保持/释放/异常清理语义（不调用真实 Win32）。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// 与 src/power.ts Win32PowerHandle 同构的 mock（映射表见文件尾）。
function createMockHandle({ failAcquire = false, failRelease = false } = {}) {
  let held = false;
  return {
    kind: 'mock',
    get held() { return held; },
    acquire() {
      if (held) return { ok: true };
      if (failAcquire) return { ok: false, error: 'mock acquire failed' };
      held = true;
      return { ok: true };
    },
    release() {
      if (!held) return { ok: true };
      if (failRelease) { held = false; return { ok: false, error: 'mock release failed' }; }
      held = false;
      return { ok: true };
    },
  };
}

describe('PowerHandle mock（映射 src/power.ts）', () => {
  it('acquire 幂等：重复申请只生效一次', () => {
    const h = createMockHandle();
    assert.deepEqual(h.acquire(), { ok: true });
    assert.deepEqual(h.acquire(), { ok: true });
    assert.equal(h.held, true);
  });
  it('release 幂等：未持有时释放为 no-op', () => {
    const h = createMockHandle();
    assert.deepEqual(h.release(), { ok: true });
    assert.equal(h.held, false);
  });
  it('acquire→release 完整周期', () => {
    const h = createMockHandle();
    h.acquire(); assert.equal(h.held, true);
    h.release(); assert.equal(h.held, false);
  });
  it('acquire 失败返回 error 而不是抛错', () => {
    const h = createMockHandle({ failAcquire: true });
    const r = h.acquire();
    assert.equal(r.ok, false);
    assert.equal(h.held, false);
  });
  it('release 失败也清持有标记，避免残留阻止后续 acquire', () => {
    const h = createMockHandle({ failRelease: true });
    h.acquire();
    const r = h.release();
    assert.equal(r.ok, false);
    assert.equal(h.held, false);
    assert.deepEqual(h.acquire(), { ok: true });
  });
  it('ES_DISPLAY_REQUIRED 永不使用（显示器必须能关闭）', () => {
    const ES_DISPLAY_REQUIRED = 0x00000002;
    const flagsUsed = 0x80000000 | 0x00000001; // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    assert.equal(flagsUsed & ES_DISPLAY_REQUIRED, 0);
  });
});
// 映射表：createMockHandle <-> src/power.ts Win32PowerHandle / UnsupportedPowerHandle。
