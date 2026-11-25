/**
 * フロントエンドのビルド
 *  - 既定: GAS HtmlService 用の単一 HTML（JS/CSS をインライン化）を dist/gas-html/ に出力
 *          staff.html（Shiftly-Staff）, admin.html（Shiftly-Admin）, setup.html（Shiftly Setup）
 *  - --preview: モックデータで動作するプレビューを dist/preview/ に出力
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const entries = resolve(rootDir, 'src/frontend/entries');
const preview = process.argv.includes('--preview');

async function buildPreview() {
  await build({ configFile: resolve(rootDir, 'vite.config.ts'), logLevel: 'warn' });
  console.log('preview → dist/preview/preview.html');
}

function inlineHtml(outDir, name) {
  const htmlPath = join(outDir, `${name}.html`);
  let html = readFileSync(htmlPath, 'utf8');
  const assets = join(outDir, 'assets');
  const files = readdirSync(assets);
  // CSS
  html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+)"[^>]*>/g, (_m, f) => `<style>\n${readFileSync(join(assets, f), 'utf8')}\n</style>`);
  // JS（クラシックスクリプトとして body 末尾に配置）
  let js = '';
  html = html.replace(/<script type="module" crossorigin src="\.\/assets\/([^"]+)"><\/script>/g, (_m, f) => {
    js += readFileSync(join(assets, f), 'utf8');
    return '';
  });
  if (!js) throw new Error(`${name}: JS が見つかりません (${files.join(',')})`);
  js = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  html = html.replace('</body>', `<script>\n${js}\n</script>\n</body>`);
  if (/src="\.\/assets\//.test(html) || /href="\.\/assets\//.test(html)) throw new Error(`${name}: 未インライン化の参照があります`);
  return html;
}

async function buildGasHtml(name) {
  const outDir = resolve(rootDir, `dist/.tmp-${name}`);
  await build({
    configFile: false,
    root: entries,
    base: './',
    logLevel: 'warn',
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2020',
      cssCodeSplit: false,
      assetsInlineLimit: 100_000_000,
      modulePreload: false,
      rollupOptions: { input: resolve(entries, `${name}.html`), output: { format: 'iife' } },
    },
  });
  const html = inlineHtml(outDir, name);
  const dest = resolve(rootDir, 'dist/gas-html');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, `${name}.html`), html);
  console.log(`gas-html/${name}.html ${(html.length / 1024).toFixed(0)} KB`);
}

if (preview) await buildPreview();
else for (const n of ['staff', 'admin', 'setup']) await buildGasHtml(n);
