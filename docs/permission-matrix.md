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

店長は全権限を固定で保持（削除不可）。**権限管理・PIN/管理用パスコード設定・端末登録・バックアップ復元・店舗設定・システム更新は店長専用**で、スタッフへは付与できません。

## API 操作ごとの認可（サーバー側で毎回検証）

| 操作 | 認証 | 必要な権限（いずれか） | スタッフの追加認証 | 更新系 |
|---|---|---|---|---|
| `adjustments.add` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `adjustments.list` | 店長／委任スタッフ | `pay_conditions_edit`, `payroll_confirm` | 必要 |  |
| `adjustments.remove` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `analytics.laborCost` | 店長／委任スタッフ | `labor_cost_view` | 必要 |  |
| `attendance.addBreak` | 店長／委任スタッフ | `attendance_edit` | 必要 | ○ |
| `attendance.compareShifts` | 店長／委任スタッフ | `attendance_view_all` |  |  |
| `attendance.correct` | 店長／委任スタッフ | `attendance_edit` | 必要 | ○ |
| `attendance.detail` | 店長／委任スタッフ | `attendance_view_all`, `attendance_edit` |  |  |
| `attendance.list` | 店長／委任スタッフ | `attendance_view_all` |  |  |
| `attendance.lookup` | スタッフ本人（端末＋PIN） | `punch_self` |  |  |
| `attendance.mine` | スタッフ本人（端末＋PIN） | `attendance_view_self` |  |  |
| `attendance.punch` | スタッフ本人（端末＋PIN） | `punch_self` |  | ○ |
| `attendance.today` | 店長／委任スタッフ | `attendance_view_all` |  |  |
| `audit.list` | 店長専用 |  |  |  |
| `auth.changePin` | スタッフ本人（端末＋PIN） |  |  | ○ |
| `auth.login` | 登録端末 |  |  | ○ |
| `auth.logout` | スタッフ本人（端末＋PIN） |  |  | ○ |
| `auth.me` | スタッフ本人（端末＋PIN） |  |  |  |
| `auth.stepUp` | スタッフ本人（端末＋PIN） |  |  | ○ |
| `backup.list` | 店長専用 |  |  |  |
| `backup.restore` | 店長専用 |  |  | ○ |
| `backup.run` | 店長専用 |  |  | ○ |
| `budgets.get` | 店長／委任スタッフ | `budget_manage`, `labor_cost_view` |  |  |
| `budgets.upsert` | 店長／委任スタッフ | `budget_manage` |  | ○ |
| `credentials.setPin` | 店長専用 |  |  | ○ |
| `credentials.setStepUp` | 店長専用 |  |  | ○ |
| `credentials.unlock` | 店長専用 |  |  | ○ |
| `deductions.get` | 店長／委任スタッフ | `pay_conditions_edit`, `payroll_confirm` | 必要 |  |
| `deductions.upsert` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `devices.createEnrollment` | 店長専用 |  |  | ○ |
| `devices.list` | 店長専用 |  |  |  |
| `devices.rename` | 店長専用 |  |  | ○ |
| `devices.revoke` | 店長専用 |  |  | ○ |
| `employees.create` | 店長／委任スタッフ | `staff_manage` | 必要 | ○ |
| `employees.list` | 店長／委任スタッフ | `staff_manage`, `attendance_view_all`, `attendance_edit`, `payroll_view_all`, `shift_edit`, `shift_publish`, `leave_manage`, `pay_conditions_edit`, `payroll_confirm`, `labor_cost_view`, `export_attendance`, `export_payroll`, `payslip_view_others` |  |  |
| `employees.reactivate` | 店長専用 |  |  | ○ |
| `employees.retire` | 店長／委任スタッフ | `staff_manage` | 必要 | ○ |
| `employees.update` | 店長／委任スタッフ | `staff_manage` | 必要 | ○ |
| `employment.list` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 |  |
| `employment.upsert` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `export.attendance` | 店長／委任スタッフ | `export_attendance` | 必要 | ○ |
| `export.payroll` | 店長／委任スタッフ | `export_payroll` | 必要 | ○ |
| `export.shifts` | 店長／委任スタッフ | `shift_edit`, `export_attendance` |  | ○ |
| `export.wageLedger` | 店長／委任スタッフ | `export_payroll` | 必要 | ○ |
| `kiosk.bootstrap` | 登録端末 |  |  |  |
| `kiosk.enroll` | 公開（未認証可） |  |  | ○ |
| `leave.adjust` | 店長／委任スタッフ | `leave_manage` | 必要 | ○ |
| `leave.detail` | 店長／委任スタッフ | `leave_manage` | 必要 |  |
| `leave.grant` | 店長／委任スタッフ | `leave_manage` | 必要 | ○ |
| `leave.mine` | スタッフ本人（端末＋PIN） | `leave_view_self` |  |  |
| `leave.overview` | 店長／委任スタッフ | `leave_manage` | 必要 |  |
| `leave.take` | 店長／委任スタッフ | `leave_manage` | 必要 | ○ |
| `notifications.list` | 店長／委任スタッフ | `notifications_view` |  |  |
| `notifications.scan` | 店長専用 |  |  | ○ |
| `notifications.update` | 店長／委任スタッフ | `notifications_view` |  | ○ |
| `payconf.get` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 |  |
| `payconf.upsertAllowance` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `payconf.upsertSalaryRule` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `payconf.upsertTransport` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `payconf.upsertWageRule` | 店長／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |
| `payroll.compute` | 店長／委任スタッフ | `payroll_view_all` | 必要 | ○ |
| `payroll.confirm` | 店長／委任スタッフ | `payroll_confirm` | 必要 | ○ |
| `payroll.correct` | 店長／委任スタッフ | `payroll_confirm` | 必要 | ○ |
| `payroll.mine` | スタッフ本人（端末＋PIN） | `payroll_view_self` |  |  |
| `payroll.openPeriod` | 店長／委任スタッフ | `payroll_confirm`, `pay_conditions_edit` | 必要 | ○ |
| `payroll.periods` | 店長／委任スタッフ | `payroll_view_all`, `payroll_confirm`, `pay_conditions_edit` | 必要 |  |
| `payroll.resultDetail` | 店長／委任スタッフ | `payroll_view_all` | 必要 |  |
| `payroll.results` | 店長／委任スタッフ | `payroll_view_all` | 必要 |  |
| `payroll.submitReview` | 店長／委任スタッフ | `payroll_confirm` | 必要 | ○ |
| `payslips.issue` | 店長／委任スタッフ | `payroll_confirm` | 必要 | ○ |
| `payslips.list` | 店長／委任スタッフ | `payslip_view_others` | 必要 |  |
| `payslips.mine` | スタッフ本人（端末＋PIN） | `payslip_view_self` |  |  |
| `payslips.pdf` | 店長専用 |  |  |  |
| `payslips.view` | 店長／委任スタッフ | `payslip_view_self`, `payslip_view_others` |  |  |
| `permissions.catalog` | 店長専用 |  |  |  |
| `permissions.set` | 店長専用 |  |  | ○ |
| `settings.confirmPayrollRules` | 店長専用 |  |  | ○ |
| `settings.get` | 店長専用 |  |  |  |
| `settings.update` | 店長専用 |  |  | ○ |
| `shiftPatterns.list` | 店長／委任スタッフ | `shift_edit` |  |  |
| `shiftPatterns.upsert` | 店長／委任スタッフ | `shift_edit` |  | ○ |
| `shifts.copyWeek` | 店長／委任スタッフ | `shift_edit` |  | ○ |
| `shifts.delete` | 店長／委任スタッフ | `shift_edit` |  | ○ |
| `shifts.history` | 店長／委任スタッフ | `shift_edit`, `shift_publish` |  |  |
| `shifts.list` | 店長／委任スタッフ | `shift_edit`, `shift_publish` |  |  |
| `shifts.publish` | 店長／委任スタッフ | `shift_publish` |  | ○ |
| `shifts.published` | スタッフ本人（端末＋PIN） | `shift_view_published` |  |  |
| `shifts.upsert` | 店長／委任スタッフ | `shift_edit` |  | ○ |
| `system.dailyJob` | 店長専用 |  |  | ○ |
| `system.finishUpdate` | 店長専用 |  |  | ○ |
| `system.info` | 店長専用 |  |  |  |
| `system.initialize` | 店長専用 |  |  | ○ |
| `system.integrityCheck` | 店長専用 |  |  |  |
| `system.migrate` | 店長専用 |  |  | ○ |
| `system.prepareUpdate` | 店長専用 |  |  | ○ |
| `system.resetSetupPairing` | 店長専用 |  |  | ○ |
| `system.setMaintenance` | 店長専用 |  |  | ○ |
| `system.status` | 公開（未認証可） |  |  |  |

### ハンドラ内の追加制約（自己操作・昇格の防止）

- スタッフは自分自身の勤怠修正・給与条件変更・雇用条件変更・有給付与/取得/調整・給与確定/訂正・退職処理を行えない
- 他者の給与明細の閲覧は `payslip_view_others` ＋追加認証（5分間）が必要。閲覧は監査ログに記録
- 人件費分析: `payroll_view_all` がない場合、スタッフ別内訳・1名のみが勤務した日の金額・時間帯別金額を返さない
- 出力: スタッフ端末（共用 iPad）にはファイル本体を返さず、店長の Drive に保存のみ
- 権限変更は既存セッションにも次の操作から反映（毎回 DB から再読込）
