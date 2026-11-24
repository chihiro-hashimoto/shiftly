/**
 * リクエストコンテキストと認可ヘルパー
 */
import type { Platform } from './platform';
import type { UnitOfWork } from './store';
import type { Employee, PermissionKey, StoreSettings } from '../shared/types';
import { E } from './errors';
import { toIsoJst, toLocalDate } from '../shared/time';

export type Principal =
  | { kind: 'owner' }
  | { kind: 'system' }
  | {
      kind: 'staff';
      employeeId: string;
      sessionId: string;
      deviceId: string;
      permissions: PermissionKey[];
      stepUp: boolean;
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

export function isOwner(ctx: Ctx): boolean {
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
  return 'system';
}

export function actorKind(ctx: Ctx): 'owner' | 'staff' | 'system' {
  return ctx.principal.kind === 'staff' ? 'staff' : ctx.principal.kind === 'owner' ? 'owner' : 'system';
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
};

export function settings(ctx: Ctx): StoreSettings {
  const rows = ctx.uow.list<StoreSettings>('store_settings');
  if (!rows[0]) throw E.notInitialized();
  return { ...DEFAULT_SETTINGS, ...rows[0] };
}

export function employee(ctx: Ctx, id: string): Employee {
  const e = ctx.uow.get<Employee>('employees', id);
  if (!e) throw E.notFound('スタッフ');
  return e;
}

export function metaValue(ctx: Ctx, key: string): string | null {
  return ctx.uow.list<{ key: string; value: string }>('system_metadata').find((m) => m.key === key)?.value ?? null;
}

export function setMeta(ctx: Ctx, key: string, value: string) {
  const row = ctx.uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === key);
  if (row) ctx.uow.update('system_metadata', { ...row, value });
  else ctx.uow.insert('system_metadata', { key, value } as never, 'meta');
}
