import { build } from 'esbuild';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const r = await build({ entryPoints: [resolve(root, 'scripts/gen-docs.ts')], bundle: true, platform: 'node', format: 'esm', write: false, target: 'node22' });
const url = 'data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64');
process.chdir(root);
await import(url);
