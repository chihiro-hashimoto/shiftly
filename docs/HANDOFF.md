# HANDOFF（セッション引き継ぎ）

> 新しいセッションは、まずこのファイルを読み、次に `docs/implementation-status.md`・`docs/decisions.md`・`AGENTS.md` を読むこと。
> 元の指示は統合マスタープロンプト v1.2 と追加仕様変更指示 v1.3。要点は `docs/requirements.md` にあり、再入力は不要。

## 現在の工程
- v1.2: 工程 A〜L 完了（F01〜F37 の実装・モック／エミュレーション検証・E2E・独立レビュー R-1・Codex 監査 C-1）
- **v1.3（2026-11-25）**: 実装・テスト・文書更新を完了（F38〜F41 を追加。docs/requirements.md「v1.3 の変更」）。Codex 監査 C-2（累計 2 回目）は docs/review-log.md を参照
- 残: Google 実環境・iPad 実機での検証（ユーザーの実機・検証用アカウントが必要。docs/live-verification.md）

## リポジトリ / ブランチ / PR / CI
- リポジトリ: https://github.com/chihiro-hashimoto/shiftly（Private）
  - 所有権の移譲先予定: https://github.com/chihirohashimotoac-coder/shiftly（ユーザーが実施。作業セッションでは移譲・コピー・新規作成をしない）
- ブランチ:
  - `claude/inspiring-einstein-73ks5s`: v1.2（PR https://github.com/chihiro-hashimoto/shiftly/pull/1、ドラフト、`b093a80`）
  - `claude/friendly-dijkstra-bt20os`: **v1.3**（`b093a80` から分岐。v1.2 の全コミットを含む）。v1.3 の新規セッションは v1.2 のブランチへ直接 push できない設定のため、別ブランチ・別 PR とした
- PR の関係: v1.3 の PR は PR #1 のブランチ（`claude/inspiring-einstein-73ks5s`）を base にした「積み重ね」の PR（差分は v1.3 の変更のみ）。統合方法は次のいずれか（ユーザーの判断）
  1. v1.3 の PR を先に PR #1 のブランチへマージ → PR #1 を main へマージ（v1.2＋v1.3 が main に入る）
  2. PR #1 をマージ後、v1.3 の PR の base を main に変更してマージ
- 最新コミット: `git log -1` で確認
- CI: `.github/workflows/ci.yml`（push・PR で実行）。結果は PR を参照

## 確定済み仕様（主なもの）
- 構成: Shiftly-Staff（= Core。v1.2 までの名称 Shiftly-Kiosk。匿名アクセス・Google 所有者として実行、DB 唯一の更新経路。店舗 iPad の画面と管理者モード）＋ Shiftly-Admin（Google 所有者のみ、HMAC 署名で Core へ転送）＋ Shiftly Setup（Apps Script API で自動構築）。詳細は docs/architecture.md と docs/decisions.md
- 認証（v1.3）: Google 所有者（構築・更新・復旧・管理者パスワードの設定）／ 管理者モード（店舗 iPad の「管理者ページ」＋管理者パスワード、無操作 5 分、重要操作は再認証）／ スタッフ（氏名＋PIN。PIN は任意。未設定は本人未確認）。docs/security.md
- スコープ: Core は drive.file / script.external_request / script.scriptapp / userinfo.email。Sheets・Drive は高度なサービスで扱う（SpreadsheetApp は使わない）
- 給与: docs/payroll-specification.md（BigInt 有理数、未設定条件があれば確定禁止、法令ルールセットを版管理）。v1.3: シフト基準（§2.5）・予定休憩は取得確認したもののみ控除（§2.6）

## 実装済み機能 ID（モックで検証済み。実環境は未検証）
- F01〜F41 のすべてについて実装あり（F38〜F41 は v1.3）。状況は docs/implementation-status.md
- 未実装として明示しているもの: 変形労働時間制等、時間単位年休、標準報酬日額方式、出来高払の割増、日割の規定、環境間のデータ移行の自動化

## 未解決・未確認
1. Google 実環境での検証: ユーザーが検証用アカウントで実施（手順と記録表: docs/live-verification.md。v1.3 の L14〜L17 を追加）。結果待ち
2. iPad 実機（Safari、ホーム画面）での検証: **ユーザーの実機が必要**（管理者モードの終了動作・PIN 入力・休憩確認ダイアログを含む）
3. （解決）Codex 監査1 #8: v1.3 の休憩仕様で対応（docs/review-log.md、D-017）
4. 未確定の業務条件（docs/requirements.md「未確定事項」）は管理者が設定画面で登録する
5. v1.3 で追加した確認待ちの事項: 管理者パスワードの初期設定（Google 所有者が Shiftly-Admin で設定）、既存店舗の時間基準（既定はシフト基準。実績基準に戻す場合は店舗設定）

## テスト結果（直近の実行）
- 下の「v1.3 検証結果」を参照（docs/test-plan.md に観点）

## 次に実行する作業
1. Codex 監査 C-2 の指摘を確認・修正し、再検証（docs/review-log.md）
2. ユーザーから実環境検証の記録（docs/live-verification.md の表）を受け取り、technical-verification.md に反映・NG を修正
3. PR の統合方法をユーザーが決定（上記）

## レビュー
- 独立レビュー R-1（Claude エージェント、Codex ではない）: 指摘 12 件をすべて修正（docs/review-log.md）
- Codex 監査 C-1: 指摘 15 件。14 件修正、#8 は v1.3 で対応（docs/review-log.md、原文 docs/reviews/codex-audit-1.md）
- Codex 監査 C-2（v1.3 実装後）: docs/review-log.md

## 累計 Codex 監査回数
- **累計 1 回**（上限 5 回。6 回目以降はユーザー承認が必要）。v1.3 実装後の監査を実施したら 2 回目として更新する
  - 1 回目: 2026-11-24、対象 `50156ae`。開発コンテナに Codex CLI 0.167.0 を一時導入し、ユーザー本人がブラウザでデバイス認証。`codex exec --sandbox read-only`
