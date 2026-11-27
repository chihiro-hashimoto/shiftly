/**
 * 権限定義
 * - 管理者（owner）は全権限を固定で保持（削除不可）
 * - スタッフは個別付与。初期値は必要最小限
 * - 権限管理・端末登録・バックアップ復元・システム更新は管理者専用（スタッフへ付与不可）
 */
import type { PermissionKey } from './types';

export interface PermissionDef {
  key: PermissionKey;
  label: string;
  group: '勤怠' | '給与' | 'シフト' | '有給' | '分析' | '出力' | '管理' | '通知';
  /** 機密操作: スタッフが実行する場合は追加認証（ステップアップ）必須 */
  sensitive: boolean;
  defaultForStaff: boolean;
}

export const PERMISSIONS: PermissionDef[] = [
  { key: 'punch_self', label: '自分の出退勤打刻', group: '勤怠', sensitive: false, defaultForStaff: true },
  { key: 'attendance_view_self', label: '自分の勤怠閲覧', group: '勤怠', sensitive: false, defaultForStaff: true },
  { key: 'attendance_view_all', label: '全員の勤怠閲覧', group: '勤怠', sensitive: false, defaultForStaff: false },
  { key: 'attendance_edit', label: '勤怠修正', group: '勤怠', sensitive: true, defaultForStaff: false },
  { key: 'payroll_view_self', label: '自分の給与閲覧', group: '給与', sensitive: false, defaultForStaff: true },
  { key: 'payroll_view_all', label: '全員の給与閲覧', group: '給与', sensitive: true, defaultForStaff: false },
  { key: 'pay_conditions_edit', label: '給与条件編集', group: '給与', sensitive: true, defaultForStaff: false },
  { key: 'payroll_confirm', label: '給与確定', group: '給与', sensitive: true, defaultForStaff: false },
  { key: 'payslip_view_self', label: '自分の給与明細閲覧', group: '給与', sensitive: false, defaultForStaff: true },
  { key: 'payslip_view_others', label: '他者の給与明細閲覧', group: '給与', sensitive: true, defaultForStaff: false },
  { key: 'shift_view_published', label: '公開シフト閲覧', group: 'シフト', sensitive: false, defaultForStaff: true },
  { key: 'shift_edit', label: 'シフト作成・編集', group: 'シフト', sensitive: false, defaultForStaff: false },
  { key: 'shift_publish', label: 'シフト公開', group: 'シフト', sensitive: false, defaultForStaff: false },
  { key: 'leave_view_self', label: '自分の有給閲覧', group: '有給', sensitive: false, defaultForStaff: true },
  { key: 'leave_manage', label: '有給管理', group: '有給', sensitive: true, defaultForStaff: false },
  { key: 'labor_cost_view', label: '人件費分析閲覧', group: '分析', sensitive: true, defaultForStaff: false },
  { key: 'budget_manage', label: '予算管理', group: '分析', sensitive: false, defaultForStaff: false },
  { key: 'export_attendance', label: '勤怠データ出力', group: '出力', sensitive: true, defaultForStaff: false },
  { key: 'export_payroll', label: '給与データ出力', group: '出力', sensitive: true, defaultForStaff: false },
  { key: 'staff_manage', label: 'スタッフ管理', group: '管理', sensitive: true, defaultForStaff: false },
  { key: 'notifications_view', label: '通知閲覧', group: '通知', sensitive: false, defaultForStaff: true },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);
export const DEFAULT_STAFF_PERMISSIONS: PermissionKey[] = PERMISSIONS.filter((p) => p.defaultForStaff).map((p) => p.key);
export const SENSITIVE_PERMISSIONS = new Set<PermissionKey>(PERMISSIONS.filter((p) => p.sensitive).map((p) => p.key));

/** 管理者専用操作（スタッフには付与不可） */
export type OwnerOnlyCapability = 'permission_manage' | 'device_manage' | 'backup_restore' | 'system_update' | 'store_settings';

export function isPermissionKey(x: unknown): x is PermissionKey {
  return typeof x === 'string' && (ALL_PERMISSION_KEYS as string[]).includes(x);
}

export function sanitizePermissions(xs: unknown): PermissionKey[] {
  if (!Array.isArray(xs)) return [];
  return [...new Set(xs.filter(isPermissionKey))];
}

/**
 * 人件費分析で個人給与が推定できる経路の制御:
 * labor_cost_view のみ（payroll_view_all なし）の場合、スタッフ別内訳は返さない。
 */
export function canSeeIndividualPay(perms: PermissionKey[] | 'all'): boolean {
  return perms === 'all' || perms.includes('payroll_view_all');
}
