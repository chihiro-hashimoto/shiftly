# Codex 独立監査 23 回目（累計）: 範囲を絞った判定（C-22 の対応の確認と不変条件 R1・R2・S1）

> 2026-11-26 実行。`codex exec --sandbox read-only`、対象 `271ebdf`。プロンプト: docs/reviews/codex-audit-23-prompt.md。以下は Codex の出力（原文のまま。行末の空白のみ除去）。ファイルへのリンクは監査時の作業ツリーの絶対パス

マージ不可

初回構築で、Core のフォルダ、Setup の記録ファイル、Apps Script プロジェクトが、それぞれ再実行で1件から2件に増えることをモックで再現しました。
復元前に開いた店舗設定画面からは、復元後も給与計算の時間基準を上書きできます。
復元後の給与停止・解除は、C-19 の控除差と C-22 の空欄の再現条件で、いずれも停止を維持しました。
判定対象は指定の `271ebdf129117ec290d75a218493e53eb98ae933` です。実際の HEAD は `f0e18eee93d0f894f4ee0f1c9fe6c86c4e067ba2` で、差分は監査プロンプト1件の追加でした。作業ツリーはクリーンで、PR #1 の指定コミットは対象の祖先、`origin/main` は初期コミット1件でした。

### C-22 のマージ前指摘

- **#1 解消**。停止行の値が空欄・空白の場合は `PAYROLL_BLOCKED` になります。[停止記録の読取](/home/user/shiftly/src/backend/context.ts:184)
- **#2 解消**。指摘された時給ルールの消失・再出現では、版の下限が復元をまたいで保持され、古い版での保存が拒否されます。版を送らない店舗設定の経路は下記の指摘1です。[復元時の版更新](/home/user/shiftly/src/backend/handlers/ops.ts:621)・[連続復元テスト](/home/user/shiftly/tests/integration/restore-policy.test.ts:306)
- **#3 未解消**。作成応答を失って検索が0件になる元のテストは通過しました。Core では作成済み ID の保存に失敗すると目印が消え、Setup では同じ ID への更新・作成がともに失敗すると予約 ID が消えます。どちらも次の検索が0件なら二重作成します。[Core の目印](/home/user/shiftly/src/backend/gas/platform.ts:224)・[Setup の予約 ID](/home/user/shiftly/src/gas/setup.ts:118)
- **#4 解消**。記録済みデプロイ ID の一時的な `404` では、確認なしの新規作成を止めます。同じ扱いが記録済みプロジェクト ID には適用されていません。[デプロイの分岐](/home/user/shiftly/src/setup/installer.ts:506)・[回帰テスト](/home/user/shiftly/tests/integration/installer.test.ts:1471)

C-19 の3件は、指摘された再現条件では解消しています。月給24万円で総支給額が同じでも、控除4万円の差を検出して解除・訂正を拒否します。プロジェクトの作成応答を失った直後は確認なしで再作成せず、配備応答に版番号がない場合は個別照会で今回の版との一致を確認してから記録します。[控除の回帰テスト](/home/user/shiftly/tests/integration/restore-policy.test.ts:134)・[作成時の確認](/home/user/shiftly/src/setup/installer.ts:456)・[配備の版確認](/home/user/shiftly/src/setup/installer.ts:530)

### 不変条件

- **R1 成り立たない**。確定給与、申請と確認、使用済み登録コードは現行行を優先し、有給の付与・取得、打刻原本、履歴、冪等性キーは候補にない行を再投入します。一方、店舗設定の通常の保存は画面が持つ版を照合せず、復元前の入力が通ります。[全表の方針](/home/user/shiftly/src/backend/handlers/ops.ts:476)・[店舗設定の保存](/home/user/shiftly/src/backend/handlers/system.ts:204)
- **R2 成り立つ**。D-025 が定める解除時点では、最新の確定・発行済み結果の全 `totals` 項目を再計算と比較し、差や計算不能があれば停止を維持します。確定・訂正・明細発行には停止チェックがあり、明細は保存済みの確定結果を使います。[比較](/home/user/shiftly/src/backend/handlers/payroll.ts:103)・[確定・訂正](/home/user/shiftly/src/backend/handlers/payroll.ts:161)・[解除](/home/user/shiftly/src/backend/handlers/payroll.ts:342)・[明細発行](/home/user/shiftly/src/backend/handlers/payroll.ts:461)
- **S1 成り立たない**。Core と Setup で作成済みの識別情報を失う経路があり、プロジェクトの再試行には一時的な `404` だけで新規作成に進む経路があります。

### マージ前に対応する指摘

1. **高 · R1 — 復元前の店舗設定画面から給与計算の時間基準を上書きできる。** `shift` のバックアップを取得し、別タブで店舗設定を開いて `actual` を未保存のまま残します。復元後にそのタブから保存します。期待値は競合として拒否し `shift` を維持することです。Core API では画面と同じ引数で保存が成功し、実際に `actual` になりました。画面操作自体はコード読解です。給与規定の確認はリセットされますが、その後に再確認すると、以後の計算に変更後の時間基準が使われます。画面から取得時の版を送り、Core が現行行と照合してから保存するようにしてください。運用ガイドの「復元前に開いていた管理画面からは保存できません」という説明は、現行の店舗設定には当てはまりません。[画面の保存](/home/user/shiftly/src/frontend/admin/pages/Settings.tsx:40)・[Core の保存](/home/user/shiftly/src/backend/handlers/system.ts:204)・[運用ガイド](/home/user/shiftly/docs/operations-guide.md:39)
2. **中 · S1 — Core が作成済み ID を保存する前に目印を消す。** ルートフォルダの作成を成功させ、直後の `SHIFTLY_ROOT_FOLDER` 保存だけを失敗させます。次の検索を正常な0件にすると、期待は停止してフォルダ1件を維持することですが、GAS エミュレーションでは再実行が成功し、2件になりました。サブフォルダ・DB・環境情報ファイルにも同じ書き込み順序があります。作成または再検出した ID の永続化を確認した後に目印を消し、確認操作も同じロックで対象の目印に限定してください。[目印を消す処理と ID の保存](/home/user/shiftly/src/backend/gas/platform.ts:207)・[環境情報ファイル](/home/user/shiftly/src/backend/gas/platform.ts:272)・[確認操作](/home/user/shiftly/src/gas/core.ts:154)
3. **中 · S1 — Setup の記録ファイルは、更新と同一 ID での作成が続けて失敗すると二重になる。** 記録ファイルの作成応答を失わせ、直後の更新を一時的に失敗させます。同じ予約 ID での作成は既存ファイルとの競合で失敗し、Setup は予約 ID を削除します。検索がまだ0件の間に再実行すると、期待は同じ ID を維持することですが、GAS エミュレーションでは記録が1件から2件に増えました。古い構築状態を持つ記録が残ります。失敗時も予約 ID を保持し、その ID で照合・再試行してください。[予約 ID を削除する分岐](/home/user/shiftly/src/gas/setup.ts:118)
4. **中 · S1 — 記録済みプロジェクトの個別照会が `404` になると、そのまま再作成する。** 作成済み ID を持つ状態で工程の完了記録の保存を失敗させ、再実行時の個別照会に一時的な `404` を返します。期待は照会できるまで停止することですが、Apps Script API のモックでは確認なしで再作成し、1件から2件になりました。Staff・Admin 共通で、Setup の管理外のプロジェクトが残ります。保存済み ID を維持し、デプロイと同様に照会の回復または Google 所有者による明示確認を待ってください。[プロジェクト作成](/home/user/shiftly/src/setup/installer.ts:437)・[個別照会](/home/user/shiftly/src/setup/apps-script-api.ts:66)

### テストと検証

- `npm run lint` と `npm run typecheck` は終了コード `0`。指定の統合差分・v1.3 差分・C-19 以降・C-22 以降の `git diff --check` はすべて終了コード `0`、出力なしでした。
- 対象3ファイルは、現行ソースと GAS バンドルをメモリ上で組み立て、Vitest の `expect` で既存アサーションを実行しました。`restore-policy` 35件、`installer` 87件、`gas-emulation` 26件が成功し、失敗は0件でした。上の4件の反例は別途メモリ上で再現しました。
- 控除の期待値は手計算で差引24万円と20万円です。全項目比較は型で項目を列挙し、各項目の変更・欠落に対して差1件を期待しています。既存2件への `retry(step, true)` の追加は明示確認後の経路を維持し、確認なしの拒否は別テストにあります。一方、全表のテストは方針の登録を網羅しており、各表の代表行や通常画面の保存経路まで網羅していません。Drive のテストにも、作成成功後の ID 保存失敗、予約 ID の更新・再作成の複合失敗、全サブフォルダの個別検証がありません。これらは上記の反例を捕捉できない箇所です。[復元テスト](/home/user/shiftly/tests/integration/restore-policy.test.ts:21)・[Drive のテスト](/home/user/shiftly/tests/integration/gas-emulation.test.ts:195)
- ファイルを出力する `npm run verify`、`npm run docs`、E2E は未実行です。外部通信なしで作業したため GitHub CI は未確認です。開発側の全件合格・再生成差分なしは申告値です。以上は Codex の独立判定で、GitHub の自動レビューとは別です。

### 次の版の前に対応

- D-024 に従い、Google 実環境で更新・ロールバックと途中失敗からの再開を確認し、Staff・Admin の配備の組と DB 構造が一致した場合だけメンテナンスを解除できることを検証する。[実環境検証 L11](/home/user/shiftly/docs/live-verification.md:44)
- 給与計算方法を変更する版では、計算版が異なる確定結果の照合条件を決める。現行の解除判定では、計算版が異なっても `totals` の全項目が一致すれば解除できるため、手順書と判断基準を合わせる。[復元手順](/home/user/shiftly/docs/update-rollback.md:51)・[比較処理](/home/user/shiftly/src/backend/handlers/payroll.ts:103)

### マージ後、本番利用の前に必要な事項

- Google 実環境で、予約 ID による記録ファイルの作成、検索への反映遅れ、初回構築の中断・再開と作成物の件数、打刻、復元、給与の停止・解除・訂正・明細発行を確認する。[実環境検証手順](/home/user/shiftly/docs/live-verification.md)
- iPad 実機の Safari・ホーム画面アプリと WebKit で確認する。[実機検証手順](/home/user/shiftly/docs/live-verification.md)
- 少なくとも1給与計算期間、紙のタイムカードと従来の給与計算を並行し、全スタッフ分を照合する。[運用ガイド](/home/user/shiftly/docs/operations-guide.md:26)