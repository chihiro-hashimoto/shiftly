# Codex 独立監査 12 回目（累計）: C-11 の対応の確認（対象を限定）

> 2026-11-25 実行。`codex exec --sandbox read-only`、対象 `fb5603b`（対応差分 `ae9a959..fb5603b`）。プロンプト: docs/reviews/codex-audit-12-prompt.md。マージ可否の判定ではない。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

一部未解消または回帰あり

実際の HEAD は `e68d729db00688fb892bf844bbcb0d6a0123af03` でした。指定の `fb5603b38fc4a31e09af5c9bcbcf7dc54d68a441` からの追加は監査依頼文の Markdown 1 件だけで、作業ツリーはクリーンでした。指定どおり `ae9a959..fb5603` を監査しました。 [監査依頼文](/home/user/shiftly/docs/reviews/codex-audit-12-prompt.md)

## 11 回目の指摘

- **#1 解消。** 一部の自動ロールバックが失敗した後の手動再試行は、修正前の Staff／Admin `2／1` から、修正後は更新開始時の `2／2` に戻ってからメンテナンスを解除しました。配備を照会できない場合にメンテナンスが続くこともモックで確認しました。 [戻し先の選択](/home/user/shiftly/src/setup/installer.ts:739) · [解除条件](/home/user/shiftly/src/setup/installer.ts:766)
- **#2 解消。** 前回の再現例だった「休憩を取れなかった」の再申告は、手順⑪が案内する Staff 画面から行えます。62 日の制限、⑬への切替、時給・手当・控除の入力先も文書とコードを照合しました。新たに記載した管理者の確認手順には、以下の回帰があります。 [手順⑪](/home/user/shiftly/docs/update-rollback.md:44) · [申告の受付](/home/user/shiftly/src/backend/handlers/requests.ts:528) · [時給・手当](/home/user/shiftly/src/frontend/admin/pages/Staff.tsx:137) · [控除](/home/user/shiftly/src/frontend/admin/pages/Payroll.tsx:520)

## 対応差分による回帰

1. **高｜配備前に更新が失敗すると、従来の手動巻き戻しが効かない。** Staff／Admin が `2／2`、直前の版が `1／1` の状態で、次の更新を更新前バックアップの通信例外で止めます。その後「直前のバージョンに戻す」を押すと、修正前は `1／1` に戻り、修正後は `2／2` のままメンテナンスを解除します。配備に着手していない更新の失敗記録も戻し先を上書きするため、現行版に障害がある店舗で直前の版を使った復旧ができません。更新の配備を取り消す必要がある場合に開始時の版の組を使い、配備前の失敗では従来の戻し先を使うようにしてください。修正前後のモックで再現しました。 [更新記録の作成](/home/user/shiftly/src/setup/installer.ts:529) · [配備前の例外処理](/home/user/shiftly/src/setup/installer.ts:612) · [戻し先の選択](/home/user/shiftly/src/setup/installer.ts:739)
2. **中｜初回セットアップ直後に巻き戻しを押すと、打刻が止まる。** 戻せる版がまだない状態でも Setup のボタンを押せます。修正前は `1／1` のまま稼働を再開し、修正後は `1／1` のままメンテナンスが継続します。案内どおり再実行しても戻し先は得られません。初回配備の店舗全体で打刻が止まります。メンテナンスを開始する前に両方の戻し先を確認し、版の組がなければ処理を中止して理由を表示してください。修正前後のモックで再現しました。 [Setup のボタン](/home/user/shiftly/src/frontend/setup/SetupApp.tsx:254) · [メンテナンス開始と戻し先](/home/user/shiftly/src/setup/installer.ts:729) · [解除条件](/home/user/shiftly/src/setup/installer.ts:766)
3. **中｜手順⑪の承認画面に「予定どおり取得」の再申告が出ない。** PIN 設定済みのスタッフが未確定勤務で「予定どおり取得」を再申告すると、申告は即時反映され、管理画面の確認一覧から除外されます。たとえば時給 1,200 円、09:00〜17:00、予定どおり 30 分休憩した勤務の期待額は 9,000 円です。実際のコード上の結果は申告の反映と確認行の非表示で、給与額は実行検証していません。この条件の勤務では、手順⑪が求める画面上の承認を完了できません。手順⑪に即時反映される場合の照合方法を記載し、画面上の承認は対象行が表示される申告について案内してください。文書とコードの読解で確認しました。 [手順⑪](/home/user/shiftly/docs/update-rollback.md:44) · [申告状態の決定](/home/user/shiftly/src/backend/handlers/requests.ts:137) · [確認一覧の抽出条件](/home/user/shiftly/src/backend/handlers/requests.ts:853)

差分外で報告対象となる重大事項は確認しませんでした。D-022 の位置づけは判定対象外です。

## 検証結果

- `npm run lint`、`npm run typecheck`、`git diff --check ae9a959..fb5603` は終了コード `0`。
- 追加の回帰テストは、Vitest の代わりに Node のアサーションでメモリ上から実行しました。修正前は `2／1` で失敗し、修正後は合格しました。上記の配備前失敗、初回配備直後、配備照会失敗も同じモックで確認しました。
- ファイル出力を伴う `npm run verify` 全体と `npm run docs`、通常の Vitest スイート、E2E、Google 実環境、iPad 実機は未検証です。

これは Codex CLI による独立した確認です。GitHub の自動レビューとは別です。