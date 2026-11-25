/**
 * リクエストコンテキストと認可ヘルパー
 */
import type { Platform } from './platform';
import type { UnitOfWork } from './store';
import type { Employee, PermissionKey, StoreSettings } from '../shared/types';
import { E } from './errors';
import { toIsoJst, toLocalDate } from '../shared/time';

export type Principal =
  /** Google 所有者（Shiftly-Admin の署名付き転送・Setup・エディタ実行） */
  | { kind: 'owner' }
  | { kind: 'system' }
  /** 管理者（v1.3: 店舗 iPad で管理者パスワードにより認証。Google 所有者に限定した操作は不可） */
  | { kind: 'admin'; sessionId: string; deviceId: string; reauth: boolean }
  | {
      kind: 'staff';
      employeeId: string;
      sessionId: string;
      deviceId: string;
      permissions: PermissionKey[];
      stepUp: boolean;
      /** PIN による本人確認済みか（v1.3: PIN 未設定のスタッフは false） */
      verified: boolean;
    }
  | { kind: 'device'; deviceId: string }
  | { kind: 'anonymous' };

export interface Ctx {
  p: Platform;
  uow: UnitOfWork;
  principal: Principal;
  now: number;
  requestId: string | null;
  op: string;
}

export function nowIso(ctx: Ctx): string {
  return toIsoJst(ctx.now);
}

export function today(ctx: Ctx): string {
  return toLocalDate(ctx.now);
}

/**
 * 管理者権限（業務上の全権限）を持つか: Google 所有者・システム・管理者パスワードで認証した管理者。
 * Google 所有者本人に限定する判定には isGoogleOwner を使う。
 */
export function isOwner(ctx: Ctx): boolean {
  return ctx.principal.kind === 'owner' || ctx.principal.kind === 'system' || ctx.principal.kind === 'admin';
}

/** Google 所有者（または時間主導トリガー等のシステム実行）か。共用 iPad の管理者は含まない */
export function isGoogleOwner(ctx: Ctx): boolean {
  return ctx.principal.kind === 'owner' || ctx.principal.kind === 'system';
}

export function staff(ctx: Ctx) {
  if (ctx.principal.kind !== 'staff') throw E.unauthenticated();
  return ctx.principal;
}

export function has(ctx: Ctx, perm: PermissionKey): boolean {
  if (isOwner(ctx)) return true;
  return ctx.principal.kind === 'staff' && ctx.principal.permissions.includes(perm);
}

export function require_(ctx: Ctx, perm: PermissionKey, label?: string) {
  if (!has(ctx, perm)) throw E.forbidden(label);
}

/** 自分のデータは *_self、他人のデータは *_all を要求 */
export function requireSelfOrAll(ctx: Ctx, employeeId: string, self: PermissionKey, all: PermissionKey) {
  if (isOwner(ctx)) return;
  const s = staff(ctx);
  if (s.employeeId === employeeId) {
    if (!s.permissions.includes(self) && !s.permissions.includes(all)) throw E.forbidden();
  } else if (!s.permissions.includes(all)) throw E.forbidden();
}

export function actorId(ctx: Ctx): string {
  if (ctx.principal.kind === 'staff') return ctx.principal.employeeId;
  if (ctx.principal.kind === 'owner') return 'owner';
  if (ctx.principal.kind === 'admin') return 'admin';
  return 'system';
}

export function actorKind(ctx: Ctx): 'owner' | 'admin' | 'staff' | 'system' {
  const k = ctx.principal.kind;
  return k === 'staff' ? 'staff' : k === 'owner' ? 'owner' : k === 'admin' ? 'admin' : 'system';
}

/** 勤怠修正・申請等の記録に使う実行者種別（system は owner として記録） */
export function actorKindForRecord(ctx: Ctx): 'owner' | 'admin' | 'staff' {
  const k = actorKind(ctx);
  return k === 'system' ? 'owner' : k;
}

/** 本人確認済みか（スタッフは PIN 認証済み。管理者・所有者は true） */
export function identityVerified(ctx: Ctx): boolean {
  return ctx.principal.kind === 'staff' ? ctx.principal.verified : isOwner(ctx);
}

/** 監査ログ（summary に個人情報・秘密情報を含めないこと） */
export function audit(ctx: Ctx, action: string, targetType: string, targetId: string | null, summary: string) {
  ctx.uow.insert('audit_logs', {
    at: nowIso(ctx),
    actorKind: actorKind(ctx),
    actorId: ctx.principal.kind === 'staff' ? ctx.principal.employeeId : null,
    action,
    targetType,
    targetId,
    summary: summary.slice(0, 500),
    requestId: ctx.requestId,
  } as never, 'aud');
}

export const DEFAULT_SETTINGS: Omit<StoreSettings, 'id' | 'createdAt' | 'updatedAt' | 'version'> = {
  storeName: '',
  storeAddress: '',
  timezone: 'Asia/Tokyo',
  businessHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, closed: false, open: '18:00', close: '26:00' })),
  businessDayCutoff: '05:00',
  workingTimeSystem: 'unset',
  weekStartDay: null,
  statutoryHolidayWeekday: null,
  weekly44Confirmed: false,
  agreement36: 'unset',
  overtime60StartDay: null,
  payrollClosingDay: null,
  payMonthOffset: null,
  payDay: null,
  yenRounding: 'half_up',
  minimumWages: [],
  employerCostRatePercent: null,
  idleTimeoutSec: 60,
  pinMaxAttempts: 5,
  pinLockMinutes: 15,
  publicHolidays: [],
  paidLeaveWageMethod: 'unset',
  halfDayLeaveAllowed: false,
  payslipDelivery: 'paper',
  retentionYears: 5,
  dailyBackupGenerations: 30,
  monthlyBackupGenerations: 12,
  payrollRulesConfirmedAt: null,
  breakMode: 'scheduled',
  payrollTimeBasis: 'shift',
};

export function settings(ctx: Ctx): StoreSettings & { breakMode: 'scheduled' | 'punch'; payrollTimeBasis: 'shift' | 'actual' } {
  const rows = ctx.uow.list<StoreSettings>('store_settings');
  if (!rows[0]) throw E.notInitialized();
  const r = rows[0];
  // v1 の行（列追加前）は空文字で読まれるため既定値で補う
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    breakMode: r.breakMode === 'punch' ? 'punch' : 'scheduled',
    payrollTimeBasis: r.payrollTimeBasis === 'actual' ? 'actual' : 'shift',
  };
}

export function employee(ctx: Ctx, id: string): Employee {
  const e = ctx.uow.get<Employee>('employees', id);
  if (!e) throw E.notFound('スタッフ');
  return e;
}

export function metaValue(ctx: Ctx, key: string): string | null {
  return ctx.uow.list<{ key: string; value: string }>('system_metadata').find((m) => m.key === key)?.value ?? null;
}

/** 復元で引き継いだ確定済みの給与期間（給与条件の確認まで確定・訂正・明細の発行を止める。Codex 監査9 #1） */
export interface PayrollRestoreLock {
  restoredAt: string;
  backupId: string;
}
export function payrollRestoreLocks(ctx: Ctx): Record<string, PayrollRestoreLock> {
  const raw = metaValue(ctx, 'payrollRestoreLocks');
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, PayrollRestoreLock>) : {};
  } catch {
    return {};
  }
}
export function setPayrollRestoreLocks(ctx: Ctx, locks: Record<string, PayrollRestoreLock>) {
  setMeta(ctx, 'payrollRestoreLocks', JSON.stringify(locks));
}

export function setMeta(ctx: Ctx, key: string, value: string) {
  const row = ctx.uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === key);
  if (row) ctx.uow.update('system_metadata', { ...row, value });
  else ctx.uow.insert('system_metadata', { key, value } as never, 'meta');
}
