/**
 * GAS 配布物のビルド
 * 出力: dist/gas/{core,admin,setup}/ 各プロジェクトのファイル一式（clasp push またはブラウザでの貼り付け用）
 *  - Code.js: esbuild で IIFE にまとめたサーバーコード ＋ google.script.run / Web アプリ用のトップレベル関数
 *  - *.html: scripts/build-frontend.mjs が生成した単一 HTML（先に npm run build を実行）
 *  - appsscript.json: gas/manifests/*.json
 *  - setup/Release.js: Core / Admin の配布物と SHA-256（Setup が自動配置時に検証）
 *  - dist/gas/release.json: 配布物のハッシュ一覧
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'dist/gas');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const versionTs = readFileSync(resolve(root, 'src/backend/version.ts'), 'utf8');
const m = versionTs.match(/APP_VERSION = '([^']+)'/);
if (!m || m[1] !== pkg.version) throw new Error(`APP_VERSION (${m?.[1]}) と package.json (${pkg.version}) が一致しません`);

const PROJECTS = {
  core: { entry: 'src/gas/core.ts', global: 'ShiftlyCore', fns: ['doGet', 'doPost', 'staffApi', 'kioskApi', 'shiftlyAuthorize', 'shiftlyDailyJob', 'shiftlyResetAdminPairing'], html: ['staff'], manifest: 'core.json' },
  admin: { entry: 'src/gas/admin.ts', global: 'ShiftlyAdmin', fns: ['doGet', 'adminApi', 'adminWhoAmI', 'shiftlyAuthorize'], html: ['admin'], manifest: 'admin.json' },
  setup: { entry: 'src/gas/setup.ts', global: 'ShiftlySetup', fns: ['doGet', 'setupApi'], html: ['setup'], manifest: 'setup-selfhosted.json' },
};

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

async function bundle(name, p) {
  const r = await build({
    entryPoints: [resolve(root, p.entry)],
    bundle: true,
    format: 'iife',
    globalName: p.global,
    target: 'es2020',
    platform: 'neutral',
    write: false,
    legalComments: 'none',
    charset: 'utf8',
    minify: false,
  });
  const code = r.outputFiles[0].text;
  // google.script.run と Web アプリはトップレベル関数宣言のみ呼び出せるため、委譲関数を生成
  const stubs = p.fns.map((f) => `function ${f}(a, b) { return ${p.global}.${f}(a, b); }`).join('\n');
  return `/* Shiftly ${pkg.version} (${name}) — 自動生成ファイル。編集しないでください */\n${code}\n${stubs}\n`;
}

mkdirSync(out, { recursive: true });
const release = { version: pkg.version, core: [], admin: [], hashes: {} };
for (const [name, p] of Object.entries(PROJECTS)) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const files = [];
  files.push({ name: 'appsscript', type: 'JSON', source: readFileSync(resolve(root, 'gas/manifests', p.manifest), 'utf8') });
  files.push({ name: 'Code', type: 'SERVER_JS', source: await bundle(name, p) });
  for (const h of p.html) {
    const f = resolve(root, 'dist/gas-html', `${h}.html`);
    if (!existsSync(f)) throw new Error(`${f} がありません。先に npm run build を実行してください`);
    files.push({ name: h, type: 'HTML', source: readFileSync(f, 'utf8') });
  }
  if (name === 'core' || name === 'admin') {
    release[name] = files;
    for (const f of files) release.hashes[`${name}/${f.name}`] = sha(f.source);
  }
  for (const f of files) writeFileSync(join(dir, `${f.name}.${f.type === 'JSON' ? 'json' : f.type === 'HTML' ? 'html' : 'js'}`), f.source);
}
// Setup に配布物を同梱（改ざん検知用ハッシュ付き）
writeFileSync(join(out, 'setup', 'Release.js'), `/* 自動生成: Shiftly ${pkg.version} 配布物 */\nvar SHIFTLY_RELEASE = ${JSON.stringify(release)};\n`);
writeFileSync(join(out, 'release.json'), JSON.stringify({ version: pkg.version, hashes: release.hashes }, null, 2));
// ホスト型 Setup 用マニフェストも出力
writeFileSync(join(out, 'setup', 'appsscript.hosted.json.txt'), readFileSync(resolve(root, 'gas/manifests/setup-hosted.json'), 'utf8'));

// 秘密情報混入チェック（簡易）
for (const name of Object.keys(PROJECTS)) {
  const code = readFileSync(join(out, name, 'Code.js'), 'utf8');
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|ghp_[0-9A-Za-z]{36}|ya29\.[0-9A-Za-z_-]+/.test(code)) throw new Error(`${name}: 秘密情報らしき文字列が含まれています`);
}
for (const name of Object.keys(PROJECTS)) {
  const size = ['Code.js', ...PROJECTS[name].html.map((h) => `${h}.html`)].reduce((a, f) => a + readFileSync(join(out, name, f)).length, 0);
  console.log(`gas/${name}: ${(size / 1024).toFixed(0)} KB`);
}
console.log(`gas/setup/Release.js: ${(readFileSync(join(out, 'setup', 'Release.js')).length / 1024).toFixed(0)} KB`);
