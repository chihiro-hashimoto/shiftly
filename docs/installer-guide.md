# 導入手順（Shiftly Setup）

> **本番導入はユーザー（店長）の承認後に実施**します。まず検証用の Google アカウントで試すことを推奨します。

## 0. 必要なもの

- 店長の Google アカウント（2 段階認証を推奨）
- PC（Chrome / Edge / Safari）
- 店舗の iPad（Safari）
- 事前準備: `docs/google-api-setup.md`（Apps Script API をオン、Setup 用 Cloud プロジェクト）

## 1. Setup の配置（どちらか一方）

### A. 自己ホスト（推奨）— 店長アカウントに Setup を置く

**clasp を使う場合（開発者が代行）**
```bash
npm ci
```
```bash
npm run build && npm run build:gas
```
```bash
cd dist/gas/setup && npx @google/clasp create --type webapp --title "Shiftly Setup" && npx @google/clasp push
```
（clasp は店長アカウントでログインした端末で実行。clasp のログイン情報 `.clasprc.json` はリポジトリにコミットしない）

**ブラウザのみの場合**
1. https://script.google.com/ で「新しいプロジェクト」を作成し、名前を「Shiftly Setup」にする
2. 「プロジェクトの設定」→「appsscript.json をエディタで表示」をオン
3. `dist/gas/setup/` の各ファイルを同名で作成して内容を貼り付け: `appsscript.json`, `Code.gs`（= Code.js）, `Release.gs`（= Release.js）, HTML ファイル `setup`（= setup.html）
4. Cloud プロジェクトの紐づけ（google-api-setup.md §2-5）
5. 「デプロイ」→「新しいデプロイ」→ 種類: ウェブアプリ、実行: 自分、アクセス: 自分のみ → デプロイ

### B. ホスト型 — 配布者のアカウントで公開

`dist/gas/setup/appsscript.hosted.json.txt` を appsscript.json として使い（実行: アクセスしているユーザー、アクセス: Google アカウントを持つ全員）、配布者がデプロイして URL を店長に渡します。Setup のコードは店長の権限で動くため、**配布者を信頼できる場合のみ**利用してください。

## 2. セットアップの実行

1. Setup の URL を店長の Google アカウントで開き、権限を確認して承認
2. 店舗名を入力し「セットアップを開始」
3. 自動工程: アカウント確認 → API 確認 → Shiftly-Kiosk 作成・コード配置・デプロイ
4. **店長の操作①**: 「スクリプトエディタを開く」→ 関数 `shiftlyAuthorize` を選んで「実行」→ 権限を確認して許可（Shiftly が作成したファイルのみ操作する権限）→ Setup に戻り「確認して続行」
   - このとき Google ドライブに `Shiftly/`（00_System〜05_Backup）とデータベースが作成され、日次トリガーが登録されます
5. 自動工程: Shiftly-Admin 作成・配置・デプロイ
6. **店長の操作②**: Admin のエディタで `shiftlyAuthorize` を実行 → 許可 → 「確認して続行」
7. 自動工程: 更新用の接続設定 → 接続・DB 整合性の確認 → 完了
8. 完了画面に表示される **店長用 URL**（ブックマーク）と **スタッフ用 URL の QR コード**を控える

途中で画面を閉じても、次回 Setup を開くと続きから再開します。進捗は Google 側（UserProperties と Drive のレジストリファイル）に保存され、端末には保存しません。

## 3. 初期設定（管理画面）

1. 「店舗設定」: 営業時間、営業日の切替時刻、労働時間制度、週の起算曜日、法定休日、締め日・支払日、最低賃金（公式資料で確認した額と根拠）、有給の賃金算定方法 等 → 「給与規定の確認」
2. 「スタッフ・権限」: スタッフ登録、PIN 設定、必要なら個別権限と管理用パスコード
3. 「給与条件」: 時給ルール・月給・交通費・手当・雇用条件
4. 「店舗端末」: 登録コードを発行

## 4. 店舗 iPad の登録

1. iPad の Safari でスタッフ用 URL（QR）を開く
2. 共有メニューから「ホーム画面に追加」
3. 店長が発行した登録コードを入力
4. **店長の Google アカウントで iPad にログインしないでください**（スタッフ用 URL はログイン不要）

## 5. トラブルシューティング

| 表示 | 原因・対処 |
|---|---|
| Apps Script API が無効です | script.google.com/home/usersettings で API をオン。Setup の Cloud プロジェクトでも API を有効化 |
| 別の Google アカウントで作成されています | 店長のアカウントでログインし直す（取り違え防止） |
| 配布ファイルの検証に失敗 | Setup を正規の配布物で更新 |
| Shiftly-Kiosk に接続できません | `shiftlyAuthorize` を実行したか確認 |
| 作成途中で通信が切れた | Setup を開き直して「続きから実行」。同名（環境 ID 付き）のプロジェクトが二重にある場合、レジストリに記録されていない方は手動で削除可 |
| iPad が「登録されていません」 | Safari のデータ消去等で端末トークンが消えた可能性。管理画面で新しい登録コードを発行して再登録（業務データは消えていません） |
