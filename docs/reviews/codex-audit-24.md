# Codex 独立監査 24 回目（累計）: 判定（C-23 の構造的な対応・D-026 の確認）

> 2026-11-27 実行。`codex exec --sandbox read-only`（codex-cli 0.167.1、ChatGPT でログイン済み）、監査対象 `5d209d7`（最終のコードの変更 `9429da3`。その後は文書のみ）。プロンプト: docs/reviews/codex-audit-24-prompt.md（`91eb430`）。ユーザーの承認は第 24 回の 1 回のみ。以下は Codex の出力（原文のまま。行末の空白のみ除去）。ファイルへのリンクは監査時の作業ツリーの絶対パス

マージ不可

復元世代の記録を失った後、同じ世代が再発行され、復元前の店舗設定が保存されることをモックで確認しました。
DB 切替直後の障害でも、切替前に読み込んだ画面から保存できるケースを2通り確認しました。
Setup は、既存の記録ファイル ID が残っていても、検索が一時的に0件になると初回構築を案内し、確認後に既存の記録を別環境の内容で上書きしました。
元の C-23 の4件はそれぞれの再現条件では解消し、復元後の給与停止・解除も対象テストに合格しました。

監査対象は PR #2 の `5d209d739036486c59705bc1d4afd8dff6ef245a` です。`git log -3 --oneline` は `91eb430` → `5d209d7` → `9429da3` で、作業ツリーはクリーンでした。`9429da3..5d209d7 --stat` は `docs/HANDOFF.md` と監査プロンプトの2文書のみ、`5d209d7..HEAD --stat` は監査プロンプト1文書のみでした。`271ebdf..5d209d7` と `fcb7b70..5d209d7` の指定差分を確認しました。

## C-23 の4件

- **#1 解消**。通常の復元後、古い世代での `settings.update` は `STALE_VIEW` になり、時間基準は `shift` を維持します。世代の再発行・切替障害時の反例は A1・A2 です。[復元世代テスト](/home/user/shiftly/tests/integration/restore-epoch.test.ts:110)
- **#2 解消**。Core の9種類の作成物で、ID 保存の失敗と検索0件が重なっても目印を保持し、再作成を止めます。[GAS エミュレーション](/home/user/shiftly/tests/integration/gas-emulation.test.ts:398)
- **#3 解消**。作成応答の喪失後、更新と同じ ID での作成が続けて失敗しても、予約 ID とファイル1件を維持します。記録本体だけが失われた場合は A3 です。[GAS エミュレーション](/home/user/shiftly/tests/integration/gas-emulation.test.ts:490)
- **#4 解消**。Staff・Admin とも、記録済みプロジェクトの一時的な `404` だけでは再作成しません。[プロジェクトの再試行](/home/user/shiftly/src/setup/installer.ts:536)・[回帰テスト](/home/user/shiftly/tests/integration/installer.test.ts:1668)

## 不変条件

- **R1 成り立たない**。全表の復元方針と通常時の世代照合は確認できました。世代を失って再発行したとき、または DB 切替直後の複合障害時には、復元前の値を書き戻せます。[復元方針](/home/user/shiftly/src/backend/handlers/ops.ts:486)・[世代の発行](/home/user/shiftly/src/backend/context.ts:226)
- **R2 成り立つ**。解除時に最新の確定・発行済み結果と再計算結果の全 `totals` 項目を比較し、差や計算不能があれば停止を維持します。月給24万円・控除なしで確定し、所得税4万円のバックアップを復元すると、期待どおり再計算の差引は20万円で、解除・訂正は拒否されました。[比較と停止](/home/user/shiftly/src/backend/handlers/payroll.ts:103)・[控除差のテスト](/home/user/shiftly/tests/integration/restore-policy.test.ts:138)
- **S1 成り立たない**。Setup は保存済みの記録ファイル ID を読み込み時の照会に使わず、既存の構築履歴を失った状態から別環境の構築を開始できます。記録ファイルの重複も完了判定から漏れます。[記録の読み込み](/home/user/shiftly/src/gas/setup.ts:97)・[完了前の点検](/home/user/shiftly/src/setup/installer.ts:483)

## 追加の確認事項

1. **世代の消失・破損・時計の巻き戻り**。有効な記録を保持する限り連続復元で単調増加します。消失・形式不正では一旦停止しますが、同一時刻や巻き戻った時刻での再発行は過去の値と重なり得ます。形式上有効な古い値も検出しません。
2. **全129操作の分類**。参照51件、`edit` 45件、除外33件を確認しました。33件は認証・端末18、システム8、出力4、内部処理2、打刻1です。対象範囲の引数と書き込み先を照合し、除外操作から画面上の業務データを丸ごと書き戻す経路は見つかりませんでした。休憩申告付き打刻は照合対象です。[権限表](/home/user/shiftly/docs/permission-matrix.md:42)・[打刻の条件](/home/user/shiftly/src/backend/handlers/attendance.ts:43)
3. **作成結果が不明な場合**。目印・ID を保持したままの保存失敗、照会失敗、検索遅延は代表ケースで停止しました。Setup の記録本体だけが失われると、残っている ID を使った照合が行われません。
4. **Setup の記録ファイルが複数ある場合**。Drive からの再検出時は同一環境なら `updatedAt` が最新の記録を選び、別環境なら停止します。通常の読み込み・完了時にも重複を扱う必要があります。
5. **Google API の制約と完了表示**。プロジェクトの重複を「未確認」として記録・表示する点は適切です。Drive の一覧はページ継続を確認しておらず、取得した範囲だけで件数を確定する点に不備があります。[未確認の表示](/home/user/shiftly/src/frontend/setup/SetupApp.tsx:215)・[Core の検索](/home/user/shiftly/src/backend/gas/platform.ts:219)
6. **打刻・給与・通常構築の回帰**。対象テストでは、申告なしの打刻、申告付き退勤の世代照合、給与の停止・解除、初回確認からの構築に通常経路の回帰は見つかりませんでした。障害時の回帰は A1〜A3 です。
7. **テストの網羅性**。指定差分で既存の期待値を緩めた変更は見つかりませんでした。全表の代表行、45操作の照合、33件の除外一覧、Core の9種類を列挙しています。現在世代での45操作の検査は照合通過までで、全操作の正常保存や複合障害まで網羅していません。[照合テスト](/home/user/shiftly/tests/integration/restore-epoch.test.ts:63)・[全表のテスト](/home/user/shiftly/tests/integration/restore-epoch.test.ts:250)

## A. マージ前に修正が必要な問題

1. **高 — 復元世代の再発行が過去の画面を有効にする。** モックで、時間基準 `shift` のバックアップを通常復元し、時計を進めずに世代の記録を削除して初期化しました。初期化前は `EPOCH_UNAVAILABLE` でしたが、初期化後は過去と同じ世代が発行され、拒否すべき保存が成功して `shift` が `actual` になりました。世代を時計から独立した識別子にし、破損・消失からの復旧時に既存の画面を無効にしてください。時計を進める現行テストに、同時刻・巻き戻り・形式上有効な古い値のケースを加えてください。[世代の発行](/home/user/shiftly/src/backend/context.ts:219)・[初期化](/home/user/shiftly/src/backend/handlers/system.ts:20)・[現行テスト](/home/user/shiftly/tests/integration/restore-epoch.test.ts:185)
2. **高 — DB 切替途中の世代が、複合障害後も使える。** モックで、切替直前に別の画面が旧 DB の `actual` を切替途中の世代で読みました。その後、①切替が反映された直後に切替処理が例外を返す場合、②切替後の世代保存と削除が両方失敗する場合の両方で、この画面からの保存が成功し、復元した `shift` が `actual` に戻りました。切替前に永続化する状態を通常更新で受理しない形にし、DB ID と確定世代の組を確認できるまで読み取りへの世代配布と業務更新を止めてください。切替結果が不明な場合も同じ規則で処理してください。[復元処理](/home/user/shiftly/src/backend/handlers/ops.ts:661)・[GAS の切替](/home/user/shiftly/src/backend/gas/platform.ts:137)・[応答の世代](/home/user/shiftly/src/backend/api.ts:180)
3. **高 — Setup が既存の記録を別環境の内容で上書きする。** GAS エミュレーションで、記録ファイルを作成後、UserProperties の記録本体だけを削除し、ファイル ID を残したまま一覧を一時的に0件にしました。初回確認が表示され、その確認後に同じファイル ID の記録が別の `envId` に置き換わりました。構築済み環境で起きると、既存構成物の関連付けを失い、別環境の作成に進めます。保存済み ID があれば最初に直接照会し、照会不能なら初回確認に進まず停止してください。既存ファイルの更新前にも環境 ID の一致を確認してください。[読込と保存](/home/user/shiftly/src/gas/setup.ts:97)・[初回確認](/home/user/shiftly/src/gas/setup.ts:193)
4. **中 — 保存済みの記録があると、Setup の記録ファイルの重複を完了前に検査しない。** コード読解で、UserProperties が有効な状態で別環境の記録ファイルが存在しても、通常の読み込みは一覧照合を省略し、完了前の確認にも記録ファイルの件数・環境 ID がありません。そのため、Drive から再検出した場合には停止する状態でも完了できます。通常の再開と完了前にも、全ページの結果と保存済み ID・環境 ID を照合してください。同一環境の複数記録から最新を選ぶ場合は、重複が残っていることを表示・記録してください。Core の件数点検も、一覧の継続トークンを扱ってください。[Setup の一覧・読込](/home/user/shiftly/src/gas/setup.ts:59)・[完了前の確認](/home/user/shiftly/src/setup/installer.ts:483)・[Core の件数点検](/home/user/shiftly/src/backend/gas/platform.ts:361)

## B. 本番導入前に Google 実環境で検証が必要な事項

- **高 — 構築の中断・再開と作成物の件数。** 検証用アカウントで初回構築を中断し、予約 ID での作成、Drive 検索への反映遅れ、デプロイ一覧の説明・個別照会、完了時の件数と関連付けを確認してください。特に再開後に構成物が増えず、プロジェクトの重複が未確認として表示されることを記録してください。[実環境検証](/home/user/shiftly/docs/live-verification.md:4)
- **高 — 実際の DB 切替と給与停止。** Google 実環境で、復元中の並行読み取り、Script Properties の保存と読み直し、Drive の目印の付け替えを確認してください。復元後の古い画面の拒否、打刻原本の保持、給与の停止・解除・訂正・明細発行を確認し、打刻と読み込み直しは iPad 実機・WebKit でも検証してください。[実環境検証](/home/user/shiftly/docs/live-verification.md:7)

## C. 次の版を公開する前に対応すべき事項

- **中 — 計算版を変更した場合の復元後の解除条件。** 現行の解除判定は計算結果の全項目を照合します。計算方法を変更する版では、旧版で確定した期間を復元し、どの計算版で照合するか、差が残る場合にどう扱うかを先に決めて検証してください。[給与停止の判断](/home/user/shiftly/src/backend/handlers/payroll.ts:365)・[D-025](/home/user/shiftly/docs/decisions.md:278)
- **中 — 更新・ロールバックの実環境検証。** D-024 の前提どおり、次版の公開前に中断・再開を含めて、Staff・Admin の配備の組と DB 構造がそろうことを検証してください。今回の監査範囲からは除外しました。[実環境検証 L11](/home/user/shiftly/docs/live-verification.md:46)

## D. マージを阻止しない改善の提案

- **低 — 監査表で全件検査の範囲を明記する。** 45操作の現在世代の検査は空の引数で `STALE_VIEW` 以外になることを確認しています。全操作の正常保存を確かめたと読めないように、照合の検査と業務処理の回帰テストを区別して記録してください。[全 `edit` 操作のテスト](/home/user/shiftly/tests/integration/restore-epoch.test.ts:69)・[作成物の検証表](/home/user/shiftly/docs/creation-matrix.md:17)

## 実行結果

- `npm run lint`、`npm run typecheck`、指定差分と HEAD 差分の `git diff --check` は終了コード `0` でした。
- 通常の Vitest 実行は一時ディレクトリを作成できず、`ENOENT` で終了しました。代わりに対象5ファイルをメモリ上で読み込み、Vitest のアサーションで **319件合格、失敗・スキップ0件**でした。内訳は復元世代69、復元方針35、Installer 147、GAS エミュレーション64、クライアント世代4です。既存の GAS バンドル3本の本体は、現行ソースをメモリで組み立てた結果と一致しました。
- 出力を伴う `npm run verify`、`npm run docs`、E2E は未実行です。GitHub CI の成功は開発側申告です。外部通信は行っておらず、Google 実環境・iPad 実機・WebKit、認証・署名の仕組み、共用 iPad の画面表示は未検証です。

以上は Codex CLI による独立判定で、GitHub の自動レビューとは別です。