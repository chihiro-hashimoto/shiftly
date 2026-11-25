/**
 * 店舗 iPad（Kiosk）の E2E（プレビュー: メモリ上のモック Core）
 * ※ Playwright の Chromium による検証。WebKit / iPad 実機での検証ではない
 */
import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && errors.push(m.text()));
  await page.goto('/preview.html');
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
  return errors;
}

async function login(page: Page, name: string, pin: string) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click();
}

test('名前選択 → PIN → 出勤 → 完了表示 → 自動ログアウト', async ({ page }) => {
  const errors = await open(page);
  await login(page, 'デモ 次郎', '604135');
  await expect(page.getByText('デモ 次郎さん').first()).toBeVisible();
  const clockIn = page.getByRole('button', { name: /^出勤/ });
  await expect(clockIn).toBeEnabled();
  await expect(page.getByRole('button', { name: /^退勤/ })).toBeDisabled();
  await clockIn.click();
  await expect(page.getByText(/出勤しました/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible({ timeout: 6000 });
  // 再ログインすると勤務中
  await login(page, 'デモ 次郎', '604135');
  await expect(page.getByText('勤務中')).toBeVisible();
  await expect(page.getByRole('button', { name: /^出勤/ })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('誤った PIN は拒否し、成功と表示しない', async ({ page }) => {
  await open(page);
  await login(page, 'サンプル 花子', '111112');
  await expect(page.getByRole('alert')).toContainText('PIN');
  await expect(page.getByText('サンプル 花子さん', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^出勤/ })).toHaveCount(0);
});

test('休憩中の退勤は確認ダイアログ', async ({ page }) => {
  await open(page);
  await login(page, 'サンプル 一郎', '482913');
  await page.getByRole('button', { name: /^出勤/ }).click();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible({ timeout: 6000 });
  await login(page, 'サンプル 一郎', '482913');
  await page.getByRole('button', { name: /^休憩開始/ }).click();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible({ timeout: 6000 });
  await login(page, 'サンプル 一郎', '482913');
  await page.getByRole('button', { name: /^退勤/ }).click();
  await expect(page.getByRole('dialog', { name: '休憩中です' })).toBeVisible();
  await page.getByRole('button', { name: '休憩を終了して退勤' }).click();
  await expect(page.getByText(/退勤しました/)).toBeVisible();
});

test('本人画面: 勤怠・シフト・給与・有給の表示とログアウトで個人情報を破棄', async ({ page }) => {
  await open(page);
  await login(page, 'サンプル 一郎', '482913');
  await page.getByRole('tab', { name: '自分の勤怠' }).click();
  await expect(page.getByText(/直近30日の実働/)).toBeVisible();
  await page.getByRole('tab', { name: 'シフト' }).click();
  await expect(page.locator('.badge-board').first()).toBeVisible();
  await page.getByRole('tab', { name: '給与', exact: true }).click();
  await expect(page.getByText(/見込額/).first()).toBeVisible();
  await page.getByRole('tab', { name: '有給' }).click();
  await expect(page.getByText('有給残日数')).toBeVisible();
  await page.getByRole('button', { name: 'ログアウト' }).click();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
  await expect(page.getByText('有給残日数')).toHaveCount(0);
  // 端末に業務データを保存していない（プレビューでは端末トークンも注入のため localStorage は空）
  const keys = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
  expect(keys.filter((k) => k !== 'shiftly.device.v1')).toEqual([]);
});

test('タブ非表示でセッション終了（共用端末の個人情報残存対策）', async ({ page }) => {
  await open(page);
  await login(page, 'サンプル 花子', '573024');
  await expect(page.getByText('サンプル 花子さん').first()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
});

test('主要タップ領域は 44px 以上', async ({ page }) => {
  await open(page);
  for (const b of await page.locator('.k-tile').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await login(page, 'サンプル 花子', '573024');
  for (const b of await page.locator('.k-act, .k-tabs button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test('委任された管理メニュー（店長代理: 追加認証あり）', async ({ page }) => {
  await open(page);
  await login(page, 'デモ 店長代理', '715246');
  await page.getByRole('tab', { name: '管理メニュー' }).click();
  await expect(page.getByText('店長から委任された権限の範囲で操作できます')).toBeVisible();
});

test('横スクロールが発生しない', async ({ page }) => {
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
