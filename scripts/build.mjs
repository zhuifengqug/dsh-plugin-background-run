/* 构建脚本（仅 Node 内置模块，无外部构建依赖）。
 * 用 node:module.stripTypeScriptTypes 把 src/*.ts 转译为 lib/*.js（标准 ESM），
 * 再把 client/client.js 拷贝为 lib/client.js。
 * src/ 为唯一权威源码；lib/ 为构建产物，可删除后重建。
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = join(root, 'lib');
mkdirSync(libDir, { recursive: true });

const sources = ['power.ts', 'state.ts', 'config.ts', 'network.ts', 'index.ts', 'status-controller.ts', 'typert.ts'];
for (const f of sources) {
  const src = join(root, 'src', f);
  const text = readFileSync(src, 'utf8');
  if (text.length < 100) throw new Error(`build: src/${f} 为空或过短，拒绝构建`);
  const js = stripTypeScriptTypes(text, { mode: 'transform', sourceMap: false });
  const outName = f.replace(/\.ts$/, '.js');
  writeFileSync(join(libDir, outName), js);
  console.log(`built lib/${outName}`);
}
// 装饰器 @Remote 在 status-controller.ts 中使用：stripTypeScriptTypes(mode=transform)
// 不支持旧版装饰器，转译后手动校验并给出明确错误。
const sc = readFileSync(join(libDir, 'status-controller.js'), 'utf8');
if (sc.includes('@Remote')) {
  throw new Error('build: status-controller.js 仍含装饰器语法，需改写为无装饰器写法');
}
if (!readFileSync(join(root, 'src', 'index.ts'), 'utf8').includes('export function apply')) {
  throw new Error('build: src/index.ts 缺少 export function apply');
}
copyFileSync(join(root, 'client', 'client.js'), join(libDir, 'client.js'));
console.log('build ok: lib/*.js emitted, lib/client.js copied');
