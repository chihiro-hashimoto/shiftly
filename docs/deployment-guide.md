# デプロイ・開発環境ガイド

## 1. 環境の分離

| 環境 | 内容 | データ |
|---|---|---|
| 開発・プレビュー | ブラウザ内のモック Core（`npm run dev` / `npm run preview`） | 架空のサンプルのみ（メモリ上） |
| 自動テスト | Vitest（メモリ環境）、GAS エミュレータ、Playwright（プレビュー） | テスト用の架空データ |
| 検証用 Google 環境 | 本番と別の Google アカウントで Setup を実行 | 架空データのみ。**ユーザー承認後に構築** |
| 本番 | 管理者の Google アカウント | 実データ。**ユーザー承認後** |

実データ・認証情報（clasp のログイン情報、OAuth トークン等）を GitHub や開発環境に保存しないこと（.gitignore 済み）。

## 2. コマンド

```bash
npm ci
```
```bash
npm run verify
```
`verify` = lint → typecheck → 単体テスト → フロントエンドビルド → GAS ビルド → プレビュービルド → 統合テスト → セキュリティテスト → E2E

個別: `npm run lint` / `typecheck` / `test` / `test:integration` / `test:security` / `build` / `build:gas` / `build:preview` / `test:e2e` / `docs`（DB スキーマ・権限マトリクスの再生成）

## 3. 成果物

| パス | 内容 |
|---|---|
| `dist/gas-html/` | GAS 用の単一 HTML（staff / admin / setup） |
| `dist/gas/core/` | Shiftly-Staff（Core）: appsscript.json, Code.js, staff.html |
| `dist/gas/admin/` | Shiftly-Admin: appsscript.json, Code.js, admin.html |
| `dist/gas/setup/` | Shiftly Setup: appsscript.json（自己ホスト）, Code.js, Release.js（Core/Admin 同梱）, setup.html, appsscript.hosted.json.txt |
| `dist/gas/setup-hosted/` | **共通 Shiftly Setup（A案。D-029）**の配置用一式: appsscript.json（実行=アクセスしているユーザー・アクセス=Google アカウントを持つ全員・例外のログなし）, Code.js・Release.js・setup.html（`setup/` と同一） |
| `dist/gas/release.json` | 配布物の SHA-256 一覧 |
| `dist/preview/` | モックで動くプレビュー |

Core と Admin は Setup が自動配置するため、手動で配置するのは Setup のみです（docs/installer-guide.md）。

## 4. プレビューの確認方法（非公開を維持）

- ローカル: `npm run build:preview && npm run preview` → http://127.0.0.1:4173/
- CI: GitHub Actions の Artifacts「shiftly-preview」（リポジトリにアクセスできる人のみ）をダウンロードし、`npx serve` 等でローカル表示
- GitHub Pages: 案内ページと架空のデータのデモだけを公開する（「7」。D-030。2026-11-27 にリポジトリが公開の状態であることを確認した後の変更）

## 5. 本番デプロイ・main へのマージ

- いずれも**ユーザー承認後**に実施。CI 合格・Codex 監査結果の確認・並行運用計画の合意を前提とする

## 6. 共通 Shiftly Setup の公開・更新（開発者が行う。A案。D-029）

> 本番の公開（一般の利用者への URL の配布）は**ユーザーの承認後**。まず限定公開（OAuth の公開ステータス「テスト」＋テストユーザー）で docs/live-verification.md L41〜L49 を確認する。

### 6.1 一度だけ行う準備
1. 開発者の Google アカウント（店舗の業務データを置かないアカウント）で、docs/google-api-setup.md「2」（標準 Cloud プロジェクト・Apps Script API と Drive API の有効化・OAuth の同意画面・テストユーザー）
2. リポジトリの main（統合後）で配置物を作る
```bash
npm ci
```
```bash
npm run build && npm run build:gas
```
3. https://script.google.com/ で新しいプロジェクト「Shiftly Setup」を作成し、「プロジェクトの設定」で「appsscript.json をエディタで表示」をオンにする
4. `dist/gas/setup-hosted/` の 4 ファイルを配置する（clasp を使う場合は、このフォルダで `npx @google/clasp create --type webapp --title "Shiftly Setup"` → `npx @google/clasp push`。clasp のログイン情報 `.clasprc.json` はコミットしない。ブラウザの場合は `appsscript.json`・`Code`（Code.js）・`Release`（Release.js）・HTML の `setup`（setup.html）を貼り付け）
5. 「プロジェクトの設定」→「Google Cloud Platform（GCP）プロジェクト」→ 1 のプロジェクト番号に変更
6. 「デプロイ」→「新しいデプロイ」→ 種類: ウェブアプリ、**次のユーザーとして実行: ウェブアプリケーションにアクセスしているユーザー**、**アクセスできるユーザー: Google アカウントを持つ全員** → デプロイ → 表示された URL（…/exec）が**共通 Setup の URL**。デプロイ ID を記録する
7. 開発者自身（またはテストユーザー）で URL を開き、承認の画面と「構築の内容」が表示されることを確認する

### 6.2 共通 Setup の更新（URL を変えない）
- 新しい版の配置物を 4 と同じ方法で上書きし、「デプロイ」→「デプロイを管理」→ 既存のデプロイを編集 →「バージョン: 新バージョン」→ デプロイ（**新しいデプロイを作らない**。デプロイ ID と URL が維持される）
- 共通 Setup は初回の構築だけを行い、構築済みの環境を変更しない（D-027。別の版の Setup で開いた環境は「この Setup では変更しません」で止まる）。構築済みの環境の更新は docs/update-rollback.md「2」（Google 所有者の保守作業）
- 配置は、リポジトリの main（GitHub Release の配布物と同じコミット）から作ったものだけにする。Setup のコードは利用者の権限で動くため、未レビューの変更を配置しない
- 共通 Setup のスクリプトの共有（編集者の追加）はしない。開発者のアカウントの 2 段階認証を必須にする

### 6.3 一般公開
- OAuth の審査（docs/google-api-setup.md「5」）の完了・ユーザーの承認・L41〜L49 の確認の後に、OAuth の公開ステータスを「本番環境」に切り替える。それまでは限定公開（テストユーザーだけ）

## 7. GitHub Pages（案内ページ＋デモ。D-030）

公開物は `dist/pages/`（`npm run build:preview && npm run build:pages`）: `index.html`（site/index.html）と `demo/`（架空のデータのプレビュー）。GAS の配布物・業務データ・秘密情報は含めない。

### 7.1 最初の公開（リポジトリの管理者が行う）
1. GitHub のリポジトリ → **Settings → Pages** →「Build and deployment」の **Source を「GitHub Actions」** にする
2. main への統合の前に作業ブランチから公開する場合: **Settings → Environments → github-pages** →「Deployment branches and tags」に `claude/determined-ptolemy-xuuec8` を追加する（既定では main だけが許可される）
3. **Actions → Pages** のワークフローを再実行する（または作業ブランチに push する）→ 完了すると Settings → Pages に公開の URL（`https://<アカウント>.github.io/shiftly/`）が表示される
4. main への統合の後は、2 で追加した作業ブランチを外す

### 7.2 共通 Setup の URL の掲載
- `site/config.json` の `setupUrl` に共通 Setup の URL（`https://script.google.com/macros/s/…/exec`。docs/deployment-guide.md「6.1」の 6）を入れて push する。限定公開の間は、案内ページに「限定公開中」と表示される
- 一般公開（OAuth の審査の後）までは、テストユーザー以外には使えない

### 7.3 注意
- Pages は誰でも閲覧できる。業務データ・実在のスタッフの情報・秘密情報を `site/` に置かない
- 所有権の移譲の後は、移譲先のリポジトリで 7.1 をやり直す（URL が変わる）
