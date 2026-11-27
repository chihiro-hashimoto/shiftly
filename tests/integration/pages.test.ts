/**
 * GitHub Pages の公開物（dist/pages。D-030）の確認
 * 前提: npm run build:preview && npm run build:pages（未ビルドの場合はスキップ）
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const built = existsSync('dist/pages/index.html');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

describe.skipIf(!built)('GitHub Pages の公開物', () => {
  it('案内ページ・デモ（index と preview）・.nojekyll だけを含み、GAS の配布物を含まない', () => {
    const files = walk('dist/pages').map((f) => f.replace(/\\/g, '/').replace('dist/pages/', ''));
    expect(files).toContain('index.html');
    expect(files).toContain('.nojekyll');
    expect(files).toContain('demo/index.html');
    expect(files).toContain('demo/preview.html');
    for (const f of files) expect(f === 'index.html' || f === '.nojekyll' || f.startsWith('demo/')).toBe(true);
    expect(files.some((f) => /Code\.js|Release\.js|appsscript/.test(f))).toBe(false);
  });

  it('埋め込みの項目が残っておらず、共通 Setup の URL は未設定か Apps Script の Web アプリの URL だけ', () => {
    const html = readFileSync('dist/pages/index.html', 'utf8');
    expect(html).not.toContain('{{');
    const url = /var url = '([^']*)'/.exec(html)![1]!;
    expect(url === '' || /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)).toBe(true);
  });

  it('外部から読み込むのは Google Fonts だけ（スクリプトは外部から読み込まない）', () => {
    for (const f of walk('dist/pages').filter((x) => x.endsWith('.html'))) {
      const html = readFileSync(f, 'utf8');
      expect(html).not.toMatch(/<script[^>]+src="https?:/);
      for (const m of html.matchAll(/(?:href|src)="(https?:[^"]+)"/g)) expect(m[1]).toMatch(/^https:\/\/fonts\.(googleapis|gstatic)\.com/);
    }
  });

  it('デモは架空のデータのプレビューで、相対パスで資産を読み込む（/shiftly/demo/ で表示できる）', () => {
    const demo = readFileSync('dist/pages/demo/index.html', 'utf8');
    expect(demo).toBe(readFileSync('dist/pages/demo/preview.html', 'utf8'));
    expect(demo).toMatch(/src="\.\/assets\//);
  });
});
