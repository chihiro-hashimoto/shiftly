# HANDOFF（セッション引き継ぎ）

> 新しいセッションは、まずこのファイルを読み、次に `docs/implementation-status.md`・`docs/decisions.md`・`AGENTS.md` を読むこと。
> 元の指示は統合マスタープロンプト v1.2。要点は `docs/requirements.md` にあり、再入力は不要。

## 現在の工程
- 工程 A〜K 完了（実装・モック／エミュレーション検証・E2E・独立レビュー修正）
- 工程 L: PR 作成済み（ドラフト）。Codex 監査は Codex CLI がないため未実施
- 残: Google 実環境・iPad 実機での検証（ユーザー承認・実機が必要）

## リポジトリ / ブランチ / PR / CI
- リポジトリ: https://github.com/chihiro-hashimoto/shiftly（Private）
  - 指示書の記載は `chihirohashimotoac-coder/shiftly`。本セッションが操作できるのは `chihiro-hashimoto/shiftly` のみ（**ユーザー確認事項**）
- ブランチ: `claude/inspiring-einstein-73ks5s`（main は Initial commit のまま）
- 最新コミット: `git log -1` で確認
- PR: https://github.com/chihiro-hashimoto/shiftly/pull/1（ドラフト。main へのマージはユーザー承認後）
- CI: `.github/workflows/ci.yml`。コミット `58e61bf` で成功（run #18、2026-11-24）

## 確定済み仕様（主なもの）
- 構成: Shiftly-Kiosk（= Core。匿名アクセス・店長として実行、DB 唯一の更新経路）＋ Shiftly-Admin（本人のみ、HMAC 署名で Core へ転送）＋ Shiftly Setup（Apps Script API で自動構築）。詳細は docs/architecture.md と docs/decisions.md
- スコープ: Core は drive.file / script.external_request / script.scriptapp / userinfo.email。Sheets・Drive は高度なサービスで扱う（SpreadsheetApp は使わない）
- 給与: docs/payroll-specification.md（BigInt 有理数で計算、未設定条件があれば確定禁止、法令ルールセットを版管理）

## 実装済み機能 ID（モックで検証済み。実環境は未検証）
- F01〜F37 のすべてについて実装あり。状況は docs/implementation-status.md
- 未実装として明示しているもの: 変形労働時間制等、時間単位年休、標準報酬日額方式、出来高払の割増、日割の規定、環境間のデータ移行の自動化

## 未解決・未確認
1. Google 実環境での検証（docs/technical-verification.md §4 の 11 項目）: **ユーザーの承認と検証用アカウントが必要**
2. iPad 実機（Safari、ホーム画面）での検証: **ユーザーの実機が必要**
3. Codex 独立監査: この環境に Codex CLI がない（`codex: command not found`）。**未実施**
4. 対象リポジトリ名の差異（D-001）
5. 未確定の業務条件（docs/requirements.md「未確定事項」）は店長が設定画面で登録する

## テスト結果（直近の実行）
- `npm run verify`（2026-11-24 実行、exit 0）: lint・typecheck 合格／単体 86・統合 33・セキュリティ 27・E2E 44 件すべて合格
  - 単体に給与ゴールデン 50 件・レビュー回帰 3 件を含む
  - 統合に Core API・Setup 状態機械・ビルド済み GAS バンドルのエミュレーションを含む
  - E2E は Kiosk・Setup・管理画面全 16 ページ（iPad 横・縦／PC 1440／スマホ 390、Chromium）

## 次に実行する作業
1. （完了）管理画面全ページ・独立レビュー修正・verify・PR 作成
2. （完了）CI 成功を確認
3. Codex 監査（Codex CLI が使える環境・ユーザーの認証が必要）
4. ユーザーの承認後: 検証用 Google アカウントで実環境検証を行い、technical-verification.md に実測結果を追記

## レビュー
- 独立レビュー R-1（Claude エージェント、Codex ではない）: 指摘 12 件をすべて修正（docs/review-log.md）

## 累計 Codex 監査回数
- **0 回**（Codex CLI を利用できないため未実施。上限は 5 回）
