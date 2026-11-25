/**
 * 店舗 iPad（Staff）の E2E（プレビュー: メモリ上のモック Core）
 * ※ Playwright の Chromium による検証。WebKit / iPad 実機での検証ではない
 * v1.3: PIN は可変長（4〜12桁）のため、入力後に「確定」を押す。休憩ボタンは標準（予定休憩方式）では表示しない
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
  await page.getByRole('button', { name: '確定' }).click();
}

const ADMIN_PW = 'Demo#Manager2026';

async function enterAdmin(page: Page, pw = ADMIN_PW) {
  await page.getByRole('button', { name: '管理者ページ' }).click();
  await page.getByLabel('管理者パスワード').fill(pw);
  await page.getByRole('button', { name: '管理者モードに入る' }).click();
}

async function openAdminNav(page: Page, name: string) {
  // 管理画面の描画を待ってから（スマホ幅では）メニューを開く
  await expect(page.locator('.a-head h1')).toBeVisible();
  const menu = page.getByRole('button', { name: 'メニュー' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: '管理メニュー' }).getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
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

test('休憩打刻方式: 休憩中の退勤は確認ダイアログ', async ({ page }) => {
  await open(page);
  // 前提: 管理者モードの店舗設定で「休憩打刻」に切り替える（標準は予定休憩方式で休憩ボタンを表示しない）
  await enterAdmin(page);
  await openAdminNav(page, '店舗設定');
  const sec = page.locator('#st-worktime');
  await sec.getByRole('combobox').nth(1).selectOption('punch');
  await sec.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('設定を保存しました')).toBeVisible();
  await page.getByRole('button', { name: 'スタッフ画面へ戻る' }).click();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
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
  for (const b of await page.locator('.sf-tile').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await login(page, 'サンプル 花子', '573024');
  for (const b of await page.locator('.sf-act, .sf-tabs button').all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test('委任された管理メニュー（管理者代理: 追加認証あり）', async ({ page }) => {
  await open(page);
  await login(page, 'デモ 管理者代理', '715246');
  await page.getByRole('tab', { name: '管理メニュー' }).click();
  await expect(page.getByText('管理者から委任された権限の範囲で操作できます')).toBeVisible();
});

test('予定休憩方式: 休憩ボタンを表示せず、退勤時に休憩の取得状況を確認（通常は1回のタップ）', async ({ page }) => {
  await open(page);
  await login(page, 'サンプル 花子', '573024');
  await expect(page.getByRole('button', { name: /^休憩開始/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^出勤/ }).click();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible({ timeout: 6000 });
  await login(page, 'サンプル 花子', '573024');
  await page.getByRole('button', { name: /^退勤/ }).click();
  await expect(page.getByRole('dialog', { name: /休憩は予定どおり取れましたか/ })).toBeVisible();
  await page.getByRole('button', { name: '予定どおり取得して退勤' }).click();
  await expect(page.getByText(/退勤しました/)).toBeVisible();
});

test('PIN 未設定: 名前の選択だけで出勤でき、給与・勤怠の詳細は表示しない', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /デモ 三郎/ }).click();
  await expect(page.getByText('PIN が設定されていないため、本人確認ができていません')).toBeVisible();
  await expect(page.getByRole('tab', { name: '給与', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '自分の勤怠' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: '勤怠の修正・申請' })).toBeVisible();
  await page.getByRole('button', { name: /^出勤/ }).click();
  await expect(page.getByText(/出勤しました/)).toBeVisible();
});

test('PIN 設定済みのスタッフは PIN を入力しないとログインできない', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /サンプル 花子/ }).click();
  await expect(page.getByRole('dialog', { name: /PIN 入力/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '確定' })).toBeDisabled();
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByRole('button', { name: /^出勤/ })).toHaveCount(0);
});

test('勤怠確認・修正: 本人が出退勤を修正でき、元の打刻が残る', async ({ page }) => {
  await open(page);
  await login(page, 'サンプル 一郎', '482913');
  await page.getByRole('tab', { name: '自分の勤怠' }).click();
  await expect(page.getByText(/直近30日の実働/)).toBeVisible();
  await page.getByRole('button', { name: '出退勤を修正' }).first().click();
  await page.getByLabel('修正理由（必須）').fill('E2E: 退勤の押し忘れ');
  await page.getByRole('button', { name: '保存' }).click();
  // 変更がない場合はサーバーが拒否する（原本の値のままでは修正にならない）
  await expect(page.getByRole('alert')).toContainText('修正内容が現在の記録と同じです');
});

test('管理者ページ: 誤ったパスワードは拒否、正しいパスワードで管理者モード → スタッフ画面へ戻ると管理情報を残さない', async ({ page }) => {
  await open(page);
  await enterAdmin(page, 'Wrong#Password99');
  await expect(page.getByRole('alert')).toContainText('正しくありません');
  await page.getByLabel('管理者パスワード').fill(ADMIN_PW);
  await page.getByRole('button', { name: '管理者モードに入る' }).click();
  await expect(page.getByRole('region', { name: '管理者モード' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ダッシュボード', level: 1 })).toBeVisible();
  // Google 所有者に限定した「システム・更新」と、廃止した「給与条件」は表示しない
  const menu = page.getByRole('button', { name: 'メニュー' });
  if (await menu.isVisible()) await menu.click();
  const nav = page.getByRole('navigation', { name: '管理メニュー' });
  await expect(nav.getByRole('button', { name: '申請・確認', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'システム・更新', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: '給与条件', exact: true })).toHaveCount(0);
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'スタッフ画面へ戻る' }).click();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
  await expect(page.getByRole('region', { name: '管理者モード' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toHaveCount(0);
  // 端末に管理者のトークン・業務データを保存していない
  const keys = await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)));
  expect(keys.filter((k) => k !== 'shiftly.device.v1')).toEqual([]);
});

test('Codex 監査2 #9: 管理者パスワードの送信直後にキャンセルすると、遅れて届いた応答でも管理者モードにならない', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '管理者ページ' }).click();
  await page.getByLabel('管理者パスワード').fill(ADMIN_PW);
  await page.getByRole('button', { name: '管理者モードに入る' }).click();
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await page.waitForTimeout(800);
  await expect(page.getByRole('region', { name: '管理者モード' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
});

test('Codex 監査3 #5: PIN の確定直後にキャンセルすると、遅れて届いた応答でも本人画面を開かない', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: /サンプル 花子/ }).click();
  for (const d of '573024') await page.getByRole('button', { name: d, exact: true }).click();
  await page.getByRole('button', { name: '確定' }).click();
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await page.waitForTimeout(800);
  // 本人画面（氏名・状態の表示とログアウトボタン）が開いていない
  await expect(page.locator('.sf-state')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ログアウト' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
});

test('管理者モード: タブ非表示（バックグラウンド）で管理者モードを終了', async ({ page }) => {
  await open(page);
  await enterAdmin(page);
  await expect(page.getByRole('region', { name: '管理者モード' })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
});

test('管理者モード: 再読み込みでスタッフ画面に戻る（管理者のトークンを保持しない）', async ({ page }) => {
  await open(page);
  await enterAdmin(page);
  await expect(page.getByRole('region', { name: '管理者モード' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'スタッフを選択' })).toBeVisible();
  await expect(page.getByRole('region', { name: '管理者モード' })).toHaveCount(0);
});

test('管理者モード: スタッフ・権限から対象スタッフの時給ルールを開ける', async ({ page }) => {
  await open(page);
  await enterAdmin(page);
  await openAdminNav(page, 'スタッフ・権限');
  await page.getByRole('button', { name: 'サンプル 花子さんの時給ルール' }).click();
  await expect(page.getByTestId('pc-target')).toContainText('サンプル 花子（時給制）');
  await page.getByRole('button', { name: '← スタッフ一覧に戻る' }).click();
  await expect(page.getByRole('heading', { name: 'スタッフ一覧' })).toBeVisible();
});

test('横スクロールが発生しない', async ({ page }) => {
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
