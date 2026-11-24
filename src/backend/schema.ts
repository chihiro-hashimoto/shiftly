/**
 * DB スキーマ（Google Sheets 上の論理テーブル）
 * - 1テーブル = 1シート（月別パーティションのテーブルは `<table>__YYYY_MM`）
 * - 1行目はヘッダー（列名）。列の追加は末尾のみ（後方互換）
 * - 値は RAW で書き込む（文字列 '=...' が数式として評価されない）
 * 詳細は docs/database-schema.md
 */

export type ColType = 'string' | 'number' | 'boolean' | 'json' | 'string_nullable' | 'number_nullable';

export interface TableDef {
  name: TableName;
  columns: Array<[string, ColType]>;
  /** 月別パーティションの基準列（ISO日時 or YYYY-MM-DD） */
  partitionBy?: string;
  /** 主にどの操作で読むか（ドキュメント用） */
  description: string;
}

export const META_COLS: Array<[string, ColType]> = [
  ['id', 'string'],
  ['createdAt', 'string'],
  ['updatedAt', 'string'],
  ['version', 'number'],
];

export type TableName =
  | 'store_settings'
  | 'employees'
  | 'employment_history'
  | 'credentials'
  | 'permissions'
  | 'devices'
  | 'device_enrollments'
  | 'sessions'
  | 'wage_rules'
  | 'salary_rules'
  | 'attendance_events'
  | 'attendance_corrections'
  | 'manual_breaks'
  | 'shifts'
  | 'shift_patterns'
  | 'shift_history'
  | 'leave_grants'
  | 'leave_transactions'
  | 'transport_rules'
  | 'allowances'
  | 'deductions'
  | 'payroll_adjustments'
  | 'payroll_periods'
  | 'payroll_results'
  | 'pay_slips'
  | 'budgets'
  | 'notifications'
  | 'audit_logs'
  | 'backup_history'
  | 'system_metadata'
  | 'request_idempotency'
  | 'operation_journal'
  | 'migration_history'
  | 'exports';

const t = (name: TableName, description: string, cols: Array<[string, ColType]>, partitionBy?: string): TableDef => ({
  name,
  description,
  columns: [...META_COLS, ...cols],
  ...(partitionBy ? { partitionBy } : {}),
});

export const SCHEMA_VERSION = 1;

export const TABLES: TableDef[] = [
  t('store_settings', '店舗設定（1行）', [
    ['storeName', 'string'], ['storeAddress', 'string'], ['timezone', 'string'], ['businessHours', 'json'], ['businessDayCutoff', 'string'],
    ['workingTimeSystem', 'string'], ['weekStartDay', 'number_nullable'], ['statutoryHolidayWeekday', 'number_nullable'], ['weekly44Confirmed', 'boolean'],
    ['agreement36', 'string'], ['overtime60StartDay', 'number_nullable'], ['payrollClosingDay', 'number_nullable'], ['payMonthOffset', 'number_nullable'],
    ['payDay', 'number_nullable'], ['yenRounding', 'string'], ['minimumWages', 'json'], ['employerCostRatePercent', 'number_nullable'],
    ['idleTimeoutSec', 'number'], ['pinMaxAttempts', 'number'], ['pinLockMinutes', 'number'], ['publicHolidays', 'json'],
    ['paidLeaveWageMethod', 'string'], ['halfDayLeaveAllowed', 'boolean'], ['payslipDelivery', 'string'], ['retentionYears', 'number'],
    ['dailyBackupGenerations', 'number'], ['monthlyBackupGenerations', 'number'], ['payrollRulesConfirmedAt', 'string_nullable'],
  ]),
  t('employees', 'スタッフ（主キーは id。氏名は主キーにしない）', [
    ['employeeCode', 'string'], ['displayName', 'string'], ['kana', 'string'], ['status', 'string'], ['hireDate', 'string_nullable'],
    ['retireDate', 'string_nullable'], ['payType', 'string'], ['sortOrder', 'number'], ['electronicPayslipConsent', 'boolean'], ['note', 'string'],
  ]),
  t('employment_history', '雇用条件履歴', [
    ['employeeId', 'string'], ['effectiveFrom', 'string'], ['effectiveTo', 'string_nullable'], ['payType', 'string'],
    ['weeklyScheduledDays', 'number_nullable'], ['weeklyScheduledMinutes', 'number_nullable'], ['yearlyScheduledDays', 'number_nullable'],
    ['dailyScheduledMinutes', 'number_nullable'], ['monthlyAverageScheduledMinutes', 'number_nullable'], ['note', 'string'],
  ]),
  t('credentials', 'PIN・管理用パスコードのハッシュ（平文なし。pepper は Script Properties）', [
    ['employeeId', 'string'], ['kind', 'string'], ['hash', 'string'], ['salt', 'string'], ['iterations', 'number'], ['algo', 'string'],
    ['failedCount', 'number'], ['lockedUntil', 'string_nullable'], ['mustChange', 'boolean'],
  ]),
  t('permissions', 'スタッフ個別権限', [['employeeId', 'string'], ['permissions', 'json']]),
  t('devices', '登録済み店舗端末（トークンはハッシュのみ）', [
    ['name', 'string'], ['tokenHash', 'string'], ['status', 'string'], ['registeredAt', 'string'], ['lastUsedAt', 'string_nullable'],
    ['revokedAt', 'string_nullable'], ['userAgentHint', 'string'],
  ]),
  t('device_enrollments', '端末登録コード（短時間・使い捨て）', [['codeHash', 'string'], ['deviceName', 'string'], ['expiresAt', 'string'], ['usedAt', 'string_nullable']]),
  t('sessions', 'スタッフセッション（トークンはハッシュのみ。月別。有効期限30分のため直近2か月のみ参照）', [
    ['tokenHash', 'string'], ['deviceId', 'string'], ['employeeId', 'string'], ['expiresAt', 'string'], ['lastActivityAt', 'string'],
    ['stepUpUntil', 'string_nullable'], ['revokedAt', 'string_nullable'],
  ], 'createdAt'),
  t('wage_rules', '時給ルール（個人・曜日・時間帯・祝日・特定日）', [
    ['employeeId', 'string'], ['kind', 'string'], ['hourlyRate', 'number'], ['effectiveFrom', 'string'], ['effectiveTo', 'string_nullable'],
    ['weekdays', 'json'], ['timeFrom', 'string_nullable'], ['timeTo', 'string_nullable'], ['specialDates', 'json'], ['priority', 'number'],
    ['includesNightPremium', 'boolean'], ['premiumBaseRate', 'number_nullable'], ['note', 'string'],
  ]),
  t('salary_rules', '月給制の給与条件', [
    ['employeeId', 'string'], ['effectiveFrom', 'string'], ['effectiveTo', 'string_nullable'], ['monthlySalary', 'number'],
    ['monthlyScheduledMinutes', 'number_nullable'], ['scheduledWeekdays', 'json'], ['scheduledDailyMinutes', 'number_nullable'],
    ['inLegalOvertimeRate', 'number_nullable'], ['fixedOvertime', 'json'], ['absenceDeduction', 'json'], ['lateEarlyDeduction', 'json'],
    ['confirmed', 'boolean'], ['note', 'string'],
  ]),
  t('attendance_events', '打刻原本（追記専用・月別）', [
    ['employeeId', 'string'], ['type', 'string'], ['at', 'string'], ['deviceId', 'string_nullable'], ['source', 'string'],
    ['requestId', 'string'], ['actorId', 'string_nullable'], ['note', 'string'],
  ], 'at'),
  t('attendance_corrections', '勤怠修正（原本は不変。修正前後・理由・修正者）', [
    ['employeeId', 'string'], ['action', 'string'], ['targetEventId', 'string_nullable'], ['newType', 'string_nullable'], ['newAt', 'string_nullable'],
    ['reason', 'string'], ['actorId', 'string'], ['actorKind', 'string'], ['status', 'string'], ['before', 'string'], ['after', 'string'],
  ]),
  t('manual_breaks', '手動登録の休憩', [['employeeId', 'string'], ['start', 'string'], ['end', 'string'], ['reason', 'string'], ['actorId', 'string']]),
  t('shifts', 'シフト', [
    ['employeeId', 'string'], ['date', 'string'], ['start', 'string'], ['end', 'string'], ['breakMinutes', 'number'], ['applyFixedBreak', 'boolean'],
    ['fixedBreakStart', 'string_nullable'], ['status', 'string'], ['publishedAt', 'string_nullable'], ['note', 'string'],
  ]),
  t('shift_patterns', '勤務パターン', [['name', 'string'], ['start', 'string'], ['end', 'string'], ['breakMinutes', 'number']]),
  t('shift_history', 'シフト変更履歴', [['shiftId', 'string'], ['action', 'string'], ['before', 'string'], ['after', 'string'], ['actorId', 'string']]),
  t('leave_grants', '有給付与', [
    ['employeeId', 'string'], ['grantDate', 'string'], ['days', 'number'], ['expiresOn', 'string'], ['kind', 'string'],
    ['attendanceRateConfirmed', 'boolean'], ['note', 'string'],
  ]),
  t('leave_transactions', '有給取得・調整履歴', [
    ['employeeId', 'string'], ['date', 'string'], ['days', 'number'], ['kind', 'string'], ['scheduledMinutes', 'number_nullable'],
    ['grantId', 'string_nullable'], ['reason', 'string'], ['actorId', 'string'],
  ]),
  t('transport_rules', '交通費規定（個人別）', [
    ['employeeId', 'string'], ['effectiveFrom', 'string'], ['effectiveTo', 'string_nullable'], ['method', 'string'], ['amount', 'number'],
    ['monthlyCap', 'number_nullable'], ['actualAmounts', 'json'], ['note', 'string'],
  ]),
  t('allowances', '各種手当', [
    ['employeeId', 'string'], ['name', 'string'], ['kind', 'string'], ['amount', 'number'], ['effectiveFrom', 'string'], ['effectiveTo', 'string_nullable'],
    ['premiumBaseCategory', 'string'], ['includeInMinimumWage', 'boolean'], ['periodAmounts', 'json'], ['note', 'string'],
  ]),
  t('deductions', '控除（手動入力）', [
    ['employeeId', 'string'], ['periodId', 'string'], ['status', 'string'], ['incomeTax', 'number'], ['residentTax', 'number'],
    ['healthInsurance', 'number'], ['pension', 'number'], ['employmentInsurance', 'number'], ['nursingInsurance', 'number'], ['others', 'json'], ['note', 'string'],
  ]),
  t('payroll_adjustments', '給与調整（承認済みの欠勤・遅刻早退控除、手動加減算）', [
    ['employeeId', 'string'], ['periodId', 'string'], ['kind', 'string'], ['quantity', 'number'], ['amount', 'number_nullable'], ['label', 'string'],
    ['reason', 'string'], ['approvedBy', 'string'],
  ]),
  t('payroll_periods', '給与計算期間', [['periodKey', 'string'], ['from', 'string'], ['to', 'string'], ['payDate', 'string'], ['status', 'string']]),
  t('payroll_results', '給与計算結果（確定版は不変。訂正は新リビジョン）', [
    ['periodId', 'string'], ['employeeId', 'string'], ['revision', 'number'], ['status', 'string'], ['computedAt', 'string'],
    ['confirmedAt', 'string_nullable'], ['confirmedBy', 'string_nullable'], ['calcVersion', 'string'], ['totals', 'json'], ['snapshot', 'string'],
    ['issues', 'string'], ['correctionReason', 'string'],
  ]),
  t('pay_slips', '給与明細', [
    ['periodId', 'string'], ['employeeId', 'string'], ['payrollResultId', 'string'], ['revision', 'number'], ['driveFileId', 'string_nullable'],
    ['issuedAt', 'string'], ['status', 'string'],
  ]),
  t('budgets', '人件費予算', [['month', 'string'], ['monthlyAmount', 'number'], ['dailyAmounts', 'json'], ['laborCostAllocation', 'string']]),
  t('notifications', 'アプリ内通知', [
    ['kind', 'string'], ['dedupeKey', 'string'], ['audience', 'string'], ['employeeId', 'string_nullable'], ['title', 'string'], ['body', 'string'],
    ['severity', 'string'], ['status', 'string'], ['relatedDate', 'string_nullable'],
  ]),
  t('audit_logs', '監査ログ（追記専用・月別。PII・秘密情報は記録しない）', [
    ['at', 'string'], ['actorKind', 'string'], ['actorId', 'string_nullable'], ['action', 'string'], ['targetType', 'string'],
    ['targetId', 'string_nullable'], ['summary', 'string'], ['requestId', 'string_nullable'],
  ], 'at'),
  t('backup_history', 'バックアップ履歴', [
    ['kind', 'string'], ['driveFileId', 'string'], ['schemaVersion', 'number'], ['status', 'string'], ['sizeBytes', 'number_nullable'], ['note', 'string'],
  ]),
  t('system_metadata', 'システム情報（環境ID・スキーマ・バージョン等）', [['key', 'string'], ['value', 'string']]),
  t('request_idempotency', '冪等性キー（再送時の重複登録防止）', [['requestId', 'string'], ['op', 'string'], ['principalKey', 'string'], ['responseJson', 'string']], 'createdAt'),
  t('operation_journal', '書き込み処理履歴（部分失敗の検出・再実行。月別）', [['op', 'string'], ['state', 'string'], ['detail', 'string']], 'createdAt'),
  t('migration_history', 'DB マイグレーション履歴', [['fromVersion', 'number'], ['toVersion', 'number'], ['status', 'string'], ['note', 'string']]),
  t('exports', '出力ファイル履歴', [['kind', 'string'], ['format', 'string'], ['driveFileId', 'string'], ['requestedBy', 'string'], ['note', 'string']]),
];

export const TABLE_BY_NAME: Record<TableName, TableDef> = Object.fromEntries(TABLES.map((d) => [d.name, d])) as Record<TableName, TableDef>;

export function partitionKeyOf(def: TableDef, row: Record<string, unknown>): string | null {
  if (!def.partitionBy) return null;
  const v = row[def.partitionBy];
  if (typeof v !== 'string' || v.length < 7) throw new Error(`パーティション列 ${def.partitionBy} が不正です`);
  // ISO（+09:00）でも YYYY-MM-DD でも先頭7文字が JST の年月
  return v.slice(0, 7);
}

export function sheetNameFor(def: TableDef, partition: string | null): string {
  return partition ? `${def.name}__${partition.replace('-', '_')}` : def.name;
}
