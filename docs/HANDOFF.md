# HANDOFF（セッション引き継ぎ）

> 新しいセッションはまずこのファイルと `docs/implementation-status.md`・`docs/decisions.md` を読むこと。
> 元の指示: 統合マスタープロンプト v1.2（要点は `docs/requirements.md`）。

## 現在の工程
- 工程A〜C の途中（基盤・共有ドメイン・Core バックエンド完了。GAS アダプタ・フロントエンド・Setup は作業中）

## 作業ブランチ / リポジトリ
- リポジトリ: https://github.com/chihiro-hashimoto/shiftly（Private）
  - ※指示書の記載は `chihirohashimotoac-coder/shiftly`。本セッションで操作権限があるのは `chihiro-hashimoto/shiftly` のみ（ユーザー確認事項）
- ブランチ: `claude/inspiring-einstein-73ks5s`
- PR: 未作成

## 実装済み（モック検証のみ。Google 実環境は未検証）
- 共有ドメイン: 勤怠・労働時間区分・給与計算・有給・人件費・通知・CSV/XLSX・暗号（`src/shared`）
- Core API: 約80操作（`src/backend`）、メモリ上のモック環境（`src/backend/mock.ts`）

## テスト結果（直近）
- `npx vitest run`: unit 83 / integration 22 / security 24 = 129 合格
- lint / typecheck: 合格

## 次に実行する作業
1. GAS アダプタ（`src/backend/gas/`）と GAS エントリ（Core=Kiosk, Admin, Setup）
2. フロントエンド（Kiosk / Admin / Setup）とモックプレビュー、E2E
3. Setup（Apps Script API による自動構築）・更新・ロールバック
4. 文書一式、CI、Codex 監査（CLI 未導入）、PR

## 累計 Codex 監査回数
- 0 回（Codex CLI はこの環境に未導入）
