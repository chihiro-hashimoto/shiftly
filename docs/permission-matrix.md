# 権限マトリクス

> `npm run docs` で src/shared/permissions.ts と登録済み API 操作から自動生成。手で編集しないでください。

## スタッフ個別権限

| キー | 名称 | 区分 | 機密（追加認証） | 初期値 |
|---|---|---|---|---|
| `punch_self` | 自分の出退勤打刻 | 勤怠 |  | 付与 |
| `attendance_view_self` | 自分の勤怠閲覧 | 勤怠 |  | 付与 |
| `attendance_view_all` | 全員の勤怠閲覧 | 勤怠 |  |  |
| `attendance_edit` | 勤怠修正 | 勤怠 | ○ |  |
| `payroll_view_self` | 自分の給与閲覧 | 給与 |  | 付与 |
| `payroll_view_all` | 全員の給与閲覧 | 給与 | ○ |  |
| `pay_conditions_edit` | 給与条件編集 | 給与 | ○ |  |
| `payroll_confirm` | 給与確定 | 給与 | ○ |  |
| `payslip_view_self` | 自分の給与明細閲覧 | 給与 |  | 付与 |
| `payslip_view_others` | 他者の給与明細閲覧 | 給与 | ○ |  |
| `shift_view_published` | 公開シフト閲覧 | シフト |  | 付与 |
| `shift_edit` | シフト作成・編集 | シフト |  |  |
| `shift_publish` | シフト公開 | シフト |  |  |
| `leave_view_self` | 自分の有給閲覧 | 有給 |  | 付与 |
| `leave_manage` | 有給管理 | 有給 | ○ |  |
| `labor_cost_view` | 人件費分析閲覧 | 分析 | ○ |  |
| `budget_manage` | 予算管理 | 分析 |  |  |
| `export_attendance` | 勤怠データ出力 | 出力 | ○ |  |
| `export_payroll` | 給与データ出力 | 出力 | ○ |  |
| `staff_manage` | スタッフ管理 | 管理 | ○ |  |
| `notifications_view` | 通知閲覧 | 通知 |  | 付与 |

管理者（Google 所有者、および店舗 iPad で管理者パスワードにより認証した管理者モード）は全権限を固定で保持（削除不可）。**権限管理・PIN/管理用パスコード設定・端末登録・店舗設定は管理者専用**で、スタッフへは付与できません。**システムの構築・更新・移行・メンテナンス切替、バックアップからの復元、管理者パスワードの初期設定・再設定は Google 所有者専用**で、管理者モードからも実行できません。

## 管理者・スタッフの区分（v1.3）

| 区分 | 認証 | できること |
|---|---|---|
| Google 所有者 | Google アカウント（Shiftly-Admin・Setup・エディタ） | すべて（構築・更新・復旧＝バックアップからの復元を含む・管理者パスワードの設定/再設定を含む） |
| 管理者モード | 登録済み端末＋管理者パスワード（無操作5分で終了） | 「管理者モード」列が ○ の操作。「再認証」が ○ の操作は直近5分以内のパスワード再入力が必要 |
| スタッフ（本人確認済み） | 登録済み端末＋氏名＋PIN | 個別権限の範囲 |
| スタッフ（本人未確認・PIN 未設定） | 登録済み端末＋氏名 | 「PIN なし」列が ○ の操作のみ（打刻・公開シフト・承認待ちとなる申告） |

## API 操作ごとの認可（サーバー側で毎回検証）

「分類」と「世代の照合」は D-026（復元世代）。分類 `edit`（画面上のデータに基づく業務更新）はすべて、API の共通の入口（ロックの内側）で、画面がデータを取得した時点の復元世代を照合し、古い・ない場合は拒否する。照合しない更新系の操作は、理由を src/backend/epoch-exemptions.ts に登録している（下の「世代の照合を適用しない更新系の操作」）。

| 操作 | 分類 | 認証 | 必要な権限（いずれか） | スタッフの追加認証 | 管理者モード | 再認証 | PIN なし | 更新系 | 世代の照合 |
|---|---|---|---|---|---|---|---|---|---|
| `adjustments.add` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `adjustments.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit`, `payroll_confirm` | 必要 | ○ |  |  |  |  |
| `adjustments.remove` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `adminAuth.changePassword` | auth | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `adminAuth.login` | auth | 登録端末 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `adminAuth.logout` | auth | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `adminAuth.me` | read | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  |  |  |
| `adminAuth.reauth` | auth | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `adminAuth.revokeSessions` | auth | Google 所有者 |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `adminAuth.setPassword` | auth | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `adminAuth.status` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `adminAuth.unlock` | auth | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `analytics.laborCost` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `labor_cost_view` | 必要 | ○ |  |  |  |  |
| `attendance.addBreak` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `attendance.adminCorrectSession` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `attendance.clockOutContext` | read | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ |  |  |
| `attendance.compareShifts` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all` |  | ○ |  |  |  |  |
| `attendance.correct` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `attendance.detail` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |  |
| `attendance.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all` |  | ○ |  |  |  |  |
| `attendance.lookup` | read | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ |  |  |
| `attendance.mine` | read | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  |  |  |
| `attendance.myDetails` | read | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  |  |  |
| `attendance.punch` | punch | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ | 除外（理由は下表） |
| `attendance.review` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `attendance.reviewList` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |  |
| `attendance.selfCorrect` | edit | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ | ○ |
| `attendance.staffDetails` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |  |
| `attendance.today` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all` |  | ○ |  |  |  |  |
| `audit.list` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `auth.changePin` | auth | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  |  | ○ | 除外（理由は下表） |
| `auth.login` | auth | 登録端末 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `auth.logout` | auth | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  | ○ | ○ | 除外（理由は下表） |
| `auth.me` | read | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  | ○ |  |  |
| `auth.stepUp` | auth | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  |  | ○ | 除外（理由は下表） |
| `backup.list` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `backup.restore` | system | Google 所有者 |  |  |  | ○ |  | ○ | 除外（理由は下表） |
| `backup.run` | system | Google 所有者 |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `breaks.adminDeclare` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `breaks.declare` | edit | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ | ○ |
| `budgets.get` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `budget_manage`, `labor_cost_view` |  | ○ |  |  |  |  |
| `budgets.upsert` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `budget_manage` |  | ○ |  |  | ○ | ○ |
| `credentials.clearPin` | auth | Google 所有者 |  |  | ○ | ○ |  | ○ | 除外（理由は下表） |
| `credentials.setPin` | auth | Google 所有者 |  |  | ○ | ○ |  | ○ | 除外（理由は下表） |
| `credentials.setStepUp` | auth | Google 所有者 |  |  | ○ | ○ |  | ○ | 除外（理由は下表） |
| `credentials.unlock` | auth | Google 所有者 |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `deductions.get` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit`, `payroll_confirm` | 必要 | ○ |  |  |  |  |
| `deductions.upsert` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `devices.createEnrollment` | auth | Google 所有者 |  |  | ○ | ○ |  | ○ | 除外（理由は下表） |
| `devices.list` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `devices.rename` | edit | Google 所有者 |  |  | ○ |  |  | ○ | ○ |
| `devices.revoke` | auth | Google 所有者 |  |  | ○ | ○ |  | ○ | 除外（理由は下表） |
| `employees.create` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage` | 必要 | ○ |  |  | ○ | ○ |
| `employees.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage`, `attendance_view_all`, `attendance_edit`, `payroll_view_all`, `shift_edit`, `shift_publish`, `leave_manage`, `pay_conditions_edit`, `payroll_confirm`, `labor_cost_view`, `export_attendance`, `export_payroll`, `payslip_view_others` |  | ○ |  |  |  |  |
| `employees.reactivate` | edit | Google 所有者 |  |  | ○ |  |  | ○ | ○ |
| `employees.retire` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage` | 必要 | ○ |  |  | ○ | ○ |
| `employees.update` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage` | 必要 | ○ |  |  | ○ | ○ |
| `employment.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  |  |  |
| `employment.upsert` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `export.attendance` | output | 管理者（Google 所有者・管理者モード）／委任スタッフ | `export_attendance` | 必要 | ○ |  |  | ○ | 除外（理由は下表） |
| `export.payroll` | output | 管理者（Google 所有者・管理者モード）／委任スタッフ | `export_payroll` | 必要 | ○ |  |  | ○ | 除外（理由は下表） |
| `export.shifts` | output | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit`, `export_attendance` |  | ○ |  |  | ○ | 除外（理由は下表） |
| `export.wageLedger` | output | 管理者（Google 所有者・管理者モード）／委任スタッフ | `export_payroll` | 必要 | ○ |  |  | ○ | 除外（理由は下表） |
| `kiosk.bootstrap`（互換名: v1.2 までの名称。staff.* と同じ処理） | read | 登録端末 |  |  |  |  |  |  |  |
| `leave.adjust` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  | ○ | ○ |
| `leave.detail` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  |  |  |
| `leave.grant` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  | ○ | ○ |
| `leave.mine` | read | スタッフ本人（端末＋氏名選択／PIN） | `leave_view_self` |  |  |  |  |  |  |
| `leave.overview` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  |  |  |
| `leave.take` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  | ○ | ○ |
| `notifications.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `notifications_view` |  | ○ |  |  |  |  |
| `notifications.scan` | internal | Google 所有者 |  |  | ○ |  |  | ○ | 除外（理由は下表） |
| `notifications.update` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `notifications_view` |  | ○ |  |  | ○ | ○ |
| `offshift.confirm` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `offshift.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |  |
| `overtime.cancel` | edit | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  | ○ | ○ |
| `overtime.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |  |
| `overtime.mine` | read | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  |  |  |
| `overtime.request` | edit | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ | ○ |
| `overtime.resubmit` | edit | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  | ○ | ○ |
| `overtime.review` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ | ○ |
| `payconf.get` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  |  |  |
| `payconf.upsertAllowance` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `payconf.upsertSalaryRule` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `payconf.upsertTransport` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `payconf.upsertWageRule` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `payroll.compute` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all`, `payroll_confirm` | 必要 | ○ |  |  | ○ | ○ |
| `payroll.confirm` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ | ○ |  | ○ | ○ |
| `payroll.correct` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ | ○ |  | ○ | ○ |
| `payroll.mine` | read | スタッフ本人（端末＋氏名選択／PIN） | `payroll_view_self` |  |  |  |  |  |  |
| `payroll.openPeriod` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm`, `pay_conditions_edit` | 必要 | ○ |  |  | ○ | ○ |
| `payroll.periods` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all`, `payroll_confirm`, `pay_conditions_edit`, `payslip_view_others`, `export_payroll` | 必要 | ○ |  |  |  |  |
| `payroll.releaseRestoreLock` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ | ○ |  | ○ | ○ |
| `payroll.restoreLockReview` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ |  |  |  |  |
| `payroll.resultDetail` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all` | 必要 | ○ |  |  |  |  |
| `payroll.results` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all`, `payroll_confirm` | 必要 | ○ |  |  |  |  |
| `payroll.submitReview` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ |  |  | ○ | ○ |
| `payslips.issue` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ |  |  | ○ | ○ |
| `payslips.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payslip_view_others` | 必要 | ○ |  |  |  |  |
| `payslips.mine` | read | スタッフ本人（端末＋氏名選択／PIN） | `payslip_view_self` |  |  |  |  |  |  |
| `payslips.pdf` | read | Google 所有者 |  |  |  |  |  |  |  |
| `payslips.view` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payslip_view_self`, `payslip_view_others` |  | ○ |  |  |  |  |
| `permissions.catalog` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `permissions.set` | edit | Google 所有者 |  |  | ○ | ○ |  | ○ | ○ |
| `requests.summary` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |  |
| `settings.confirmPayrollRules` | edit | Google 所有者 |  |  | ○ | ○ |  | ○ | ○ |
| `settings.get` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `settings.update` | edit | Google 所有者 |  |  | ○ |  |  | ○ | ○ |
| `shiftPatterns.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  |  |  |
| `shiftPatterns.upsert` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ | ○ |
| `shifts.copyWeek` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ | ○ |
| `shifts.delete` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ | ○ |
| `shifts.history` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit`, `shift_publish` |  | ○ |  |  |  |  |
| `shifts.list` | read | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit`, `shift_publish` |  | ○ |  |  |  |  |
| `shifts.publish` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_publish` |  | ○ |  |  | ○ | ○ |
| `shifts.published` | read | スタッフ本人（端末＋氏名選択／PIN） | `shift_view_published` |  |  |  | ○ |  |  |
| `shifts.upsert` | edit | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ | ○ |
| `staff.bootstrap` | read | 登録端末 |  |  |  |  |  |  |  |
| `staff.enroll` | auth | 公開（未認証可） |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.dailyJob` | internal | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.finishUpdate` | system | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.info` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `system.initialize` | system | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.integrityCheck` | read | Google 所有者 |  |  | ○ |  |  |  |  |
| `system.migrate` | system | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.prepareUpdate` | system | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.resetSetupPairing` | system | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.setMaintenance` | system | Google 所有者 |  |  |  |  |  | ○ | 除外（理由は下表） |
| `system.status` | read | 公開（未認証可） |  |  |  |  |  |  |  |
| `system.storageCheck` | read | Google 所有者 |  |  |  |  |  |  |  |

### 世代の照合を適用しない更新系の操作（D-026。src/backend/epoch-exemptions.ts）

| 操作 | 分類 | 理由 |
|---|---|---|
| `adminAuth.changePassword` | auth | 管理者が新しいパスワードを設定する（現在のパスワードで確認） |
| `adminAuth.login` | auth | 管理者モードのログイン（セッションの発行） |
| `adminAuth.logout` | auth | 管理者モードのログアウト |
| `adminAuth.reauth` | auth | 管理者の再認証（セッションの状態だけを変える） |
| `adminAuth.revokeSessions` | auth | 管理者セッションの一括失効（安全側の操作） |
| `adminAuth.setPassword` | auth | Google 所有者が管理者パスワードを新しく設定する（画面のデータを書き戻さない） |
| `adminAuth.unlock` | auth | 管理者パスワードのロックの解除 |
| `auth.changePin` | auth | 本人が新しい PIN を設定する（現在の PIN で確認。画面のデータを書き戻さない） |
| `auth.login` | auth | ログイン（セッションの発行）。画面のデータを書き戻さない |
| `auth.logout` | auth | ログアウト（セッションの失効） |
| `auth.stepUp` | auth | 追加認証（セッションの状態だけを変える） |
| `credentials.clearPin` | auth | スタッフの PIN の解除 |
| `credentials.setPin` | auth | スタッフの PIN を新しく設定する（画面のデータを書き戻さない） |
| `credentials.setStepUp` | auth | 追加認証のパスコードを新しく設定する |
| `credentials.unlock` | auth | PIN のロックの解除 |
| `devices.createEnrollment` | auth | 端末登録コードの発行（新しいコードを作るだけ） |
| `devices.revoke` | auth | 端末の失効（安全側の操作。復元でも失効は巻き戻らない） |
| `staff.enroll` | auth | 端末の登録（使い捨ての登録コード。復元でも使用済みのコードは巻き戻らない） |
| `notifications.scan` | internal | 通知の検出（現在のデータから通知を作る。画面のデータを使わない） |
| `system.dailyJob` | internal | 日次の定期実行（現在のデータからバックアップ・通知を作る） |
| `export.attendance` | output | 出力（現在のデータを読み出してファイルを作る。出力の履歴だけを追記する） |
| `export.payroll` | output | 出力（同上） |
| `export.shifts` | output | 出力（同上） |
| `export.wageLedger` | output | 出力（同上） |
| `attendance.punch` | punch | 打刻の時刻はサーバーの時刻で、画面のデータで既存のデータを書き換えない（打刻原本は追記だけ。復元でも再投入される）。復元でスタッフのセッションは失効し、ログインし直す |
| `backup.restore` | system | 復元そのもの（Google 所有者だけ。確認の入力が必要。実行時に世代を進める） |
| `backup.run` | system | バックアップの作成（現在のデータを複製するだけ） |
| `system.finishUpdate` | system | 更新の完了（整合性の確認と版の記録。Setup の工程） |
| `system.initialize` | system | 初期化（冪等。既存のデータは変えない） |
| `system.migrate` | system | DB の構造の移行（Setup の更新の工程。画面のデータを使わない） |
| `system.prepareUpdate` | system | 更新の準備（メンテナンスの開始とバックアップ。Setup の工程） |
| `system.resetSetupPairing` | system | Setup との接続のリセット（新しい接続の準備だけ） |
| `system.setMaintenance` | system | メンテナンスの切り替え（Setup の工程） |

### ハンドラ内の追加制約（自己操作・昇格の防止）

- スタッフは自分自身の勤怠修正（管理者向けの修正）・給与条件変更・雇用条件変更・有給付与/取得/調整・給与確定/訂正・退職処理、自分の早出残業申請・本人修正・休憩申告の確認（承認）を行えない
- 本人による勤怠修正・休憩申告・早出残業申請（v1.3）は、本人の勤務からサーバー側で対象を特定する（他人の勤務は指定できない）。本人未確認（PIN 未設定）の申告・確定済み期間の修正は承認待ち（未反映）
- 他者の給与明細の閲覧は `payslip_view_others` ＋追加認証（5分間）が必要。閲覧は監査ログに記録
- 人件費分析: `payroll_view_all` がない場合、スタッフ別内訳・1名のみが勤務した日の金額・時間帯別金額を返さない
- 出力: 共用 iPad（スタッフ・管理者モード）にはファイル本体を返さず、Google 所有者の Drive に保存のみ
- 権限変更は既存セッションにも次の操作から反映（毎回 DB から再読込）
