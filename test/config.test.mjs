/* 设置面回归（Loader/Config 触点，需求 §4 B1/B2/B6）——直接对 lib/ 产物断言，
 * 防止三类必修项回退：
 * 1. 漏 `.volatile()`：宿主 volatileForm() 返回 undefined → describe() 跳过整个条目；
 * 2. 漏导出 `Config`：宿主 schema(entry) 读 entry.fiber.runtime.Config 得到 undefined；
 * 3. 误加 `export default apply`：loader unwrapExports() 会丢弃模块级 inject。
 *
 * 另附 normalizeSettings 的兼容性归一化（旧配置缺字段/类型错误一律 false）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const entry = await import('@gjs27/dsh-plugin-background-run');
const config = await import('../lib/config.js');

/**
 * 解析 schemastery `toJSON()` 的扁平结构。
 *
 * 实测形状（schemastery 3.18.4）：
 *   { uid: 3, refs: {
 *       2: { type: 'boolean', meta: { default: false, volatile: true } },
 *       3: { type: 'object', meta: { default: {} }, dict: { backgroundRunEnabled: 2 } } } }
 * 即：**根节点本身也在 refs 里**（由 `uid` 指定），`dict` 的字段值可能是
 * 指向 `refs` 的数字引用，也可能是内联对象。三种情况都要处理。
 */
function resolveRoot(json) {
  if (json && json.dict === undefined && json.refs && typeof json.uid === 'number') {
    const root = json.refs[String(json.uid)];
    if (root !== undefined) return root;
  }
  return json;
}

function resolveField(json, key) {
  const root = resolveRoot(json);
  const node = root && root.dict ? root.dict[key] : undefined;
  if (node !== null && typeof node === 'object') return node;
  if (typeof node === 'number' && json.refs) return json.refs[String(node)];
  return undefined;
}

describe('Config 导出契约（宿主读 entry.fiber.runtime.Config）', () => {
  it('入口模块导出 Config，且带 toJSON', () => {
    assert.ok(entry.Config, 'Config 必须从入口模块导出');
    assert.equal(typeof entry.Config.toJSON, 'function');
  });

  it('backgroundRunEnabled 存在、default=false 且标了 volatile', () => {
    const json = entry.Config.toJSON();
    const field = resolveField(json, 'backgroundRunEnabled');
    assert.ok(field, 'backgroundRunEnabled 必须在 schema 中');
    assert.equal(field.meta && field.meta.volatile, true, '必须标 volatile，否则条目被 describe() 跳过');
    assert.equal(field.meta && field.meta.default, false, '默认必须是 false（安全默认）');
    assert.equal(field.type, 'boolean');
  });

  it('inject 声明 settings 与 configEditor（apply 同步期就要能查到自己的条目）', () => {
    assert.ok(Array.isArray(entry.inject));
    assert.ok(entry.inject.includes('settings'));
    assert.ok(entry.inject.includes('configEditor'));
  });

  it('保持纯命名导出：没有 default，apply 是函数，name 是命名空间', () => {
    assert.equal(entry.default, undefined, 'default 导出会让 loader 丢弃 inject');
    assert.equal(typeof entry.apply, 'function');
    assert.equal(entry.name, 'background-run');
  });
});

describe('normalizeSettings 兼容性归一化', () => {
  it('缺字段按 false', () => {
    assert.deepEqual(config.normalizeSettings({}), { backgroundRunEnabled: false });
  });

  it('类型错误（字符串/数字/null）一律 false', () => {
    assert.deepEqual(config.normalizeSettings({ backgroundRunEnabled: 'true' }), { backgroundRunEnabled: false });
    assert.deepEqual(config.normalizeSettings({ backgroundRunEnabled: 1 }), { backgroundRunEnabled: false });
    assert.deepEqual(config.normalizeSettings({ backgroundRunEnabled: null }), { backgroundRunEnabled: false });
  });

  it('显式 true 透传', () => {
    assert.deepEqual(config.normalizeSettings({ backgroundRunEnabled: true }), { backgroundRunEnabled: true });
  });

  it('非对象输入回退安全默认值', () => {
    assert.deepEqual(config.normalizeSettings(undefined), { backgroundRunEnabled: false });
    assert.deepEqual(config.normalizeSettings('nope'), { backgroundRunEnabled: false });
    assert.deepEqual(config.normalizeSettings(null), { backgroundRunEnabled: false });
  });

  it('命名空间常量与 Loader 条目 id 一致', () => {
    assert.equal(config.BACKGROUND_RUN_SETTINGS_NAMESPACE, 'background-run');
  });
});
