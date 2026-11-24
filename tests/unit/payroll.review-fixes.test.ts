/**
 * 独立レビュー指摘に対する回帰テスト（期待値は手計算）
 */
import { describe, expect, it } from 'vitest';
import { computePayroll, type PayrollInput } from '../../src/shared/payroll';
import { localDateTime } from '../../src/shared/time';
import type { StoreSettings, WageRule, WorkSession } from '../../src/shared/types';

const meta = { id: 'x', createdAt: '', updatedAt: '', version: 1 };
const settings = (o: Partial<StoreSettings> = {}): StoreSettings =>
  ({
    ...meta, storeName: 's', storeAddress: '', timezone: 'Asia/Tokyo', businessHours: [], businessDayCutoff: '05:00', workingTimeSystem: 'standard', weekStartDay: 0,
    statutoryHolidayWeekday: 0, weekly44Confirmed: false, agreement36: 'concluded', overtime60StartDay: null, payrollClosingDay: 0, payMonthOffset: 1, payDay: 10,
    yenRounding: 'half_up', minimumWages: [{ effectiveFrom: '2020-01-01', hourly: 1000, label: 't', sourceNote: 't' }], employerCostRatePercent: null, idleTimeoutSec: 60,
    pinMaxAttempts: 5, pinLockMinutes: 15, publicHolidays: [], paidLeaveWageMethod: 'normal', halfDayLeaveAllowed: false, payslipDelivery: 'paper', retentionYears: 5,
    dailyBackupGenerations: 30, monthlyBackupGenerations: 12, payrollRulesConfirmedAt: '2026-01-01T00:00:00+09:00', ...o,
  }) as StoreSettings;
const sess = (d: string, s: string, e: string): WorkSession => ({ employeeId: 'e1', start: localDateTime(d, s), end: localDateTime(d, e), breaks: [], laborDate: d, businessDate: d, eventIds: [], anomalies: [] });
const rule = (rate: number, from: string, to: string | null = null): WageRule => ({ ...meta, id: `w${rate}`, employeeId: 'e1', kind: 'base', hourlyRate: rate, effectiveFrom: from, effectiveTo: to, weekdays: [], timeFrom: null, timeTo: null, specialDates: [], priority: 0, includesNightPremium: false, premiumBaseRate: null, note: '' });
const input = (o: Partial<PayrollInput>): PayrollInput => ({
  employee: { ...meta, id: 'e1', employeeCode: '', displayName: 'A', kana: '', status: 'active', hireDate: '2020-01-01', retireDate: null, payType: 'hourly', sortOrder: 0, electronicPayslipConsent: false, note: '' },
  period: { id: 'p', periodKey: '2026-12', from: '2026-12-01', to: '2026-12-31', payDate: '2027-01-10' },
  settings: settings(),
  sessions: [],
  employment: [],
  wageRules: [rule(1000, '2020-01-01')],
  salaryRules: [],
  allowances: [],
  transportRules: [{ ...meta, employeeId: 'e1', effectiveFrom: '2020-01-01', effectiveTo: null, method: 'none', amount: 0, monthlyCap: null, actualAmounts: {}, note: '' }],
  deduction: { ...meta, employeeId: 'e1', periodId: 'p', status: 'explicit_none', incomeTax: 0, residentTax: 0, healthInsurance: 0, pension: 0, employmentInsurance: 0, nursingInsurance: 0, others: [], note: '' },
  adjustments: [],
  leaveTakes: [],
  shifts: [],
  pendingCorrectionCount: 0,
  averageDailyWage: null,
  leaveOverdrawnDays: 0,
  ...o,
});

describe('月60時間超: 期間前の時間外を当期に算入しない（指摘 #6）', () => {
  it('11/30（期間前・同じ週）の時間外4hは12月の60時間に数えない', () => {
    // 11/30(月) 8:00-20:00 = 12h（日次時間外 4h、週判定のための読み込み）
    // 12月の平日 17日 × 8:00-20:00 = 各日 時間外 4h → 68h。60h 超は 8h = 480 分
    // 週の法定内: 11/29週 = 11/30 8h + 12/1-4 8h×4 = 40h（週の時間外なし）。以降の週は 5日×8h=40h
    const days = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11', '2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2026-12-21', '2026-12-22', '2026-12-23'];
    const out = computePayroll(input({ sessions: [sess('2026-11-30', '08:00', '20:00'), ...days.map((d) => sess(d, '08:00', '20:00'))] }));
    expect(out.totals.overtimeMinutes).toBe(68 * 60);
    expect(out.totals.over60Minutes).toBe(480);
    // 60h×1000×0.25 = 15000、8h×1000×0.5 = 4000
    expect(out.totals.overtimePremium).toBe(15000);
    expect(out.totals.over60Premium).toBe(4000);
  });
});

describe('最低賃金: 暦日で判定（指摘 #7）', () => {
  it('改定日をまたぐ深夜勤務の午前0時以降が旧単価なら最低賃金違反', () => {
    // 最低賃金 10/03 から 1100円。時給ルールは営業日基準: 10/02 営業日の 0:00-2:00 は旧単価 1000円 → 違反
    const s = settings({ minimumWages: [{ effectiveFrom: '2020-01-01', hourly: 1000, label: 'a', sourceNote: 'a' }, { effectiveFrom: '2026-10-03', hourly: 1100, label: 'b', sourceNote: 'b' }] });
    const out = computePayroll(
      input({
        period: { id: 'p', periodKey: '2026-10', from: '2026-10-01', to: '2026-10-31', payDate: '2026-11-10' },
        settings: s,
        wageRules: [rule(1000, '2020-01-01', '2026-10-02'), rule(1100, '2026-10-03')],
        sessions: [{ ...sess('2026-10-02', '20:00', '26:00') }],
      }),
    );
    expect(out.issues.some((i) => i.code === 'MIN_WAGE_VIOLATION' && i.date === '2026-10-03')).toBe(true);
    expect(out.canConfirm).toBe(false);
  });
});

describe('有給の超過取得は確定不可（指摘 #8）', () => {
  it('leaveOverdrawnDays > 0 なら blocking', () => {
    const out = computePayroll(input({ leaveOverdrawnDays: 1 }));
    expect(out.issues.map((i) => i.code)).toContain('LEAVE_OVERDRAWN');
    expect(out.canConfirm).toBe(false);
  });
});
