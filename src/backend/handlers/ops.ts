/**
 * 出力・人件費分析・予算・通知・バックアップ/復元
 * F21 通知 / F22 人件費分析 / F23 予算 / F24 CSV・Excel / F26 バックアップ・復元
 */
import { defineOps } from '../api';
import { audit, has, isOwner, nowIso, settings, staff, today, type Ctx } from '../context';
import { E } from '../errors';
import * as v from '../validate';
import type { BackupHistory, Budget, Device, Employee, NotificationRow, PayrollPeriod, PayrollResult, Shift, WorkSession } from '../../shared/types';
import { toCsv, type Cell } from '../../shared/csv';
import { buildXlsx, toBase64, type XSheet } from '../../shared/xlsx';
import { utf8 } from '../../shared/crypto';
import { activeEmployees, employeesInPeriod, latestResult, sessionsFor, payrollInput } from '../services';
import { sessionView } from './attendance';
import { addDays, formatMinutes, localDateTime, type LocalDate } from '../../shared/time';
import { computePayroll } from '../../shared/payroll';
import { allocateLaborCost, budgetStatus, monthRange, shiftToSession } from '../../shared/analytics';
import { canSeeIndividualPay } from '../../shared/permissions';
import { detectAttendanceNotifications, detectLeaveNotifications, newOnly, type NotificationDraft } from '../../shared/notifications';
import { SCHEMA_VERSION } from '../schema';
import { revokeSessionsWhere } from '../auth';
import { integrityCheck } from './system';
import type { LeaveGrant, LeaveTransaction, WageRule, SalaryRule, TransportRule } from '../../shared/types';
import { UnitOfWork } from '../store';

// ------------------------------------------------------------------ 出力
type Format = 'csv' | 'xlsx';

function deliver(ctx: Ctx, kind: string, baseName: string, format: Format, sheets: XSheet[]) {
  const fileName = `${baseName}.${format}`;
  const bytes = format === 'csv' ? utf8(toCsv(sheets[0]!.header, sheets[0]!.rows as Cell[][])) : buildXlsx(sheets);
  const mime = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const f = ctx.p.files.createFile('03_Exports', fileName, mime, bytes);
  ctx.uow.insert('exports', { kind, format, driveFileId: f.fileId, requestedBy: isOwner(ctx) ? 'owner' : staff(ctx).employeeId, note: fileName } as never, 'exp');
  audit(ctx, 'export', kind, f.fileId, `${fileName}`);
  // 共用 iPad（スタッフ）には業務データを含むファイルを返さず、店長の Drive に保存するのみ
  if (!isOwner(ctx)) return { savedToDrive: true, fileName };
  return { savedToDrive: true, fileName, mimeType: mime, base64: toBase64(bytes) };
}

function fmtTime(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

const ANOMALY_JA: Record<string, string> = {
  missing_clock_out: '退勤打刻漏れ', break_not_ended: '休憩終了漏れ', insufficient_break: '休憩不足', abnormal_hours: '長時間勤務',
  fixed_break_applied: '固定休憩適用', clock_out_during_break: '休憩中退勤', duplicate_clock_in: '二重出勤', overlapping_breaks: '休憩重複',
  fixed_break_outside_work: '固定休憩が勤務外', duplicate_break_start: '二重休憩開始', break_end_without_start: '休憩開始なし',
};

function payrollRows(ctx: Ctx, p: PayrollPeriod) {
  const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e]));
  return employeesInPeriod(ctx, p.from, p.to)
    .map((e) => ({ e: names.get(e.id)!, r: latestResult(ctx, p.id, e.id) }))
    .filter((x) => x.r && (x.r.status === 'confirmed' || x.r.status === 'issued')) as Array<{ e: Employee; r: PayrollResult }>;
}

defineOps([
  {
    name: 'export.attendance',
    auth: 'staff_or_owner',
    perms: ['export_attendance'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const { from, to } = v.range(a, 62);
      const format = v.oneOf(a, 'format', ['csv', 'xlsx'] as const);
      const rows: Cell[][] = [];
      const s = settings(ctx);
      for (const e of ctx.uow.list<Employee>('employees')) {
        for (const ss of sessionsFor(ctx, e.id, from, to, s)) {
          const vw = sessionView(ss, ctx.now);
          rows.push([e.employeeCode, e.displayName, vw.laborDate, vw.businessDate, fmtTime(vw.start), fmtTime(vw.end), vw.breakMinutes, vw.workMinutes, formatMinutes(vw.workMinutes), vw.anomalies.map((x) => ANOMALY_JA[x] ?? x).join('・')]);
        }
      }
      rows.sort((x, y) => String(x[2]).localeCompare(String(y[2])) || String(x[1]).localeCompare(String(y[1]), 'ja'));
      return deliver(ctx, 'attendance', `勤怠_${from}_${to}`, format, [
        { name: '勤怠', header: ['社員番号', '氏名', '労働日', '営業日', '出勤', '退勤', '休憩(分)', '実働(分)', '実働(時:分)', '注意'], rows },
      ]);
    },
  },
  {
    name: 'export.payroll',
    auth: 'staff_or_owner',
    perms: ['export_payroll'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const p = ctx.uow.get<PayrollPeriod>('payroll_periods', v.id(a, 'periodId'));
      if (!p) throw E.notFound('給与期間');
      const format = v.oneOf(a, 'format', ['csv', 'xlsx'] as const);
      const rows = payrollRows(ctx, p).map(({ e, r }) => {
        const t = r.totals;
        const allowances = t.allowances.reduce((s, x) => s + x.amount, 0);
        return [e.employeeCode, e.displayName, p.periodKey, p.payDate, r.revision, t.workDays, t.workMinutes, t.overtimeMinutes, t.over60Minutes, t.nightMinutes, t.holidayMinutes,
          t.basePay, t.extraHoursBasePay, t.overtimePremium, t.over60Premium, t.nightPremium, t.holidayPremium, t.fixedOvertimePay, t.fixedOvertimeExcess, t.paidLeavePay, allowances, t.transport, -t.absenceDeduction,
          t.grossPay, t.deductionTotal, t.netPay] as Cell[];
      });
      return deliver(ctx, 'payroll', `給与_${p.periodKey}`, format, [
        {
          name: '給与',
          header: ['社員番号', '氏名', '対象月', '支払日', '版', '出勤日数', '実働(分)', '時間外(分)', '60h超(分)', '深夜(分)', '休日(分)', '基本', '所定外', '時間外割増', '60h超割増', '深夜割増', '休日割増', '固定残業代', '固定残業超過', '有給賃金', '手当計', '交通費', '欠勤等控除', '総支給', '控除計', '差引支給'],
          rows,
        },
      ]);
    },
  },
  {
    name: 'export.shifts',
    auth: 'staff_or_owner',
    perms: ['shift_edit', 'export_attendance'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const { from, to } = v.range(a, 62);
      const format = v.oneOf(a, 'format', ['csv', 'xlsx'] as const);
      const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e.displayName]));
      const rows = ctx.uow
        .list<Shift>('shifts')
        .filter((s) => s.date >= from && s.date <= to && s.status !== 'cancelled')
        .sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start))
        .map((s) => [s.date, names.get(s.employeeId) ?? '', s.start, s.end, s.breakMinutes, s.status === 'published' ? '公開' : '下書き'] as Cell[]);
      return deliver(ctx, 'shifts', `シフト_${from}_${to}`, format, [{ name: 'シフト', header: ['日付', '氏名', '開始', '終了', '休憩(分)', '状態'], rows }]);
    },
  },
  {
    name: 'export.wageLedger',
    auth: 'staff_or_owner',
    perms: ['export_payroll'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      // 賃金台帳（労基則54条の記載事項に対応する列。性別は本システムで保持しないため別途記入）
      const a = v.obj(raw);
      const year = v.int(a, 'year', { min: 2020, max: 2100, label: '年' });
      const format = v.oneOf(a, 'format', ['csv', 'xlsx'] as const);
      const periods = ctx.uow.list<PayrollPeriod>('payroll_periods').filter((p) => p.periodKey.startsWith(`${year}-`)).sort((x, y) => (x.periodKey < y.periodKey ? -1 : 1));
      const sheets: XSheet[] = [];
      const header = ['氏名', '性別（別途記入）', '賃金計算期間', '支払日', '労働日数', '労働時間数', '時間外労働時間数', '休日労働時間数', '深夜労働時間数', '基本給・基本賃金', '所定外賃金', '時間外割増', '休日割増', '深夜割増', '固定残業代', '有給賃金', '手当', '交通費', '欠勤等控除', '総支給額', '控除内訳', '控除合計', '差引支給額', '版'];
      const byEmp = new Map<string, { e: Employee; rows: Cell[][] }>();
      for (const p of periods) {
        for (const { e, r } of payrollRows(ctx, p)) {
          const t = r.totals;
          const entry = byEmp.get(e.id) ?? { e, rows: [] };
          entry.rows.push([e.displayName, '', `${p.from}〜${p.to}`, p.payDate, t.workDays, formatMinutes(t.workMinutes), formatMinutes(t.overtimeMinutes), formatMinutes(t.holidayMinutes), formatMinutes(t.nightMinutes),
            t.basePay, t.extraHoursBasePay, t.overtimePremium + t.over60Premium, t.holidayPremium, t.nightPremium, t.fixedOvertimePay + t.fixedOvertimeExcess, t.paidLeavePay,
            t.allowances.map((x) => `${x.name}:${x.amount}`).join(' / '), t.transport, -t.absenceDeduction, t.grossPay, t.deductions.map((x) => `${x.name}:${x.amount}`).join(' / '), t.deductionTotal, t.netPay, r.revision]);
          byEmp.set(e.id, entry);
        }
      }
      for (const { e, rows } of byEmp.values()) sheets.push({ name: e.displayName, header, rows });
      if (!sheets.length) sheets.push({ name: '賃金台帳', header, rows: [] });
      if (format === 'csv') {
        const all = [...byEmp.values()].flatMap((x) => x.rows);
        return deliver(ctx, 'wage_ledger', `賃金台帳_${year}`, 'csv', [{ name: '賃金台帳', header, rows: all }]);
      }
      return deliver(ctx, 'wage_ledger', `賃金台帳_${year}`, 'xlsx', sheets);
    },
  },
]);

// ------------------------------------------------------------------ 人件費分析・予算
const IGNORE_FOR_COST = new Set(['DEDUCTION_UNENTERED', 'PENDING_CORRECTIONS', 'NEGATIVE_NET_PAY', 'PAYROLL_RULES_UNCONFIRMED', 'AGREEMENT36_NOT_CONCLUDED']);

function costFor(ctx: Ctx, e: Employee, from: LocalDate, to: LocalDate, sessionsOverride?: WorkSession[]) {
  const pseudo: PayrollPeriod = { id: `analytics-${from}`, periodKey: from.slice(0, 7), from, to, payDate: to, status: 'uncomputed', createdAt: '', updatedAt: '', version: 0 };
  const input = payrollInput(ctx, e, pseudo);
  if (sessionsOverride) input.sessions = sessionsOverride;
  input.deduction = null;
  const out = computePayroll(input);
  const incomplete = out.issues.some((i) => i.severity === 'blocking' && !IGNORE_FOR_COST.has(i.code));
  return { out: { ...out, canConfirm: !incomplete }, input };
}

defineOps([
  {
    name: 'analytics.laborCost',
    auth: 'staff_or_owner',
    perms: ['labor_cost_view'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const month = v.str(v.obj(raw), 'month', { pattern: /^\d{4}-\d{2}$/, label: '対象月' });
      const { from, to } = monthRange(month);
      const s = settings(ctx);
      const d = today(ctx);
      const budget = ctx.uow.list<Budget>('budgets').find((b) => b.month === month) ?? null;
      const method = budget?.laborCostAllocation ?? 'by_worked_minutes';
      const emps = employeesInPeriod(ctx, from, to);
      const shifts = ctx.uow.list<Shift>('shifts').filter((x) => x.status === 'published' && x.date >= from && x.date <= to);
      const actualInputs = [];
      const forecastInputs = [];
      const plannedInputs = [];
      const contributors: Record<string, Set<string>> = {};
      for (const e of emps) {
        const sr = ctx.uow.list<SalaryRule>('salary_rules').find((x) => x.employeeId === e.id);
        const scheduledWeekdays = sr?.scheduledWeekdays ?? [];
        // 実績（今日まで）
        const actualTo = to < d ? to : d;
        const actual = costFor(ctx, e, from, to);
        // 期間前（週・月60時間判定用）のセッションを含む、今日までの実績
        const actualSessions = actual.input.sessions.filter((x) => x.laborDate <= actualTo);
        const act = costFor(ctx, e, from, to, actualSessions);
        const wm: Record<string, number> = {};
        for (const x of act.out.daily) {
          wm[x.date] = x.workMinutes;
          (contributors[x.date] ??= new Set()).add(e.id);
        }
        actualInputs.push({ employee: e, output: act.out, workMinutesByDate: wm, scheduledWeekdays });
        // 予定（公開シフトのみ）
        const planSessions = shifts.filter((x) => x.employeeId === e.id).map((x) => shiftToSession(x, s.businessDayCutoff));
        const plan = costFor(ctx, e, from, to, [...actual.input.sessions.filter((x) => x.laborDate < from), ...planSessions]);
        plannedInputs.push({ employee: e, output: plan.out, workMinutesByDate: {}, scheduledWeekdays });
        // 予測（実績＋明日以降の予定）
        const futurePlan = planSessions.filter((x) => x.laborDate > actualTo);
        const fc = costFor(ctx, e, from, to, [...actualSessions, ...futurePlan]);
        forecastInputs.push({ employee: e, output: fc.out, workMinutesByDate: {}, scheduledWeekdays });
      }
      const actualReport = allocateLaborCost(from, to, actualInputs, method, s.employerCostRatePercent);
      const planned = allocateLaborCost(from, to, plannedInputs, method, s.employerCostRatePercent);
      const forecast = allocateLaborCost(from, to, forecastInputs, method, s.employerCostRatePercent);
      const actualByDate = Object.fromEntries(Object.entries(actualReport.byDate).map(([k, c]) => [k, c.amount]));
      const status = budgetStatus(month, budget, actualByDate, forecast.total, d);
      const individual = canSeeIndividualPay(isOwner(ctx) ? 'all' : staff(ctx).permissions);
      // 給与閲覧権限がない場合、個人の給与を推定できる内訳（スタッフ別・1名のみの日/時間帯）を返さない
      const mask = (r: typeof actualReport) => {
        if (individual) return r;
        return {
          ...r,
          byEmployee: [],
          byDate: Object.fromEntries(Object.entries(r.byDate).map(([k, c]) => [k, (contributors[k]?.size ?? 0) >= 2 ? c : { amount: null as unknown as number, minutes: c.minutes }])),
          byHour: r.byHour.map(() => ({ amount: null as unknown as number, minutes: 0 })),
          incomplete: r.incomplete.map((x) => ({ ...x, name: '（非表示）', employeeId: '' })),
        };
      };
      return { month, actual: mask(actualReport), planned: { total: planned.total, employerCostEstimate: planned.employerCostEstimate }, forecast: { total: forecast.total }, budget: status, method, individualVisible: individual };
    },
  },
  {
    name: 'budgets.get',
    auth: 'staff_or_owner',
    perms: ['budget_manage', 'labor_cost_view'],
    mutating: false,
    handler: (ctx, raw) => {
      const month = v.str(v.obj(raw), 'month', { pattern: /^\d{4}-\d{2}$/ });
      return ctx.uow.list<Budget>('budgets').find((b) => b.month === month) ?? null;
    },
  },
  {
    name: 'budgets.upsert',
    auth: 'staff_or_owner',
    perms: ['budget_manage'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const month = v.str(a, 'month', { pattern: /^\d{4}-\d{2}$/, label: '対象月' });
      const monthlyAmount = v.int(a, 'monthlyAmount', { min: 0, max: 1_000_000_000, label: '月間予算' });
      const dailyRaw = a.dailyAmounts && typeof a.dailyAmounts === 'object' ? (a.dailyAmounts as Record<string, unknown>) : {};
      const { from, to } = monthRange(month);
      const dailyAmounts: Record<string, number> = {};
      for (const [k, val] of Object.entries(dailyRaw)) {
        if (k < from || k > to || typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) throw E.invalid('日別予算の形式が不正です');
        dailyAmounts[k] = val;
      }
      const laborCostAllocation = v.oneOf(a, 'laborCostAllocation', ['by_calendar_day', 'by_worked_minutes', 'by_scheduled_days'] as const, '月給制の配賦方法');
      const cur = ctx.uow.list<Budget>('budgets').find((b) => b.month === month);
      const saved = cur ? ctx.uow.update('budgets', { ...cur, monthlyAmount, dailyAmounts, laborCostAllocation }) : ctx.uow.insert<Budget>('budgets', { month, monthlyAmount, dailyAmounts, laborCostAllocation }, 'bud');
      audit(ctx, 'budget.upsert', 'budget', saved.id, `${month}`);
      return saved;
    },
  },
]);

// ------------------------------------------------------------------ 通知
export function scanNotifications(ctx: Ctx): number {
  const d = today(ctx);
  const emps = activeEmployees(ctx);
  const s = settings(ctx);
  const sessionsByEmployee: Record<string, WorkSession[]> = {};
  for (const e of emps) sessionsByEmployee[e.id] = sessionsFor(ctx, e.id, addDays(d, -7), d, s);
  const shifts = ctx.uow.list<Shift>('shifts').filter((x) => x.status === 'published' && x.date >= addDays(d, -7) && x.date <= d && localDateTime(x.date, x.start) < ctx.now);
  const drafts: NotificationDraft[] = [
    ...detectAttendanceNotifications({ now: ctx.now, today: d, employees: emps, sessionsByEmployee, publishedShifts: shifts, lateGraceMinutes: 1, absenceGraceMinutes: 30 }),
    ...detectLeaveNotifications(emps, ctx.uow.list<LeaveGrant>('leave_grants'), ctx.uow.list<LeaveTransaction>('leave_transactions'), d),
  ];
  // 未入力の給与条件
  for (const e of emps) {
    const hasWage = e.payType === 'hourly' ? ctx.uow.list<WageRule>('wage_rules').some((w) => w.employeeId === e.id && w.kind === 'base') : ctx.uow.list<SalaryRule>('salary_rules').some((w) => w.employeeId === e.id);
    const hasTransport = ctx.uow.list<TransportRule>('transport_rules').some((t) => t.employeeId === e.id && t.method !== 'unset');
    if (!hasWage || !hasTransport)
      drafts.push({ kind: 'pay_conditions_missing', dedupeKey: `pay_conditions_missing:${e.id}:${!hasWage}:${!hasTransport}`, audience: 'managers', employeeId: e.id, title: '給与条件が未入力です', body: `${e.displayName}さん: ${!hasWage ? '時給/月給' : ''}${!hasWage && !hasTransport ? '・' : ''}${!hasTransport ? '交通費' : ''}が未設定です`, severity: 'warning', relatedDate: null });
  }
  // 未確定給与（支払日の7日前を過ぎても確定していない期間）
  for (const p of ctx.uow.list<PayrollPeriod>('payroll_periods')) {
    if ((p.status === 'confirmed' || p.status === 'issued') || addDays(p.payDate, -7) > d) continue;
    drafts.push({ kind: 'payroll_unconfirmed', dedupeKey: `payroll_unconfirmed:${p.id}`, audience: 'managers', employeeId: null, title: '未確定の給与があります', body: `${p.periodKey} 分（支払日 ${p.payDate}）の給与が確定していません`, severity: 'warning', relatedDate: p.payDate });
  }
  // Drive 容量
  const q = ctx.p.files.storageQuota();
  if (q && q.limit && q.usage / q.limit > 0.9)
    drafts.push({ kind: 'drive_capacity', dedupeKey: `drive_capacity:${d.slice(0, 7)}`, audience: 'owner', employeeId: null, title: 'Google Drive の空き容量が少なくなっています', body: `使用率 ${Math.round((q.usage / q.limit) * 100)}%。容量不足になると勤怠の保存・バックアップに失敗する可能性があります`, severity: 'critical', relatedDate: d });
  // バックアップ失敗
  const lastBackup = ctx.uow.list<BackupHistory>('backup_history').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (lastBackup && lastBackup.status === 'failed')
    drafts.push({ kind: 'backup_failed', dedupeKey: `backup_failed:${lastBackup.id}`, audience: 'owner', employeeId: null, title: 'バックアップに失敗しました', body: lastBackup.note.slice(0, 200), severity: 'critical', relatedDate: d });
  const existing = ctx.uow.list<NotificationRow>('notifications');
  const fresh = newOnly(drafts, existing);
  for (const n of fresh) ctx.uow.insert<NotificationRow>('notifications', { ...n, status: 'unread' }, 'ntf');
  return fresh.length;
}

const ATTENDANCE_KINDS = new Set(['missing_clock_in', 'missing_clock_out', 'missing_break_end', 'late', 'early_leave', 'absence', 'abnormal_hours', 'insufficient_break']);

function visibleTo(ctx: Ctx, n: NotificationRow): boolean {
  if (isOwner(ctx)) return true;
  const me = staff(ctx);
  if (n.audience === 'owner') return false;
  if (n.employeeId === me.employeeId && n.audience !== 'managers') return true;
  if (n.audience === 'managers') {
    if (ATTENDANCE_KINDS.has(n.kind)) return has(ctx, 'attendance_view_all');
    if (n.kind === 'leave_expiring' || n.kind === 'leave_5day_obligation') return has(ctx, 'leave_manage') || n.employeeId === me.employeeId;
    if (n.kind === 'payroll_unconfirmed' || n.kind === 'pay_conditions_missing') return has(ctx, 'payroll_confirm') || has(ctx, 'pay_conditions_edit');
    if (n.kind === 'budget_over') return has(ctx, 'labor_cost_view');
  }
  return false;
}

defineOps([
  {
    name: 'notifications.list',
    auth: 'staff_or_owner',
    perms: ['notifications_view'],
    mutating: false,
    handler: (ctx, raw) => {
      const includeResolved = v.bool(v.obj(raw), 'includeResolved');
      return ctx.uow
        .list<NotificationRow>('notifications')
        .filter((n) => (includeResolved || n.status !== 'resolved') && visibleTo(ctx, n))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 200);
    },
  },
  {
    name: 'notifications.update',
    auth: 'staff_or_owner',
    perms: ['notifications_view'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const n = ctx.uow.get<NotificationRow>('notifications', v.id(a, 'id'));
      if (!n || !visibleTo(ctx, n)) throw E.notFound('通知');
      const status = v.oneOf(a, 'status', ['unread', 'read', 'resolved'] as const);
      return ctx.uow.update('notifications', { ...n, status });
    },
  },
  {
    name: 'notifications.scan',
    auth: 'owner',
    mutating: true,
    handler: (ctx) => ({ created: scanNotifications(ctx) }),
  },
]);

// ------------------------------------------------------------------ バックアップ・復元
export function runBackup(ctx: Ctx, kind: BackupHistory['kind'], note = ''): BackupHistory {
  const name = `Shiftly_backup_${kind}_${nowIso(ctx).slice(0, 19).replace(/[:T]/g, '-')}`;
  try {
    const f = ctx.p.files.copyDatabase('05_Backup', name);
    const row = ctx.uow.insert<BackupHistory>('backup_history', { kind, driveFileId: f.fileId, schemaVersion: SCHEMA_VERSION, status: 'ok', sizeBytes: f.sizeBytes, note }, 'bak');
    pruneBackups(ctx, kind);
    audit(ctx, 'backup.run', 'backup', row.id, `${kind}`);
    return row;
  } catch (e) {
    const row = ctx.uow.insert<BackupHistory>('backup_history', { kind, driveFileId: '', schemaVersion: SCHEMA_VERSION, status: 'failed', sizeBytes: null, note: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }, 'bak');
    audit(ctx, 'backup.failed', 'backup', row.id, `${kind}`);
    return row;
  }
}

/** 世代数を超えた日次・月次バックアップを削除（法定保存対象の原本は DB 側に保持。手動・更新前は自動削除しない） */
function pruneBackups(ctx: Ctx, kind: BackupHistory['kind']) {
  if (kind !== 'daily' && kind !== 'monthly') return;
  const s = settings(ctx);
  const keep = kind === 'daily' ? s.dailyBackupGenerations : s.monthlyBackupGenerations;
  const rows = ctx.uow.list<BackupHistory>('backup_history').filter((b) => b.kind === kind && b.status === 'ok' && b.driveFileId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  for (const old of rows.slice(keep)) {
    try {
      ctx.p.files.trashFile('05_Backup', old.driveFileId);
      ctx.uow.update('backup_history', { ...old, status: 'pruned', note: `世代管理により削除 ${nowIso(ctx)}` });
    } catch {
      /* 削除失敗は次回再試行 */
    }
  }
}

const APPEND_ONLY_TABLES = ['attendance_events', 'attendance_corrections', 'manual_breaks', 'audit_logs'] as const;

defineOps([
  {
    name: 'backup.run',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => runBackup(ctx, v.oneOf(v.obj(raw), 'kind', ['daily', 'monthly', 'pre_update', 'manual'] as const), 'manual request'),
  },
  {
    name: 'backup.list',
    auth: 'owner',
    mutating: false,
    allowInMaintenance: true,
    handler: (ctx) => ctx.uow.list<BackupHistory>('backup_history').sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  },
  {
    name: 'backup.restore',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const b = ctx.uow.get<BackupHistory>('backup_history', v.id(a, 'backupId'));
      if (!b || b.status !== 'ok' || !b.driveFileId) throw E.notFound('バックアップ');
      if (v.str(a, 'confirmText', { max: 20 }) !== '復元する') throw E.invalid('確認のため「復元する」と入力してください');
      if (b.schemaVersion > SCHEMA_VERSION) throw E.invalid('新しいバージョンのバックアップは復元できません（アプリを更新してください）');
      // 1) 復元前バックアップ
      const pre = runBackup(ctx, 'manual', `復元前の自動バックアップ（復元元 ${b.id}）`);
      if (pre.status !== 'ok') throw E.conflict('復元前のバックアップに失敗したため中止しました');
      // 2) バックアップ作成後に追加された追記専用データ（打刻原本・修正・監査ログ等）を退避
      const since = b.createdAt;
      const preserved: Record<string, Record<string, unknown>[]> = {};
      for (const t of APPEND_ONLY_TABLES) preserved[t] = ctx.uow.list<Record<string, unknown>>(t).filter((r) => String(r.createdAt) > since);
      const revokedDevices = ctx.uow.list<Device>('devices').filter((d) => d.status === 'revoked');
      const backupHistory = ctx.uow.list<BackupHistory>('backup_history');
      ctx.uow.flush();
      // 3) DB 切替（バックアップの複製を新 DB として有効化）
      const sw = ctx.p.database.activateCopyOf(b.driveFileId);
      // 旧 DB のシート一覧・行番号のキャッシュを破棄（新 DB に対して読み書きする）
      ctx.uow.adapter.reset?.();
      const uow2 = new UnitOfWork(ctx.uow.adapter, { now: () => ctx.now, newId: (pf) => `${pf}_${ctx.p.randomHex(10)}` });
      const ctx2: Ctx = { ...ctx, uow: uow2 };
      // 4) 退避データを再投入（id 一致は上書き＝冪等）
      let restored = 0;
      for (const t of APPEND_ONLY_TABLES) {
        for (const r of preserved[t]!) {
          const existing = uow2.list<Record<string, unknown>>(t).find((x) => x.id === r.id);
          if (!existing) {
            uow2.insert(t, r as never);
            restored++;
          }
        }
      }
      // 5) 失効情報の維持: 現行で失効済みの端末は失効のまま。全セッション失効
      for (const d of revokedDevices) {
        const cur = uow2.get<Device>('devices', d.id);
        if (cur && cur.status !== 'revoked') uow2.update('devices', { ...cur, status: 'revoked', revokedAt: d.revokedAt });
      }
      revokeSessionsWhere(ctx2, () => true);
      // バックアップ履歴は現行のものを引き継ぐ
      for (const h of backupHistory) if (!uow2.get<BackupHistory>('backup_history', h.id)) uow2.insert('backup_history', h as never);
      audit(ctx2, 'backup.restore', 'backup', b.id, `復元 新DB=${sw.newId} 旧DB=${sw.previousId} 再投入=${restored}`);
      uow2.flush();
      const check = integrityCheck(ctx2);
      return { restoredFrom: b.id, preservedRowsReinserted: restored, previousDatabaseId: sw.previousId, integrity: check, note: '全スタッフのセッションを失効しました。端末は失効済みのものを除き引き続き利用できます' };
    },
  },
]);
