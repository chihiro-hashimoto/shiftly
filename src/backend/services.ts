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
  BreakDeclaration,
  DeductionEntry,
  Employee,
  EmploymentHistory,
  LeaveGrant,
  LeaveTransaction,
  ManualBreak,
  OvertimeRequest,
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
import { addDays, localDateTime, monthKey, type LocalDate } from '../shared/time';
import { computePayroll, type PayrollInput, type PayrollIssue, type PayrollOutput } from '../shared/payroll';
import { applyTimeBasis, type SessionTimeBasis } from '../shared/worktime';
import { weekStartOf, overtime60WindowStart } from '../shared/labor';
import { periodForKey } from '../shared/period';
import { leaveBalance } from '../shared/leave';
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
  const shifts = ctx.uow.list<Shift>('shifts').filter((x) => x.employeeId === employeeId && x.date >= addDays(from, -1) && x.date <= addDays(to, 1));
  // v1.3: 予定休憩は「取得した」と申告・確認された勤務だけに控除する（breakDeclarations を必ず渡す）
  const decls = ctx.uow.list<BreakDeclaration>('break_declarations').filter((d) => d.employeeId === employeeId);
  return buildSessions(employeeId, evs, mbs, shifts, { ...DEFAULT_SESSION_OPTIONS, businessDayCutoff: st.businessDayCutoff, now: ctx.now, breakDeclarations: decls }).filter(
    (x) => x.laborDate >= from && x.laborDate <= to,
  );
}

/** 給与計算用の勤務（店舗設定の時間基準に従い、シフト基準ではシフト外の未確認時間を除外） */
export function payableSessionsFor(ctx: Ctx, employeeId: string, from: LocalDate, to: LocalDate, s?: StoreSettings): { sessions: WorkSession[]; details: SessionTimeBasis[]; basis: 'shift' | 'actual' } {
  const st = s ?? settings(ctx);
  const actual = sessionsFor(ctx, employeeId, from, to, st);
  const shifts = ctx.uow.list<Shift>('shifts').filter((x) => x.employeeId === employeeId && x.date >= addDays(from, -1) && x.date <= addDays(to, 1));
  const reqs = ctx.uow.list<OvertimeRequest>('overtime_requests').filter((r) => r.employeeId === employeeId);
  const basis = st.payrollTimeBasis === 'actual' ? 'actual' : 'shift';
  const r = applyTimeBasis(actual, shifts, reqs, basis);
  return { ...r, basis };
}

/** 勤怠修正の対象日（修正後または修正前の日時の日付） */
export function correctionDate(c: AttendanceCorrection): LocalDate | null {
  const at = c.newAt ?? (() => {
    try {
      return (JSON.parse(c.before || '{}') as { at?: string }).at ?? null;
    } catch {
      return null;
    }
  })();
  return at ? (at.slice(0, 10) as LocalDate) : null;
}

/** v1.2 以前の行（列追加前）の確認状態は「確認不要」とみなす */
export function reviewStatusOf(c: { reviewStatus?: string | null }): AttendanceCorrection['reviewStatus'] {
  const r = c.reviewStatus;
  return r === 'unreviewed' || r === 'pending' || r === 'approved' || r === 'rejected' ? r : 'not_required';
}

/** 給与計算に影響する勤怠の確認状況（期間内） */
export function attendanceReviewIssues(ctx: Ctx, employeeId: string, from: LocalDate, to: LocalDate, details: SessionTimeBasis[]): PayrollIssue[] {
  const out: PayrollIssue[] = [];
  for (const d of details) {
    if (d.laborDate < from || d.laborDate > to) continue;
    if (d.unresolvedMinutes > 0) {
      const cats = [...new Set(d.candidates.filter((c) => c.segments.some((g) => g.resolution === 'unresolved')).map((c) => ({ early: '早出', late: '残業', between: 'シフト間', no_shift: 'シフト未登録' })[c.category]))];
      out.push({
        severity: 'blocking',
        code: 'OFF_SHIFT_UNCONFIRMED',
        message: `シフト外の勤務候補（${cats.join('・')}）${d.unresolvedMinutes}分が未確認です。早出・残業申請の承認、または実労働の有無の確認を行ってください（未申請でも実労働であれば給与に含めます）`,
        date: d.laborDate,
      });
    }
  }
  const reqs = ctx.uow.list<OvertimeRequest>('overtime_requests').filter((r) => r.employeeId === employeeId && r.workDate >= from && r.workDate <= to);
  const pending = reqs.filter((r) => r.status === 'pending').length;
  if (pending) out.push({ severity: 'blocking', code: 'OVERTIME_REQUEST_PENDING', message: `未処理の早出・残業申請が${pending}件あります` });
  const returned = reqs.filter((r) => r.status === 'returned').length;
  if (returned) out.push({ severity: 'confirm', code: 'OVERTIME_REQUEST_RETURNED', message: `差戻し中の早出・残業申請が${returned}件あります（該当時間が未確認の場合は給与確定できません）` });
  const cors = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.employeeId === employeeId);
  const inRange = (c: AttendanceCorrection) => {
    const d = correctionDate(c);
    return d !== null && d >= addDays(from, -1) && d <= addDays(to, 1);
  };
  const unreviewed = new Set(cors.filter((c) => inRange(c) && reviewStatusOf(c) === 'unreviewed' && c.status === 'applied').map((c) => c.groupId ?? c.id)).size;
  if (unreviewed) out.push({ severity: 'confirm', code: 'SELF_CORRECTION_UNREVIEWED', message: `スタッフ本人による勤怠修正（管理者未確認）が${unreviewed}件あります。内容を確認してください` });
  const decls = ctx.uow.list<BreakDeclaration>('break_declarations').filter((d) => d.employeeId === employeeId && d.laborDate >= from && d.laborDate <= to);
  const pendingDecl = decls.filter((d) => d.status === 'pending').length;
  if (pendingDecl) out.push({ severity: 'blocking', code: 'BREAK_DECLARATION_PENDING', message: `確認待ちの休憩の申告が${pendingDecl}件あります` });
  return out;
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

/** 'YYYY-MM' の前月キー */
function prevKey(k: string): string {
  const y = Number(k.slice(0, 4));
  const m = Number(k.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** 他の給与期間と日付が重なっていないか（締め日の変更などで重複・二重計上しないための検査） */
export function overlappingPeriod(ctx: Ctx, p: Pick<PayrollPeriod, 'periodKey' | 'from' | 'to'>): PayrollPeriod | null {
  return ctx.uow.list<PayrollPeriod>('payroll_periods').find((x) => x.periodKey !== p.periodKey && x.from <= p.to && p.from <= x.to) ?? null;
}

export function getOrCreatePeriod(ctx: Ctx, periodKey: string, create: boolean): PayrollPeriod | null {
  const all = ctx.uow.list<PayrollPeriod>('payroll_periods');
  const ex = all.find((p) => p.periodKey === periodKey);
  if (ex || !create) return ex ?? null;
  const r = periodForKey(periodKey, periodConfig(settings(ctx)));
  // 直前月の期間が作成済みなら、その翌日から開始する（締め日を変更した移行期に期間の重複・欠落を作らない）
  const prev = all.find((p) => p.periodKey === prevKey(periodKey));
  const from = prev ? addDays(prev.to, 1) : r.from;
  if (from > r.to) throw E.invalid(`${periodKey} の期間を作成できません（前の期間 ${prev!.from}〜${prev!.to} と締め日の設定が合いません）`);
  const ov = overlappingPeriod(ctx, { periodKey, from, to: r.to });
  if (ov) throw E.invalid(`${periodKey} の期間（${from}〜${r.to}）が作成済みの期間 ${ov.periodKey}（${ov.from}〜${ov.to}）と重なるため作成できません`);
  return ctx.uow.insert<PayrollPeriod>('payroll_periods', { periodKey, from, to: r.to, payDate: r.payDate, status: 'uncomputed' }, 'per');
}

/** 給与期間の勤務がすべて終わった時刻（期間末日の翌日の営業日切替時刻）。これより前は正式確定できない */
export function periodClosedAt(ctx: Ctx, p: PayrollPeriod): number {
  return localDateTime(addDays(p.to, 1), settings(ctx).businessDayCutoff);
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
  // 週の時間外判定と月60時間の累計に必要な過去の勤務を読む。
  // 60時間の起算日が週の途中にある場合、その週の初日まで遡る（起算週の週次時間外を取りこぼさない）
  const windowStart = s.overtime60StartDay === null ? period.from : overtime60WindowStart(period.from, { overtime60StartDay: s.overtime60StartDay } as never);
  const earliest = windowStart < period.from ? windowStart : period.from;
  const lookbackFrom = weekStartOf(earliest, s.weekStartDay ?? 0);
  const tb = payableSessionsFor(ctx, employee.id, lookbackFrom, period.to, s);
  const sessions = tb.sessions;
  const by = <T extends { employeeId: string }>(xs: T[]) => xs.filter((x) => x.employeeId === employee.id);
  // 承認待ち（未反映）の勤怠修正: 期間内（日付不明のものを含む）
  const pendingCorrections = new Set(
    ctx.uow
      .list<AttendanceCorrection>('attendance_corrections')
      .filter((c) => c.employeeId === employee.id && c.status === 'pending')
      .filter((c) => {
        const d = correctionDate(c);
        return d === null || (d >= addDays(period.from, -1) && d <= addDays(period.to, 1));
      })
      .map((c) => c.groupId ?? c.id),
  ).size;
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
    leaveOverdrawnDays: leaveBalance(by(ctx.uow.list<LeaveGrant>('leave_grants')), by(ctx.uow.list<LeaveTransaction>('leave_transactions')), period.to).overdrawn,
    averageDailyWage: s.paidLeaveWageMethod === 'average' ? averageDailyWage(ctx, employee, period.from) : null,
    extraIssues: attendanceReviewIssues(ctx, employee.id, period.from, period.to, tb.details),
    timeBasis: { basis: tb.basis, details: tb.details.filter((d) => d.laborDate >= period.from && d.laborDate <= period.to) },
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

/** 日付が給与確定済みの期間に含まれる場合はその期間 */
export function confirmedPeriodFor(ctx: Ctx, d: LocalDate): PayrollPeriod | null {
  const p = ctx.uow.list<PayrollPeriod>('payroll_periods').find((x) => x.from <= d && d <= x.to);
  if (!p) return null;
  const confirmed = ctx.uow.list<PayrollResult>('payroll_results').some((r) => r.periodId === p.id && (r.status === 'confirmed' || r.status === 'issued'));
  return confirmed ? p : null;
}
