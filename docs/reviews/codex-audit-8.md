# Codex 独立監査 8 回目（累計）: マージ可否の判定（C-7 の修正後）

> 2026-11-25 実行。`codex exec --sandbox read-only`、対象 `56d402d`。プロンプト: docs/reviews/codex-audit-8-prompt.md。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

マージ不可

- 判定対象は `56d402dbb56cb7a2a1ae9b26053cd0bd66d2863a` と `origin/main` の統合差分です。実際の HEAD は `13157031a3018699436438002e45cdd27a7a2828` で、追加は監査依頼文の Markdown 1 件でした。作業ツリーはクリーンで、PR #1 の指定コミットは判定対象の祖先です。
- バックアップ復元で確定済み給与が稼働 DB から消え、同じ給与を再確定できることをメモリ上で再現しました。旧版への復旧後には未取得の予定休憩が再び控除される経路もあります。
- 読み取り専用で実行した lint・型検査・単体・統合・セキュリティ検証は合格しました。指定 SHA の PR #2 の CI は完了状態 `cancelled` で、成功を確認できませんでした。 [GitHub Actions 実行 #48](https://github.com/chihiro-hashimoto/shiftly/actions/runs/45555995026)
- これは Codex CLI による独立判定です。GitHub の自動レビューとは別です。

### 7 回目の監査指摘

1. **解消** — 移行要求前に保護状態を保存し、配備照会に失敗した再開は変更前に中断します。承認待ちの再開も移行前に両配備を照合します。 [installer.ts](/home/user/shiftly/src/setup/installer.ts:496) · [回帰テスト](/home/user/shiftly/tests/integration/installer.test.ts:592)
2. **解消** — v1.3 Setup が作る更新前バックアップには `maintenance=on` が入ります。バックアップの内容をモックで確認し、v1.2 Core がその値を保持して復元候補を有効化することをコードで確認しました。旧 Core を動かした通し検証は未実施です。 [回帰テスト](/home/user/shiftly/tests/integration/installer.test.ts:680) · [v1.2 の復元処理](https://github.com/chihiro-hashimoto/shiftly/blob/b093a808f2270a947dfa4f78597fe9a690a7e799/src/backend/handlers/ops.ts#L473-L519)

### マージを止める指摘

1. **高 — 復元後に確定済み給与を再確定できる。** 時給 1,200 円で 09:00〜14:00 の勤務を登録し、控除なしで締めた期間について、確定直前にバックアップを取得します。初回は 6,000 円で確定します。期待は復元後も確定結果が引き継がれるか、照合が終わるまで再確定が止まることです。実際には復元時の整合性チェックが成功し、給与結果が 0 件になり、再度 6,000 円をリビジョン 1 として確定できました。メモリ上の Core API で再現済みです。バックアップ取得後に確定・訂正・発行した給与が対象で、支払い済みの期間を再処理するおそれがあります。確定結果・リビジョン・明細の参照を復元候補で照合し、引き継げない場合は切替または再確定を止めてください。 [復元時の引き継ぎ](/home/user/shiftly/src/backend/handlers/ops.ts:504) · [給与確定](/home/user/shiftly/src/backend/handlers/payroll.ts:52)

2. **高 — v1.2 への手動復旧後、未取得の予定休憩を控除した給与を確定できる。** 時給 1,200 円、09:00〜17:00 の勤務、公開シフトに固定休憩 30 分、実際の休憩はゼロとします。更新後に v1.3 で「取得なし」を記録し、手順書どおり v1.2 へ戻して更新前バックアップを復元します。基本給の期待値は 9,600 円です。旧 Core は「取得なし」の申告を給与に使わず、打刻・手動休憩がなければ固定休憩を控除するため、計算上は 9,000 円になります。旧版の警告を確認済みにすればその額で確定できます。旧版コードの読解と手計算による判定です。旧版での給与確定を再開する前に、影響期間の休憩・勤怠を復元前の記録と照合し、旧版で表現できる形に反映するか、別の給与計算手段へ切り替える手順を設けてください。現行手順は計算規則が変わる旨の注意にとどまります。 [復旧手順](/home/user/shiftly/docs/update-rollback.md:44) · [v1.2 の固定休憩処理](https://github.com/chihiro-hashimoto/shiftly/blob/b093a808f2270a947dfa4f78597fe9a690a7e799/src/shared/attendance.ts#L233-L247) · [v1.2 の給与確定処理](https://github.com/chihiro-hashimoto/shiftly/blob/b093a808f2270a947dfa4f78597fe9a690a7e799/src/backend/handlers/payroll.ts#L62-L70)

3. **中 — 更新前バックアップの失敗後に打刻が停止したままになる。** DB 複製を失敗させると、更新準備は `CONFLICT` を返します。手順書上はメンテナンス解除が期待されますが、先に確定した `on` が残り、解除の書き込みは例外により確定されません。v1.3 Core のモックで `maintenance=true` を確認しました。v1.2 からの更新でも Setup が先に `on` を確定し、準備失敗時は解除せず終了する経路をコードで確認しました。影響は店舗全体の打刻です。準備開始前の状態を記録し、今回開始したメンテナンスだけを、スキーマが一致すると確認できた場合に解除してください。解除できない場合は、画面と手順書に継続状態と復旧操作を表示してください。 [更新準備](/home/user/shiftly/src/backend/handlers/update.ts:24) · [Setup の失敗処理](/home/user/shiftly/src/setup/installer.ts:529) · [手順書](/home/user/shiftly/docs/update-rollback.md:14)

### 検証結果

- lint `exit 0`、型検査 `exit 0`、単体 `96 passed / 1 skipped`、統合 `131 passed`、セキュリティ `38 passed`。テストの終了コードはいずれも `0` でした。ファイルを書き出す XLSX 検証 1 件、ビルド、E2E、`npm run verify` 全体は未実行です。
- 初回構築、正常更新、配備失敗時の自動ロールバックは既存のモックテストで合格しました。承認待ちの再開テストは保存済みの承認待ち状態から配備順を検証しています。実際の v1→v2 は追加型の移行で、破壊的移行の承認待ちに入る通し検証は未実施です。 [インストーラーテスト](/home/user/shiftly/tests/integration/installer.test.ts:183) · [承認待ちの再開テスト](/home/user/shiftly/tests/integration/installer.test.ts:657)
- 給与ゴールデンの既存期待値に変更はありません。照合した v1.3 のシフト外勤務の期待値は区間からの手計算と一致しました。ハーネスの `actual` は旧ケースの前提を維持し、v1.3 の `shift` は別ケースで検証しています。中断再開テストの変更は配備済みという前提を追加しており、アサーションは維持されています。 [給与テスト](/home/user/shiftly/tests/integration/v13.test.ts:45) · [ハーネス](/home/user/shiftly/tests/helpers/harness.ts:44) · [中断再開テスト](/home/user/shiftly/tests/integration/installer.test.ts:460)
- 認証・認可、PIN 未設定時の応答、打刻原本・修正履歴、ジャーナル・冪等性、共用 iPad の終了処理はコードと該当テストを確認しました。コミット履歴のパターン検索では秘密鍵、認証トークン、実在スタッフの業務データに該当するものは見つかりませんでした。
- `git diff --check` は統合差分が `exit 2`（末尾空白 1 件、ファイル末尾の余分な空行 2 件）、v1.3 差分が `exit 2`（末尾空白 1 件）、`7937e91..56d402d` が `exit 0` でした。空白は判定理由に含めていません。

### マージ後・本番利用前

- Google の検証用アカウントで L1〜L17 を実施し、実際の v1.2 Core からの更新、通信中断、旧版へのロールバックと復元、再更新まで記録する。 [実環境検証](/home/user/shiftly/docs/live-verification.md)
- 共用 iPad 実機の Safari／WebKit で、ログアウト、タブ非表示、再読み込み、bfcache 復帰後の情報残留と、機密ファイルの端末保存がないことを確認する。
- 少なくとも 1 給与計算期間は紙のタイムカードと従来の給与計算を並行運用し、全員分を照合する。 [運用ガイド](/home/user/shiftly/docs/operations-guide.md:26)