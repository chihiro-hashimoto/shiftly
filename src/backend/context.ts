/**
 * リクエストコンテキストと認可ヘルパー
 */
import type { Platform } from './platform';
import type { UnitOfWork } from './store';
import type { Employee, PermissionKey, StoreSettings } from '../shared/types';
import { ApiError, E } from './errors';
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
/**
 * 復元後の給与の停止（期間 ID → 停止）。記録を読み取れない場合は「停止なし」と見なさず、エラーにする
 * （確定・訂正・明細の発行・停止の解除・復元を止める。迷ったら止める。独立した点検 補足2）
 */
export function payrollRestoreLocks(ctx: Ctx): Record<string, PayrollRestoreLock> {
  // 記録の行がない場合だけ「停止なし」。行があるのに値が空・空白・壊れている場合は止める（Codex 監査22 #1。停止なしは '{}' で表す）
  const row = ctx.uow.list<{ key: string; value: string | null }>('system_metadata').find((m) => m.key === 'payrollRestoreLocks');
  if (!row) return {};
  const raw = typeof row.value === 'string' ? row.value : '';
  const broken = () =>
    new ApiError('PAYROLL_BLOCKED', '復元後の給与の確認の記録（system_metadata の payrollRestoreLocks）を読み取れないため、給与の確定・訂正・明細の発行を停止しています。DB を手で編集した場合は元に戻してください', 409);
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw broken();
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw broken();
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || typeof (v as PayrollRestoreLock).restoredAt !== 'string' || typeof (v as PayrollRestoreLock).backupId !== 'string') throw broken();
  }
  return o as Record<string, PayrollRestoreLock>;
}
export function setPayrollRestoreLocks(ctx: Ctx, locks: Record<string, PayrollRestoreLock>) {
  setMeta(ctx, 'payrollRestoreLocks', JSON.stringify(locks));
}

export function setMeta(ctx: Ctx, key: string, value: string) {
  const row = ctx.uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === key);
  if (row) ctx.uow.update('system_metadata', { ...row, value });
  else ctx.uow.insert('system_metadata', { key, value } as never, 'meta');
}

/**
 * 画面の世代（epoch。D-026・D-027）。画面がデータを取得した時点の世代を、画面からの業務更新（kind: 'edit'）で照合する。
 * 業務 DB・バックアップとは別の保存場所（Script Properties。モックでは SecretStore）に置くため、DB の内容の変更で巻き戻らない。
 * 値は乱数（時刻・前回の値に依存しない。Codex 監査24 A1）。発行するのは次の 2 つの場合だけ:
 * - 初めての構築の初期化（system.initialize。DB に初期化の記録がない場合）
 * - Google 所有者の保守作業の終了（maintenance.finish。全セッションの失効と同時に行い、保守の前に開いた画面をすべて無効にする）
 * 既存の環境で記録が失われた・壊れた場合は、自動では作り直さない（業務の更新は EPOCH_UNAVAILABLE で止まり、保守作業の終了で再発行する）
 */
export const EPOCH_KEY = 'SHIFTLY_RESTORE_EPOCH';
export function currentEpoch(p: Platform): number | null {
  const raw = p.secrets.get(EPOCH_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return /^[1-9][0-9]{0,15}$/.test(raw) && Number.isSafeInteger(n) ? n : null;
}
/**
 * 新しい世代を乱数で発行して保存する（現在の値・時刻に依存しない。48 ビットの乱数のため、過去に発行した値と一致する確率は無視できるほど小さい）。
 * 保存できたことを読み直して確かめる
 */
export function issueEpoch(p: Platform): number {
  const prev = currentEpoch(p);
  let next = 0;
  for (let i = 0; i < 4 && (next === 0 || next === prev); i++) next = parseInt(p.randomHex(6), 16) + 1;
  if (next === prev || !Number.isSafeInteger(next) || next < 1) throw new Error('画面の世代を発行できませんでした');
  p.secrets.set(EPOCH_KEY, String(next));
  if (currentEpoch(p) !== next) throw new Error('画面の世代を保存できませんでした');
  return next;
}

/**
 * Google 所有者の保守作業の記録（D-027）。業務 DB の外（Script Properties）に置く: 保守の作業で DB の内容（system_metadata を含む）を
 * 手で戻しても、保守中であることは失われない。記録があれば（内容を読み取れない場合も）保守中として、全員の更新系を止める（api.ts）
 */
export const MAINTENANCE_KEY = 'SHIFTLY_MAINTENANCE';
export interface MaintenanceState {
  startedAt: string;
  /** 開始時のバックアップ（backup_history の ID）。開始の途中で失敗した場合は null */
  backupId: string | null;
  /** 開始時の DB の内容の記録（Google ドライブの 00_System のファイル）。開始の途中で失敗した場合は null */
  snapshotFileId: string | null;
}
export function maintenanceActive(p: Platform): boolean {
  try {
    return p.secrets.get(MAINTENANCE_KEY) !== null;
  } catch {
    return true;
  }
}
/** 保守の記録を読む。記録がない場合は null。内容を読み取れない場合は 'broken' */
export function maintenanceState(p: Platform): MaintenanceState | 'broken' | null {
  const raw = p.secrets.get(MAINTENANCE_KEY);
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as MaintenanceState;
    if (!o || typeof o !== 'object' || typeof o.startedAt !== 'string') return 'broken';
    return { startedAt: o.startedAt, backupId: typeof o.backupId === 'string' ? o.backupId : null, snapshotFileId: typeof o.snapshotFileId === 'string' ? o.snapshotFileId : null };
  } catch {
    return 'broken';
  }
}
