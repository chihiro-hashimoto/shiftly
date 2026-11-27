/** Google 所有者の管理画面の巡回 E2E（プレビュー: モック Core）。全ページでエラーがなく、横スクロールが発生しないこと
 * v1.3: 「給与条件」の独立したナビゲーションを廃止（スタッフ・権限から開く）、「申請・確認」を追加 */
import { expect, test } from '@playwright/test';

const PAGES = ['ダッシュボード', '勤怠', '申請・確認', 'シフト', '有給休暇', '通知', '給与計算', '給与明細', '人件費・予算', 'データ出力', 'スタッフ・権限', '店舗端末', '店舗設定', '監査ログ', 'バックアップ', 'システム・保守'];

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

// D-026 の「画面を読み込み直してください」の表示は、旧版では画面の復元の操作で確かめていた。v1.3 ではアプリ内の復元を提供しない
// （D-027 B案。世代が変わるのは Google 所有者の保守作業の終了だけで、画面からは操作できない）ため、画面の表示の確認は
// tests/unit/client-epoch.test.ts（世代の固定と検知）と tests/integration/view-epoch.test.ts（サーバーの拒否）で行う
test('D-027: バックアップ画面に復元のボタンがなく、保守作業の案内を表示する（バックアップの作成・履歴は使える）', async ({ page, isMobile }) => {
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
  await expect(page.getByText('データの復元は安全性確保のため、Google所有者による保守作業として行います。')).toBeVisible();
  await page.getByRole('button', { name: '今すぐバックアップ' }).click();
  await expect(page.getByText('バックアップを作成しました')).toBeVisible();
  await expect(page.getByRole('button', { name: /復元/ })).toHaveCount(0);
  await open('システム・保守');
  await expect(page.getByRole('heading', { name: /アップデート・データの復元（保守作業）/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /DB 更新|更新を完了|メンテナンスを解除/ })).toHaveCount(0);
});
