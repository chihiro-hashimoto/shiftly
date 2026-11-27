/**
 * スタッフ・雇用条件・個別権限・認証情報
 * F04 個別権限 / F05 スタッフ・雇用条件
 *
 * なりすまし・権限昇格の防止:
 * - 権限の付与・変更、PIN・管理用パスコードの設定/リセットは管理者専用（Google 所有者、または管理者パスワードで再認証した管理者）
 * - staff_manage を持つスタッフも、他人の認証情報・権限は変更できない
 */
import { defineOps } from '../api';
import { audit, has, isOwner, nowIso, require_, type Ctx } from '../context';
import { E } from '../errors';
import * as v from '../validate';
import type { Credential, Employee, EmploymentHistory, PermissionKey, PermissionRow } from '../../shared/types';
import { DEFAULT_STAFF_PERMISSIONS, PERMISSIONS, sanitizePermissions } from '../../shared/permissions';
import { clearPin, hasPin, permissionsOf, revokeSessionsWhere, setCredential } from '../auth';
import { validatePinPolicy, validateStepUpSecret } from '../../shared/crypto';
import { parseIso } from '../../shared/time';

const MANAGER_VIEW_PERMS: PermissionKey[] = [
  'staff_manage', 'attendance_view_all', 'attendance_edit', 'payroll_view_all', 'shift_edit', 'shift_publish', 'leave_manage',
  'pay_conditions_edit', 'payroll_confirm', 'labor_cost_view', 'export_attendance', 'export_payroll', 'payslip_view_others',
];

function publicEmployee(e: Employee, full: boolean) {
  if (full) return e;
  return { id: e.id, displayName: e.displayName, kana: e.kana, status: e.status, payType: e.payType, sortOrder: e.sortOrder };
}

function readEmployeeArgs(a: v.Args, partial: boolean) {
  const has_ = (k: string) => !partial || Object.prototype.hasOwnProperty.call(a, k);
  const out: Partial<Employee> = {};
  if (has_('displayName')) out.displayName = v.str(a, 'displayName', { max: 40, label: '表示名' });
  if (has_('kana')) out.kana = v.str(a, 'kana', { max: 60, optional: true, label: 'ふりがな' });
  if (has_('employeeCode')) out.employeeCode = v.str(a, 'employeeCode', { max: 20, optional: true, label: '社員番号' });
  if (has_('hireDate')) out.hireDate = v.dateOrNull(a, 'hireDate', '入社日');
  if (has_('payType')) out.payType = v.oneOf(a, 'payType', ['hourly', 'monthly'] as const, '給与形態');
  if (has_('sortOrder')) out.sortOrder = Number.isNaN(v.int(a, 'sortOrder', { optional: true, min: 0, max: 9999 })) ? 0 : (a.sortOrder as number);
  if (has_('electronicPayslipConsent')) out.electronicPayslipConsent = v.bool(a, 'electronicPayslipConsent');
  if (has_('note')) out.note = v.optStr(a, 'note', 500);
  return out;
}

defineOps([
  {
    name: 'employees.list',
    kind: 'read',
    auth: 'staff_or_owner',
    perms: MANAGER_VIEW_PERMS,
    mutating: false,
    handler: (ctx, raw) => {
      const includeRetired = v.bool(v.obj(raw), 'includeRetired');
      const full = has(ctx, 'staff_manage');
      return ctx.uow
        .list<Employee>('employees')
        .filter((e) => includeRetired || e.status === 'active')
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((e) => ({
          ...publicEmployee(e, full),
          ...(isOwner(ctx)
            ? {
                permissions: permissionsOf(ctx, e.id),
                hasPin: hasPin(ctx, e.id),
                hasStepUp: ctx.uow.list<Credential>('credentials').some((c) => c.employeeId === e.id && c.kind === 'stepup' && c.hash !== ''),
                locked: ctx.uow.list<Credential>('credentials').some((c) => c.employeeId === e.id && !!c.lockedUntil && parseIso(c.lockedUntil) > ctx.now),
              }
            : {}),
        }));
    },
  },
  {
    name: 'employees.create',
    kind: 'edit',
    auth: 'staff_or_owner',
    perms: ['staff_manage'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const d = readEmployeeArgs(a, false);
      const count = ctx.uow.list<Employee>('employees').filter((e) => e.status === 'active').length;
      if (count >= 50) throw E.invalid('登録できるスタッフ数の上限に達しています');
      const e = ctx.uow.insert<Employee>(
        'employees',
        {
          employeeCode: d.employeeCode ?? '',
          displayName: d.displayName!,
          kana: d.kana ?? '',
          status: 'active',
          hireDate: d.hireDate ?? null,
          retireDate: null,
          payType: d.payType!,
          sortOrder: d.sortOrder ?? count,
          electronicPayslipConsent: d.electronicPayslipConsent ?? false,
          note: d.note ?? '',
        },
        'emp',
      );
      ctx.uow.insert<PermissionRow>('permissions', { employeeId: e.id, permissions: [...DEFAULT_STAFF_PERMISSIONS] }, 'prm');
      audit(ctx, 'employee.create', 'employee', e.id, 'スタッフ登録');
      return e;
    },
  },
  {
    name: 'employees.update',
    kind: 'edit',
    auth: 'staff_or_owner',
    perms: ['staff_manage'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = ctx.uow.get<Employee>('employees', v.id(a, 'employeeId'));
      if (!e) throw E.notFound('スタッフ');
      const patch = readEmployeeArgs(a, true);
      if (patch.payType && patch.payType !== e.payType) require_(ctx, 'pay_conditions_edit', '給与形態の変更');
      if (typeof a.version !== 'number') throw E.invalid('version が必要です');
      const saved = ctx.uow.update('employees', { ...e, ...patch, version: a.version as number });
      audit(ctx, 'employee.update', 'employee', e.id, `変更項目: ${Object.keys(patch).join(',')}`);
      return saved;
    },
  },
  {
    name: 'employees.retire',
    kind: 'edit',
    auth: 'staff_or_owner',
    perms: ['staff_manage'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = ctx.uow.get<Employee>('employees', v.id(a, 'employeeId'));
      if (!e) throw E.notFound('スタッフ');
      if (ctx.principal.kind === 'staff' && ctx.principal.employeeId === e.id) throw E.forbidden('自分自身の退職処理');
      // 退職者は無効化のみ（勤怠・給与・監査ログは保持）
      const saved = ctx.uow.update('employees', { ...e, status: 'retired', retireDate: v.date(a, 'retireDate', { label: '退職日' }) });
      revokeSessionsWhere(ctx, (s) => s.employeeId === e.id);
      audit(ctx, 'employee.retire', 'employee', e.id, '退職（無効化）');
      return saved;
    },
  },
  {
    name: 'employees.reactivate',
    kind: 'edit',
    auth: 'owner',
    adminAllowed: true,
    mutating: true,
    handler: (ctx, raw) => {
      const e = ctx.uow.get<Employee>('employees', v.id(v.obj(raw), 'employeeId'));
      if (!e) throw E.notFound('スタッフ');
      const saved = ctx.uow.update('employees', { ...e, status: 'active', retireDate: null });
      audit(ctx, 'employee.reactivate', 'employee', e.id, '再有効化');
      return saved;
    },
  },
  // ------------------------------------------------------------ 権限（管理者専用）
  {
    name: 'permissions.catalog',
    kind: 'read',
    auth: 'owner',
    adminAllowed: true,
    mutating: false,
    handler: () => ({ permissions: PERMISSIONS, defaults: DEFAULT_STAFF_PERMISSIONS }),
  },
  {
    name: 'permissions.set',
    kind: 'edit',
    auth: 'owner',
    adminAllowed: true,
    reauth: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      const e = ctx.uow.get<Employee>('employees', employeeId);
      if (!e) throw E.notFound('スタッフ');
      const perms = sanitizePermissions(a.permissions);
      const row = ctx.uow.list<PermissionRow>('permissions').find((p) => p.employeeId === employeeId);
      const before = row ? row.permissions : DEFAULT_STAFF_PERMISSIONS;
      if (row) ctx.uow.update('permissions', { ...row, permissions: perms });
      else ctx.uow.insert<PermissionRow>('permissions', { employeeId, permissions: perms }, 'prm');
      const added = perms.filter((x) => !before.includes(x));
      const removed = before.filter((x) => !perms.includes(x));
      audit(ctx, 'permission.change', 'employee', employeeId, `追加: ${added.join(',') || 'なし'} / 削除: ${removed.join(',') || 'なし'}`);
      return { employeeId, permissions: perms };
    },
  },
  // ------------------------------------------------------------ 認証情報（管理者専用）
  {
    name: 'credentials.setPin',
    kind: 'auth',
    auth: 'owner',
    adminAllowed: true,
    reauth: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      if (!ctx.uow.get<Employee>('employees', employeeId)) throw E.notFound('スタッフ');
      const pin = v.str(a, 'pin', { max: 12, label: 'PIN' });
      const err = validatePinPolicy(pin);
      if (err) throw E.invalid(err);
      setCredential(ctx, employeeId, 'pin', pin, false);
      revokeSessionsWhere(ctx, (s) => s.employeeId === employeeId);
      audit(ctx, 'credential.set_pin', 'employee', employeeId, 'PIN設定（管理者）');
      return { ok: true };
    },
  },
  {
    // v1.3: PIN の解除（PIN 未設定に戻す）。以後は本人未確認のログインとなり、給与・明細・勤怠詳細は表示されない
    name: 'credentials.clearPin',
    kind: 'auth',
    auth: 'owner',
    adminAllowed: true,
    reauth: true,
    mutating: true,
    handler: (ctx, raw) => {
      const employeeId = v.id(v.obj(raw), 'employeeId');
      if (!ctx.uow.get<Employee>('employees', employeeId)) throw E.notFound('スタッフ');
      const cleared = clearPin(ctx, employeeId);
      revokeSessionsWhere(ctx, (s) => s.employeeId === employeeId);
      audit(ctx, 'credential.clear_pin', 'employee', employeeId, cleared ? 'PIN解除（管理者）' : 'PIN解除（未設定のため変更なし）');
      return { ok: true, cleared };
    },
  },
  {
    name: 'credentials.setStepUp',
    kind: 'auth',
    auth: 'owner',
    adminAllowed: true,
    reauth: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      if (!ctx.uow.get<Employee>('employees', employeeId)) throw E.notFound('スタッフ');
      const pass = v.str(a, 'passcode', { max: 64, label: '管理用パスコード' });
      const err = validateStepUpSecret(pass);
      if (err) throw E.invalid(err);
      setCredential(ctx, employeeId, 'stepup', pass, false);
      audit(ctx, 'credential.set_stepup', 'employee', employeeId, '管理用パスコード設定（管理者）');
      return { ok: true };
    },
  },
  {
    name: 'credentials.unlock',
    kind: 'auth',
    auth: 'owner',
    adminAllowed: true,
    mutating: true,
    handler: (ctx, raw) => {
      const employeeId = v.id(v.obj(raw), 'employeeId');
      for (const c of ctx.uow.list<Credential>('credentials').filter((x) => x.employeeId === employeeId)) {
        ctx.uow.update('credentials', { ...c, failedCount: 0, lockedUntil: null, lockCount: 0 });
      }
      audit(ctx, 'credential.unlock', 'employee', employeeId, 'ロック解除');
      return { ok: true };
    },
  },
  // ------------------------------------------------------------ 雇用条件
  {
    name: 'employment.list',
    kind: 'read',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const employeeId = v.id(v.obj(raw), 'employeeId');
      return ctx.uow.list<EmploymentHistory>('employment_history').filter((x) => x.employeeId === employeeId).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    },
  },
  {
    name: 'employment.upsert',
    kind: 'edit',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => upsertEmployment(ctx, v.obj(raw)),
  },
]);

function upsertEmployment(ctx: Ctx, a: v.Args) {
  const employeeId = v.id(a, 'employeeId');
  const emp = ctx.uow.get<Employee>('employees', employeeId);
  if (!emp) throw E.notFound('スタッフ');
  if (ctx.principal.kind === 'staff' && ctx.principal.employeeId === employeeId) throw E.forbidden('自分自身の雇用条件の変更');
  const data = {
    employeeId,
    effectiveFrom: v.date(a, 'effectiveFrom', { label: '適用開始日' }),
    effectiveTo: v.dateOrNull(a, 'effectiveTo', '適用終了日'),
    payType: v.oneOf(a, 'payType', ['hourly', 'monthly'] as const, '給与形態'),
    weeklyScheduledDays: v.intOrNull(a, 'weeklyScheduledDays', { min: 0, max: 7, label: '週所定労働日数' }),
    weeklyScheduledMinutes: v.intOrNull(a, 'weeklyScheduledMinutes', { min: 0, max: 7 * 24 * 60, label: '週所定労働時間' }),
    yearlyScheduledDays: v.intOrNull(a, 'yearlyScheduledDays', { min: 0, max: 366, label: '年間所定労働日数' }),
    dailyScheduledMinutes: v.intOrNull(a, 'dailyScheduledMinutes', { min: 0, max: 24 * 60, label: '1日所定労働時間' }),
    monthlyAverageScheduledMinutes: v.intOrNull(a, 'monthlyAverageScheduledMinutes', { min: 0, max: 31 * 24 * 60, label: '1か月平均所定労働時間' }),
    note: v.optStr(a, 'note', 300),
  };
  if (data.effectiveTo && data.effectiveTo < data.effectiveFrom) throw E.invalid('適用終了日は開始日以降にしてください');
  const id = typeof a.id === 'string' ? v.id(a, 'id') : null;
  let saved: EmploymentHistory;
  if (id) {
    const cur = ctx.uow.get<EmploymentHistory>('employment_history', id);
    if (!cur || cur.employeeId !== employeeId) throw E.notFound('雇用条件');
    saved = ctx.uow.update('employment_history', { ...cur, ...data, version: (a.version as number) ?? cur.version });
  } else {
    saved = ctx.uow.insert<EmploymentHistory>('employment_history', data, 'emh');
  }
  audit(ctx, 'employment.upsert', 'employee', employeeId, `雇用条件 ${data.effectiveFrom}〜`);
  void nowIso;
  return saved;
}
