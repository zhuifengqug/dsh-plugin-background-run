/* 网络探测超时回归（需求 §4 B12）——直接测 lib/network.js 产物。
 *
 * 背景：旧实现用 `dns.lookup(host, { signal: AbortSignal.timeout(ms) })`，但 Node 的
 * `LookupOptions` 没有 `signal` 字段、运行时也被忽略（实测预先 abort 的 signal 仍然
 * 正常 resolve）。所以 8s 超时保护实际不存在，且 tsc 报 TS2769。
 * 现在改为 `Promise.race` + 显式定时器（定时器 unref，不拖住宿主进程），本文件把它钉住。
 *
 * 注意（本文件的设计约束）：被测实现里的超时定时器是 `unref()` 的 —— 它不负责保活事件
 * 循环。因此**不能用「永不 settle 的 lookup」**做夹具：那样进程没有任何待办 handle，
 * 事件循环提前结束，node:test 会以
 * `Promise resolution is still pending but the event loop has already resolved`
 * 取消测试（这正是一次真实踩坑）。改用「比超时慢、但最终会 settle」的探测：
 * 它的普通定时器保活事件循环，同时仍然验证「超时先于探测结果胜出」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { NetworkMonitor, lookupWithTimeout } = await import('../lib/network.js');

const TIMEOUT_MS = 60;
const SLOW_MS = 500;

/**
 * 比超时慢得多的探测（模拟 DNS 挂死）。
 *
 * 这里的定时器**故意不 unref**：它是本夹具的保活 handle —— 被测实现里的超时定时器是
 * unref 的，只有事件循环里还有别的待办 handle 时它才可能触发。若把这里也 unref，
 * 事件循环会立刻枯竭，测试会被 node:test 以
 * `Promise resolution is still pending but the event loop has already resolved` 取消
 * （这正是本文件第一版踩的坑）。
 */
const slowLookup = () => new Promise((resolve) => {
  setTimeout(() => resolve({ address: '127.0.0.1', family: 4 }), SLOW_MS);
});
/** 立即成功的探测实现。 */
const resolvesNow = () => Promise.resolve({ address: '127.0.0.1', family: 4 });

describe('lookupWithTimeout（显式超时语义）', () => {
  it('探测慢于超时时在 timeoutMs 附近 reject，不等到探测结果', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      () => lookupWithTimeout('api.deepseek.com', TIMEOUT_MS, slowLookup),
      /DNS 探测超时/,
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= TIMEOUT_MS - 5, `不应早于 timeoutMs 返回（实际 ${elapsed} ms）`);
    assert.ok(elapsed < SLOW_MS, `必须在探测结果之前超时返回（实际 ${elapsed} ms）`);
  });

  it('探测正常时 resolve，不误报超时', async () => {
    await lookupWithTimeout('api.deepseek.com', 1000, resolvesNow);
  });
});

describe('NetworkMonitor.probeOnce（超时 -> offline）', () => {
  it('超时的探测返回 offline，并触发一次中断回调', async () => {
    const changes = [];
    const logs = [];
    const monitor = new NetworkMonitor(
      (online) => changes.push(online),
      (message) => logs.push(message),
      { timeoutMs: TIMEOUT_MS, lookup: slowLookup },
    );
    const startedAt = Date.now();
    const result = await monitor.probeOnce();
    const elapsed = Date.now() - startedAt;

    assert.equal(result, 'offline');
    assert.ok(elapsed < SLOW_MS, `必须在探测结果之前判定 offline（实际 ${elapsed} ms）`);
    assert.deepEqual(changes, [false]);
    assert.equal(logs.length, 1);
    assert.equal(monitor.isOnline, false);
  });

  it('恢复后返回 online 并触发一次恢复回调', async () => {
    const changes = [];
    let slow = true;
    const monitor = new NetworkMonitor(
      (online) => changes.push(online),
      () => {},
      { timeoutMs: TIMEOUT_MS, lookup: () => (slow ? slowLookup() : resolvesNow()) },
    );
    assert.equal(await monitor.probeOnce(), 'offline');
    slow = false;
    assert.equal(await monitor.probeOnce(), 'online');
    assert.deepEqual(changes, [false, true]);
    assert.equal(monitor.isOnline, true);
  });

  it('stop() 清掉轮询定时器，且 start() 幂等（不叠加定时器）', () => {
    const monitor = new NetworkMonitor(() => {}, () => {}, { intervalMs: 10_000, lookup: resolvesNow });
    monitor.start();
    const first = monitor.timer;
    assert.ok(first, 'start() 之后应有定时器');
    monitor.start();
    assert.equal(monitor.timer, first, 'start() 幂等：不得叠加第二个定时器');
    monitor.stop();
    assert.equal(monitor.timer, undefined, 'stop() 必须清掉定时器（否则卸载后仍持有 handle）');
    // 卸载后不应再有任何待办 handle（unref 的定时器不计入，仍显式断言一次语义）。
    assert.equal(monitor.isOnline, true);
  });
});
