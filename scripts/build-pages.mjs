/**
 * GitHub Pages の公開物のビルド（docs/decisions.md D-030）
 * 出力: dist/pages/
 *  - index.html: 案内ページ（site/index.html。site/config.json の共通 Setup の URL・状態を埋め込む）
 *  - demo/: 架空のデータだけで動くプレビュー（dist/preview の複製。Google に接続しない。先に npm run build:preview を実行）
 * 業務データ・秘密情報は含めない（秘密情報らしき文字列があればビルドを失敗させる）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist/pages');
const preview = resolve(root, 'dist/preview');
if (!existsSync(join(preview, 'preview.html'))) throw new Error('dist/preview がありません。先に npm run build:preview を実行してください');

const cfg = JSON.parse(readFileSync(resolve(root, 'site/config.json'), 'utf8'));
const setupUrl = typeof cfg.setupUrl === 'string' ? cfg.setupUrl.trim() : '';
// 共通 Setup の URL は Apps Script の Web アプリの URL だけを受け付ける（任意の URL へ誘導しない）
if (setupUrl && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(setupUrl)) throw new Error(`site/config.json の setupUrl が Apps Script の Web アプリの URL ではありません: ${setupUrl}`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const status = setupUrl ? '限定公開中です（提供者が登録した Google アカウントだけが使えます）' : String(cfg.setupStatus ?? '準備中です');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const index = readFileSync(resolve(root, 'site/index.html'), 'utf8').replace('{{SETUP_URL}}', setupUrl).replace('{{SETUP_STATUS}}', esc(status));
if (index.includes('{{')) throw new Error('site/index.html に埋め込まれていない項目があります');
writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, '.nojekyll'), '');
cpSync(preview, join(out, 'demo'), { recursive: true });
copyFileSync(join(out, 'demo', 'preview.html'), join(out, 'demo', 'index.html'));

// 秘密情報混入チェック（簡易。build-gas.mjs と同じ方針）
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
for (const f of walk(out)) {
  const t = readFileSync(f, 'utf8');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|ya29\.[0-9A-Za-z_-]+|SHIFTLY_SETUP_SECRETS/.test(t)) throw new Error(`${f}: 秘密情報らしき文字列が含まれています`);
}
console.log(`pages → dist/pages（共通 Setup の URL: ${setupUrl || '未設定'}）`);
