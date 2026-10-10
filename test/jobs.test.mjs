/* jobs 触发点回归（需求 §4 B3）——直接对 lib/ 产物断言两类事实：
 *
 * 1. **活跃态判定语义**：目标宿主 dsh-jobs-local 的终止态是 `completed | killed | failed`，
 *    运行态是 `running | stopping`；本插件按 `status` 差分计数，判定错就会漏减计数
 *    （电源保持永不释放）或漏加计数（任务期间不申请保持）。
 * 2. **已删除 API 的回归守卫**：`onJobsChanged` / `onJobDone` / `JobSnapshot` 在
 *    dsh 0.2.0-rc.2 全库 0 命中，源码与构建产物里都不允许再出现；
 *    同时 `jobs.subscribe` 必须仍被使用（否则后台任务退化为纯轮询）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = await import('@gjs27/dsh-plugin-background-run');
const libEntry = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
const srcEntry = readFileSync(join(root, 'src', 'index.ts'), 'utf8');

describe('isActiveJobStatus：活跃态判定（目标宿主 status 语义）', () => {
  it('running / stopping 视为活跃', () => {
    assert.equal(entry.isActiveJobStatus('running'), true);
    assert.equal(entry.isActiveJobStatus('stopping'), true);
  });

  it('completed / killed / failed 视为已结束', () => {
    assert.equal(entry.isActiveJobStatus('completed'), false);
    assert.equal(entry.isActiveJobStatus('killed'), false);
    assert.equal(entry.isActiveJobStatus('failed'), false);
  });

  it('非运行态事件名与异常输入一律不算活跃（防计数泄漏）', () => {
    assert.equal(entry.isActiveJobStatus('registered'), false);
    assert.equal(entry.isActiveJobStatus('removed'), false);
    assert.equal(entry.isActiveJobStatus('output'), false);
    assert.equal(entry.isActiveJobStatus(undefined), false);
    assert.equal(entry.isActiveJobStatus(null), false);
    assert.equal(entry.isActiveJobStatus(0), false);
  });
});

describe('obsolete jobs API 回归守卫（B3）', () => {
  it('构建产物不含 onJobsChanged / onJobDone / JobSnapshot', () => {
    for (const obsolete of ['onJobsChanged', 'onJobDone', 'JobSnapshot']) {
      assert.equal(
        libEntry.includes(obsolete),
        false,
        `lib/index.js 不得再出现已删除的 ${obsolete}（0.2.0-rc.2 全库无此 API）`,
      );
    }
  });

  it('源码不含 obsolete 调用（注释里的历史说明允许）', () => {
    // 只检查真实调用形态，避免误伤文件头「已删除」的说明性注释。
    assert.equal(/\.onJobsChanged\s*\(/.test(srcEntry), false);
    assert.equal(/\.onJobDone\s*\(/.test(srcEntry), false);
    assert.equal(/import\s+type\s*\{[^}]*JobSnapshot[^}]*\}/.test(srcEntry), false);
  });

  it('仍使用 jobs 事件订阅（否则后台任务退化为纯轮询）与 list() 兜底', () => {
    assert.ok(libEntry.includes('subscribe'), 'lib/index.js 必须仍调用 jobs 事件订阅');
    assert.equal(typeof entry.isActiveJobStatus, 'function');
  });

  it('优先使用目标入口 events.subscribe(filter, listener)（T3-JOBS-EVENTS-SUBSCRIBE 正向守卫）', () => {
    // 产物里必须出现目标形状：读 `jobs.events` 后调 `.subscribe(`。
    assert.match(libEntry, /\.events\b/, 'lib/index.js 必须读取 jobs.events');
    assert.match(libEntry, /events[\s\S]{0,200}?\.subscribe\s*\(/, '必须经 events.subscribe(...) 订阅');
    // 源码侧同样断言，防止只改产物。
    assert.match(srcEntry, /jobs\.events\.subscribe\s*\(/, 'src/index.ts 必须调用 jobs.events.subscribe(...)');
  });

  it('保留旧形状兼容分支（仅目标对象没有 events 入口时使用）', () => {
    // 只检查真实调用形态，避开文件头里对历史 API 的说明性注释：
    // 实际订阅代码必须同时存在 events 分支与旧兼容分支，且 events 分支在前。
    const eventsCall = srcEntry.indexOf('jobs.events.subscribe(');
    const legacyCall = srcEntry.indexOf('jobs.subscribe(ctx,');
    assert.ok(eventsCall >= 0, 'src 必须含 events.subscribe 调用');
    assert.ok(legacyCall >= 0, 'src 必须保留旧 subscribe(ctx, ...) 兼容分支');
    assert.ok(eventsCall < legacyCall, 'events 入口必须优先于旧兼容分支');
    assert.match(srcEntry, /typeof\s+jobs\.events\.subscribe\s*===\s*'function'/, '必须以能力探测选择入口');
  });

  it('jobs 事件接线不得用 any/never 绕过类型检查', () => {
    assert.equal(/\bas\s+any\b/.test(srcEntry), false, 'src/index.ts 不得出现 as any');
    // 收窄到 jobs 类型与订阅实现本体；不要扫到文件其余部分的 ctx.get/ctx.on 历史 as never。
    const jobsBlockStart = srcEntry.indexOf('export interface JobsRegistryLike');
    const jobsBlockEnd = srcEntry.indexOf('export function isActiveJobStatus');
    const jobsBlock = srcEntry.slice(jobsBlockStart, jobsBlockEnd);
    assert.equal(/as\s+never/.test(jobsBlock), false, 'jobs 注册表探针类型不得用 as never');
    assert.equal(/as\s+any/.test(jobsBlock), false, 'jobs 注册表探针类型不得用 as any');
  });

  it('导出作业对账周期常量（周期对账是唯一可信兜底）', () => {
    assert.equal(typeof entry.SETTINGS_SYNC_MS, 'number');
    assert.ok(entry.SETTINGS_SYNC_MS > 0);
  });
});
