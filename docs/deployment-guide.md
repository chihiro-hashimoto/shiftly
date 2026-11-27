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
| `dist/gas/release.json` | 配布物の SHA-256 一覧 |
| `dist/preview/` | モックで動くプレビュー |

Core と Admin は Setup が自動配置するため、手動で配置するのは Setup のみです（docs/installer-guide.md）。

## 4. プレビューの確認方法（非公開を維持）

- ローカル: `npm run build:preview && npm run preview` → http://127.0.0.1:4173/
- CI: GitHub Actions の Artifacts「shiftly-preview」（リポジトリにアクセスできる人のみ）をダウンロードし、`npx serve` 等でローカル表示
- GitHub Pages 等での公開は行わない（非公開リポジトリ・データ保護のため）

## 5. 本番デプロイ・main へのマージ

- いずれも**ユーザー承認後**に実施。CI 合格・Codex 監査結果の確認・並行運用計画の合意を前提とする
