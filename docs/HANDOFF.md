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
- `npm run verify`（2026-11-25、Codex 監査14 の対応後に実行、exit 0。生成文書の差分なしも確認）: lint・typecheck 合格／単体 97・統合 169・セキュリティ 38・E2E 84 件すべて合格
  - 統合に v1.3（v13.test.ts 47 件: §9.2 の期待値を含む）・Codex 監査2〜6 の回帰（codex-audit-2.test.ts・codex-audit-3.test.ts・codex-audit-6.test.ts・codex-audit-8.test.ts・codex-audit-9.test.ts・codex-audit-10.test.ts・installer.test.ts）・GAS エミュレーション（v1.2 の 32 列シートの読み込みと移行を含む）
  - E2E は店舗 iPad（スタッフ・管理者モード・PIN 未設定・休憩確認）・Google 所有者の管理画面の全ページ・Setup（iPad 横・縦／PC 1440／スマホ 390、Chromium）
- GitHub CI: v1.3 の各コミット（`564a04a`・`d132bd6`・`12ea421`）で成功。最新コミットは PR のチェックを参照
- いずれもモック・エミュレーション・Chromium での検証。**Google 実環境・iPad 実機・WebKit では未検証**

## 次に実行する作業
1. Codex 監査 C-15（C-14 の対応の確認。対象を限定）の指摘 1 件（中）への対応（ユーザーの判断待ち。docs/review-log.md C-15）。ロールバックの戻し先は版の組の記録から選ぶ（D-023）。旧版への巻き戻しは給与計算には非対応（D-022）
2. ユーザーから実環境検証の記録（docs/live-verification.md の表）を受け取り、technical-verification.md に反映・NG を修正
3. PR の統合方法をユーザーが決定（上記）

## レビュー
- 独立レビュー R-1（Claude エージェント、Codex ではない）: 指摘 12 件をすべて修正（docs/review-log.md）
- Codex 監査 C-1: 指摘 15 件。14 件修正、#8 は v1.3 で対応（docs/review-log.md、原文 docs/reviews/codex-audit-1.md）
- Codex 監査 C-2（v1.3 実装後）: 指摘 10 件をすべて修正（docs/review-log.md、原文 docs/reviews/codex-audit-2.md）

## 累計 Codex 監査回数
- **累計 15 回**（承認済みの上限 5 回。6〜15 回目はユーザーの指示で実施。16 回目以降もユーザーの承認が必要）
  - 1 回目: 2026-11-24、対象 `50156ae`。開発コンテナに Codex CLI 0.167.0 を一時導入し、ユーザー本人がブラウザでデバイス認証。`codex exec --sandbox read-only`
  - 2 回目: 2026-11-25、対象 `564a04a`（v1.3 実装後）。Codex CLI 0.167.1、ユーザー本人のデバイス認証。指摘 10 件をすべて修正（docs/review-log.md C-2）
  - 3 回目: 2026-11-25、対象 `d132bd6`（C-2 の修正後の再監査）。C-2 の 6 件解消・4 件未解消＋新規 2 件 → 6 件をすべて修正（docs/review-log.md C-3）
  - 4 回目: 2026-11-25、対象 `12ea421`（C-3 の修正後の再監査）。C-3 の 4 件解消・2 件未解消＋新規 3 件 → 5 件をすべて修正（docs/review-log.md C-4）
  - 5 回目: 2026-11-25、対象 `d43d321`（C-4 の修正後の再監査）。重大 0 件。C-4 の 3 件解消・2 件未解消＋新規 1 件 → 3 件をすべて修正（docs/review-log.md C-5）
  - 6 回目: 2026-11-25、対象 `df70198`（マージ可否の判定）。**判定はマージ不可**。指摘 4 件（高 3 / 中 1）は、ユーザーの指示によりすべて修正（docs/review-log.md C-6）
  - 7 回目: 2026-11-25、対象 `7937e91`（C-6 の修正後のマージ可否の判定）。**判定はマージ不可**。C-6 の 2 件解消・2 件未解消。指摘 2 件（高 2）は、ユーザーの指示によりすべて修正（docs/review-log.md C-7）
  - 8 回目: 2026-11-25、対象 `56d402d`（C-7 の修正後のマージ可否の判定）。**判定はマージ不可**。C-7 の 2 件は解消。新規の指摘 3 件（高 2 / 中 1）は、ユーザーの指示により対応（#1・#3 はコード、#2 は手順書。docs/review-log.md C-8）
  - 9 回目: 2026-11-25、対象 `84af493`（C-8 の対応後のマージ可否の判定）。**判定はマージ不可**。C-8 の 1 件解消・2 件未解消。指摘 3 件（高 2 / 中 1）は、ユーザーの指示により対応（#1・#3 はコード、#2 は手順書。docs/review-log.md C-9・decisions.md D-022）
  - 10 回目: 2026-11-25、対象 `e616d04`（C-9 の対応の確認。対象を限定。マージ可否の判定ではない）。結果は一部未解消または回帰あり（C-9 の 3 件は一部未解消、回帰 2 件: 高 1 / 中 1）。ユーザーの指示によりすべて対応（docs/review-log.md C-10）
  - 11 回目: 2026-11-25、対象 `ae9a959`（C-10 の対応の確認。対象を限定）。C-10 の 3 件解消・2 件未解消。指摘 2 件（高 1 / 中 1）は、ユーザーの指示により対応（#1 はコード、#2 は手順書。docs/review-log.md C-11）
  - 12 回目: 2026-11-25、対象 `fb5603b`（C-11 の対応の確認。対象を限定）。C-11 の 2 件は解消。対応による回帰 3 件（高 1 / 中 2）は、ユーザーの指示により対応し、状態の組み合わせを網羅するテストを追加（docs/review-log.md C-12）
  - 13 回目: 2026-11-25、対象 `ede9758`（C-12 の対応の確認。対象を限定）。C-12 の 3 件は解消。対応による回帰 2 件（高 2）とテストの不足は、ユーザーの指示により版の組を明示的に記録する方式で対応（docs/review-log.md C-13・decisions.md D-023）
  - 14 回目: 2026-11-25、対象 `34ee228`（C-13 の対応の確認。対象を限定）。C-13 の指摘は解消。版の組の記録方式による回帰 3 件（高 2 / 中 1）は、ユーザーの指示により対応（docs/review-log.md C-14）
  - 15 回目: 2026-11-25、対象 `112259a`（C-14 の対応の確認。対象を限定）。C-14 の 3 件は解消。対応による回帰 1 件（中）は未対応（docs/review-log.md C-15）
