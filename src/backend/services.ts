/**
 * 業務サービス（複数ハンドラから使う読み取り・組み立て処理）
 */
import type { Ctx } from './context';
import { settings, today } from './context';
import { E } from './errors';
import type {
  Allowance,
  AttendanceCorrection,
  AttendanceEvent,
  DeductionEntry,
  Employee,
  EmploymentHistory,
  LeaveTransaction,
  ManualBreak,
  PayrollAdjustment,
  PayrollPeriod,
  PayrollResult,
  SalaryRule,
  Shift,
  StoreSettings,
  TransportRule,
  WageRule,
  WorkSession,
} from '../shared/types';
import { buildSessions, effectiveEvents, DEFAULT_SESSION_OPTIONS, type EffectiveEvent } from '../shared/attendance';
import { addDays, monthKey, type LocalDate } from '../shared/time';
import { computePayroll, type PayrollInput, type PayrollOutput } from '../shared/payroll';
import { weekStartOf, overtime60WindowStart } from '../shared/labor';
import { periodForKey } from '../shared/period';
import { TABLE_BY_NAME } from './schema';

export function monthsBetween(from: LocalDate, to: LocalDate): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** 期間の打刻原本（前後1日分の余裕を持って読む） */
export function loadEvents(ctx: Ctx, from: LocalDate, to: LocalDate): AttendanceEvent[] {
  const parts = monthsBetween(addDays(from, -1), addDays(to, 1));
  const existing = new Set(ctx.uow.adapter.partitions(TABLE_BY_NAME.attendance_events));
  return ctx.uow.list<AttendanceEvent>('attendance_events', { partitions: parts.filter((p) => existing.has(p)) });
}

export function loadEffective(ctx: Ctx, employeeId: string | null, from: LocalDate, to: LocalDate): EffectiveEvent[] {
  const evs = loadEvents(ctx, from, to).filter((e) => !employeeId || e.employeeId === employeeId);
  const cors = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => !employeeId || c.employeeId === employeeId);
  return effectiveEvents(evs, cors);
}

/** 勤務セッションの再構築（労働日が [from, to] のもの） */
export function sessionsFor(ctx: Ctx, employeeId: string, from: LocalDate, to: LocalDate, s?: StoreSettings): WorkSession[] {
  const st = s ?? settings(ctx);
  const evs = loadEffective(ctx, employeeId, addDays(from, -1), addDays(to, 1));
  const mbs = ctx.uow.list<ManualBreak>('manual_breaks').filter((b) => b.employeeId === employeeId);
  const shifts = ctx.uow.list<Shift>('shifts').filter((x) => x.employeeId === employeeId && x.date >= addDays(from, -1) && x.date <= to);
  return buildSessions(employeeId, evs, mbs, shifts, { ...DEFAULT_SESSION_OPTIONS, businessDayCutoff: st.businessDayCutoff, now: ctx.now }).filter(
    (x) => x.laborDate >= from && x.laborDate <= to,
  );
}

export function activeEmployees(ctx: Ctx): Employee[] {
  return ctx.uow
    .list<Employee>('employees')
    .filter((e) => e.status === 'active')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.kana.localeCompare(b.kana, 'ja'));
}

export function periodConfig(s: StoreSettings) {
  if (s.payrollClosingDay === null || s.payMonthOffset === null || s.payDay === null) throw E.invalid('給与締め日・支払日が未設定です（店舗設定で設定してください）');
  return { closingDay: s.payrollClosingDay, payMonthOffset: s.payMonthOffset, payDay: s.payDay };
}

export function getOrCreatePeriod(ctx: Ctx, periodKey: string, create: boolean): PayrollPeriod | null {
  const ex = ctx.uow.list<PayrollPeriod>('payroll_periods').find((p) => p.periodKey === periodKey);
  if (ex || !create) return ex ?? null;
  const r = periodForKey(periodKey, periodConfig(settings(ctx)));
  return ctx.uow.insert<PayrollPeriod>('payroll_periods', { periodKey, from: r.from, to: r.to, payDate: r.payDate, status: 'uncomputed' }, 'per');
}

/** 平均賃金（労基法12条）: 直前3か月の確定給与（交通費等を含む総支給）÷総暦日数、最低保障（日給・時給制: 総額÷労働日数×60%） */
export function averageDailyWage(ctx: Ctx, employee: Employee, beforeDate: LocalDate): { n: string; d: string } | null {
  const periods = ctx.uow.list<PayrollPeriod>('payroll_periods').filter((p) => p.to < beforeDate).sort((a, b) => (a.to < b.to ? 1 : -1)).slice(0, 3);
  if (periods.length < 3) return null;
  const results = ctx.uow.list<PayrollResult>('payroll_results').filter((r) => r.employeeId === employee.id && (r.status === 'confirmed' || r.status === 'issued'));
  let total = 0;
  let workDays = 0;
  for (const p of periods) {
    const r = results.filter((x) => x.periodId === p.id).sort((a, b) => b.revision - a.revision)[0];
    if (!r) return null;
    // 臨時の賃金・3か月を超える期間ごとの賃金は含めない（手動加算は臨時扱いとして除外）
    total += r.totals.grossPay - r.totals.allowances.filter((a) => a.name.startsWith('調整')).reduce((s, a) => s + a.amount, 0);
    workDays += r.totals.workDays;
  }
  const calendarDays = (Date.parse(periods[0]!.to) - Date.parse(periods[periods.length - 1]!.from)) / 86400000 + 1;
  // 比較は分数で: total/calendarDays vs total*0.6/workDays
  if (employee.payType === 'hourly' && workDays > 0) {
    // total/cal < 0.6*total/workDays  <=>  workDays < 0.6*cal
    if (workDays * 10 < 6 * calendarDays) return { n: String(total * 6), d: String(workDays * 10) };
  }
  return { n: String(total), d: String(calendarDays) };
}

/** 給与計算の入力組み立て */
export function payrollInput(ctx: Ctx, employee: Employee, period: PayrollPeriod): PayrollInput {
  const s = settings(ctx);
  const lookbackFrom = [weekStartOf(period.from, s.weekStartDay ?? 0), s.overtime60StartDay === null ? period.from : overtime60WindowStart(period.from, { overtime60StartDay: s.overtime60StartDay } as never)].sort()[0]!;
  const sessions = sessionsFor(ctx, employee.id, lookbackFrom, period.to, s);
  const by = <T extends { employeeId: string }>(xs: T[]) => xs.filter((x) => x.employeeId === employee.id);
  const pendingCorrections = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.employeeId === employee.id && c.status === 'pending').length;
  return {
    employee,
    period: { id: period.id, periodKey: period.periodKey, from: period.from, to: period.to, payDate: period.payDate },
    settings: s,
    sessions,
    employment: by(ctx.uow.list<EmploymentHistory>('employment_history')),
    wageRules: by(ctx.uow.list<WageRule>('wage_rules')),
    salaryRules: by(ctx.uow.list<SalaryRule>('salary_rules')),
    allowances: by(ctx.uow.list<Allowance>('allowances')),
    transportRules: by(ctx.uow.list<TransportRule>('transport_rules')),
    deduction: by(ctx.uow.list<DeductionEntry>('deductions')).find((d) => d.periodId === period.id) ?? null,
    adjustments: by(ctx.uow.list<PayrollAdjustment>('payroll_adjustments')).filter((a) => a.periodId === period.id && (a.quantity > 0 || (a.amount ?? 0) > 0)),
    leaveTakes: by(ctx.uow.list<LeaveTransaction>('leave_transactions')).filter((l) => l.kind === 'take' && l.date >= period.from && l.date <= period.to),
    shifts: by(ctx.uow.list<Shift>('shifts')).filter((x) => x.date >= period.from && x.date <= period.to),
    pendingCorrectionCount: pendingCorrections,
    averageDailyWage: s.paidLeaveWageMethod === 'average' ? averageDailyWage(ctx, employee, period.from) : null,
  };
}

export function runPayroll(ctx: Ctx, employee: Employee, period: PayrollPeriod): { input: PayrollInput; output: PayrollOutput } {
  const input = payrollInput(ctx, employee, period);
  return { input, output: computePayroll(input) };
}

/** 対象期間に在籍していたスタッフ */
export function employeesInPeriod(ctx: Ctx, from: LocalDate, to: LocalDate): Employee[] {
  return ctx.uow
    .list<Employee>('employees')
    .filter((e) => (!e.hireDate || e.hireDate <= to) && (!e.retireDate || e.retireDate >= from))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function latestResult(ctx: Ctx, periodId: string, employeeId: string): PayrollResult | null {
  return (
    ctx.uow
      .list<PayrollResult>('payroll_results')
      .filter((r) => r.periodId === periodId && r.employeeId === employeeId && r.status !== 'superseded')
      .sort((a, b) => b.revision - a.revision)[0] ?? null
  );
}

export function currentMonth(ctx: Ctx): string {
  return monthKey(today(ctx));
}
