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

// ---- 共通の Shiftly Setup（A案・D-029）。デモ（Google には接続しない） ----
const noHorizontalScroll = async (page: import('@playwright/test').Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

test('A案: 構築の前に、構築先のアカウント・作成するもの・保存先・権限・確認事項を表示する', async ({ page }) => {
  await page.goto('/preview.html?view=setup');
  const plan = page.getByRole('region', { name: '構築の内容' });
  await expect(plan).toBeVisible();
  await expect(plan.getByText(/構築先の Google アカウント/)).toBeVisible();
  await expect(plan.getByText(/owner@example\.invalid/)).toBeVisible();
  await expect(plan.getByText(/あなたの Google ドライブだけに保存します/)).toBeVisible();
  await expect(plan.getByText(/Shiftly が作成したファイルだけ/)).toBeVisible();
  await expect(plan.getByText(/課金（クレジットカード）の登録を求められた場合は中止/)).toBeVisible();
  await noHorizontalScroll(page);
});

test('A案: Apps Script API がオフ → Google の設定画面の案内 → 再確認 → ブラウザでの権限承認・初期化の案内 → 完了と次に行うこと', async ({ page }) => {
  await page.goto('/preview.html?view=setup&apiOff=1');
  await page.getByLabel('店舗名').fill('デモ店舗');
  await page.getByRole('button', { name: 'セットアップを開始' }).click();
  await page.getByLabel(/初めてです/).check();
  await page.getByRole('button', { name: '確認したので再実行' }).click();
  await expect(page.getByRole('alert').getByText('Google Apps Script API がオフになっています')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Google の設定画面を開く' })).toHaveAttribute('href', 'https://script.google.com/home/usersettings');
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: '設定が完了したので再確認' }).click();
  await expect(page.getByText('管理者の操作が必要です')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Google の権限を承認して初期化' })).toHaveAttribute('href', /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/dev#shiftly-init=[0-9a-f]{64}$/);
  await expect(page.getByText(/うまくいかない場合/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'スクリプトエディタを開く' })).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: '確認して続行' }).click();
  await expect(page.getByRole('link', { name: 'Google の権限を承認して接続' })).toHaveAttribute('href', /\/dev#shiftly-init=admin$/);
  await page.getByRole('button', { name: '確認して続行' }).click();
  await page.getByLabel(/1 つずつであることを確認しました/).check();
  await page.getByRole('button', { name: '確認したので再実行' }).click();
  await expect(page.getByRole('heading', { name: 'Shiftly の準備ができました' })).toBeVisible();
  const next = page.getByRole('region', { name: '次に行うこと' });
  await expect(next.getByText(/管理者パスワード/)).toBeVisible();
  await expect(next.getByText(/登録コード/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: '管理画面を開く' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'スタッフ用URLのQRコード' })).toBeVisible();
  await noHorizontalScroll(page);
});

for (const role of ['staff', 'admin'] as const) {
  test(`A案: ブラウザでの${role === 'staff' ? '初期化' : '接続'}の画面（Shiftly-${role === 'staff' ? 'Staff' : 'Admin'} のテスト用 URL で表示）`, async ({ page }) => {
    await page.goto(`/preview.html?view=webinit-${role}`);
    await expect(page.getByRole('heading', { name: role === 'staff' ? 'Shiftly の初期化' : '管理画面の接続' })).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: role === 'staff' ? '初期化する' : '接続する' }).click();
    await expect(page.getByText('完了しました。')).toBeVisible();
    await expect(page.getByText(/Shiftly Setup の画面に戻り、「確認して続行」/)).toBeVisible();
  });
}
