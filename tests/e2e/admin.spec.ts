/** 店長用管理画面の巡回 E2E（プレビュー: モック Core）。全ページでエラーがなく、横スクロールが発生しないこと */
import { expect, test } from '@playwright/test';

const PAGES = ['ダッシュボード', '勤怠', 'シフト', '有給休暇', '通知', '給与計算', '給与明細', '給与条件', '人件費・予算', 'データ出力', 'スタッフ・権限', '店舗端末', '店舗設定', '監査ログ', 'バックアップ', 'システム・更新'];

test('全ページを表示してもエラーが出ない', async ({ page, isMobile }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && errors.push(m.text()));
  await page.goto('/preview.html?view=admin');
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  for (const name of PAGES) {
    if (isMobile) {
      const menu = page.getByRole('button', { name: 'メニュー' });
      if (await menu.isVisible()) await menu.click();
    }
    await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('.callout-bull[role="alert"]')).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${name} の横スクロール`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test('店長は勤怠を修正でき、修正履歴に理由が残る', async ({ page }) => {
  await page.goto('/preview.html?view=admin');
  const menu = page.getByRole('button', { name: 'メニュー' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name: '勤怠', exact: true }).click();
  await page.getByRole('button', { name: '明細・修正' }).first().click();
  await page.getByRole('button', { name: '打刻を追加' }).click();
  await page.getByLabel(/理由/).fill('E2E: 打刻漏れの補正');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('E2E: 打刻漏れの補正')).toBeVisible();
});
