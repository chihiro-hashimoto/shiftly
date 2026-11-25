# Codex 独立監査 13 回目（累計）: C-12 の対応の確認（対象を限定）

> 2026-11-25 実行。`codex exec --sandbox read-only`、対象 `ede9758`（対応差分 `fb5603b..ede9758`）。プロンプト: docs/reviews/codex-audit-13-prompt.md。マージ可否の判定ではない。以下は Codex の出力（原文のまま）。ファイルへのリンクは監査時の作業ツリーの絶対パス

一部未解消または回帰あり

実際の HEAD は `9e926ffc87069886a6ddb04d55b17067de501155` でした。指定の `ede97585e41e810aee006382ecd12512a6511d91` 以降の変更は監査依頼文の Markdown 1 件で、作業ツリーはクリーンでした。指定どおり `fb5603b..ede97585` を監査しました。 [追加された監査依頼文](/home/user/shiftly/docs/reviews/codex-audit-13-prompt.md)

## 12 回目の指摘

- **#1 解消。** 更新前バックアップが通信例外で失敗した後、手動ロールバックで各プロジェクトの直前の版へ戻ることをモックで確認しました。 [戻し先の選択](/home/user/shiftly/src/setup/installer.ts:748) · [組み合わせテスト](/home/user/shiftly/tests/integration/installer.test.ts:888)
- **#2 解消。** 初回構築直後に戻し先がない場合は、メンテナンス開始前に中止します。開始前のメンテナンス状態が解除中・継続中のどちらでも維持されることをモックで確認しました。 [中止条件](/home/user/shiftly/src/setup/installer.ts:756) · [初回構築のテスト](/home/user/shiftly/tests/integration/installer.test.ts:941)
- **#3 解消。** 手順⑪は、一覧で承認・確認する申告と、PIN 設定済みのスタッフの未確定勤務で即時反映される「予定どおり取得」を書き分けています。後者は「勤怠」の対象勤務の「休憩」欄で合計時間を照合できます。文書とコードを照合しました。 [手順⑪](/home/user/shiftly/docs/update-rollback.md:44) · [一覧の抽出条件](/home/user/shiftly/src/backend/handlers/requests.ts:853) · [休憩欄](/home/user/shiftly/src/frontend/admin/pages/Attendance.tsx:219)

## 対応差分による回帰

1. **高｜移行後に二度巻き戻してから更新を再開すると、旧版のまま更新成功になる。** Staff／Admin `2／2` から `3／3` を配備し、DB 移行の応答を失わせます。手動ロールバックを二度行うと `2／2`、`1／1` の順に戻ります。その後「更新を再開」を押すと、配備の判定が `1／1` を今回の更新先とみなし、再配備を省略します。モックでは修正前は `4／4` を再配備して成功し、修正後は `1／1` のまま成功を返しました。移行後の復旧で、古いコードが稼働したまま Setup に更新完了と記録されます。**推奨修正**は、今回配備した版の組を更新記録に保存し、再開時と完了直前に実配備をその組と照合することです。 [巻き戻し時の版番号更新](/home/user/shiftly/src/setup/installer.ts:768) · [再配備の省略条件](/home/user/shiftly/src/setup/installer.ts:509) · [配備の判定](/home/user/shiftly/src/setup/installer.ts:681) · [更新完了の記録](/home/user/shiftly/src/setup/installer.ts:601)
2. **高｜旧形式の更新記録が残っていると、二度目の手動ロールバックで Staff と Admin が異なる世代になり、メンテナンスが解除される。** 現行 `2／2`、直前 `1／1` で開始した更新が Staff だけを配備し、Admin の版作成と自動ロールバックで失敗した状態を使います。`startPrevious` のない旧形式の記録では、一度目の手動ロールバックで `2／2` に戻っても、「直前の版」が `2／1` のまま `codeTouched` が解除されます。更新開始前のメンテナンスが解除中で、スキーマが一致する条件では、二度目の操作で `2／1` が配備され、打刻が再開します。モックでは修正前は `2／2` を維持し、修正後は `2／1` でメンテナンスを解除しました。該当する旧形式の記録を持つ店舗では、Staff と Admin を異なる世代で運用することになります。**推奨修正**は、旧形式の記録でさらに前の版の組を確定できない場合は、開始時の組へ復旧した時点でその先の巻き戻しを中止することです。 [配備時の直前版の保存](/home/user/shiftly/src/setup/installer.ts:447) · [二度目の戻し先](/home/user/shiftly/src/setup/installer.ts:748) · [旧形式の記録での着手フラグ解除](/home/user/shiftly/src/setup/installer.ts:790)

## 状態の組み合わせテスト

- 追加の 16 件を、既存モックと Node のアサーションでメモリ上から実行しました。修正前は **3 件合格・13 件失敗**、修正後は **16 件合格**でした。上記 2 件は別のモックシナリオで修正前後を比較しました。既存の二度目の手動ロールバックのテストは、移行前の失敗と `startPrevious` がある記録を使っています。移行後の二度目の巻き戻しからの再開と、旧形式の記録の両方が抜けています。 [二度目の手動ロールバックのテスト](/home/user/shiftly/tests/integration/installer.test.ts:954)
- **N1・N3** の実装は、版が `cur` と異なることを今回の更新先の版の代わりに使っています。このため、両方が `cur` 以外の誤った版でも検出できません。今回実際に配備した版の組との完全一致を検証する必要があります。 **M2** はスキーマが一致し、配備を確認でき、開始前のメンテナンス状態が既知のケースに限って成立します。開始前の状態が不明な場合と、スキーマ不一致で解除できない場合が組み合わせに含まれていません。 [不変条件のコメント](/home/user/shiftly/tests/integration/installer.test.ts:878) · [N1〜M2 の検証](/home/user/shiftly/tests/integration/installer.test.ts:921)

差分外で報告対象となる重大事項は確認しませんでした。D-022 は判定対象外です。

`git diff --check fb5603b..ede9758`、ESLint、`tsc --noEmit` はいずれも終了コード `0` でした。ファイル出力を伴う `npm run verify` 全体と `npm run docs` は未実行です。通常の Vitest スイート、E2E、Google 実環境、iPad 実機、給与額の実行検証は行っていません。

これは Codex CLI による独立監査です。GitHub の自動レビューとは別です。