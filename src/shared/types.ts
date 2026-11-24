/**
 * Shiftly ドメイン型定義
 * DB（Google Sheets）の各テーブル行と 1:1 対応する型を中心に定義する。
 * 詳細な列定義・制約は docs/database-schema.md を参照。
 */
import type { Instant, LocalDate, LocalTime } from './time';

export type Id = string;

/** 全テーブル共通メタ列 */
export interface RowMeta {
  id: Id;
  createdAt: string; // ISO8601 +09:00
  updatedAt: string;
  version: number; // 楽観的排他用（更新ごとに +1）
}

// ---------------------------------------------------------------- 店舗設定
export interface BusinessHours {
  /** 0=日〜6=土 */
  weekday: number;
  closed: boolean;
  open: LocalTime; // 'HH:MM'
  close: LocalTime; // 翌日にまたがる場合 '26:00' のように 24 以上で表記
}

export type WorkingTimeSystem =
  | 'standard' // 通常の労働時間制（1日8h・週40h/44h）
  | 'monthly_variable' // 1か月単位の変形労働時間制（未対応）
  | 'yearly_variable' // 1年単位の変形労働時間制（未対応）
  | 'flextime' // フレックスタイム制（未対応）
  | 'unset';

export const SUPPORTED_WORKING_TIME_SYSTEMS: WorkingTimeSystem[] = ['standard'];

export type RoundingMode = 'half_up' | 'ceil';

export interface MinimumWageEntry {
  effectiveFrom: LocalDate;
  hourly: number; // 円
  label: string; // 例: '東京都 地域別最低賃金'
  sourceNote: string; // 根拠（店長が確認した公式ページ等）
}

export interface StoreSettings extends RowMeta {
  storeName: string;
  storeAddress: string;
  timezone: 'Asia/Tokyo';
  businessHours: BusinessHours[];
  /** 営業日の切替時刻（例 '05:00' → 当日5:00〜翌日4:59 を同一営業日として表示・集計） */
  businessDayCutoff: LocalTime;
  workingTimeSystem: WorkingTimeSystem;
  /** 週の起算曜日（0=日）。就業規則に定めがなければ日曜（行政解釈） */
  weekStartDay: number | null;
  /** 法定休日の曜日（0=日）。null は未設定 */
  statutoryHolidayWeekday: number | null;
  /** 週44時間特例の適用を店長が確認済みか（業種・常時10人未満の要件） */
  weekly44Confirmed: boolean;
  /** 36協定の締結・届出状況（記録のみ。計算は実労働時間に基づく） */
  agreement36: 'unset' | 'concluded' | 'not_concluded';
  /** 月60時間の起算日（null の場合は給与計算期間の初日） */
  overtime60StartDay: number | null;
  /** 給与締め日（1〜28 または 0=末日）。null は未設定 */
  payrollClosingDay: number | null;
  /** 支払月（0=当月, 1=翌月）と支払日（1〜28 または 0=末日） */
  payMonthOffset: number | null;
  payDay: number | null;
  /** 1時間当たり賃金・割増賃金の円未満処理 */
  yenRounding: RoundingMode;
  minimumWages: MinimumWageEntry[];
  /** 会社負担社会保険料等の概算率（%）。人件費分析専用の仮定値。null は未設定 */
  employerCostRatePercent: number | null;
  /** 個人情報表示中の無操作タイムアウト（秒） */
  idleTimeoutSec: number;
  /** PIN 失敗許容回数・ロック分 */
  pinMaxAttempts: number;
  pinLockMinutes: number;
  /** 祝日（店舗の時給ルール用。法定休日とは無関係） */
  publicHolidays: LocalDate[];
  /** 有給休暇の賃金算定方法（就業規則で定める） */
  paidLeaveWageMethod: 'unset' | 'normal' | 'average' | 'standard_remuneration';
  /** 半日単位の年休を就業規則で認めているか（時間単位年休は労使協定が必要なため未対応） */
  halfDayLeaveAllowed: boolean;
  /** 電子交付の運用（本人承諾が前提） */
  payslipDelivery: 'paper' | 'electronic_with_consent';
  /** 保存期間（年）。法定下限未満は不可 */
  retentionYears: number;
  dailyBackupGenerations: number;
  monthlyBackupGenerations: number;
  /** 設定済み項目の確認フラグ（給与確定前チェック用） */
  payrollRulesConfirmedAt: string | null;
}

// ---------------------------------------------------------------- 従業員
export type PayType = 'hourly' | 'monthly';
export type EmployeeStatus = 'active' | 'retired';

export interface Employee extends RowMeta {
  employeeCode: string; // 表示用社員番号（主キーではない）
  displayName: string; // 表示名（氏名選択に使用）
  kana: string;
  status: EmployeeStatus;
  hireDate: LocalDate | null;
  retireDate: LocalDate | null;
  payType: PayType;
  /** 表示順 */
  sortOrder: number;
  /** 電子明細の本人承諾 */
  electronicPayslipConsent: boolean;
  note: string;
}

/** 雇用条件の履歴（適用期間付き） */
export interface EmploymentHistory extends RowMeta {
  employeeId: Id;
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
  payType: PayType;
  /** 週所定労働日数（有給比例付与判定用）。null 未設定 */
  weeklyScheduledDays: number | null;
  /** 週所定労働時間（分） */
  weeklyScheduledMinutes: number | null;
  /** 年間所定労働日数（週以外で定める場合） */
  yearlyScheduledDays: number | null;
  /** 1日の所定労働時間（分）: 日額手当の割増算定基礎・有給の通常賃金の既定値 */
  dailyScheduledMinutes: number | null;
  /** 1か月平均所定労働時間（分）: 月額手当の割増算定基礎（時給制） */
  monthlyAverageScheduledMinutes: number | null;
  note: string;
}

// ---------------------------------------------------------------- 認証
export interface Credential extends RowMeta {
  employeeId: Id;
  kind: 'pin' | 'stepup';
  /** PBKDF2-HMAC-SHA256(pepper付き) の結果（hex）。平文は保存しない */
  hash: string;
  salt: string;
  iterations: number;
  algo: 'pbkdf2-sha256-peppered-v1';
  failedCount: number;
  lockedUntil: string | null;
  mustChange: boolean;
}

export type PermissionKey =
  | 'punch_self'
  | 'attendance_view_self'
  | 'attendance_view_all'
  | 'attendance_edit'
  | 'payroll_view_self'
  | 'payroll_view_all'
  | 'pay_conditions_edit'
  | 'payroll_confirm'
  | 'payslip_view_self'
  | 'payslip_view_others'
  | 'shift_view_published'
  | 'shift_edit'
  | 'shift_publish'
  | 'leave_view_self'
  | 'leave_manage'
  | 'labor_cost_view'
  | 'budget_manage'
  | 'export_attendance'
  | 'export_payroll'
  | 'staff_manage'
  | 'notifications_view';

export interface PermissionRow extends RowMeta {
  employeeId: Id;
  permissions: PermissionKey[];
}

export interface Device extends RowMeta {
  name: string;
  /** 端末トークンの SHA-256（平文は端末のみ保持） */
  tokenHash: string;
  status: 'active' | 'revoked';
  registeredAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  userAgentHint: string;
}

/** 端末登録用の短時間・使い捨てコード */
export interface DeviceEnrollment extends RowMeta {
  codeHash: string;
  deviceName: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SessionRow extends RowMeta {
  tokenHash: string;
  deviceId: Id;
  employeeId: Id;
  expiresAt: string;
  lastActivityAt: string;
  stepUpUntil: string | null;
  revokedAt: string | null;
}

// ---------------------------------------------------------------- 給与条件
export interface WageRule extends RowMeta {
  employeeId: Id;
  /** base: 基本時給 / weekday: 曜日別 / timeband: 時間帯別 / holiday: 祝日 / special_date: 特定日 */
  kind: 'base' | 'weekday' | 'timeband' | 'holiday' | 'special_date';
  hourlyRate: number;
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
  weekdays: number[]; // kind=weekday/timeband で使用（空は全曜日）
  timeFrom: LocalTime | null; // kind=timeband（'22:00'）
  timeTo: LocalTime | null; // kind=timeband（'29:00' のように翌日表記可）
  specialDates: LocalDate[];
  /** 数値が大きいほど優先。同一優先度で重なる場合は矛盾として警告 */
  priority: number;
  /** この時給に法定の深夜割増を含むか（含む場合は premiumBaseRate 必須） */
  includesNightPremium: boolean;
  premiumBaseRate: number | null;
  note: string;
}

export interface SalaryRule extends RowMeta {
  employeeId: Id;
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
  monthlySalary: number;
  /** 1か月平均所定労働時間（分）: 割増賃金・最低賃金判定の基礎 */
  monthlyScheduledMinutes: number | null;
  /** 所定労働日の曜日 */
  scheduledWeekdays: number[];
  /** 1日の所定労働時間（分） */
  scheduledDailyMinutes: number | null;
  /** 法定内残業の支払率（100 or 125） */
  inLegalOvertimeRate: 100 | 125 | null;
  fixedOvertime: { enabled: boolean; amount: number; coveredMinutes: number } | null;
  /** 欠勤控除の有無と日額算定の除数（日数）。null は規定未確認 */
  absenceDeduction: { enabled: boolean; divisorDays: number | null } | null;
  /** 遅刻早退控除の有無 */
  lateEarlyDeduction: { enabled: boolean } | null;
  confirmed: boolean; // 店長が給与規定と照合済みか
  note: string;
}

export type TransportMethod = 'unset' | 'none' | 'per_day' | 'monthly' | 'actual';
export interface TransportRule extends RowMeta {
  employeeId: Id;
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
  method: TransportMethod;
  amount: number; // per_day: 1日額, monthly: 月額
  monthlyCap: number | null;
  /** 実費精算の期間別金額（key: periodId） */
  actualAmounts: Record<string, number>;
  note: string;
}

/** 給与調整（欠勤・遅刻早退控除は店長が承認したもののみ。自動反映しない） */
export interface PayrollAdjustment extends RowMeta {
  employeeId: Id;
  periodId: Id;
  kind: 'absence_days' | 'late_early_minutes' | 'manual_addition' | 'manual_subtraction';
  quantity: number; // 日数 or 分
  amount: number | null; // manual_* の場合の金額
  label: string;
  reason: string;
  approvedBy: Id;
}

/** 割増賃金の算定基礎から除外できるのは労基則21条の7種のみ */
export type PremiumBaseCategory =
  | 'include'
  | 'exclude_family'
  | 'exclude_commute'
  | 'exclude_separation'
  | 'exclude_education'
  | 'exclude_housing'
  | 'exclude_temporary'
  | 'exclude_over_month';

export interface Allowance extends RowMeta {
  employeeId: Id;
  name: string;
  kind: 'fixed_monthly' | 'per_workday' | 'per_hour' | 'variable';
  amount: number;
  effectiveFrom: LocalDate;
  effectiveTo: LocalDate | null;
  premiumBaseCategory: PremiumBaseCategory;
  includeInMinimumWage: boolean;
  /** variable の場合の期間別金額 */
  periodAmounts: Record<string, number>; // key: periodId
  note: string;
}

export type DeductionStatus = 'unentered' | 'entered' | 'explicit_none';
export interface DeductionItem {
  name: string;
  amount: number;
  basis: 'statutory' | 'labor_agreement';
}
export interface DeductionEntry extends RowMeta {
  employeeId: Id;
  periodId: Id;
  status: DeductionStatus;
  incomeTax: number;
  residentTax: number;
  healthInsurance: number;
  pension: number;
  employmentInsurance: number;
  nursingInsurance: number;
  others: DeductionItem[];
  note: string;
}

// ---------------------------------------------------------------- 勤怠
export type PunchType = 'clock_in' | 'clock_out' | 'break_start' | 'break_end';
export type WorkState = 'off' | 'working' | 'on_break' | 'clocked_out';

/** 打刻原本（追記専用。通常操作で更新・削除しない） */
export interface AttendanceEvent extends RowMeta {
  employeeId: Id;
  type: PunchType;
  at: string; // サーバー時刻（ISO）
  deviceId: Id | null;
  source: 'kiosk' | 'admin_manual' | 'paper_recovery';
  requestId: string; // 冪等性キー
  /** 原本の作成者（手動登録の場合） */
  actorId: Id | null;
  note: string;
}

/** 勤怠修正（原本は変更せず、差分として保存） */
export interface AttendanceCorrection extends RowMeta {
  employeeId: Id;
  action: 'add' | 'void' | 'replace';
  targetEventId: Id | null;
  newType: PunchType | null;
  newAt: string | null;
  reason: string;
  actorId: Id; // 'owner' or employeeId
  actorKind: 'owner' | 'staff';
  status: 'applied' | 'pending' | 'rejected';
  before: string; // JSON
  after: string; // JSON
}

export interface BreakInterval {
  start: Instant;
  end: Instant | null;
  source: 'punch' | 'fixed' | 'manual';
}

/** 打刻原本＋修正から再構築される勤務（派生データ。いつでも再生成可能） */
export interface WorkSession {
  employeeId: Id;
  start: Instant;
  end: Instant | null;
  breaks: BreakInterval[];
  /** 労務上の労働日（始業時刻の暦日） */
  laborDate: LocalDate;
  /** 店舗運営上の営業日 */
  businessDate: LocalDate;
  eventIds: Id[];
  anomalies: string[];
}

/** 手動登録の休憩（打刻漏れ補正など） */
export interface ManualBreak extends RowMeta {
  employeeId: Id;
  start: string;
  end: string;
  reason: string;
  actorId: Id;
}

// ---------------------------------------------------------------- シフト
export interface Shift extends RowMeta {
  employeeId: Id;
  date: LocalDate; // 勤務開始日
  start: LocalTime; // 'HH:MM'
  end: LocalTime; // 24時以降は翌日（例 '26:00'）
  breakMinutes: number; // 固定休憩（予定）
  /** 固定休憩を実績に適用するか（打刻休憩がない場合のみ適用） */
  applyFixedBreak: boolean;
  fixedBreakStart: LocalTime | null;
  status: 'draft' | 'published' | 'cancelled';
  publishedAt: string | null;
  note: string;
}

export interface ShiftPattern extends RowMeta {
  name: string;
  start: LocalTime;
  end: LocalTime;
  breakMinutes: number;
}

// ---------------------------------------------------------------- 有給
export interface LeaveGrant extends RowMeta {
  employeeId: Id;
  grantDate: LocalDate;
  days: number;
  expiresOn: LocalDate; // 時効（付与日から2年）
  kind: 'statutory' | 'proportional' | 'initial_balance' | 'extra';
  /** 出勤率8割以上を確認したか */
  attendanceRateConfirmed: boolean;
  note: string;
}

export interface LeaveTransaction extends RowMeta {
  employeeId: Id;
  date: LocalDate;
  days: number; // 取得=正, 調整は adjust
  kind: 'take' | 'adjust' | 'expire';
  /** 有給取得時の所定労働時間（分）: 通常の賃金方式の計算用 */
  scheduledMinutes: number | null;
  grantId: Id | null;
  reason: string;
  actorId: Id;
}

// ---------------------------------------------------------------- 給与
export type PayrollStatus = 'uncomputed' | 'draft' | 'review' | 'confirmed' | 'issued';

export interface PayrollPeriod extends RowMeta {
  periodKey: string; // 例 '2026-11'（支給対象月）
  from: LocalDate;
  to: LocalDate;
  payDate: LocalDate;
  status: PayrollStatus;
}

export interface PayrollResult extends RowMeta {
  periodId: Id;
  employeeId: Id;
  revision: number; // 訂正ごとに +1（旧版は superseded）
  status: PayrollStatus | 'superseded';
  computedAt: string;
  confirmedAt: string | null;
  confirmedBy: Id | null;
  calcVersion: string;
  /** 明細の金額（円・整数） */
  totals: PayrollTotals;
  /** 計算根拠・入力スナップショット（JSON）。確定後は不変 */
  snapshot: string;
  issues: string; // JSON PayrollIssue[]
  correctionReason: string;
}

export interface PayrollTotals {
  workDays: number;
  workMinutes: number;
  overtimeMinutes: number;
  over60Minutes: number;
  nightMinutes: number;
  holidayMinutes: number;
  basePay: number;
  /** 月給制: 所定時間外の通常賃金部分（法定内残業・時間外・休日労働の100%部分） */
  extraHoursBasePay: number;
  overtimePremium: number;
  over60Premium: number;
  nightPremium: number;
  holidayPremium: number;
  fixedOvertimePay: number;
  fixedOvertimeExcess: number;
  paidLeavePay: number;
  paidLeaveDays: number;
  allowances: { name: string; amount: number }[];
  transport: number;
  absenceDeduction: number;
  grossPay: number;
  deductions: { name: string; amount: number }[];
  deductionTotal: number;
  netPay: number;
}

export interface PaySlip extends RowMeta {
  periodId: Id;
  employeeId: Id;
  payrollResultId: Id;
  revision: number;
  driveFileId: string | null;
  issuedAt: string;
  status: 'issued' | 'superseded';
}

// ---------------------------------------------------------------- 分析・予算
export interface Budget extends RowMeta {
  month: string; // 'YYYY-MM'
  monthlyAmount: number;
  dailyAmounts: Record<LocalDate, number>;
  laborCostAllocation: 'by_calendar_day' | 'by_worked_minutes' | 'by_scheduled_days';
}

// ---------------------------------------------------------------- 通知
export type NotificationKind =
  | 'missing_clock_in'
  | 'missing_clock_out'
  | 'missing_break_end'
  | 'late'
  | 'early_leave'
  | 'absence'
  | 'abnormal_hours'
  | 'insufficient_break'
  | 'payroll_unconfirmed'
  | 'pay_conditions_missing'
  | 'leave_expiring'
  | 'leave_5day_obligation'
  | 'budget_over'
  | 'backup_failed'
  | 'drive_capacity'
  | 'update_available'
  | 'min_wage_violation';

export interface NotificationRow extends RowMeta {
  kind: NotificationKind;
  dedupeKey: string;
  /** 'owner' 宛 or 特定 employeeId 宛 */
  audience: 'owner' | 'staff_self' | 'managers';
  employeeId: Id | null;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'unread' | 'read' | 'resolved';
  relatedDate: LocalDate | null;
}

// ---------------------------------------------------------------- 監査・システム
export interface AuditLog extends RowMeta {
  at: string;
  actorKind: 'owner' | 'staff' | 'system';
  actorId: Id | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string; // PII・秘密情報を含めない
  requestId: string | null;
}

export interface BackupHistory extends RowMeta {
  kind: 'daily' | 'monthly' | 'pre_update' | 'manual';
  driveFileId: string;
  schemaVersion: number;
  /** pruned: 世代管理により削除済み */
  status: 'ok' | 'failed' | 'pruned';
  sizeBytes: number | null;
  note: string;
}

export interface SystemMetadata extends RowMeta {
  key: string;
  value: string;
}

export interface RequestIdempotency extends RowMeta {
  requestId: string;
  op: string;
  principalKey: string;
  responseJson: string;
}

export interface OperationJournal extends RowMeta {
  op: string;
  state: 'started' | 'committed' | 'failed';
  detail: string;
}
