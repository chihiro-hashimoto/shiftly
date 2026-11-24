/**
 * システム・店舗設定・端末・認証・監査ログ
 * F01 初期設定 / F02 店舗端末 / F03 認証 / F25 監査ログ / F27 店舗設定 / F35 DB更新
 */
import { defineOps } from '../api';
import { audit, metaValue, nowIso, setMeta, settings, staff, DEFAULT_SETTINGS, type Ctx } from '../context';
import { E } from '../errors';
import * as v from '../validate';
import { createEnrollment, enrollDevice, ensureSecrets, login, logout, revokeSessionsWhere, setCredential, stepUp, verifyCredential } from '../auth';
import type { AuditLog, BusinessHours, Device, Employee, MinimumWageEntry, StoreSettings } from '../../shared/types';
import { SCHEMA_VERSION, TABLES } from '../schema';
import { validatePinFormat } from '../../shared/crypto';
import { effectiveState, STATE_LABEL, allowedPunches } from '../../shared/attendance';
import { loadEffective, activeEmployees } from '../services';
import { addDays } from '../../shared/time';
import { today } from '../context';
import { validatePeriodConfig } from '../../shared/period';
import { APP_VERSION } from '../version';

export function initialize(ctx: Ctx, args: { storeName: string; envId: string }) {
  ensureSecrets(ctx.p);
  const existing = ctx.uow.list<StoreSettings>('store_settings');
  if (existing.length === 0) {
    ctx.uow.insert<StoreSettings>('store_settings', { ...DEFAULT_SETTINGS, storeName: args.storeName } as never, 'set');
  }
  if (!metaValue(ctx, 'envId')) setMeta(ctx, 'envId', args.envId);
  if (!metaValue(ctx, 'schemaVersion')) setMeta(ctx, 'schemaVersion', String(SCHEMA_VERSION));
  if (!metaValue(ctx, 'appVersion')) setMeta(ctx, 'appVersion', APP_VERSION);
  if (!metaValue(ctx, 'initializedAt')) setMeta(ctx, 'initializedAt', nowIso(ctx));
  audit(ctx, 'system.initialize', 'system', null, '初期化（冪等）');
  return { initialized: true, envId: metaValue(ctx, 'envId') ?? args.envId };
}

function validateSettingsPatch(a: v.Args): Partial<StoreSettings> {
  const out: Partial<StoreSettings> = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(a, k);
  if (has('storeName')) out.storeName = v.str(a, 'storeName', { max: 60, label: '店舗名' });
  if (has('storeAddress')) out.storeAddress = v.str(a, 'storeAddress', { max: 200, optional: true, label: '所在地' });
  if (has('businessHours')) {
    const bh = a.businessHours;
    if (!Array.isArray(bh) || bh.length !== 7) throw E.invalid('営業時間は7曜日分を指定してください');
    out.businessHours = bh.map((x, i): BusinessHours => {
      const o = v.obj(x);
      const closed = v.bool(o, 'closed');
      const open = closed ? '00:00' : v.time(o, 'open', { label: '開店時刻' });
      const close = closed ? '00:00' : v.time(o, 'close', { allowNextDay: true, label: '閉店時刻' });
      if (!closed && close <= open) throw E.invalid('閉店時刻は開店時刻より後にしてください（翌日は24:00以降で入力）');
      return { weekday: i, closed, open, close };
    });
  }
  if (has('businessDayCutoff')) out.businessDayCutoff = v.time(a, 'businessDayCutoff', { label: '営業日の切替時刻' });
  if (has('workingTimeSystem')) out.workingTimeSystem = v.oneOf(a, 'workingTimeSystem', ['standard', 'monthly_variable', 'yearly_variable', 'flextime', 'unset'] as const, '労働時間制度');
  if (has('weekStartDay')) out.weekStartDay = v.intOrNull(a, 'weekStartDay', { min: 0, max: 6, label: '週の起算曜日' });
  if (has('statutoryHolidayWeekday')) out.statutoryHolidayWeekday = v.intOrNull(a, 'statutoryHolidayWeekday', { min: 0, max: 6, label: '法定休日' });
  if (has('weekly44Confirmed')) out.weekly44Confirmed = v.bool(a, 'weekly44Confirmed');
  if (has('agreement36')) out.agreement36 = v.oneOf(a, 'agreement36', ['unset', 'concluded', 'not_concluded'] as const);
  if (has('overtime60StartDay')) out.overtime60StartDay = v.intOrNull(a, 'overtime60StartDay', { min: 0, max: 28 });
  if (has('payrollClosingDay') || has('payMonthOffset') || has('payDay')) {
    out.payrollClosingDay = v.intOrNull(a, 'payrollClosingDay', { min: 0, max: 28, label: '締め日' });
    out.payMonthOffset = v.intOrNull(a, 'payMonthOffset', { min: 0, max: 1, label: '支払月' });
    out.payDay = v.intOrNull(a, 'payDay', { min: 0, max: 28, label: '支払日' });
    if (out.payrollClosingDay !== null && out.payMonthOffset !== null && out.payDay !== null) {
      const errs = validatePeriodConfig({ closingDay: out.payrollClosingDay, payMonthOffset: out.payMonthOffset, payDay: out.payDay });
      if (errs.length) throw E.invalid(errs.join(' / '));
    }
  }
  if (has('yenRounding')) out.yenRounding = v.oneOf(a, 'yenRounding', ['half_up', 'ceil'] as const);
  if (has('minimumWages')) {
    const mw = a.minimumWages;
    if (!Array.isArray(mw) || mw.length > 50) throw E.invalid('最低賃金の形式が不正です');
    out.minimumWages = mw.map((x): MinimumWageEntry => {
      const o = v.obj(x);
      return {
        effectiveFrom: v.date(o, 'effectiveFrom', { label: '最低賃金の適用開始日' }),
        hourly: v.int(o, 'hourly', { min: 1, max: 10000, label: '最低賃金（時間額）' }),
        label: v.str(o, 'label', { max: 60, label: '名称' }),
        sourceNote: v.str(o, 'sourceNote', { max: 300, label: '根拠（確認した公式資料）' }),
      };
    });
  }
  if (has('employerCostRatePercent')) {
    const x = a.employerCostRatePercent;
    out.employerCostRatePercent = x === null || x === '' ? null : v.num(a, 'employerCostRatePercent', { min: 0, max: 50, label: '会社負担率' });
  }
  if (has('idleTimeoutSec')) out.idleTimeoutSec = v.int(a, 'idleTimeoutSec', { min: 20, max: 600, label: '無操作タイムアウト' });
  if (has('pinMaxAttempts')) out.pinMaxAttempts = v.int(a, 'pinMaxAttempts', { min: 3, max: 10 });
  if (has('pinLockMinutes')) out.pinLockMinutes = v.int(a, 'pinLockMinutes', { min: 5, max: 1440 });
  if (has('publicHolidays')) out.publicHolidays = v.dateArray(a, 'publicHolidays');
  if (has('paidLeaveWageMethod')) out.paidLeaveWageMethod = v.oneOf(a, 'paidLeaveWageMethod', ['unset', 'normal', 'average', 'standard_remuneration'] as const);
  if (has('halfDayLeaveAllowed')) out.halfDayLeaveAllowed = v.bool(a, 'halfDayLeaveAllowed');
  if (has('payslipDelivery')) out.payslipDelivery = v.oneOf(a, 'payslipDelivery', ['paper', 'electronic_with_consent'] as const);
  if (has('retentionYears')) out.retentionYears = v.int(a, 'retentionYears', { min: 5, max: 20, label: '保存期間（法定5年未満は不可）' });
  if (has('dailyBackupGenerations')) out.dailyBackupGenerations = v.int(a, 'dailyBackupGenerations', { min: 7, max: 120 });
  if (has('monthlyBackupGenerations')) out.monthlyBackupGenerations = v.int(a, 'monthlyBackupGenerations', { min: 12, max: 120 });
  return out;
}

/** 給与計算に影響する設定項目（変更時は給与規定の確認をリセット） */
const PAYROLL_KEYS: Array<keyof StoreSettings> = [
  'workingTimeSystem', 'weekStartDay', 'statutoryHolidayWeekday', 'weekly44Confirmed', 'overtime60StartDay', 'payrollClosingDay',
  'payMonthOffset', 'payDay', 'yenRounding', 'minimumWages', 'paidLeaveWageMethod', 'businessDayCutoff', 'publicHolidays', 'halfDayLeaveAllowed',
];

defineOps([
  {
    name: 'system.status',
    auth: 'public',
    mutating: false,
    allowInMaintenance: true,
    handler: (ctx) => {
      // 公開情報のみ（店舗名は登録端末からのみ）
      let initialized: boolean;
      let storeName: string | null = null;
      try {
        const s = settings(ctx);
        initialized = true;
        if (ctx.principal.kind === 'device') storeName = s.storeName;
      } catch {
        initialized = false;
      }
      return { initialized, version: APP_VERSION, maintenance: metaValue(ctx, 'maintenance') === 'on', deviceRegistered: ctx.principal.kind === 'device', storeName };
    },
  },
  {
    name: 'system.initialize',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      return initialize(ctx, { storeName: v.str(a, 'storeName', { max: 60, label: '店舗名' }), envId: v.str(a, 'envId', { max: 64, pattern: /^[A-Za-z0-9_-]+$/ }) });
    },
  },
  {
    name: 'system.info',
    auth: 'owner',
    mutating: false,
    allowInMaintenance: true,
    handler: (ctx) => ({
      envId: metaValue(ctx, 'envId'),
      schemaVersion: Number(metaValue(ctx, 'schemaVersion') ?? '0'),
      expectedSchemaVersion: SCHEMA_VERSION,
      appVersion: metaValue(ctx, 'appVersion'),
      codeVersion: APP_VERSION,
      maintenance: metaValue(ctx, 'maintenance') === 'on',
      initializedAt: metaValue(ctx, 'initializedAt'),
      platform: ctx.p.kind,
      storage: ctx.p.files.storageQuota(),
    }),
  },
  {
    name: 'system.setMaintenance',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      const on = v.bool(v.obj(raw), 'on');
      setMeta(ctx, 'maintenance', on ? 'on' : 'off');
      audit(ctx, 'system.maintenance', 'system', null, on ? 'メンテナンス開始' : 'メンテナンス終了');
      return { maintenance: on };
    },
  },
  {
    name: 'system.integrityCheck',
    auth: 'owner',
    mutating: false,
    allowInMaintenance: true,
    handler: (ctx) => integrityCheck(ctx),
  },
  {
    name: 'settings.get',
    auth: 'owner',
    mutating: false,
    handler: (ctx) => settings(ctx),
  },
  {
    name: 'settings.update',
    auth: 'owner',
    mutating: true,
    handler: (ctx, raw) => {
      const patch = validateSettingsPatch(v.obj(raw));
      const cur = settings(ctx);
      const next = { ...cur, ...patch };
      const payrollChanged = PAYROLL_KEYS.some((k) => k in patch && JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
      if (payrollChanged) next.payrollRulesConfirmedAt = null;
      const saved = ctx.uow.update('store_settings', next);
      audit(ctx, 'settings.update', 'store_settings', cur.id, `変更項目: ${Object.keys(patch).join(',')}`);
      return { settings: saved, payrollRulesReset: payrollChanged };
    },
  },
  {
    name: 'settings.confirmPayrollRules',
    auth: 'owner',
    mutating: true,
    handler: (ctx) => {
      const s = settings(ctx);
      const missing: string[] = [];
      if (s.workingTimeSystem === 'unset') missing.push('労働時間制度');
      if (s.weekStartDay === null) missing.push('週の起算曜日');
      if (s.statutoryHolidayWeekday === null) missing.push('法定休日');
      if (s.payrollClosingDay === null || s.payDay === null || s.payMonthOffset === null) missing.push('締め日・支払日');
      if (s.minimumWages.length === 0) missing.push('最低賃金');
      if (s.paidLeaveWageMethod === 'unset') missing.push('有給休暇の賃金算定方法');
      if (missing.length) throw E.invalid(`未設定の項目があります: ${missing.join('、')}`);
      const saved = ctx.uow.update('store_settings', { ...s, payrollRulesConfirmedAt: nowIso(ctx) });
      audit(ctx, 'settings.confirm_payroll_rules', 'store_settings', s.id, '給与規定の確認');
      return saved;
    },
  },
  // ------------------------------------------------------------ 端末
  {
    name: 'devices.list',
    auth: 'owner',
    mutating: false,
    handler: (ctx) => ctx.uow.list<Device>('devices').map(({ tokenHash: _t, ...d }) => d),
  },
  {
    name: 'devices.createEnrollment',
    auth: 'owner',
    mutating: true,
    handler: (ctx, raw) => createEnrollment(ctx, v.str(v.obj(raw), 'deviceName', { max: 40, label: '端末名' })),
  },
  {
    name: 'devices.revoke',
    auth: 'owner',
    mutating: true,
    handler: (ctx, raw) => {
      const id = v.id(v.obj(raw), 'deviceId');
      const d = ctx.uow.get<Device>('devices', id);
      if (!d) throw E.notFound('端末');
      ctx.uow.update('devices', { ...d, status: 'revoked', revokedAt: nowIso(ctx) });
      revokeSessionsWhere(ctx, (s) => s.deviceId === id);
      audit(ctx, 'device.revoke', 'device', id, '端末の失効');
      return { ok: true };
    },
  },
  {
    name: 'devices.rename',
    auth: 'owner',
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const d = ctx.uow.get<Device>('devices', v.id(a, 'deviceId'));
      if (!d) throw E.notFound('端末');
      ctx.uow.update('devices', { ...d, name: v.str(a, 'name', { max: 40, label: '端末名' }) });
      audit(ctx, 'device.rename', 'device', d.id, '端末名の変更');
      return { ok: true };
    },
  },
  {
    name: 'kiosk.enroll',
    auth: 'public',
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      return enrollDevice(ctx, v.str(a, 'code', { max: 20, label: '登録コード' }), v.str(a, 'userAgent', { optional: true, max: 300 }));
    },
  },
  {
    name: 'kiosk.bootstrap',
    auth: 'device',
    mutating: false,
    handler: (ctx) => {
      const s = settings(ctx);
      // 初期画面に給与・詳細勤怠は出さない（氏名と表示順のみ）
      return {
        storeName: s.storeName,
        idleTimeoutSec: s.idleTimeoutSec,
        staff: activeEmployees(ctx).map((e) => ({ id: e.id, displayName: e.displayName, kana: e.kana })),
        serverTime: ctx.now,
      };
    },
  },
  // ------------------------------------------------------------ スタッフ認証
  {
    name: 'auth.login',
    auth: 'device',
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      if (ctx.principal.kind !== 'device') throw E.deviceNotRegistered();
      const dev = ctx.uow.get<Device>('devices', ctx.principal.deviceId);
      if (!dev) throw E.deviceNotRegistered();
      const r = login(ctx, dev, v.id(a, 'employeeId', 'スタッフ'), v.str(a, 'pin', { max: 12, label: 'PIN' }));
      const evs = loadEffective(ctx, r.employee.id, addDays(today(ctx), -3), today(ctx));
      const { state: st, staleOpenSince } = effectiveState(evs, ctx.now);
      return {
        sessionToken: r.sessionToken,
        employee: { id: r.employee.id, displayName: r.employee.displayName, payType: r.employee.payType },
        permissions: r.permissions,
        state: st,
        stateLabel: STATE_LABEL[st],
        allowedPunches: allowedPunches(st),
        staleOpenSince,
      };
    },
  },
  {
    name: 'auth.logout',
    auth: 'session',
    mutating: true,
    handler: (ctx) => {
      logout(ctx, staff(ctx).sessionId);
      audit(ctx, 'auth.logout', 'employee', staff(ctx).employeeId, 'ログアウト');
      return { ok: true };
    },
  },
  {
    name: 'auth.me',
    auth: 'session',
    mutating: false,
    handler: (ctx) => {
      const s = staff(ctx);
      const e = ctx.uow.get<Employee>('employees', s.employeeId)!;
      const evs = loadEffective(ctx, s.employeeId, addDays(today(ctx), -3), today(ctx));
      const { state: st, staleOpenSince } = effectiveState(evs, ctx.now);
      return {
        employee: { id: e.id, displayName: e.displayName, payType: e.payType },
        permissions: s.permissions,
        stepUp: s.stepUp,
        state: st,
        stateLabel: STATE_LABEL[st],
        allowedPunches: allowedPunches(st),
        staleOpenSince,
        idleTimeoutSec: settings(ctx).idleTimeoutSec,
      };
    },
  },
  {
    name: 'auth.stepUp',
    auth: 'session',
    mutating: true,
    handler: (ctx, raw) => {
      const s = staff(ctx);
      stepUp(ctx, s.sessionId, s.employeeId, v.str(v.obj(raw), 'passcode', { max: 64, label: '管理用パスコード' }));
      return { ok: true, minutes: 5 };
    },
  },
  {
    name: 'auth.changePin',
    auth: 'session',
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const s = staff(ctx);
      const current = v.str(a, 'currentPin', { max: 12, label: '現在のPIN' });
      const next = v.str(a, 'newPin', { max: 12, label: '新しいPIN' });
      const err = validatePinFormat(next);
      if (err) throw E.invalid(err);
      // 本人確認として現在の PIN を再検証
      verifyCurrentPin(ctx, s.employeeId, current);
      setCredential(ctx, s.employeeId, 'pin', next, false);
      revokeSessionsWhere(ctx, (x) => x.employeeId === s.employeeId && x.id !== s.sessionId);
      audit(ctx, 'credential.change_pin', 'employee', s.employeeId, '本人によるPIN変更');
      return { ok: true };
    },
  },
  // ------------------------------------------------------------ 監査ログ
  {
    name: 'audit.list',
    auth: 'owner',
    mutating: false,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const month = v.str(a, 'month', { pattern: /^\d{4}-\d{2}$/, label: '対象月' });
      const parts = ctx.uow.adapter.partitions(TABLES.find((t) => t.name === 'audit_logs')!);
      if (!parts.includes(month)) return [];
      return ctx.uow.list<AuditLog>('audit_logs', { partitions: [month] }).sort((x, y) => (x.at < y.at ? 1 : -1));
    },
  },
]);

function verifyCurrentPin(ctx: Ctx, employeeId: string, pin: string) {
  verifyCredential(ctx, employeeId, 'pin', pin);
}

/** DB 整合性チェック（F26/F37 の復元後確認にも使用） */
export function integrityCheck(ctx: Ctx) {
  const issues: string[] = [];
  const emps = ctx.uow.list<Employee>('employees');
  const ids = new Set(emps.map((e) => e.id));
  const dup = emps.length - ids.size;
  if (dup) issues.push(`スタッフIDの重複: ${dup}件`);
  const check = (table: Parameters<typeof ctx.uow.list>[0], col = 'employeeId', opts?: { partitions?: string[] }) => {
    const rows = ctx.uow.list<Record<string, unknown>>(table, opts);
    const orphan = rows.filter((r) => typeof r[col] === 'string' && !ids.has(r[col] as string)).length;
    if (orphan) issues.push(`${table}: 存在しないスタッフを参照する行 ${orphan}件`);
    const idset = new Set(rows.map((r) => r.id));
    if (idset.size !== rows.length) issues.push(`${table}: 主キー重複`);
  };
  for (const t of ['credentials', 'permissions', 'wage_rules', 'salary_rules', 'attendance_corrections', 'shifts', 'leave_grants', 'leave_transactions', 'payroll_results', 'pay_slips'] as const) check(t);
  check('attendance_events');
  const journal = ctx.uow.list<{ state: string }>('operation_journal');
  const pending = journal.filter((j) => j.state === 'started').length;
  const failed = journal.filter((j) => j.state === 'failed').length;
  if (pending) issues.push(`未完了の書き込み処理: ${pending}件（次回の更新時に自動再適用）`);
  if (failed) issues.push(`再適用できなかった書き込み処理: ${failed}件（要確認）`);
  const sv = Number(metaValue(ctx, 'schemaVersion') ?? '0');
  if (sv !== SCHEMA_VERSION) issues.push(`スキーマバージョン不一致（DB: ${sv} / アプリ: ${SCHEMA_VERSION}）`);
  const settingsRows = ctx.uow.list('store_settings').length;
  if (settingsRows !== 1) issues.push(`店舗設定の行数が不正です（${settingsRows}行）`);
  return { ok: issues.length === 0, issues, checkedAt: nowIso(ctx), counts: { employees: emps.length } };
}
