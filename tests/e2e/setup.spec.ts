/** Shiftly Setup 画面（デモ: Google には接続しない）の E2E */
import { expect, test } from '@playwright/test';

test('セットアップの開始 → 権限承認待ち → 完了 → URL と QR の表示', async ({ page }) => {
  await page.goto('/preview.html?view=setup');
  await expect(page.getByRole('heading', { name: /Google アカウントに準備します/ })).toBeVisible();
  await page.getByLabel('店舗名').fill('デモ店舗');
  await page.getByRole('button', { name: 'セットアップを開始' }).click();
  // Setup の記録がない場合は、初めての構築であることの確認を求める（D-026。以前の環境の二重作成の防止）
  await page.getByLabel(/初めてです/).check();
  await page.getByRole('button', { name: '確認したので再実行' }).click();
  await expect(page.getByText('管理者の操作が必要です')).toBeVisible();
  await expect(page.getByRole('link', { name: 'スクリプトエディタを開く' })).toHaveAttribute('href', /script\.google\.com\/home\/projects\//);
  await page.getByRole('button', { name: '確認して続行' }).click();
  await expect(page.getByText('管理者の操作が必要です')).toBeVisible();
  await page.getByRole('button', { name: '確認して続行' }).click();
  // 自動では確かめられない項目（プロジェクトの重複）は、所有者の確認を完了の条件にする（D-027・Codex 監査24 A4 による仕様変更。操作の追加）
  await page.getByLabel(/1 つずつであることを確認しました/).check();
  await page.getByRole('button', { name: '確認したので再実行' }).click();
  await expect(page.getByRole('heading', { name: 'Shiftly の準備ができました' })).toBeVisible();
  await expect(page.getByText('所有者が確認:')).toBeVisible();
  await expect(page.getByRole('img', { name: 'スタッフ用URLのQRコード' })).toBeVisible();
});

test('D-027: 完了の後に、アプリの更新・ロールバックの操作を表示しない（保守作業の案内だけ）', async ({ page }) => {
  await page.goto('/preview.html?view=setup');
  await page.getByLabel('店舗名').fill('デモ店舗');
  await page.getByRole('button', { name: 'セットアップを開始' }).click();
  await page.getByLabel(/初めてです/).check();
  await page.getByRole('button', { name: '確認したので再実行' }).click();
  await page.getByRole('button', { name: '確認して続行' }).click();
  await page.getByRole('button', { name: '確認して続行' }).click();
  await page.getByLabel(/1 つずつであることを確認しました/).check();
  await page.getByRole('button', { name: '確認したので再実行' }).click();
  await expect(page.getByRole('heading', { name: 'Shiftly の準備ができました' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'アップデート・保守' })).toBeVisible();
  await expect(page.getByText(/Google 所有者による保守作業として行います/)).toBeVisible();
  await expect(page.getByRole('button', { name: /に更新|直前のバージョンに戻す|更新を再開/ })).toHaveCount(0);
});
