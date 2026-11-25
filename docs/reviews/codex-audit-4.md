# Shiftly v1.3 独立監査

対象 HEAD は `12ea42146c6c7025002a30e106c628bf0bd21195` です。C-3 後の差分、v1.3 全体の差分、ローカルの `origin/main...HEAD` を確認しました。`origin/main` は対象 HEAD の祖先です。これは Codex CLI による読み取り専用の独立監査です。GitHub の自動レビューとは別に実施しました。

**前回の6件は4件解消、2件未解消です。新規の重要な指摘は高2件、中1件です。**

## 前回の指摘6件

1. **未解消（コード読解）** — 移行の成功応答を受け取った後の完了失敗では旧版へ戻りませんが、DB が v2 に更新された直後に応答が失われると `migrated` が偽のまま旧 Core へ戻り、旧管理画面からメンテナンスを解除できます。移行結果が不明な間は現行 Core を維持し、DB の実状態を確認してから切替可否を判断してください。[installer.ts](../../src/setup/installer.ts:479)
2. **解消（画面はコード読解、Core は統合テスト）** — 選んだ区間を秒まで送受信し、同じ分の別区間は未確認のまま残ります。残り20秒を実労働と確認した後の基本賃金は9,607円でした。[Requests.tsx](../../src/frontend/admin/pages/Requests.tsx:368) · [codex-audit-3.test.ts](../../tests/integration/codex-audit-3.test.ts:31)
3. **未解消（旧形式の行を模したモックで再現）** — `parentRequestId` 付きの新規行は失効しますが、旧形式の行は元申請IDが理由欄にしかなく、再審査後も残ります。09:00–17:10、シフト終了17:00、時給1,200円で前半5分を承認し、後半5分を「未確認」に変更すると、期待値は仮9,700円で確定不可、実際は仮9,700円でシフト外確認による確定ブロックなしでした。既存行も元申請にひも付けて失効対象に含めてください。[requests.ts](../../src/backend/handlers/requests.ts:629) · [schema.ts](../../src/backend/schema.ts:212)
4. **解消（統合テスト）** — 開始時刻なしで受付済みの申告には、後から設定した休憩を控除しません。元の再現条件で480分・9,600円を維持しました。[attendance.ts](../../src/shared/attendance.ts:317) · [codex-audit-3.test.ts](../../tests/integration/codex-audit-3.test.ts:71)
5. **解消（コード読解）** — PIN 入力をキャンセルすると、その試行の遅延成功応答を破棄し、発行済みセッションの失効を要求します。ページ非表示時も親画面がダイアログを閉じます。[StaffApp.tsx](../../src/frontend/staff/StaffApp.tsx:274) · [StaffApp.tsx](../../src/frontend/staff/StaffApp.tsx:370)
6. **解消（統合テスト）** — 対象期間に在籍した退職済み Staff が確認一覧に出ます。退職前の10分を実労働と確認すると基本賃金は9,800円でした。[requests.ts](../../src/backend/handlers/requests.ts:713) · [codex-audit-3.test.ts](../../tests/integration/codex-audit-3.test.ts:92)

## 新規の重要な指摘

### 高 — 退勤確認に表示した時間より長い予定休憩を控除する

- **根拠・再現条件（モック Core で再現、画面はコード読解）**　シフトと打刻が09:00–17:00、時給1,200円、実際の休憩は12:00–12:30。退勤画面に30分が表示された後、管理者が予定休憩を12:00–13:00に変更して再公開します。Staff が表示済みの画面で「予定どおり取得して退勤」を押すと、画面は申告種別だけを送り、Core は変更後の60分を保存します。期待値は確認済みの30分を控除して**450分・9,000円**、または変更を表示して再確認です。実際は**420分・8,400円**でした。[StaffApp.tsx](../../src/frontend/staff/StaffApp.tsx:981) · [attendance.ts](../../src/backend/handlers/attendance.ts:72) · [requests.ts](../../src/backend/handlers/requests.ts:114)
- **影響・推奨修正**　退勤確認を開いてから送信するまでにシフトが変わると、取得していない休憩を控除した金額が確定候補になります。表示した勤務・予定休憩の版を送信し、Core で照合してください。変更があれば休憩を反映する前に再確認を求めてください。

### 高 — 正常更新後の手動ロールバックで旧 Core が新 DB のまま稼働する

- **根拠・再現条件（コード読解）**　v1.2 から v1.3 への更新を正常完了すると、DB は v2 になり、メンテナンスは解除されます。その状態で Setup の「直前のバージョンに戻す」を押すと、処理はメンテナンスを開始せずに旧版を配備し、その後でスキーマの組み合わせを確認します。画面は「メンテナンスを継続」と報告し得ますが、DB 上では解除されたままです。[update.ts](../../src/backend/handlers/update.ts:74) · [SetupApp.tsx](../../src/frontend/setup/SetupApp.tsx:243) · [installer.ts](../../src/setup/installer.ts:535)
- **影響・推奨修正**　復元前から旧版の打刻・給与処理が実行可能になり、v1.3 の休憩申告やシフト外勤務の確認が給与に反映されないおそれがあります。配備変更前に書き込みを停止し、対象 DB と旧版の互換性を確認できる復旧手順にしてください。

### 中 — 移行後に失敗すると、再読み込みした Setup から案内どおり再試行できない

- **根拠・再現条件（コード読解）**　DB 移行後に完了処理が失敗すると、修正後の Setup は新しい Core を維持し、更新の再実行を案内します。その後 Setup を開き直すと、Core の `ping` が配備済みコードの版を返すため、更新先と同じ版だと判定されます。画面には「最新のバージョンです」と表示され、更新ボタンが消えます。[installer.ts](../../src/setup/installer.ts:450) · [installer.ts](../../src/setup/installer.ts:512) · [core.ts](../../src/gas/core.ts:73) · [SetupApp.tsx](../../src/frontend/setup/SetupApp.tsx:218)
- **影響・推奨修正**　メンテナンス中の復旧が案内された画面で進められません。Google 所有者の管理画面には更新完了操作があります。Setup でも未完了の更新状態を見て再開を表示し、移行済みなら更新前バックアップの再取得や再配備を経ずに完了処理へ進めるようにしてください。

## 検証結果

- `npm run lint`、`npm run typecheck` はともに終了コード `0`。
- キャッシュを無効にし、設定をメモリで読み込んだ Vitest は `Test Files 16 passed (16)`、`Tests 247 passed | 1 skipped (248)`。一時ファイルを作る XLSX 検証1件を除外しました。
- `npm run verify` 全体、ビルド、Playwright E2E はファイルを書き出すため未実行です。Google 実環境と iPad 実機も未検証です。ファイル変更、Git の変更操作、外部送信は行っていません。