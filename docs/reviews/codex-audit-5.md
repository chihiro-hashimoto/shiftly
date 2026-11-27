# Shiftly v1.3 独立監査

対象 HEAD は `d43d321f00e2435db06a4a2ba1e3b8586fddc3a0` です。C-4 修正差分、v1.3 全体の差分、ローカルの `origin/main...HEAD` を確認しました。`origin/main` は対象 HEAD の祖先です。Codex CLI による累計5回目の読み取り専用監査で、GitHub の自動レビューとは別に実施しました。

**前回の5件は解消3件、未解消2件です。重大の指摘はなく、高2件、中1件です。**

## 前回の指摘

1. **未解消** — 移行完了後の応答喪失は回帰テストで解消を確認しました。移行処理がまだ実行中に応答を失った場合は、ロック外で読んだ旧スキーマ版を根拠に旧 Core へ戻る余地があります。[installer.ts](../../src/setup/installer.ts:539)
2. **解消** — 旧形式の確認行も理由欄の元申請 ID で照合し、再審査時に失効します。統合テストで確認しました。[requests.ts](../../src/backend/handlers/requests.ts:655) · [codex-audit-3.test.ts](../../tests/integration/codex-audit-3.test.ts:141)
3. **解消** — 表示した30分の予定休憩が送信前に60分へ変わると、申告と退勤の両方を記録せず、再確認を求めます。Core は統合テスト、画面はコード読解で確認しました。同日複数シフトでの回帰は下記のとおりです。[requests.ts](../../src/backend/handlers/requests.ts:126) · [StaffApp.tsx](../../src/frontend/staff/StaffApp.tsx:765)
4. **解消** — 手動ロールバックは切替前にメンテナンスを開始し、切替後のスキーマ一致を確認できた場合だけ自動解除します。モックの統合テストとコード読解で確認しました。[installer.ts](../../src/setup/installer.ts:569) · [installer.test.ts](../../tests/integration/installer.test.ts:366)
5. **未解消** — 移行済みの記録が残る完了処理エラーでは再開できます。移行の確定直後に Setup の実行が中断され、その記録が残らない場合は、再開時にバックアップ取得と再配備からやり直します。[installer.ts](../../src/setup/installer.ts:491)

## 重要な指摘

### 高 — 移行中の応答喪失で、旧 Core と移行済み DB の組み合わせに切り替わる（前回 #1 の残存）

- **再現条件と影響（コード読解。実環境でのタイムアウトは未検証）**　v1→v2 の更新で、Setup が移行の応答を失った時点で Core 側の移行が続いている場合、ロックを取らない `system.info` はコミット前の v1 を返し得ます。その後、移行が v2 を確定してから `rollbackCode` のメンテナンス開始がロックを取得すると、Setup はスキーマを再確認せず旧 Core に切り替えます。期待動作は、移行の結果を確定できるまで現行 Core を維持することです。この経路では自動解除は止まりますが、v1.2 の管理画面からは手動解除でき、店舗全体が旧版の勤怠・給与処理で再開し得ます。[installer.ts](../../src/setup/installer.ts:539) · [installer.ts](../../src/setup/installer.ts:569) · [system.ts](../../src/backend/handlers/system.ts:155) · [api.ts](../../src/backend/api.ts:141)
- **推奨修正**　応答喪失時は現行 Core を維持し、Core の更新ロック内で未完了の書き込みを回収してから、移行状態を確定してください。移行前と確認できた場合に限り、自動ロールバックへ進めてください。

### 高 — 移行直後に Setup が中断すると、再開時にロールバック先を上書きする（前回 #5 の残存）

- **再現条件と影響（コード読解）**　v1→v2 の移行を Core が確定した直後、Setup が `migrated: true` を保存する前に実行が終了します。保存済みの段階は `migrate` です。期待動作は、配備済みの版と DB を確認して完了処理へ進むことです。実際の分岐では更新前バックアップを再取得し、`backupId` を v2 のバックアップへ差し替えます。また、再配備によって手動ロールバック先の `previousVersionNumber` が新コードの版番号に更新されます。元のバックアップ自体は残りますが、Setup が保持する参照では移行前のコードと DB に戻れなくなります。[installer.ts](../../src/setup/installer.ts:491) · [installer.ts](../../src/setup/installer.ts:519) · [installer.ts](../../src/setup/installer.ts:427) · [installer.ts](../../src/setup/installer.ts:576)
- **推奨修正**　`migrate` または `finish` から再開するときは、処理を進める前に配備版と Core の移行状態を照合し、最初のバックアップ ID と切替前の版番号を保持してください。

### 中 — 同日の複数シフトで「予定どおり取得して退勤」を繰り返し拒否する（新規回帰）

- **再現条件と影響（モック Core で再現、画面はコード読解）**　同じ Staff に、09:00–12:00（休憩10:00–10:15）、15:00–18:00（休憩16:00–16:30）の順で公開シフトを登録します。15:00 に出勤し、18:00 に退勤します。期待動作は16:00–16:30の30分を表示し、確認後に退勤を保存することです。実際は開いた勤務に対して午前の15分を表示し、退勤リクエストでは閉じた勤務に対して午後の30分を選ぶため、`PLANNED_BREAK_CHANGED` で拒否されます。再取得しても午前の15分が表示され、2回の試行後も勤務中でした。同日の複数シフトでこの条件に当たる Staff は、通常の予定どおりの退勤を完了できません。[attendance.ts](../../src/shared/attendance.ts:284) · [requests.ts](../../src/backend/handlers/requests.ts:476) · [attendance.ts](../../src/backend/handlers/attendance.ts:67) · [StaffApp.tsx](../../src/frontend/staff/StaffApp.tsx:765)
- **推奨修正**　表示と保存の双方で、出勤から仮の退勤時刻までの勤務区間を使い、同じ規則で予定休憩を選んでください。再確認時には Core が照合に使った予定休憩を表示してください。

## 検証結果

- `npm run typecheck` は終了コード `0`。
- Vitest は書き込みを伴う XLSX テストを除外して再実行し、**16ファイル、253件合格、1件スキップ**。除外前の実行は、当該テストが `/tmp` にディレクトリを作成しようとして `EROFS` で失敗しました。
- `npm run verify` はビルド成果物を書き出すため未実行です。E2E、Google 実環境、iPad 実機での検証も未実施です。