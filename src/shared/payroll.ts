/**
 * 給与計算エンジン（純粋関数）
 *
 * - 入力は確定時にスナップショットとして保存できる形（JSON 化可能）で受け取る。
 * - 金額は Frac（有理数）で積算し、項目ごとの期間合計で 1 回だけ円未満処理する。
 * - 未設定・未確認の条件は PayrollIssue として返し、severity='blocking' が 1 件でもあれば確定不可。
 *   計算結果自体は「見込額（不完全）」として表示可能。
 * - 法定割増率は LEGAL_RULESETS で適用期間とともにバージョン管理する。
 */
import type {
  Allowance,
  DeductionEntry,
  Employee,
  EmploymentHistory,
  LeaveTransaction,
  PayrollAdjustment,
  PayrollTotals,
  SalaryRule,
  Shift,
  StoreSettings,
  TransportRule,
  WageRule,
  WorkSession,
} from './types';
import { SUPPORTED_WORKING_TIME_SYSTEMS } from './types';
import { Frac } from './money';
import { classifyLabor, summarize, type LaborConfig, type LaborPiece } from './labor';
import { resolveRate, timebandCuts } from './wage';
import {
  MINUTE_MS,
  addDays,
  dayOfWeek,
  diffDays,
  parseTimeToMinutes,
  startOfLocalDate,
  type Instant,
  type LocalDate,
} from './time';
import { businessDateOf } from './attendance';

export const CALC_VERSION = 'shiftly-payroll-1.0.0';

export interface LegalRuleset {
  id: string;
  effectiveFrom: LocalDate;
  overtimePct: number;
  over60Pct: number;
  holidayPct: number;
  nightPct: number;
  dailyLimitMinutes: number;
  weeklyLimitMinutes: number;
  weeklyLimitSpecialMinutes: number;
}

/** 法令の改正に備え、適用開始日付きで管理（新しいものを末尾に追加） */
export const LEGAL_RULESETS: LegalRuleset[] = [
  {
    // 労基法37条・割増賃金令。月60時間超50%は中小企業も2023-04-01から適用
    id: 'JP-LSA-2023-04',
    effectiveFrom: '2023-04-01',
    overtimePct: 25,
    over60Pct: 50,
    holidayPct: 35,
    nightPct: 25,
    dailyLimitMinutes: 8 * 60,
    weeklyLimitMinutes: 40 * 60,
    weeklyLimitSpecialMinutes: 44 * 60,
  },
];

export function rulesetFor(d: LocalDate): LegalRuleset | null {
  const cands = LEGAL_RULESETS.filter((r) => r.effectiveFrom <= d);
  return cands.length ? cands[cands.length - 1]! : null;
}

export type IssueSeverity = 'blocking' | 'confirm' | 'info';
export interface PayrollIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  date?: LocalDate;
}

export interface PayrollPeriodInput {
  id: string;
  periodKey: string;
  from: LocalDate;
  to: LocalDate;
  payDate: LocalDate;
}

export interface PayrollInput {
  employee: Employee;
  period: PayrollPeriodInput;
  settings: StoreSettings;
  /** 週・月60時間判定のため期間前（週初・起算日）からのセッションを含める */
  sessions: WorkSession[];
  employment: EmploymentHistory[];
  wageRules: WageRule[];
  salaryRules: SalaryRule[];
  allowances: Allowance[];
  transportRules: TransportRule[];
  deduction: DeductionEntry | null;
  adjustments: PayrollAdjustment[];
  leaveTakes: LeaveTransaction[];
  shifts: Shift[];
  pendingCorrectionCount: number;
  /** 期間末時点で付与日数を超えて取得登録された有給の日数（0 なら問題なし） */
  leaveOverdrawnDays?: number;
  /** 平均賃金方式の場合の1日平均賃金（円, 分数）。算出不能なら null */
  averageDailyWage: { n: string; d: string } | null;
}

export interface DailyBreakdown {
  date: LocalDate;
  workMinutes: number;
  overtimeMinutes: number;
  over60Minutes: number;
  nightMinutes: number;
  holidayMinutes: number;
}

export interface BasisLine {
  label: string;
  detail: string;
  amount: number;
}

/** 人件費分析用: 区間ごとの概算コスト（時給制のみ。円・小数） */
export interface PieceCost {
  laborDate: LocalDate;
  businessDate: LocalDate;
  start: Instant;
  minutes: number;
  amount: number;
}

export interface PayrollOutput {
  pieceCosts: PieceCost[];
  totals: PayrollTotals;
  issues: PayrollIssue[];
  daily: DailyBreakdown[];
  basis: BasisLine[];
  canConfirm: boolean;
  calcVersion: string;
  rulesetId: string | null;
}

const ZERO = Frac.ZERO;

function secFrac(seconds: number): Frac {
  return Frac.of(seconds, 3600); // 時間（分数）
}

function effectiveAt<T extends { effectiveFrom: LocalDate; effectiveTo: LocalDate | null }>(xs: T[], d: LocalDate): T[] {
  return xs.filter((x) => x.effectiveFrom <= d && (x.effectiveTo === null || d <= x.effectiveTo));
}

function overlapsPeriod<T extends { effectiveFrom: LocalDate; effectiveTo: LocalDate | null }>(xs: T[], from: LocalDate, to: LocalDate): T[] {
  return xs.filter((x) => x.effectiveFrom <= to && (x.effectiveTo === null || x.effectiveTo >= from));
}

export function minimumWageAt(settings: StoreSettings, d: LocalDate): number | null {
  const cands = settings.minimumWages.filter((m) => m.effectiveFrom <= d).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
  return cands.length ? cands[cands.length - 1]!.hourly : null;
}

function scheduledNetMinutesOfShift(sh: Shift): number {
  return Math.max(0, parseTimeToMinutes(sh.end) - parseTimeToMinutes(sh.start) - sh.breakMinutes);
}

export function computePayroll(input: PayrollInput): PayrollOutput {
  const { employee, period, settings } = input;
  const issues: PayrollIssue[] = [];
  const add = (severity: IssueSeverity, code: string, message: string, date?: LocalDate) => {
    if (!issues.some((i) => i.code === code && i.date === date)) issues.push({ severity, code, message, ...(date ? { date } : {}) });
  };
  const rnd = settings.yenRounding;
  const ruleset = rulesetFor(period.to);
  if (!ruleset) add('blocking', 'RULESET_MISSING', '対象期間に適用できる法令ルールセットがありません');
  const rs = ruleset ?? LEGAL_RULESETS[0]!;

  // ---- 店舗設定の前提チェック
  if (settings.workingTimeSystem === 'unset') add('blocking', 'WORKING_TIME_SYSTEM_UNSET', '労働時間制度が未設定です');
  else if (!SUPPORTED_WORKING_TIME_SYSTEMS.includes(settings.workingTimeSystem))
    add('blocking', 'WORKING_TIME_SYSTEM_UNSUPPORTED', '選択された労働時間制度（変形労働時間制等）には対応していないため、正式な給与確定はできません');
  if (settings.statutoryHolidayWeekday === null) add('blocking', 'STATUTORY_HOLIDAY_UNSET', '法定休日が未設定です');
  if (settings.weekStartDay === null) add('blocking', 'WEEK_START_UNSET', '週の起算曜日が未設定です');
  if (!settings.payrollRulesConfirmedAt) add('blocking', 'PAYROLL_RULES_UNCONFIRMED', '給与規定（店舗設定）の確認が完了していません');
  if (settings.agreement36 !== 'concluded')
    add('info', 'AGREEMENT36_NOT_CONCLUDED', '36協定が締結済みとして登録されていません（計算は実労働時間どおりに行います）');
  if ((input.leaveOverdrawnDays ?? 0) > 0) add('blocking', 'LEAVE_OVERDRAWN', `有給休暇が付与日数を${input.leaveOverdrawnDays}日超えて登録されています`);
  if (input.pendingCorrectionCount > 0) add('blocking', 'PENDING_CORRECTIONS', `未処理の勤怠修正が${input.pendingCorrectionCount}件あります`);

  const weeklyLimit = settings.weekly44Confirmed ? rs.weeklyLimitSpecialMinutes : rs.weeklyLimitMinutes;
  if (settings.weekly44Confirmed)
    add('confirm', 'WEEKLY_44_APPLIED', '週44時間特例を適用しています（常時10人未満・対象業種の要件を満たすことを確認してください）');

  const cutoffMin = parseTimeToMinutes(settings.businessDayCutoff);
  const laborCfg: LaborConfig = {
    statutoryHolidayWeekday: settings.statutoryHolidayWeekday ?? 0,
    weekStartDay: settings.weekStartDay ?? 0,
    weeklyLimitMinutes: weeklyLimit,
    dailyLimitMinutes: rs.dailyLimitMinutes,
    overtime60StartDay: settings.overtime60StartDay,
    periodFrom: period.from,
    businessDayCutoffMinutes: cutoffMin,
  };

  // ---- 勤怠の状態チェック
  for (const s of input.sessions) {
    if (s.laborDate < period.from || s.laborDate > period.to) continue;
    if (s.end === null) add('blocking', 'OPEN_SESSION', '退勤打刻のない勤務があります', s.laborDate);
    if (s.anomalies.includes('missing_clock_out')) add('blocking', 'MISSING_CLOCK_OUT', '退勤打刻漏れがあります', s.laborDate);
    if (s.anomalies.includes('break_not_ended')) add('blocking', 'BREAK_NOT_ENDED', '休憩終了の打刻漏れがあります', s.laborDate);
    if (s.anomalies.includes('insufficient_break'))
      add('confirm', 'INSUFFICIENT_BREAK', '法定の休憩時間（6時間超45分・8時間超60分）に満たない勤務があります', s.laborDate);
    if (s.anomalies.includes('fixed_break_applied'))
      add('confirm', 'FIXED_BREAK_APPLIED', 'シフトの固定休憩を適用した勤務があります（実際に取得したか確認してください）', s.laborDate);
    if (s.anomalies.includes('abnormal_hours')) add('confirm', 'ABNORMAL_HOURS', '異常に長い勤務があります', s.laborDate);
    if (s.anomalies.includes('clock_out_during_break')) add('confirm', 'CLOCK_OUT_DURING_BREAK', '休憩中に退勤した勤務があります', s.laborDate);
  }

  // ---- 区分
  const rulesForCuts = input.wageRules;
  const pieces = classifyLabor(
    input.sessions.filter((s) => s.end !== null),
    laborCfg,
    (s) => {
      // 時間帯ルール境界と営業日境界で分割
      const cuts: Instant[] = [];
      const firstBd = businessDateOf(s.start, settings.businessDayCutoff);
      const lastBd = businessDateOf(s.end ?? s.start, settings.businessDayCutoff);
      for (let bd = firstBd; bd <= lastBd; bd = nextDate(bd)) {
        cuts.push(...timebandCuts(rulesForCuts, bd));
        cuts.push(startOfLocalDate(bd) + cutoffMin * MINUTE_MS);
      }
      return cuts;
    },
  );
  const inPeriod = pieces.filter((p) => p.laborDate >= period.from && p.laborDate <= period.to);
  const sum = summarize(inPeriod);

  // ---- 日別内訳
  const dailyMap = new Map<LocalDate, DailyBreakdown>();
  for (const p of inPeriod) {
    const d = dailyMap.get(p.laborDate) ?? { date: p.laborDate, workMinutes: 0, overtimeMinutes: 0, over60Minutes: 0, nightMinutes: 0, holidayMinutes: 0 };
    d.workMinutes += p.minutes;
    if (p.overtime !== 'none') d.overtimeMinutes += p.minutes;
    if (p.over60) d.over60Minutes += p.minutes;
    if (p.night) d.nightMinutes += p.minutes;
    if (p.holiday) d.holidayMinutes += p.minutes;
    dailyMap.set(p.laborDate, d);
  }
  const daily = [...dailyMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  // ---- 雇用条件
  const emp = effectiveAt(input.employment, period.to)[0] ?? null;
  const basis: BasisLine[] = [];
  let basePay = ZERO;
  let extraBase = ZERO;
  let otPrem = ZERO;
  let ot60Prem = ZERO;
  let holPrem = ZERO;
  let nightPrem = ZERO;
  let fixedOtPay = 0;
  let fixedOtExcess = ZERO;
  let paidLeave = ZERO;
  let absenceDeduction = 0;
  const pieceCosts: PieceCost[] = [];

  // 割増算定基礎へ加算する手当の時間単価（分数）
  const allowancesInPeriod = overlapsPeriod(input.allowances, period.from, period.to);
  const premiumAllowanceHourly = (monthlyMinutes: number | null, dailyMinutes: number | null): Frac => {
    let f = ZERO;
    for (const a of allowancesInPeriod) {
      if (a.premiumBaseCategory !== 'include') continue;
      if (a.kind === 'fixed_monthly') {
        if (!monthlyMinutes) {
          add('blocking', 'ALLOWANCE_PREMIUM_BASE_UNDETERMINED', `手当「${a.name}」を割増算定基礎に含めるための1か月平均所定労働時間が未設定です`);
          continue;
        }
        f = f.add(Frac.of(a.amount * 60, monthlyMinutes));
      } else if (a.kind === 'per_workday') {
        if (!dailyMinutes) {
          add('blocking', 'ALLOWANCE_PREMIUM_BASE_UNDETERMINED', `手当「${a.name}」を割増算定基礎に含めるための1日の所定労働時間が未設定です`);
          continue;
        }
        f = f.add(Frac.of(a.amount * 60, dailyMinutes));
      } else if (a.kind === 'per_hour') {
        f = f.add(Frac.of(a.amount));
      } else {
        add('blocking', 'VARIABLE_ALLOWANCE_PREMIUM_UNSUPPORTED', `変動手当「${a.name}」を割増算定基礎に含める計算（出来高払制）には対応していません`);
      }
    }
    return f;
  };

  const pct = (p: number) => Frac.of(p, 100);
  const minWageCheck = (hourly: Frac, d: LocalDate) => {
    const mw = minimumWageAt(settings, d);
    if (mw === null) {
      add('blocking', 'MIN_WAGE_UNSET', '最低賃金（地域別最低賃金）が設定されていません');
      return;
    }
    if (hourly.cmp(Frac.of(mw)) < 0) add('blocking', 'MIN_WAGE_VIOLATION', `最低賃金（${mw}円）を下回る賃金があります`, d);
  };

  if (employee.payType === 'hourly') {
    // ================================================ 時給制
    const allowHourly = premiumAllowanceHourly(emp?.monthlyAverageScheduledMinutes ?? null, emp?.dailyScheduledMinutes ?? null);
    const minWageAllowHourly = (() => {
      let f = ZERO;
      for (const a of allowancesInPeriod) {
        if (!a.includeInMinimumWage) continue;
        if (a.kind === 'per_hour') f = f.add(Frac.of(a.amount));
      }
      return f;
    })();
    const groups = new Map<string, { rate: number; seconds: number; amount: Frac }>();
    for (const p of inPeriod) {
      const r = resolveRateForPiece(input.wageRules, p, cutoffMin, settings.publicHolidays);
      if (!r) {
        add('blocking', 'WAGE_UNSET', '時給が設定されていない勤務があります', p.laborDate);
        continue;
      }
      if (r.conflict) add('blocking', 'WAGE_RULE_CONFLICT', '同じ優先度で時給の異なるルールが重複しています（高い時給で暫定計算）', p.businessDate);
      if (r.nightIncluded && p.night && Frac.of(r.rate).cmp(Frac.of(r.premiumBase).mul(pct(100 + rs.nightPct))) < 0)
        add('blocking', 'NIGHT_INCLUDED_RATE_INSUFFICIENT', '深夜割増込み時給が法定の割増率を満たしていません', p.laborDate);
      const h = secFrac(p.seconds);
      const amt = Frac.of(r.rate).mul(h);
      basePay = basePay.add(amt);
      const key = `${r.rate}`;
      const g = groups.get(key) ?? { rate: r.rate, seconds: 0, amount: ZERO };
      g.seconds += p.seconds;
      g.amount = g.amount.add(amt);
      groups.set(key, g);
      const pb = Frac.of(r.premiumBase).add(allowHourly);
      if (p.overtime !== 'none') {
        if (p.over60) ot60Prem = ot60Prem.add(pb.mul(h).mul(pct(rs.over60Pct)));
        else otPrem = otPrem.add(pb.mul(h).mul(pct(rs.overtimePct)));
      }
      if (p.holiday) holPrem = holPrem.add(pb.mul(h).mul(pct(rs.holidayPct)));
      if (p.night && !r.nightIncluded) nightPrem = nightPrem.add(pb.mul(h).mul(pct(rs.nightPct)));
      {
        let c = amt;
        if (p.overtime !== 'none') c = c.add(pb.mul(h).mul(pct(p.over60 ? rs.over60Pct : rs.overtimePct)));
        if (p.holiday) c = c.add(pb.mul(h).mul(pct(rs.holidayPct)));
        if (p.night && !r.nightIncluded) c = c.add(pb.mul(h).mul(pct(rs.nightPct)));
        pieceCosts.push({ laborDate: p.laborDate, businessDate: p.businessDate, start: p.start, minutes: p.minutes, amount: c.toNumber() });
      }
      // 最低賃金は実際に働いた暦日で判定（日付をまたぐ勤務の午前0時以降は翌日の最低賃金が適用される）
      minWageCheck(Frac.of(r.premiumBase).add(minWageAllowHourly), p.calendarDate);
    }
    for (const g of groups.values()) {
      basis.push({ label: '基本賃金（時給）', detail: `${g.rate}円 × ${fmtSec(g.seconds)}`, amount: g.amount.round(rnd) });
    }
    if (inPeriod.length === 0) {
      // 勤務がなくても時給設定の有無・最低賃金は確認する
      const anyBase = effectiveAt(input.wageRules.filter((w) => w.kind === 'base'), period.to);
      if (anyBase.length === 0) add('blocking', 'WAGE_UNSET', '基本時給が設定されていません');
    }
    // 有給休暇の賃金
    const leaveDays = input.leaveTakes.reduce((a, l) => a + l.days, 0);
    if (leaveDays > 0) {
      const method = settings.paidLeaveWageMethod;
      if (method === 'unset') add('blocking', 'PAID_LEAVE_METHOD_UNSET', '有給休暇の賃金算定方法が未設定です');
      else if (method === 'standard_remuneration')
        add('blocking', 'PAID_LEAVE_METHOD_UNSUPPORTED', '標準報酬日額方式には対応していません（労使協定が必要）');
      else if (method === 'normal') {
        for (const l of input.leaveTakes) {
          const mins = l.scheduledMinutes ?? emp?.dailyScheduledMinutes ?? null;
          if (!mins) {
            add('blocking', 'LEAVE_SCHEDULED_MINUTES_UNSET', '有給取得日の所定労働時間が未設定です', l.date);
            continue;
          }
          const base = effectiveAt(input.wageRules.filter((w) => w.kind === 'base'), l.date).sort((a, b) => b.priority - a.priority)[0];
          if (!base) {
            add('blocking', 'WAGE_UNSET', '有給取得日の基本時給が未設定です', l.date);
            continue;
          }
          // scheduledMinutes は取得単位（半日なら半日分）の所定時間を想定
          const minutesForDay = l.scheduledMinutes !== null ? l.scheduledMinutes : mins * l.days;
          paidLeave = paidLeave.add(Frac.of(base.hourlyRate * minutesForDay, 60));
        }
      } else if (method === 'average') {
        if (!input.averageDailyWage) add('blocking', 'AVERAGE_WAGE_UNAVAILABLE', '平均賃金を算出できません（直前3か月の確定給与が不足）');
        else {
          const avg = Frac.of(BigInt(input.averageDailyWage.n), BigInt(input.averageDailyWage.d));
          // 平均賃金は銭未満切捨てが通例（労基法12条の運用）。ここでは分数のまま乗じ、合計で円未満処理する
          paidLeave = paidLeave.add(avg.mul(Frac.of(Math.round(leaveDays * 2), 2)));
        }
      }
    }
    for (const a of input.adjustments) {
      if (a.kind === 'absence_days' || a.kind === 'late_early_minutes')
        add('info', 'ADJUSTMENT_IGNORED_HOURLY', '時給制のため欠勤・遅刻早退控除は適用されません（不就労時間はもともと支給対象外）');
    }
  } else {
    // ================================================ 月給制
    const rules = effectiveAt(input.salaryRules, period.to);
    const sr = rules[0] ?? null;
    if (!sr) {
      add('blocking', 'SALARY_RULE_UNSET', '月給制の給与条件が未設定です');
    } else {
      if (!sr.confirmed) add('blocking', 'SALARY_RULE_UNCONFIRMED', '月給制の給与規定が確認済みになっていません');
      if (overlapsPeriod(input.salaryRules, period.from, period.to).length > 1)
        add('blocking', 'SALARY_CHANGED_MID_PERIOD', '期間途中で月給が変更されています（日割規定の確認が必要）');
      const hired = employee.hireDate && employee.hireDate > period.from;
      const retired = employee.retireDate && employee.retireDate < period.to;
      basePay = Frac.of(sr.monthlySalary);
      if (hired || retired) {
        add('blocking', 'PRORATION_RULE_UNCONFIRMED', '期間途中の入社・退職のため日割計算が必要です（暦日按分で暫定計算）');
        const s = hired ? employee.hireDate! : period.from;
        const e = retired ? employee.retireDate! : period.to;
        const days = diffDays(e, s) + 1;
        const total = diffDays(period.to, period.from) + 1;
        basePay = Frac.of(sr.monthlySalary * Math.max(0, days), total);
      }
      basis.push({ label: '基本給（月給）', detail: `${sr.monthlySalary.toLocaleString('ja-JP')}円`, amount: basePay.round(rnd) });

      const msm = sr.monthlyScheduledMinutes;
      if (!msm) add('blocking', 'MONTHLY_SCHEDULED_UNSET', '1か月平均所定労働時間が未設定のため、時間単価を算出できません');
      const allowHourly = premiumAllowanceHourly(msm, sr.scheduledDailyMinutes);
      const hourlyBase = msm ? Frac.of(sr.monthlySalary * 60, msm).add(allowHourly) : ZERO;

      // 最低賃金（月給 + 最低賃金算入手当）÷ 所定労働時間
      if (msm) {
        let mwMonthly = Frac.of(sr.monthlySalary);
        for (const a of allowancesInPeriod) if (a.includeInMinimumWage && a.kind === 'fixed_monthly') mwMonthly = mwMonthly.add(Frac.of(a.amount));
        minWageCheck(mwMonthly.mul(60).div(msm), period.to);
      }

      // 所定時間を超える法定内労働（法定内残業）の判定
      const scheduledFor = (d: LocalDate): number => {
        const sh = input.shifts.filter((x) => x.employeeId === employee.id && x.date === d && x.status === 'published');
        if (sh.length) return sh.reduce((a, x) => a + scheduledNetMinutesOfShift(x), 0);
        return sr.scheduledWeekdays.includes(dayOfWeek(d)) ? (sr.scheduledDailyMinutes ?? 0) : 0;
      };
      let inLegalSec = 0;
      const byDate = new Map<LocalDate, LaborPiece[]>();
      for (const p of inPeriod) if (!p.holiday && p.overtime === 'none') byDate.set(p.laborDate, [...(byDate.get(p.laborDate) ?? []), p]);
      for (const [d, ps] of byDate) {
        const sch = scheduledFor(d) * 60;
        const total = ps.reduce((a, p) => a + p.seconds, 0);
        if (total > sch) inLegalSec += total - sch;
      }
      let otSec = 0;
      let holSec = 0;
      for (const p of inPeriod) {
        const h = secFrac(p.seconds);
        if (p.overtime !== 'none') {
          otSec += p.seconds;
          if (p.over60) ot60Prem = ot60Prem.add(hourlyBase.mul(h).mul(pct(rs.over60Pct)));
          else otPrem = otPrem.add(hourlyBase.mul(h).mul(pct(rs.overtimePct)));
        }
        if (p.holiday) {
          holSec += p.seconds;
          holPrem = holPrem.add(hourlyBase.mul(h).mul(pct(rs.holidayPct)));
        }
        if (p.night) nightPrem = nightPrem.add(hourlyBase.mul(h).mul(pct(rs.nightPct)));
      }
      if (inLegalSec > 0) {
        if (sr.inLegalOvertimeRate === null)
          add('blocking', 'IN_LEGAL_OT_RATE_UNSET', '所定時間を超える法定内労働の支払率（100%/125%）が未設定です');
        const rate = sr.inLegalOvertimeRate ?? 100;
        extraBase = extraBase.add(hourlyBase.mul(secFrac(inLegalSec)).mul(pct(rate)));
        basis.push({ label: '法定内残業（通常賃金）', detail: `${fmtSec(inLegalSec)} × ${rate}%`, amount: hourlyBase.mul(secFrac(inLegalSec)).mul(pct(rate)).round(rnd) });
      }
      const otBase = hourlyBase.mul(secFrac(otSec));
      const holBase = hourlyBase.mul(secFrac(holSec));
      extraBase = extraBase.add(holBase);

      if (sr.fixedOvertime?.enabled) {
        const fo = sr.fixedOvertime;
        if (fo.coveredMinutes <= 0) add('blocking', 'FIXED_OT_INVALID', '固定残業代の対象時間が不正です');
        else if (Frac.of(fo.amount * 60, fo.coveredMinutes).cmp(hourlyBase.mul(pct(100 + rs.overtimePct))) < 0)
          add('blocking', 'FIXED_OT_RATE_INSUFFICIENT', '固定残業代の金額が対象時間に対する法定の時間外賃金を下回っています');
        const owed = otBase.add(otPrem).add(ot60Prem);
        fixedOtPay = fo.amount;
        const diff = owed.sub(Frac.of(fo.amount));
        fixedOtExcess = diff.cmp(ZERO) > 0 ? diff : ZERO;
        otPrem = ZERO;
        ot60Prem = ZERO;
        basis.push({ label: '固定残業代', detail: `${fo.coveredMinutes / 60}時間分`, amount: fo.amount });
        if (!fixedOtExcess.isZero()) basis.push({ label: '固定残業代超過分', detail: '実時間外賃金 − 固定残業代', amount: fixedOtExcess.round(rnd) });
      } else {
        extraBase = extraBase.add(otBase);
      }

      // 欠勤・遅刻早退控除（店長が承認した調整のみ。シフトから自動反映しない）
      for (const a of input.adjustments) {
        if (a.kind === 'absence_days') {
          if (!sr.absenceDeduction?.enabled || !sr.absenceDeduction.divisorDays) {
            add('blocking', 'ABSENCE_DEDUCTION_RULE_UNSET', '欠勤控除の規定が未設定です');
            continue;
          }
          // 控除は労働者に不利にならないよう円未満切捨て
          absenceDeduction += Math.floor((sr.monthlySalary * a.quantity) / sr.absenceDeduction.divisorDays);
        } else if (a.kind === 'late_early_minutes') {
          if (!sr.lateEarlyDeduction?.enabled || !msm) {
            add('blocking', 'LATE_EARLY_DEDUCTION_RULE_UNSET', '遅刻・早退控除の規定が未設定です');
            continue;
          }
          absenceDeduction += floorFrac(Frac.of(sr.monthlySalary * a.quantity, msm));
        }
      }
      // 有給は月給制では基本給が継続支給されるため追加支給なし
    }
  }

  // ---- 手当
  const allowanceLines: { name: string; amount: number }[] = [];
  for (const a of allowancesInPeriod) {
    const cur = effectiveAt([a], period.to).length > 0 || a.effectiveTo === null;
    if (!cur && a.kind === 'fixed_monthly') continue;
    let amt: Frac;
    if (a.kind === 'fixed_monthly') amt = Frac.of(a.amount);
    else if (a.kind === 'per_workday') {
      const days = daily.filter((d) => d.workMinutes > 0 && d.date >= a.effectiveFrom && (a.effectiveTo === null || d.date <= a.effectiveTo)).length;
      amt = Frac.of(a.amount * days);
    } else if (a.kind === 'per_hour') {
      const sec = inPeriod.filter((p) => p.laborDate >= a.effectiveFrom && (a.effectiveTo === null || p.laborDate <= a.effectiveTo)).reduce((s, p) => s + p.seconds, 0);
      amt = Frac.of(a.amount).mul(secFrac(sec));
    } else {
      const v = a.periodAmounts[period.id];
      if (v === undefined) {
        add('blocking', 'ALLOWANCE_UNENTERED', `変動手当「${a.name}」の今期の金額が未入力です`);
        continue;
      }
      amt = Frac.of(v);
    }
    allowanceLines.push({ name: a.name, amount: amt.round(rnd) });
  }
  for (const a of input.adjustments) {
    if (a.kind === 'manual_addition') allowanceLines.push({ name: a.label || '調整（加算）', amount: a.amount ?? 0 });
  }

  // ---- 交通費
  let transport = 0;
  const tr = effectiveAt(input.transportRules, period.to)[0] ?? null;
  if (!tr || tr.method === 'unset') add('blocking', 'TRANSPORT_UNSET', '交通費の支給方式が未設定です（支給なしの場合は「支給なし」を明示してください）');
  else if (tr.method === 'per_day') transport = tr.amount * sum.workDays;
  else if (tr.method === 'monthly') transport = tr.amount;
  else if (tr.method === 'actual') {
    const v = tr.actualAmounts[period.id];
    if (v === undefined) add('blocking', 'TRANSPORT_ACTUAL_UNENTERED', '交通費（実費）の今期の金額が未入力です');
    else transport = v;
  }
  if (tr && tr.monthlyCap !== null && transport > tr.monthlyCap) transport = tr.monthlyCap;

  // ---- 控除
  const dedLines: { name: string; amount: number }[] = [];
  const ded = input.deduction;
  if (!ded || ded.status === 'unentered') add('blocking', 'DEDUCTION_UNENTERED', '控除額（税・社会保険料等）が未入力です（控除なしの場合は「控除なし」を明示してください）');
  else if (ded.status === 'entered') {
    const std: Array<[string, number]> = [
      ['所得税', ded.incomeTax],
      ['住民税', ded.residentTax],
      ['健康保険料', ded.healthInsurance],
      ['介護保険料', ded.nursingInsurance],
      ['厚生年金保険料', ded.pension],
      ['雇用保険料', ded.employmentInsurance],
    ];
    for (const [n, v] of std) if (v > 0) dedLines.push({ name: n, amount: v });
    for (const o of ded.others) {
      if (o.basis === 'labor_agreement')
        add('confirm', 'DEDUCTION_LABOR_AGREEMENT', `控除「${o.name}」は賃金控除に関する労使協定が必要です`);
      dedLines.push({ name: o.name, amount: o.amount });
    }
  }
  for (const a of input.adjustments) {
    if (a.kind === 'manual_subtraction') {
      add('confirm', 'MANUAL_SUBTRACTION', '手動の減額調整があります（法令・労使協定上の根拠を確認してください）');
      dedLines.push({ name: a.label || '調整（減額）', amount: a.amount ?? 0 });
    }
  }

  // ---- 合計（項目ごとに円未満処理）
  const r = (f: Frac) => f.round(rnd);
  const totals: PayrollTotals = {
    workDays: sum.workDays,
    workMinutes: Math.round(sum.workMinutes),
    overtimeMinutes: Math.round(sum.overtimeMinutes),
    over60Minutes: Math.round(sum.over60Minutes),
    nightMinutes: Math.round(sum.nightMinutes),
    holidayMinutes: Math.round(sum.holidayMinutes),
    basePay: r(basePay),
    extraHoursBasePay: r(extraBase),
    overtimePremium: r(otPrem),
    over60Premium: r(ot60Prem),
    nightPremium: r(nightPrem),
    holidayPremium: r(holPrem),
    fixedOvertimePay: fixedOtPay,
    fixedOvertimeExcess: r(fixedOtExcess),
    paidLeavePay: r(paidLeave),
    paidLeaveDays: input.leaveTakes.reduce((a, l) => a + l.days, 0),
    allowances: allowanceLines,
    transport,
    absenceDeduction,
    grossPay: 0,
    deductions: dedLines,
    deductionTotal: 0,
    netPay: 0,
  };
  totals.grossPay =
    totals.basePay +
    totals.extraHoursBasePay +
    totals.overtimePremium +
    totals.over60Premium +
    totals.nightPremium +
    totals.holidayPremium +
    totals.fixedOvertimePay +
    totals.fixedOvertimeExcess +
    totals.paidLeavePay +
    allowanceLines.reduce((a, l) => a + l.amount, 0) +
    totals.transport -
    totals.absenceDeduction;
  totals.deductionTotal = dedLines.reduce((a, l) => a + l.amount, 0);
  totals.netPay = totals.grossPay - totals.deductionTotal;
  if (totals.netPay < 0) add('blocking', 'NEGATIVE_NET_PAY', '差引支給額がマイナスになります');
  if (totals.grossPay < 0) add('blocking', 'NEGATIVE_GROSS_PAY', '総支給額がマイナスになります');

  if (totals.overtimePremium || totals.over60Premium)
    basis.push({ label: '時間外割増', detail: `${fmtMin(sum.overtimeMinutes)}（うち60時間超 ${fmtMin(sum.over60Minutes)}）`, amount: totals.overtimePremium + totals.over60Premium });
  if (totals.holidayPremium) basis.push({ label: '法定休日割増', detail: `${fmtMin(sum.holidayMinutes)} × ${rs.holidayPct}%`, amount: totals.holidayPremium });
  if (totals.nightPremium) basis.push({ label: '深夜割増', detail: `${fmtMin(sum.nightMinutes)} × ${rs.nightPct}%`, amount: totals.nightPremium });

  return {
    pieceCosts,
    totals,
    issues,
    daily,
    basis,
    canConfirm: !issues.some((i) => i.severity === 'blocking'),
    calcVersion: CALC_VERSION,
    rulesetId: ruleset?.id ?? null,
  };
}

function resolveRateForPiece(rules: WageRule[], p: LaborPiece, cutoffMin: number, holidays: string[]) {
  void cutoffMin;
  const minuteFromBd = Math.round((p.start - startOfLocalDate(p.businessDate)) / MINUTE_MS);
  return resolveRate(rules, p.businessDate, minuteFromBd, holidays);
}

function nextDate(d: LocalDate): LocalDate {
  return addDays(d, 1);
}

/** 円未満切捨て（控除額用: 労働者に不利にならない方向） */
function floorFrac(f: Frac): number {
  return Number(f.n / f.d);
}

function fmtSec(sec: number): string {
  const m = Math.round(sec / 60);
  return fmtMin(m);
}
function fmtMin(m: number): string {
  const mm = Math.round(m);
  return `${Math.floor(mm / 60)}時間${String(mm % 60).padStart(2, '0')}分`;
}

/** 確定前チェックで confirm レベルの課題に対する確認が揃っているか */
export function unacknowledged(issues: PayrollIssue[], acks: string[]): PayrollIssue[] {
  const set = new Set(acks);
  return issues.filter((i) => i.severity === 'confirm' && !set.has(issueKey(i)));
}

export function issueKey(i: PayrollIssue): string {
  return i.date ? `${i.code}@${i.date}` : i.code;
}
