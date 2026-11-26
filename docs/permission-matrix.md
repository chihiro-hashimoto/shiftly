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

管理者（Google 所有者、および店舗 iPad で管理者パスワードにより認証した管理者モード）は全権限を固定で保持（削除不可）。**権限管理・PIN/管理用パスコード設定・端末登録・バックアップ復元・店舗設定は管理者専用**で、スタッフへは付与できません。**システムの構築・更新・移行・メンテナンス切替、管理者パスワードの初期設定・再設定は Google 所有者専用**で、管理者モードからも実行できません。

## 管理者・スタッフの区分（v1.3）

| 区分 | 認証 | できること |
|---|---|---|
| Google 所有者 | Google アカウント（Shiftly-Admin・Setup・エディタ） | すべて（構築・更新・復旧・管理者パスワードの設定/再設定を含む） |
| 管理者モード | 登録済み端末＋管理者パスワード（無操作5分で終了） | 「管理者モード」列が ○ の操作。「再認証」が ○ の操作は直近5分以内のパスワード再入力が必要 |
| スタッフ（本人確認済み） | 登録済み端末＋氏名＋PIN | 個別権限の範囲 |
| スタッフ（本人未確認・PIN 未設定） | 登録済み端末＋氏名 | 「PIN なし」列が ○ の操作のみ（打刻・公開シフト・承認待ちとなる申告） |

## API 操作ごとの認可（サーバー側で毎回検証）

| 操作 | 認証 | 必要な権限（いずれか） | スタッフの追加認証 | 管理者モード | 再認証 | PIN なし | 更新系 |
|---|---|---|---|---|---|---|---|
| `adjustments.add` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `adjustments.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit`, `payroll_confirm` | 必要 | ○ |  |  |  |
| `adjustments.remove` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `adminAuth.changePassword` | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  | ○ |
| `adminAuth.login` | 登録端末 |  |  |  |  |  | ○ |
| `adminAuth.logout` | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  | ○ |
| `adminAuth.me` | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  |  |
| `adminAuth.reauth` | 管理者モード（管理者パスワード）のみ |  |  | ○ |  |  | ○ |
| `adminAuth.revokeSessions` | Google 所有者 |  |  | ○ |  |  | ○ |
| `adminAuth.setPassword` | Google 所有者 |  |  |  |  |  | ○ |
| `adminAuth.status` | Google 所有者 |  |  | ○ |  |  |  |
| `adminAuth.unlock` | Google 所有者 |  |  |  |  |  | ○ |
| `analytics.laborCost` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `labor_cost_view` | 必要 | ○ |  |  |  |
| `attendance.addBreak` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `attendance.adminCorrectSession` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `attendance.clockOutContext` | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ |  |
| `attendance.compareShifts` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all` |  | ○ |  |  |  |
| `attendance.correct` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `attendance.detail` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |
| `attendance.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all` |  | ○ |  |  |  |
| `attendance.lookup` | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ |  |
| `attendance.mine` | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  |  |
| `attendance.myDetails` | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  |  |
| `attendance.punch` | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ |
| `attendance.review` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `attendance.reviewList` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |
| `attendance.selfCorrect` | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ |
| `attendance.staffDetails` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |
| `attendance.today` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all` |  | ○ |  |  |  |
| `audit.list` | Google 所有者 |  |  | ○ |  |  |  |
| `auth.changePin` | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  |  | ○ |
| `auth.login` | 登録端末 |  |  |  |  |  | ○ |
| `auth.logout` | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  | ○ | ○ |
| `auth.me` | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  | ○ |  |
| `auth.stepUp` | スタッフ本人（端末＋氏名選択／PIN） |  |  |  |  |  | ○ |
| `backup.list` | Google 所有者 |  |  | ○ |  |  |  |
| `backup.restore` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `backup.run` | Google 所有者 |  |  | ○ |  |  | ○ |
| `breaks.adminDeclare` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `breaks.declare` | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ |
| `budgets.get` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `budget_manage`, `labor_cost_view` |  | ○ |  |  |  |
| `budgets.upsert` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `budget_manage` |  | ○ |  |  | ○ |
| `credentials.clearPin` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `credentials.setPin` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `credentials.setStepUp` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `credentials.unlock` | Google 所有者 |  |  | ○ |  |  | ○ |
| `deductions.get` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit`, `payroll_confirm` | 必要 | ○ |  |  |  |
| `deductions.upsert` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `devices.createEnrollment` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `devices.list` | Google 所有者 |  |  | ○ |  |  |  |
| `devices.rename` | Google 所有者 |  |  | ○ |  |  | ○ |
| `devices.revoke` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `employees.create` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage` | 必要 | ○ |  |  | ○ |
| `employees.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage`, `attendance_view_all`, `attendance_edit`, `payroll_view_all`, `shift_edit`, `shift_publish`, `leave_manage`, `pay_conditions_edit`, `payroll_confirm`, `labor_cost_view`, `export_attendance`, `export_payroll`, `payslip_view_others` |  | ○ |  |  |  |
| `employees.reactivate` | Google 所有者 |  |  | ○ |  |  | ○ |
| `employees.retire` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage` | 必要 | ○ |  |  | ○ |
| `employees.update` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `staff_manage` | 必要 | ○ |  |  | ○ |
| `employment.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  |  |
| `employment.upsert` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `export.attendance` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `export_attendance` | 必要 | ○ |  |  | ○ |
| `export.payroll` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `export_payroll` | 必要 | ○ |  |  | ○ |
| `export.shifts` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit`, `export_attendance` |  | ○ |  |  | ○ |
| `export.wageLedger` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `export_payroll` | 必要 | ○ |  |  | ○ |
| `kiosk.bootstrap`（互換名: v1.2 までの名称。staff.* と同じ処理） | 登録端末 |  |  |  |  |  |  |
| `leave.adjust` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  | ○ |
| `leave.detail` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  |  |
| `leave.grant` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  | ○ |
| `leave.mine` | スタッフ本人（端末＋氏名選択／PIN） | `leave_view_self` |  |  |  |  |  |
| `leave.overview` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  |  |
| `leave.take` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `leave_manage` | 必要 | ○ |  |  | ○ |
| `notifications.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `notifications_view` |  | ○ |  |  |  |
| `notifications.scan` | Google 所有者 |  |  | ○ |  |  | ○ |
| `notifications.update` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `notifications_view` |  | ○ |  |  | ○ |
| `offshift.confirm` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `offshift.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |
| `overtime.cancel` | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  | ○ |
| `overtime.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |
| `overtime.mine` | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  |  |
| `overtime.request` | スタッフ本人（端末＋氏名選択／PIN） | `punch_self` |  |  |  | ○ | ○ |
| `overtime.resubmit` | スタッフ本人（端末＋氏名選択／PIN） | `attendance_view_self` |  |  |  |  | ○ |
| `overtime.review` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_edit` | 必要 | ○ |  |  | ○ |
| `payconf.get` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  |  |
| `payconf.upsertAllowance` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `payconf.upsertSalaryRule` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `payconf.upsertTransport` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `payconf.upsertWageRule` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `payroll.compute` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all`, `payroll_confirm` | 必要 | ○ |  |  | ○ |
| `payroll.confirm` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ | ○ |  | ○ |
| `payroll.correct` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ | ○ |  | ○ |
| `payroll.mine` | スタッフ本人（端末＋氏名選択／PIN） | `payroll_view_self` |  |  |  |  |  |
| `payroll.openPeriod` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm`, `pay_conditions_edit` | 必要 | ○ |  |  | ○ |
| `payroll.periods` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all`, `payroll_confirm`, `pay_conditions_edit`, `payslip_view_others`, `export_payroll` | 必要 | ○ |  |  |  |
| `payroll.releaseRestoreLock` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ | ○ |  | ○ |
| `payroll.restoreLockReview` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ |  |  |  |
| `payroll.resultDetail` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all` | 必要 | ○ |  |  |  |
| `payroll.results` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_view_all`, `payroll_confirm` | 必要 | ○ |  |  |  |
| `payroll.submitReview` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ |  |  | ○ |
| `payslips.issue` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payroll_confirm` | 必要 | ○ |  |  | ○ |
| `payslips.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payslip_view_others` | 必要 | ○ |  |  |  |
| `payslips.mine` | スタッフ本人（端末＋氏名選択／PIN） | `payslip_view_self` |  |  |  |  |  |
| `payslips.pdf` | Google 所有者 |  |  |  |  |  |  |
| `payslips.view` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `payslip_view_self`, `payslip_view_others` |  | ○ |  |  |  |
| `permissions.catalog` | Google 所有者 |  |  | ○ |  |  |  |
| `permissions.set` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `requests.summary` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `attendance_view_all`, `attendance_edit` |  | ○ |  |  |  |
| `settings.confirmPayrollRules` | Google 所有者 |  |  | ○ | ○ |  | ○ |
| `settings.get` | Google 所有者 |  |  | ○ |  |  |  |
| `settings.update` | Google 所有者 |  |  | ○ |  |  | ○ |
| `shiftPatterns.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  |  |
| `shiftPatterns.upsert` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ |
| `shifts.copyWeek` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ |
| `shifts.delete` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ |
| `shifts.history` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit`, `shift_publish` |  | ○ |  |  |  |
| `shifts.list` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit`, `shift_publish` |  | ○ |  |  |  |
| `shifts.publish` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_publish` |  | ○ |  |  | ○ |
| `shifts.published` | スタッフ本人（端末＋氏名選択／PIN） | `shift_view_published` |  |  |  | ○ |  |
| `shifts.upsert` | 管理者（Google 所有者・管理者モード）／委任スタッフ | `shift_edit` |  | ○ |  |  | ○ |
| `staff.bootstrap` | 登録端末 |  |  |  |  |  |  |
| `staff.enroll` | 公開（未認証可） |  |  |  |  |  | ○ |
| `system.dailyJob` | Google 所有者 |  |  |  |  |  | ○ |
| `system.finishUpdate` | Google 所有者 |  |  |  |  |  | ○ |
| `system.info` | Google 所有者 |  |  | ○ |  |  |  |
| `system.initialize` | Google 所有者 |  |  |  |  |  | ○ |
| `system.integrityCheck` | Google 所有者 |  |  | ○ |  |  |  |
| `system.migrate` | Google 所有者 |  |  |  |  |  | ○ |
| `system.prepareUpdate` | Google 所有者 |  |  |  |  |  | ○ |
| `system.resetSetupPairing` | Google 所有者 |  |  |  |  |  | ○ |
| `system.setMaintenance` | Google 所有者 |  |  |  |  |  | ○ |
| `system.status` | 公開（未認証可） |  |  |  |  |  |  |

### ハンドラ内の追加制約（自己操作・昇格の防止）

- スタッフは自分自身の勤怠修正（管理者向けの修正）・給与条件変更・雇用条件変更・有給付与/取得/調整・給与確定/訂正・退職処理、自分の早出残業申請・本人修正・休憩申告の確認（承認）を行えない
- 本人による勤怠修正・休憩申告・早出残業申請（v1.3）は、本人の勤務からサーバー側で対象を特定する（他人の勤務は指定できない）。本人未確認（PIN 未設定）の申告・確定済み期間の修正は承認待ち（未反映）
- 他者の給与明細の閲覧は `payslip_view_others` ＋追加認証（5分間）が必要。閲覧は監査ログに記録
- 人件費分析: `payroll_view_all` がない場合、スタッフ別内訳・1名のみが勤務した日の金額・時間帯別金額を返さない
- 出力: 共用 iPad（スタッフ・管理者モード）にはファイル本体を返さず、Google 所有者の Drive に保存のみ
- 権限変更は既存セッションにも次の操作から反映（毎回 DB から再読込）
