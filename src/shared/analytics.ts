/**
 * 人件費分析・予算
 *
 * - 実績値（確定給与/仮計算の総支給）、予定値（公開シフトから計算）、予測値（実績＋残り予定）、未確定値を区別する。
 * - 総支給額ベースの人件費と、会社負担社会保険料等の概算（店舗設定の率。仮定値）を区別する。
 * - 月給制スタッフの日別・時間帯別配賦方法は予算設定で選択（暦日均等／実労働時間比例／所定日均等）。
 * - 給与閲覧権限（payroll_view_all）がない閲覧者にはスタッフ別内訳を返さない（呼び出し側で制御）。
 */
import type { PayrollOutput, PieceCost } from './payroll';
import type { Budget, Employee, Shift, WorkSession } from './types';
import { addDays, dayOfWeek, eachDate, localDateTime, minuteOfDay, MINUTE_MS, type LocalDate } from './time';
import { businessDateOf } from './attendance';

export type ValueKind = 'actual' | 'planned' | 'forecast';

/** シフト → 予定の勤務セッション（休憩は固定休憩開始が指定されていればその位置、なければ中間に配置） */
export function shiftToSession(sh: Shift, cutoff: string): WorkSession {
  const start = localDateTime(sh.date, sh.start);
  const end = localDateTime(sh.date, sh.end);
  const breaks = [];
  if (sh.breakMinutes > 0 && end > start) {
    const bs = sh.fixedBreakStart ? localDateTime(sh.date, sh.fixedBreakStart) : start + Math.floor((end - start - sh.breakMinutes * MINUTE_MS) / 2 / MINUTE_MS) * MINUTE_MS;
    breaks.push({ start: bs, end: bs + sh.breakMinutes * MINUTE_MS, source: 'fixed' as const });
  }
  return {
    employeeId: sh.employeeId,
    start,
    end,
    breaks,
    laborDate: sh.date,
    businessDate: businessDateOf(start, cutoff),
    eventIds: [],
    anomalies: [],
  };
}

export interface EmployeeCostInput {
  employee: Employee;
  output: PayrollOutput;
  /** 月給制の配賦用: 日別の実労働分（時給制は pieceCosts を使用） */
  workMinutesByDate: Record<LocalDate, number>;
  scheduledWeekdays: number[];
}

export interface CostCell {
  amount: number;
  minutes: number;
}

export interface LaborCostReport {
  from: LocalDate;
  to: LocalDate;
  total: number;
  byDate: Record<LocalDate, CostCell>;
  byWeekday: CostCell[]; // 0..6
  byHour: CostCell[]; // 0..23（営業日ではなく実時刻）
  byEmployee: Array<{ employeeId: string; name: string; amount: number; minutes: number }>;
  incomplete: Array<{ employeeId: string; name: string; reason: string }>;
  employerCostEstimate: number | null;
}

function emptyCells(n: number): CostCell[] {
  return Array.from({ length: n }, () => ({ amount: 0, minutes: 0 }));
}

/**
 * 給与計算結果を日・曜日・時間帯・スタッフ別に配賦する。
 * 総支給額（交通費を含む）から区間コストの合計を引いた残余（手当・交通費・月給など）は配賦方法に従い日に按分する。
 */
export function allocateLaborCost(
  from: LocalDate,
  to: LocalDate,
  inputs: EmployeeCostInput[],
  method: Budget['laborCostAllocation'],
  employerCostRatePercent: number | null,
): LaborCostReport {
  const dates = eachDate(from, to);
  const byDate: Record<LocalDate, CostCell> = {};
  for (const d of dates) byDate[d] = { amount: 0, minutes: 0 };
  const byWeekday = emptyCells(7);
  const byHour = emptyCells(24);
  const byEmployee: LaborCostReport['byEmployee'] = [];
  const incomplete: LaborCostReport['incomplete'] = [];
  let total = 0;

  const addDate = (d: LocalDate, amount: number, minutes: number) => {
    const c = byDate[d];
    if (!c) return;
    c.amount += amount;
    c.minutes += minutes;
    const w = byWeekday[dayOfWeek(d)]!;
    w.amount += amount;
    w.minutes += minutes;
  };

  for (const inp of inputs) {
    const gross = inp.output.totals.grossPay;
    total += gross;
    const minutes = inp.output.totals.workMinutes;
    byEmployee.push({ employeeId: inp.employee.id, name: inp.employee.displayName, amount: gross, minutes });
    if (!inp.output.canConfirm) incomplete.push({ employeeId: inp.employee.id, name: inp.employee.displayName, reason: '給与条件の未設定・未確認があり金額は不完全です' });

    let allocated = 0;
    const pcs: PieceCost[] = inp.output.pieceCosts.filter((p) => p.laborDate >= from && p.laborDate <= to);
    for (const p of pcs) {
      addDate(p.laborDate, p.amount, p.minutes);
      const h = byHour[Math.floor(minuteOfDay(p.start) / 60)]!;
      h.amount += p.amount;
      h.minutes += p.minutes;
      allocated += p.amount;
    }
    const remainder = gross - allocated;
    if (Math.abs(remainder) < 0.5) continue;
    // 残余の配賦
    let weights: Record<LocalDate, number> = {};
    if (method === 'by_worked_minutes') weights = { ...inp.workMinutesByDate };
    else if (method === 'by_scheduled_days') for (const d of dates) weights[d] = inp.scheduledWeekdays.includes(dayOfWeek(d)) ? 1 : 0;
    else for (const d of dates) weights[d] = 1;
    let wsum = Object.entries(weights).filter(([d]) => d >= from && d <= to).reduce((a, [, w]) => a + w, 0);
    if (wsum <= 0) {
      weights = {};
      for (const d of dates) weights[d] = 1;
      wsum = dates.length;
    }
    for (const [d, w] of Object.entries(weights)) {
      if (d < from || d > to || w <= 0) continue;
      addDate(d, (remainder * w) / wsum, pcs.length ? 0 : inp.workMinutesByDate[d] ?? 0);
    }
    // 注: 時間帯別（byHour）は時給制の区間コストのみ。月給制は日別までの配賦とする（docs/payroll-specification.md）
  }
  return {
    from,
    to,
    total,
    byDate,
    byWeekday,
    byHour,
    byEmployee,
    incomplete,
    employerCostEstimate: employerCostRatePercent === null ? null : Math.round((total * employerCostRatePercent) / 100),
  };
}

export interface BudgetStatus {
  month: string;
  budget: number | null;
  actualToDate: number;
  plannedRemaining: number;
  forecast: number;
  consumptionRate: number | null; // actual / budget
  forecastRate: number | null;
  over: boolean;
  dailyOver: LocalDate[];
}

export function budgetStatus(
  month: string,
  budget: Budget | null,
  actualByDate: Record<LocalDate, number>,
  forecastTotal: number,
  today: LocalDate,
): BudgetStatus {
  const actualToDate = Object.entries(actualByDate)
    .filter(([d]) => d <= today)
    .reduce((a, [, v]) => a + v, 0);
  const b = budget ? budget.monthlyAmount : null;
  const dailyOver: LocalDate[] = [];
  if (budget) for (const [d, amt] of Object.entries(budget.dailyAmounts)) if ((actualByDate[d] ?? 0) > amt && amt > 0) dailyOver.push(d);
  return {
    month,
    budget: b,
    actualToDate: Math.round(actualToDate),
    plannedRemaining: Math.max(0, Math.round(forecastTotal - actualToDate)),
    forecast: Math.round(forecastTotal),
    consumptionRate: b ? actualToDate / b : null,
    forecastRate: b ? forecastTotal / b : null,
    over: b !== null && forecastTotal > b,
    dailyOver,
  };
}

/** 月の初日・末日 */
export function monthRange(month: string): { from: LocalDate; to: LocalDate } {
  const from = `${month}-01`;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from, to: addDays(next, -1) };
}
