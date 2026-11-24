/** Shiftly Setup 画面（デモ: Google には接続しない）の E2E */
import { expect, test } from '@playwright/test';

test('セットアップの開始 → 権限承認待ち → 完了 → URL と QR の表示', async ({ page }) => {
  await page.goto('/preview.html?view=setup');
  await expect(page.getByRole('heading', { name: /Google アカウントに準備します/ })).toBeVisible();
  await page.getByLabel('店舗名').fill('デモ店舗');
  await page.getByRole('button', { name: 'セットアップを開始' }).click();
  await expect(page.getByText('店長の操作が必要です')).toBeVisible();
  await expect(page.getByRole('link', { name: 'スクリプトエディタを開く' })).toHaveAttribute('href', /script\.google\.com\/home\/projects\//);
  await page.getByRole('button', { name: '確認して続行' }).click();
  await expect(page.getByText('店長の操作が必要です')).toBeVisible();
  await page.getByRole('button', { name: '確認して続行' }).click();
  await expect(page.getByRole('heading', { name: 'Shiftly の準備ができました' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'スタッフ用URLのQRコード' })).toBeVisible();
});
