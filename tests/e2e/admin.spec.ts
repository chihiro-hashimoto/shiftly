/** Google 所有者の管理画面の巡回 E2E（プレビュー: モック Core）。全ページでエラーがなく、横スクロールが発生しないこと
 * v1.3: 「給与条件」の独立したナビゲーションを廃止（スタッフ・権限から開く）、「申請・確認」を追加 */
import { expect, test } from '@playwright/test';

const PAGES = ['ダッシュボード', '勤怠', '申請・確認', 'シフト', '有給休暇', '通知', '給与計算', '給与明細', '人件費・予算', 'データ出力', 'スタッフ・権限', '店舗端末', '店舗設定', '監査ログ', 'バックアップ', 'システム・更新'];

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

test('管理者は勤怠を修正でき、修正履歴に理由が残る', async ({ page }) => {
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

test('D-026: 復元の後は「画面を読み込み直してください」を表示し、読み込み直すと最新の世代で操作できる', async ({ page, isMobile }) => {
  await page.goto('/preview.html?view=admin');
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  const open = async (name: string) => {
    if (isMobile) {
      const menu = page.getByRole('button', { name: 'メニュー' });
      if (await menu.isVisible()) await menu.click();
    }
    await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  };
  await open('バックアップ');
  await page.getByRole('button', { name: '今すぐバックアップ' }).click();
  await page.getByRole('button', { name: 'このバックアップから復元' }).first().click();
  await page.getByPlaceholder('復元する').fill('復元する');
  await page.getByRole('button', { name: '復元を実行' }).click();
  // 復元の応答（新しい世代）を受け取った画面は、古い画面として読み込み直しを案内する
  const dialog = page.getByRole('alertdialog', { name: '画面を読み込み直してください' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '読み込み直す' }).click();
  await expect(dialog).toHaveCount(0);
  // 画面全体を作り直す（開いていたページは URL の指定どおり表示する）。最新の世代で読み込んだ画面では案内は出ない
  await expect(page.getByRole('heading', { name: 'バックアップ', level: 1 })).toBeVisible();
  await open('店舗設定');
  await page.waitForTimeout(400);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});
