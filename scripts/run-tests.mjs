// 多标签页合并场景的 Node 测试入口：先用 esbuild 即时打包 TS，再依次运行两组模拟。
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cases = ['scripts/merge-sim.mjs', 'scripts/store-sim.mjs'];

for (const entry of cases) {
  const outfile = path.join(root, 'scripts', path.basename(entry).replace('.mjs', '.bundle.mjs'));
  await build({ entryPoints: [path.join(root, entry)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent' });
  const mod = await import(path.join('file://', outfile));
  void mod;
}
if (process.exitCode) {
  console.error('存在失败的合并用例');
  process.exit(1);
}
