/**
 * 給与計算エンジンのゴールデンテスト（実装とは独立に手計算した期待値）
 *
 * - 期待値はすべて数値リテラル。各ケースに手計算の式をコメントで残す。
 * - 根拠: docs/payroll-specification.md（§番号をコメントに記載）
 * - 実装の出力に合わせて期待値を変更しないこと。食い違いは仕様確認の対象とする。
 *
 * カレンダー（2026年11月）: 11-01 日, 11-02 月, 11-03 火, 11-04 水, 11-05 木, 11-06 金, 11-07 土, 11-08 日 ...
 */
import { describe, expect, it } from 'vitest';
import { computePayroll, type PayrollInput, type PayrollOutput, type PayrollPeriodInput } from '../../src/shared/payroll';
import type {
  Allowance,
  DeductionEntry,
  Employee,
  EmploymentHistory,
  LeaveTransaction,
  SalaryRule,
  StoreSettings,
  TransportRule,
  WageRule,
  WorkSession,
} from '../../src/shared/types';
import { MINUTE_MS, localDateTime, parseTimeToMinutes, toLocalDate, type LocalDate, type LocalTime } from '../../src/shared/time';

// ------------------------------------------------------------------ fixtures
const META = { createdAt: '2026-01-01T00:00:00+09:00', updatedAt: '2026-01-01T00:00:00+09:00', version: 1 };
const EMP = 'e1';

const PERIOD: PayrollPeriodInput = { id: 'p1', periodKey: '2026-11', from: '2026-11-01', to: '2026-11-30', payDate: '2026-12-10' };

function settings(over: Partial<StoreSettings> = {}): StoreSettings {
  return {
    id: 'store',
    ...META,
    storeName: 'テスト店',
    storeAddress: 'テスト',
    timezone: 'Asia/Tokyo',
    businessHours: [],
    businessDayCutoff: '05:00',
    workingTimeSystem: 'standard',
    weekStartDay: 0,
    statutoryHolidayWeekday: 0,
    weekly44Confirmed: false,
    agreement36: 'concluded',
    overtime60StartDay: null,
    payrollClosingDay: 0,
    payMonthOffset: 1,
    payDay: 10,
    yenRounding: 'half_up',
    minimumWages: [{ effectiveFrom: '2025-10-01', hourly: 1000, label: 'テスト用', sourceNote: 'テスト' }],
    employerCostRatePercent: null,
    idleTimeoutSec: 120,
    pinMaxAttempts: 5,
    pinLockMinutes: 15,
    publicHolidays: [],
    paidLeaveWageMethod: 'normal',
    halfDayLeaveAllowed: false,
    payslipDelivery: 'paper',
    retentionYears: 5,
    dailyBackupGenerations: 7,
    monthlyBackupGenerations: 12,
    payrollRulesConfirmedAt: '2026-11-01T00:00:00+09:00',
    ...over,
  };
}

function employee(payType: 'hourly' | 'monthly' = 'hourly'): Employee {
  return {
    id: EMP,
    ...META,
    employeeCode: '001',
    displayName: 'テスト',
    kana: 'てすと',
    status: 'active',
    hireDate: '2025-04-01',
    retireDate: null,
    payType,
    sortOrder: 1,
    electronicPayslipConsent: false,
    note: '',
  };
}

function employment(payType: 'hourly' | 'monthly' = 'hourly'): EmploymentHistory {
  return {
    id: 'emp1',
    ...META,
    employeeId: EMP,
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    payType,
    weeklyScheduledDays: 5,
    weeklyScheduledMinutes: 2400,
    yearlyScheduledDays: null,
    dailyScheduledMinutes: 480,
    monthlyAverageScheduledMinutes: 9600,
    note: '',
  };
}

let ruleSeq = 0;
function wage(over: Partial<WageRule> = {}): WageRule {
  ruleSeq += 1;
  return {
    id: `w${ruleSeq}`,
    ...META,
    employeeId: EMP,
    kind: 'base',
    hourlyRate: 1100,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    weekdays: [],
    timeFrom: null,
    timeTo: null,
    specialDates: [],
    priority: 0,
    includesNightPremium: false,
    premiumBaseRate: null,
    note: '',
    ...over,
  };
}

function salary(over: Partial<SalaryRule> = {}): SalaryRule {
  return {
    id: 's1',
    ...META,
    employeeId: EMP,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    monthlySalary: 240000,
    monthlyScheduledMinutes: 9600,
    scheduledWeekdays: [1, 2, 3, 4, 5],
    scheduledDailyMinutes: 480,
    inLegalOvertimeRate: 100,
    fixedOvertime: null,
    absenceDeduction: { enabled: false, divisorDays: null },
    lateEarlyDeduction: { enabled: false },
    confirmed: true,
    note: '',
    ...over,
  };
}

function transport(over: Partial<TransportRule> = {}): TransportRule {
  return {
    id: 't1',
    ...META,
    employeeId: EMP,
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    method: 'none',
    amount: 0,
    monthlyCap: null,
    actualAmounts: {},
    note: '',
    ...over,
  };
}

function deduction(over: Partial<DeductionEntry> = {}, periodId = 'p1'): DeductionEntry {
  return {
    id: 'd1',
    ...META,
    employeeId: EMP,
    periodId,
    status: 'explicit_none',
    incomeTax: 0,
    residentTax: 0,
    healthInsurance: 0,
    pension: 0,
    employmentInsurance: 0,
    nursingInsurance: 0,
    others: [],
    note: '',
    ...over,
  };
}

function allowance(over: Partial<Allowance> = {}): Allowance {
  return {
    id: 'a1',
    ...META,
    employeeId: EMP,
    name: '手当',
    kind: 'fixed_monthly',
    amount: 0,
    effectiveFrom: '2025-04-01',
    effectiveTo: null,
    premiumBaseCategory: 'include',
    includeInMinimumWage: false,
    periodAmounts: {},
    note: '',
    ...over,
  };
}

function leaveTake(date: LocalDate, scheduledMinutes: number | null): LeaveTransaction {
  return {
    id: `l-${date}`,
    ...META,
    employeeId: EMP,
    date,
    days: 1,
    kind: 'take',
    scheduledMinutes,
    grantId: null,
    reason: '',
    actorId: 'owner',
  };
}

/** JST の date + 'HH:MM'（24時以降は翌日）で勤務を作る。laborDate=始業の暦日、businessDate=始業-05:00 の暦日 */
function sess(date: LocalDate, start: LocalTime, end: LocalTime, breaks: Array<[LocalTime, LocalTime]> = []): WorkSession {
  const s = localDateTime(date, start);
  return {
    employeeId: EMP,
    start: s,
    end: localDateTime(date, end),
    breaks: breaks.map(([b1, b2]) => ({ start: localDateTime(date, b1), end: localDateTime(date, b2), source: 'punch' as const })),
    laborDate: toLocalDate(s),
    businessDate: toLocalDate(s - parseTimeToMinutes('05:00') * MINUTE_MS),
    eventIds: [],
    anomalies: [],
  };
}

function hourlyInput(over: Partial<PayrollInput> = {}): PayrollInput {
  return {
    employee: employee('hourly'),
    period: PERIOD,
    settings: settings(),
    sessions: [],
    employment: [employment('hourly')],
    wageRules: [wage()],
    salaryRules: [],
    allowances: [],
    transportRules: [transport()],
    deduction: deduction(),
    adjustments: [],
    leaveTakes: [],
    shifts: [],
    pendingCorrectionCount: 0,
    averageDailyWage: null,
    ...over,
  };
}

function monthlyInput(over: Partial<PayrollInput> = {}): PayrollInput {
  return hourlyInput({
    employee: employee('monthly'),
    employment: [employment('monthly')],
    wageRules: [],
    salaryRules: [salary()],
    ...over,
  });
}

const codes = (o: PayrollOutput) => o.issues.map((i) => i.code);
const blocking = (o: PayrollOutput) => o.issues.filter((i) => i.severity === 'blocking').map((i) => i.code);
const issue = (o: PayrollOutput, code: string) => o.issues.find((i) => i.code === code);

/** 9:00-18:00 休憩12:00-13:00（実働8h）の平日 */
const day8 = (d: LocalDate) => sess(d, '09:00', '18:00', [['12:00', '13:00']]);
/** 9:00-19:00 休憩12:00-13:00（実働9h） */
const day9 = (d: LocalDate) => sess(d, '09:00', '19:00', [['12:00', '13:00']]);
/** 9:00-20:00 休憩12:00-13:00（実働10h） */
const day10 = (d: LocalDate) => sess(d, '09:00', '20:00', [['12:00', '13:00']]);
/** 9:00-22:00 休憩12:00-13:00（実働12h, 22:00ちょうどで終了するので深夜なし） */
const day12 = (d: LocalDate) => sess(d, '09:00', '22:00', [['12:00', '13:00']]);

// ================================================================== 時給制: 基本・時間外・深夜・休日
describe('時給制: 1日単位', () => {
  it('ケース1: 平日 9:00-18:00 休憩60分（実働8h）→ 基本8800、割増なし', () => {
    const o = computePayroll(hourlyInput({ sessions: [day8('2026-11-02')] }));
    // 1100円 × 8h = 8800
    expect(o.totals.workMinutes).toBe(480);
    expect(o.totals.workDays).toBe(1);
    expect(o.totals.basePay).toBe(8800);
    expect(o.totals.overtimeMinutes).toBe(0);
    expect(o.totals.overtimePremium).toBe(0);
    expect(o.totals.nightPremium).toBe(0);
    expect(o.totals.holidayPremium).toBe(0);
    // 総支給 8800（交通費なし・手当なし）、控除なし明示 → 差引 8800
    expect(o.totals.grossPay).toBe(8800);
    expect(o.totals.deductionTotal).toBe(0);
    expect(o.totals.netPay).toBe(8800);
    expect(blocking(o)).toEqual([]);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース2: 実働9h（9:00-19:00 休憩60分）→ 基本9900 + 時間外割増275', () => {
    const o = computePayroll(hourlyInput({ sessions: [day9('2026-11-02')] }));
    // 基本 1100×9h=9900、時間外は 18:00-19:00 の1h: 1100×1h×0.25=275
    expect(o.totals.workMinutes).toBe(540);
    expect(o.totals.overtimeMinutes).toBe(60);
    expect(o.totals.basePay).toBe(9900);
    expect(o.totals.overtimePremium).toBe(275);
    expect(o.totals.over60Premium).toBe(0);
    // 9900+275=10175
    expect(o.totals.grossPay).toBe(10175);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース3: 深夜 18:00-翌1:00 休憩なし(7h)、22-25時の3hが深夜 → 深夜割増825', () => {
    const o = computePayroll(hourlyInput({ sessions: [sess('2026-11-02', '18:00', '25:00')] }));
    // 基本 1100×7h=7700、深夜 1100×3h×0.25=825、時間外なし(7h≤8h)
    expect(o.totals.workMinutes).toBe(420);
    expect(o.totals.nightMinutes).toBe(180);
    expect(o.totals.overtimeMinutes).toBe(0);
    expect(o.totals.basePay).toBe(7700);
    expect(o.totals.nightPremium).toBe(825);
    expect(o.totals.overtimePremium).toBe(0);
    // 7700+825=8525
    expect(o.totals.grossPay).toBe(8525);
    // 休憩不足（confirm）が出る可能性はあるが blocking はない
    expect(blocking(o)).toEqual([]);
  });

  it('ケース4: 時間外＋深夜の重複 14:00-翌2:00 休憩18-19時（実働11h）', () => {
    const o = computePayroll(hourlyInput({ sessions: [sess('2026-11-02', '14:00', '26:00', [['18:00', '19:00']])] }));
    // 実労働: 14-18(4h) + 19-26(7h) = 11h。8h到達は 19:00+4h = 23:00 → 時間外 23:00-26:00 = 3h
    // 深夜 22:00-26:00 = 4h（うち23-26の3hは時間外と重複）
    // 基本 1100×11=12100、時間外 1100×3×0.25=825、深夜 1100×4×0.25=1100
    expect(o.totals.workMinutes).toBe(660);
    expect(o.totals.overtimeMinutes).toBe(180);
    expect(o.totals.nightMinutes).toBe(240);
    expect(o.totals.basePay).toBe(12100);
    expect(o.totals.overtimePremium).toBe(825);
    expect(o.totals.nightPremium).toBe(1100);
    // 12100+825+1100=14025
    expect(o.totals.grossPay).toBe(14025);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース5: 法定休日（日曜11-08）10:00-20:00 休憩60分(9h) → 休日割増35%、時間外なし', () => {
    const o = computePayroll(hourlyInput({ sessions: [sess('2026-11-08', '10:00', '20:00', [['14:00', '15:00']])] }));
    // 基本 1100×9=9900、休日 1100×9×0.35=3465、休日労働は時間外に含めない → 時間外0
    expect(o.totals.workMinutes).toBe(540);
    expect(o.totals.holidayMinutes).toBe(540);
    expect(o.totals.overtimeMinutes).toBe(0);
    expect(o.totals.basePay).toBe(9900);
    expect(o.totals.holidayPremium).toBe(3465);
    expect(o.totals.overtimePremium).toBe(0);
    // 9900+3465=13365
    expect(o.totals.grossPay).toBe(13365);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース6: 法定休日前日（土11-07）22:00 → 日曜 3:00（5h）→ 日曜0時以降は休日＋深夜', () => {
    const o = computePayroll(hourlyInput({ sessions: [sess('2026-11-07', '22:00', '27:00')] }));
    // 土22-24: 2h 通常＋深夜 / 日0-3: 3h 休日＋深夜（§3-2 法定休日は暦日0-24時）
    // 基本 1100×5=5500、深夜 1100×5×0.25=1375、休日 1100×3×0.35=1155
    expect(o.totals.workMinutes).toBe(300);
    expect(o.totals.holidayMinutes).toBe(180);
    expect(o.totals.nightMinutes).toBe(300);
    expect(o.totals.basePay).toBe(5500);
    expect(o.totals.nightPremium).toBe(1375);
    expect(o.totals.holidayPremium).toBe(1155);
    expect(o.totals.overtimePremium).toBe(0);
    // 5500+1375+1155=8030
    expect(o.totals.grossPay).toBe(8030);
  });

  it('ケース6b: 法定休日（日11-08）20:00 → 月曜 2:00（6h）→ 月曜部分は休日労働ではない', () => {
    const o = computePayroll(hourlyInput({ sessions: [sess('2026-11-08', '20:00', '26:00')] }));
    // 日20-24: 4h 休日（うち22-24 深夜2h）/ 月0-2: 2h 通常＋深夜（§3-2 法定休日から翌日に越えた部分は休日労働ではない）
    // 基本 1100×6=6600、休日 1100×4×0.35=1540、深夜 1100×4×0.25=1100
    expect(o.totals.holidayMinutes).toBe(240);
    expect(o.totals.nightMinutes).toBe(240);
    expect(o.totals.basePay).toBe(6600);
    expect(o.totals.holidayPremium).toBe(1540);
    expect(o.totals.nightPremium).toBe(1100);
    expect(o.totals.overtimePremium).toBe(0);
    // 6600+1540+1100=9240
    expect(o.totals.grossPay).toBe(9240);
  });
});

describe('時給制: 週40時間・月60時間', () => {
  it('ケース7: 月〜土 各7h（計42h）→ 土曜の最後の2hが週の時間外（起算日=日曜）', () => {
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
    const o = computePayroll(hourlyInput({ sessions: days.map((d) => sess(d, '09:00', '17:00', [['12:00', '13:00']])) }));
    // 月〜金 35h、土 9-12 で38h、13:00-15:00 で40h到達 → 土 15:00-17:00 の 2h が週時間外
    // 基本 1100×42=46200、時間外 1100×2×0.25=550
    expect(o.totals.workDays).toBe(6);
    expect(o.totals.workMinutes).toBe(2520);
    expect(o.totals.overtimeMinutes).toBe(120);
    expect(o.totals.basePay).toBe(46200);
    expect(o.totals.overtimePremium).toBe(550);
    // 46200+550=46750
    expect(o.totals.grossPay).toBe(46750);
  });

  it('ケース8: 月〜金 各9h ＋ 土 4h → 日次5h＋週次4h（二重計上なし）', () => {
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
    const sessions = [...days.map(day9), sess('2026-11-07', '09:00', '13:00')];
    const o = computePayroll(hourlyInput({ sessions }));
    // 日次超過 1h×5=5h、週の法定内 8h×5=40h で到達済 → 土4h は全て週時間外。計9h
    // 基本 1100×(45+4)=53900、時間外 1100×9×0.25=2475
    expect(o.totals.workMinutes).toBe(2940);
    expect(o.totals.overtimeMinutes).toBe(540);
    expect(o.totals.basePay).toBe(53900);
    expect(o.totals.overtimePremium).toBe(2475);
    // 53900+2475=56375
    expect(o.totals.grossPay).toBe(56375);
  });

  it('期間をまたぐ週: 期間 11-05〜 で、期間前の月〜水(24h)を週判定に含め、土曜8hが週時間外', () => {
    const period: PayrollPeriodInput = { id: 'p2', periodKey: '2026-11b', from: '2026-11-05', to: '2026-12-04', payDate: '2026-12-10' };
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
    const o = computePayroll(hourlyInput({ period, deduction: deduction({}, 'p2'), sessions: days.map(day8) }));
    // 週(11-01〜11-07) 累計: 月〜水 24h（期間外）、木 32h、金 40h、土 8h は全て週時間外
    // 当期計上は木・金・土の 24h: 基本 1100×24=26400、時間外 1100×8×0.25=2200
    expect(o.totals.workDays).toBe(3);
    expect(o.totals.workMinutes).toBe(1440);
    expect(o.totals.overtimeMinutes).toBe(480);
    expect(o.totals.basePay).toBe(26400);
    expect(o.totals.overtimePremium).toBe(2200);
    // 26400+2200=28600
    expect(o.totals.grossPay).toBe(28600);
  });

  it('ケース9: 月60時間超（時間外61h）→ 60h超の1hのみ50%', () => {
    // 11-02〜06, 09〜13, 16〜20 の平日15日 × 12h（日次時間外 4h/日 → 60h、週の法定内は各週40hちょうど）
    // さらに 11-23(月) 9h（時間外1h, 18:00-19:00）→ 時間外累計 61h、60h超は最後の1h
    const d15 = [
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
      '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13',
      '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20',
    ];
    const o = computePayroll(hourlyInput({ sessions: [...d15.map(day12), day9('2026-11-23')] }));
    // 総労働 15×12+9=189h → 基本 1100×189=207900
    // 時間外 25% 部分 60h: 1100×60×0.25=16500 / 60h超 1h: 1100×1×0.5=550（25%ではなく50%）
    expect(o.totals.workMinutes).toBe(189 * 60);
    expect(o.totals.over60Minutes).toBe(60);
    expect(o.totals.basePay).toBe(207900);
    expect(o.totals.overtimePremium).toBe(16500);
    expect(o.totals.over60Premium).toBe(550);
    // 207900+16500+550=224950
    expect(o.totals.grossPay).toBe(224950);
  });
});

// ================================================================== 時給ルール
describe('時給ルール', () => {
  it('ケース10: 2026-11-16 から時給1200円 → 前後の勤務で時給が切り替わる', () => {
    const wageRules = [
      wage({ id: 'w-old', hourlyRate: 1100, effectiveFrom: '2026-01-01', effectiveTo: '2026-11-15' }),
      wage({ id: 'w-new', hourlyRate: 1200, effectiveFrom: '2026-11-16', effectiveTo: null }),
    ];
    const o = computePayroll(hourlyInput({ wageRules, sessions: [day8('2026-11-13'), day8('2026-11-16')] }));
    // 11-13(金): 1100×8=8800、11-16(月): 1200×8=9600 → 18400
    expect(o.totals.basePay).toBe(18400);
    expect(o.totals.grossPay).toBe(18400);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース11: 時間帯別 22:00-29:00 時給1300(優先30) / 基本1100 → 20:00-24:00 勤務', () => {
    const wageRules = [wage({ hourlyRate: 1100, priority: 0 }), wage({ kind: 'timeband', hourlyRate: 1300, timeFrom: '22:00', timeTo: '29:00', priority: 30 })];
    const o = computePayroll(hourlyInput({ wageRules, sessions: [sess('2026-11-02', '20:00', '24:00')] }));
    // 20-22: 1100×2=2200、22-24: 1300×2=2600 → 基本 4800
    // 深夜割増（深夜込みフラグなし）: 1300×2×0.25=650
    expect(o.totals.basePay).toBe(4800);
    expect(o.totals.nightMinutes).toBe(120);
    expect(o.totals.nightPremium).toBe(650);
    // 4800+650=5450
    expect(o.totals.grossPay).toBe(5450);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース12: 金曜のみ1200(優先10) → 金曜20:00-翌2:00 は営業日=金曜なので全て1200', () => {
    const wageRules = [wage({ hourlyRate: 1100 }), wage({ kind: 'weekday', weekdays: [5], hourlyRate: 1200, priority: 10 })];
    const o = computePayroll(hourlyInput({ wageRules, sessions: [sess('2026-11-06', '20:00', '26:00')] }));
    // 土 0:00-2:00 も営業日(切替05:00)は金曜 → 1200×6=7200
    // 深夜 22-26 4h: 1200×4×0.25=1200
    expect(o.totals.basePay).toBe(7200);
    expect(o.totals.nightPremium).toBe(1200);
    // 7200+1200=8400
    expect(o.totals.grossPay).toBe(8400);
  });

  it('ケース12b: 木曜20:00-翌2:00 は金曜の暦日0-2時も営業日=木曜なので全て1100', () => {
    const wageRules = [wage({ hourlyRate: 1100 }), wage({ kind: 'weekday', weekdays: [5], hourlyRate: 1200, priority: 10 })];
    const o = computePayroll(hourlyInput({ wageRules, sessions: [sess('2026-11-05', '20:00', '26:00')] }));
    // 1100×6=6600、深夜 1100×4×0.25=1100
    expect(o.totals.basePay).toBe(6600);
    expect(o.totals.nightPremium).toBe(1100);
    expect(o.totals.grossPay).toBe(7700);
  });

  it('ケース13: 同一優先度で時給の異なる weekday ルールが重複 → WAGE_RULE_CONFLICT（blocking）', () => {
    const wageRules = [
      wage({ hourlyRate: 1100 }),
      wage({ kind: 'weekday', weekdays: [1], hourlyRate: 1200, priority: 10 }),
      wage({ kind: 'weekday', weekdays: [1], hourlyRate: 1250, priority: 10 }),
    ];
    const o = computePayroll(hourlyInput({ wageRules, sessions: [day8('2026-11-02')] }));
    expect(codes(o)).toContain('WAGE_RULE_CONFLICT');
    expect(issue(o, 'WAGE_RULE_CONFLICT')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
  });

  it('ケース13b: ルール矛盾時の暫定計算は高い時給（1250×8=10000）', () => {
    const wageRules = [
      wage({ hourlyRate: 1100 }),
      wage({ kind: 'weekday', weekdays: [1], hourlyRate: 1200, priority: 10 }),
      wage({ kind: 'weekday', weekdays: [1], hourlyRate: 1250, priority: 10 }),
    ];
    const o = computePayroll(hourlyInput({ wageRules, sessions: [day8('2026-11-02')] }));
    // §4: 暫定計算は高い時給 → 1250×8=10000
    expect(o.totals.basePay).toBe(10000);
  });
});

// ================================================================== 未設定系
describe('未設定 → 確定禁止', () => {
  const work = [day8('2026-11-02')];

  it('交通費ルールなし → TRANSPORT_UNSET', () => {
    const o = computePayroll(hourlyInput({ sessions: work, transportRules: [] }));
    expect(codes(o)).toContain('TRANSPORT_UNSET');
    expect(issue(o, 'TRANSPORT_UNSET')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
  });

  it('控除 null → DEDUCTION_UNENTERED', () => {
    const o = computePayroll(hourlyInput({ sessions: work, deduction: null }));
    expect(codes(o)).toContain('DEDUCTION_UNENTERED');
    expect(issue(o, 'DEDUCTION_UNENTERED')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
  });

  it('控除 status=unentered → DEDUCTION_UNENTERED', () => {
    const o = computePayroll(hourlyInput({ sessions: work, deduction: deduction({ status: 'unentered' }) }));
    expect(codes(o)).toContain('DEDUCTION_UNENTERED');
    expect(o.canConfirm).toBe(false);
  });

  it('最低賃金未設定 → MIN_WAGE_UNSET', () => {
    const o = computePayroll(hourlyInput({ sessions: work, settings: settings({ minimumWages: [] }) }));
    expect(codes(o)).toContain('MIN_WAGE_UNSET');
    expect(issue(o, 'MIN_WAGE_UNSET')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
  });

  it('法定休日 null → STATUTORY_HOLIDAY_UNSET', () => {
    const o = computePayroll(hourlyInput({ sessions: work, settings: settings({ statutoryHolidayWeekday: null }) }));
    expect(codes(o)).toContain('STATUTORY_HOLIDAY_UNSET');
    expect(issue(o, 'STATUTORY_HOLIDAY_UNSET')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
  });

  it('workingTimeSystem=monthly_variable → WORKING_TIME_SYSTEM_UNSUPPORTED（計算は表示）', () => {
    const o = computePayroll(hourlyInput({ sessions: work, settings: settings({ workingTimeSystem: 'monthly_variable' }) }));
    expect(codes(o)).toContain('WORKING_TIME_SYSTEM_UNSUPPORTED');
    expect(issue(o, 'WORKING_TIME_SYSTEM_UNSUPPORTED')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
    // §1: 計算は表示する → 1100×8=8800
    expect(o.totals.basePay).toBe(8800);
  });

  it('36協定 未締結は info のみ（確定可能、割増は削減しない）', () => {
    const o = computePayroll(hourlyInput({ sessions: [day9('2026-11-02')], settings: settings({ agreement36: 'not_concluded' }) }));
    expect(blocking(o)).toEqual([]);
    expect(o.canConfirm).toBe(true);
    // 1100×9=9900、時間外 1100×1×0.25=275
    expect(o.totals.basePay).toBe(9900);
    expect(o.totals.overtimePremium).toBe(275);
  });
});

// ================================================================== 控除
describe('控除', () => {
  it('ケース15a: 控除なし明示（explicit_none）は確定可能', () => {
    const o = computePayroll(hourlyInput({ sessions: [day8('2026-11-02')], deduction: deduction({ status: 'explicit_none' }) }));
    expect(codes(o)).not.toContain('DEDUCTION_UNENTERED');
    expect(o.totals.deductionTotal).toBe(0);
    expect(o.totals.netPay).toBe(8800);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース15b: 控除入力 所得税1000＋住民税2000＋雇用保険50 → 控除計3050、差引5750', () => {
    const o = computePayroll(
      hourlyInput({
        sessions: [day8('2026-11-02')],
        deduction: deduction({ status: 'entered', incomeTax: 1000, residentTax: 2000, employmentInsurance: 50 }),
      }),
    );
    // 総支給 8800、控除 1000+2000+50=3050、差引 8800-3050=5750
    expect(o.totals.grossPay).toBe(8800);
    expect(o.totals.deductionTotal).toBe(3050);
    expect(o.totals.netPay).toBe(5750);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース15c: その他控除（法定）300円も控除計に含まれる', () => {
    const o = computePayroll(
      hourlyInput({
        sessions: [day8('2026-11-02')],
        deduction: deduction({ status: 'entered', incomeTax: 1000, employmentInsurance: 50, others: [{ name: 'その他', amount: 300, basis: 'statutory' }] }),
      }),
    );
    // 1000+50+300=1350、差引 8800-1350=7450
    expect(o.totals.deductionTotal).toBe(1350);
    expect(o.totals.netPay).toBe(7450);
  });
});

// ================================================================== 最低賃金
describe('最低賃金', () => {
  it('ケース16a: 時給950 < 最低賃金1000 → MIN_WAGE_VIOLATION', () => {
    const o = computePayroll(hourlyInput({ wageRules: [wage({ hourlyRate: 950 })], sessions: [day8('2026-11-02')] }));
    expect(codes(o)).toContain('MIN_WAGE_VIOLATION');
    // 950×8=7600
    expect(o.totals.basePay).toBe(7600);
  });

  it('ケース16b: 最低賃金違反は確定不可', () => {
    const o = computePayroll(hourlyInput({ wageRules: [wage({ hourlyRate: 950 })], sessions: [day8('2026-11-02')] }));
    expect(issue(o, 'MIN_WAGE_VIOLATION')?.severity).toBe('blocking');
    expect(o.canConfirm).toBe(false);
  });

  it('時給1000 = 最低賃金1000 は違反ではない（≥）', () => {
    const o = computePayroll(hourlyInput({ wageRules: [wage({ hourlyRate: 1000 })], sessions: [day8('2026-11-02')] }));
    expect(codes(o)).not.toContain('MIN_WAGE_VIOLATION');
    expect(o.canConfirm).toBe(true);
  });
});

// ================================================================== 月給制
describe('月給制', () => {
  it('ケース17: 月給240000/160h、平日1日 実働9h → 時間外1h: 100%部分1500 + 割増375', () => {
    const o = computePayroll(monthlyInput({ sessions: [day9('2026-11-02')] }));
    // 時間単価 240000÷160h=1500。所定8h超の1hは法定時間外 → 100%部分 1500、割増 1500×0.25=375
    expect(o.totals.basePay).toBe(240000);
    expect(o.totals.overtimeMinutes).toBe(60);
    expect(o.totals.extraHoursBasePay).toBe(1500);
    expect(o.totals.overtimePremium).toBe(375);
    // 240000+1500+375=241875
    expect(o.totals.grossPay).toBe(241875);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース18: 所定7h（420分）で実働8h → 1hは法定内残業（rate100 → 1500）、割増なし', () => {
    const o = computePayroll(monthlyInput({ salaryRules: [salary({ scheduledDailyMinutes: 420 })], sessions: [day8('2026-11-02')] }));
    // 法定内残業 1h × 1500 × 100% = 1500、法定時間外なし
    expect(o.totals.overtimeMinutes).toBe(0);
    expect(o.totals.extraHoursBasePay).toBe(1500);
    expect(o.totals.overtimePremium).toBe(0);
    // 240000+1500=241500
    expect(o.totals.grossPay).toBe(241500);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース18b: 法定内残業 rate125 → 1500×1.25=1875 が加算', () => {
    const o = computePayroll(
      monthlyInput({ salaryRules: [salary({ scheduledDailyMinutes: 420, inLegalOvertimeRate: 125 })], sessions: [day8('2026-11-02')] }),
    );
    // 240000 + 1500×1×1.25 = 241875
    expect(o.totals.grossPay).toBe(241875);
  });

  it('ケース18c: 法定内残業があり支払率未設定(null) → 確定禁止', () => {
    const o = computePayroll(
      monthlyInput({ salaryRules: [salary({ scheduledDailyMinutes: 420, inLegalOvertimeRate: null })], sessions: [day8('2026-11-02')] }),
    );
    expect(blocking(o).length).toBeGreaterThan(0);
    expect(o.canConfirm).toBe(false);
  });

  // 固定残業代: 単価 37500÷20h=1875 = 1500×1.25（ちょうど基準を満たす）
  const fixedOk = { enabled: true, amount: 37500, coveredMinutes: 1200 };
  const week1 = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];

  it('ケース19a: 固定残業代 37500/20h、時間外10h → 固定37500、超過0、時間外割増0', () => {
    // 月〜金 各10h → 日次時間外 2h×5=10h（週の法定内は 8h×5=40h ちょうど）
    const o = computePayroll(monthlyInput({ salaryRules: [salary({ fixedOvertime: fixedOk })], sessions: week1.map(day10) }));
    // 実際の時間外賃金 1500×1.25×10=18750 ≤ 37500 → 超過0
    expect(o.totals.overtimeMinutes).toBe(600);
    expect(o.totals.fixedOvertimePay).toBe(37500);
    expect(o.totals.fixedOvertimeExcess).toBe(0);
    expect(o.totals.overtimePremium).toBe(0);
    // 240000+37500=277500
    expect(o.totals.grossPay).toBe(277500);
    expect(codes(o)).not.toContain('FIXED_OT_RATE_INSUFFICIENT');
    expect(o.canConfirm).toBe(true);
  });

  it('ケース19b: 固定残業代 37500/20h、時間外25h → 超過分 46875-37500=9375', () => {
    // 11-02〜06 各12h（時間外4h×5=20h）、11-09 12h（4h）、11-10 9h（1h）→ 25h
    const sessions = [...week1.map(day12), day12('2026-11-09'), day9('2026-11-10')];
    const o = computePayroll(monthlyInput({ salaryRules: [salary({ fixedOvertime: fixedOk })], sessions }));
    // 実時間外賃金 1500×1.25×25=46875 → 超過 46875-37500=9375
    expect(o.totals.overtimeMinutes).toBe(1500);
    expect(o.totals.fixedOvertimePay).toBe(37500);
    expect(o.totals.fixedOvertimeExcess).toBe(9375);
    // 240000+37500+9375=286875
    expect(o.totals.grossPay).toBe(286875);
  });

  it('ケース19c: 固定残業代 30000/20h（単価1500 < 1875）、時間外25h → 超過16875 かつ FIXED_OT_RATE_INSUFFICIENT', () => {
    const sessions = [...week1.map(day12), day12('2026-11-09'), day9('2026-11-10')];
    const o = computePayroll(
      monthlyInput({ salaryRules: [salary({ fixedOvertime: { enabled: true, amount: 30000, coveredMinutes: 1200 } })], sessions }),
    );
    // 30000÷20h=1500 < 1500×1.25=1875 → 単価不足（§5.2）
    // 実時間外賃金 46875 − 30000 = 16875
    expect(codes(o)).toContain('FIXED_OT_RATE_INSUFFICIENT');
    expect(o.totals.fixedOvertimePay).toBe(30000);
    expect(o.totals.fixedOvertimeExcess).toBe(16875);
  });

  it('ケース20: 固定残業代 20000/20h（単価1000 < 1875）→ FIXED_OT_RATE_INSUFFICIENT', () => {
    const o = computePayroll(
      monthlyInput({ salaryRules: [salary({ fixedOvertime: { enabled: true, amount: 20000, coveredMinutes: 1200 } })], sessions: week1.map(day10) }),
    );
    expect(codes(o)).toContain('FIXED_OT_RATE_INSUFFICIENT');
    expect(o.canConfirm).toBe(false);
  });
});

// ================================================================== 端数処理
describe('端数処理', () => {
  // 9:00-17:17 休憩12:00-13:00 → 実働 7h17m = 437分
  const s717 = (d: LocalDate) => sess(d, '09:00', '17:17', [['12:00', '13:00']]);

  it('ケース21a: 時給1013 × 437分（half_up）→ 7378.016… → 7378', () => {
    const o = computePayroll(hourlyInput({ wageRules: [wage({ hourlyRate: 1013 })], sessions: [s717('2026-11-02')] }));
    // 1013×437/60 = 442681/60 = 7378.0166… → 50銭未満切捨て → 7378
    expect(o.totals.workMinutes).toBe(437);
    expect(o.totals.basePay).toBe(7378);
  });

  it('ケース21b: 同条件で yenRounding=ceil → 7379', () => {
    const o = computePayroll(
      hourlyInput({ settings: settings({ yenRounding: 'ceil' }), wageRules: [wage({ hourlyRate: 1013 })], sessions: [s717('2026-11-02')] }),
    );
    // 7378.0166… → 切上げ 7379
    expect(o.totals.basePay).toBe(7379);
  });

  it('ケース21c: 期間合計で1回だけ円未満処理（ceil, 2日分）→ 14757（日ごとなら14758）', () => {
    const o = computePayroll(
      hourlyInput({
        settings: settings({ yenRounding: 'ceil' }),
        wageRules: [wage({ hourlyRate: 1013 })],
        sessions: [s717('2026-11-02'), s717('2026-11-03')],
      }),
    );
    // 1013×874/60 = 885362/60 = 14756.0333… → 切上げ 14757（日ごとに切上げると 7379×2=14758）
    expect(o.totals.basePay).toBe(14757);
  });

  it('秒単位計算: 9:00:00-17:00:30 休憩60分 → 7h0m30s × 1200 = 8410（日々の切捨てなし）', () => {
    const s = sess('2026-11-02', '09:00', '17:00', [['12:00', '13:00']]);
    s.end = (s.end as number) + 30 * 1000;
    const o = computePayroll(hourlyInput({ wageRules: [wage({ hourlyRate: 1200 })], sessions: [s] }));
    // 1200 × 25230秒/3600 = 1200×7.00833… = 8410
    expect(o.totals.basePay).toBe(8410);
  });
});

// ================================================================== 手当
describe('手当と割増算定基礎', () => {
  it('月額手当16000（算入）: 時間単価 16000÷160h=100 → 時間外1hの割増 (1100+100)×0.25=300', () => {
    const o = computePayroll(
      hourlyInput({ allowances: [allowance({ name: '職務手当', amount: 16000, premiumBaseCategory: 'include' })], sessions: [day9('2026-11-02')] }),
    );
    // 基本 9900、手当 16000、時間外 1200×1×0.25=300
    expect(o.totals.allowances).toEqual([{ name: '職務手当', amount: 16000 }]);
    expect(o.totals.overtimePremium).toBe(300);
    // 9900+16000+300=26200
    expect(o.totals.grossPay).toBe(26200);
  });

  it('通勤手当（exclude_commute）は割増算定基礎から除外 → 時間外割増は1100×0.25=275', () => {
    const o = computePayroll(
      hourlyInput({
        allowances: [allowance({ name: '通勤手当', amount: 16000, premiumBaseCategory: 'exclude_commute' })],
        sessions: [day9('2026-11-02')],
      }),
    );
    expect(o.totals.overtimePremium).toBe(275);
    // 9900+16000+275=26175
    expect(o.totals.grossPay).toBe(26175);
  });
});

// ================================================================== 交通費
describe('交通費', () => {
  const three = ['2026-11-02', '2026-11-03', '2026-11-04'].map(day8);

  it('ケース22a: per_day 500 × 出勤3日 = 1500', () => {
    const o = computePayroll(hourlyInput({ transportRules: [transport({ method: 'per_day', amount: 500 })], sessions: three }));
    expect(o.totals.workDays).toBe(3);
    expect(o.totals.transport).toBe(1500);
    expect(o.canConfirm).toBe(true);
  });

  it('ケース22b: per_day 500 × 3日、monthlyCap 1200 → 1200', () => {
    const o = computePayroll(hourlyInput({ transportRules: [transport({ method: 'per_day', amount: 500, monthlyCap: 1200 })], sessions: three }));
    // min(1500, 1200) = 1200
    expect(o.totals.transport).toBe(1200);
  });

  it('monthly 10000 → 10000', () => {
    const o = computePayroll(hourlyInput({ transportRules: [transport({ method: 'monthly', amount: 10000 })], sessions: three }));
    expect(o.totals.transport).toBe(10000);
  });
});

// ================================================================== 有給
describe('有給休暇', () => {
  it('ケース23: 時給制 normal、1日（所定480分）→ 1100×8=8800', () => {
    const o = computePayroll(hourlyInput({ leaveTakes: [leaveTake('2026-11-10', 480)] }));
    expect(o.totals.paidLeaveDays).toBe(1);
    expect(o.totals.paidLeavePay).toBe(8800);
    expect(o.totals.grossPay).toBe(8800);
    expect(o.canConfirm).toBe(true);
  });

  it('有給賃金の算定方法 unset で取得あり → 確定禁止', () => {
    const o = computePayroll(hourlyInput({ settings: settings({ paidLeaveWageMethod: 'unset' }), leaveTakes: [leaveTake('2026-11-10', 480)] }));
    expect(blocking(o).length).toBeGreaterThan(0);
    expect(o.canConfirm).toBe(false);
  });

  it('月給制は有給の追加支給なし', () => {
    const o = computePayroll(monthlyInput({ leaveTakes: [leaveTake('2026-11-10', 480)] }));
    expect(o.totals.basePay).toBe(240000);
    expect(o.totals.paidLeavePay).toBe(0);
    expect(o.totals.grossPay).toBe(240000);
  });
});
