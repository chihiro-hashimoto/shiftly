/**
 * v1.3.0 初回リリースの実環境検証（docs/live-verification.md「2.5 給与の手計算シナリオ」）と同じ入力・同じ期待値を、モックで確かめる。
 * 期待値は docs/payroll-specification.md に基づく手計算（実装の出力から作っていない）。実環境では管理画面で同じ入力をして、同じ金額になることを照合する。
 *
 * 店舗設定（架空）: 通常の労働時間制／法定休日 日曜／週の起算 日曜／締め 末日／営業日の切替 5:00／シフト基準
 * スタッフ A（時給 1,200 円、交通費 日額 400 円、控除 所得税 1,000 円）: 2026-10 の勤務（入力は管理者の「打刻を追加」）
 *   10/1（木）シフト 10:00〜15:00・打刻 10:00〜15:00 → 5:00（通常）
 *   10/2（金）シフト 10:00〜15:00・打刻 9:45〜15:20 → 早出 15 分は「実労働なし」、残業 20 分は「実労働」と確認 → 5:20
 *   10/3（土）シフト 10:00〜19:00（予定休憩 60 分 13:00〜）・打刻 10:00〜19:00・休憩 13:00〜14:00 を登録 → 8:00
 *   10/5（月）シフト 10:00〜19:00（予定休憩 60 分 13:00〜）・打刻 10:00〜19:00・休憩の登録なし（取得なし）→ 9:00（1 日 8 時間超の時間外 1:00）
 *   10/6（火）シフト 20:00〜26:00・打刻 20:00〜翌 2:00 → 6:00（深夜 22:00〜2:00 の 4:00。日付をまたぐ勤務は 10/6 の労働日）
 *   基本賃金 1,200 ×（5:00＋5:20＋8:00＋9:00＋6:00＝33:20）= 40,000 円
 *   時間外割増 1,200 × 1:00 × 25% = 300 円／深夜割増 1,200 × 4:00 × 25% = 1,200 円／交通費 400 × 5 日 = 2,000 円
 *   総支給額 43,500 円 − 控除 1,000 円 = 差引支給額 42,500 円
 * スタッフ B（月給 200,000 円、職務手当 月額 10,000 円（割増の算定基礎に算入）、交通費 月額 10,000 円、控除 健康保険 10,000 円・厚生年金 20,000 円）
 *   10/1（木）シフト 9:00〜18:00（予定休憩 60 分 12:00〜）・打刻 9:00〜18:00・休憩 12:00〜13:00 を登録 → 8:00（所定どおり。残業なし）
 *   総支給額 200,000 ＋ 10,000 ＋ 10,000 = 220,000 円 − 控除 30,000 円 = 差引支給額 190,000 円
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

const REASON = '検証の入力（架空）';

function scenario() {
  const h = new Harness();
  h.setupStore({ timeBasis: 'shift' });
  h.setNow('2026-11-27', '10:00');
  const a = h.addStaff('検証A', '482913', { rate: 1200 });
  h.ownerOk('payconf.upsertTransport', { employeeId: a, method: 'per_day', amount: 400, effectiveFrom: '2025-01-01', id: h.ownerOk<any>('payconf.get', { employeeId: a }).transportRules[0].id, version: h.ownerOk<any>('payconf.get', { employeeId: a }).transportRules[0].version });
  const b = h.addStaff('検証B', '582914', { payType: 'monthly' });
  h.ownerOk('payconf.upsertSalaryRule', { employeeId: b, effectiveFrom: '2025-01-01', monthlyScheduledMinutes: 160 * 60, scheduledWeekdays: [1, 2, 3, 4, 5], scheduledDailyMinutes: 480, confirmed: true, monthlySalary: 200000 });
  h.ownerOk('payconf.upsertAllowance', { employeeId: b, name: '職務手当', kind: 'fixed_monthly', amount: 10000, effectiveFrom: '2025-01-01', premiumBaseCategory: 'include', includeInMinimumWage: true });
  const tb = h.ownerOk<any>('payconf.get', { employeeId: b }).transportRules[0];
  h.ownerOk('payconf.upsertTransport', { employeeId: b, method: 'monthly', amount: 10000, effectiveFrom: '2025-01-01', id: tb.id, version: tb.version });

  const shift = (employeeId: string, date: string, start: string, end: string, extra: Record<string, unknown> = {}) => h.ownerOk('shifts.upsert', { employeeId, date, start, end, breakMinutes: 0, ...extra });
  const work = (employeeId: string, inAt: string, outAt: string) => {
    h.ownerOk('attendance.correct', { employeeId, action: 'add', type: 'clock_in', at: inAt, reason: REASON });
    h.ownerOk('attendance.correct', { employeeId, action: 'add', type: 'clock_out', at: outAt, reason: REASON });
  };
  shift(a, '2026-10-01', '10:00', '15:00');
  shift(a, '2026-10-02', '10:00', '15:00');
  shift(a, '2026-10-03', '10:00', '19:00', { breakMinutes: 60, fixedBreakStart: '13:00' });
  shift(a, '2026-10-05', '10:00', '19:00', { breakMinutes: 60, fixedBreakStart: '13:00' });
  shift(a, '2026-10-06', '20:00', '26:00');
  shift(b, '2026-10-01', '09:00', '18:00', { breakMinutes: 60, fixedBreakStart: '12:00' });
  h.ownerOk('shifts.publish', { from: '2026-10-01', to: '2026-10-31' });
  work(a, '2026-10-01T10:00', '2026-10-01T15:00');
  work(a, '2026-10-02T09:45', '2026-10-02T15:20');
  work(a, '2026-10-03T10:00', '2026-10-03T19:00');
  work(a, '2026-10-05T10:00', '2026-10-05T19:00');
  work(a, '2026-10-06T20:00', '2026-10-07T02:00');
  work(b, '2026-10-01T09:00', '2026-10-01T18:00');
  return { h, a, b };
}

describe('v1.3.0 実環境検証の給与シナリオ（手計算の期待値。docs/live-verification.md 2.5）', () => {
  it('シフト外の未確認の時間がある間は確定できない。確認・休憩の申告の後、手計算どおりの金額で確定できる', () => {
    const { h, a, b } = scenario();
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-10' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'entered', incomeTax: 1000, residentTax: 0, healthInsurance: 0, pension: 0, employmentInsurance: 0, nursingInsurance: 0 });
    h.ownerOk('deductions.upsert', { employeeId: b, periodId: p.id, status: 'entered', incomeTax: 0, residentTax: 0, healthInsurance: 10000, pension: 20000, employmentInsurance: 0, nursingInsurance: 0 });
    // 10/2 の早出・残業は未確認 → 確定できない
    const c0 = h.ownerOk<any>('payroll.compute', { periodId: p.id });
    const ea0 = c0.employees.find((e: any) => e.employeeId === a);
    expect(ea0.issues.some((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED')).toBe(true);
    // 管理者の確認: 早出 15 分は実労働なし、残業 20 分は実労働
    h.ownerOk('offshift.confirm', {
      comment: '検証の確認（架空）',
      items: [
        { employeeId: a, start: '2026-10-02T09:45', end: '2026-10-02T10:00', result: 'no_work', category: 'early' },
        { employeeId: a, start: '2026-10-02T15:00', end: '2026-10-02T15:20', result: 'work', category: 'late' },
      ],
    });
    // 休憩（管理画面「勤怠」→「明細・修正」→「休憩を追加」）: 10/3 は 13:00〜14:00 を取得。10/5 は取得なし（何も登録しない＝控除しない）。B の 10/1 は 12:00〜13:00
    h.ownerOk('attendance.addBreak', { employeeId: a, start: '2026-10-03T13:00', end: '2026-10-03T14:00', reason: REASON });
    h.ownerOk('attendance.addBreak', { employeeId: b, start: '2026-10-01T12:00', end: '2026-10-01T13:00', reason: REASON });
    const c = h.ownerOk<any>('payroll.compute', { periodId: p.id });
    const ea = c.employees.find((e: any) => e.employeeId === a);
    const eb = c.employees.find((e: any) => e.employeeId === b);
    expect(ea.issues.filter((i: any) => i.severity === 'blocking')).toEqual([]);
    expect(eb.issues.filter((i: any) => i.severity === 'blocking')).toEqual([]);
    // 項目ごとの照合（手計算の値）
    expect(ea.totals).toMatchObject({ workDays: 5, workMinutes: 2000, overtimeMinutes: 60, nightMinutes: 240, holidayMinutes: 0, basePay: 40000, overtimePremium: 300, nightPremium: 1200, transport: 2000, grossPay: 43500, deductionTotal: 1000, netPay: 42500 });
    expect(eb.totals).toMatchObject({ workMinutes: 480, overtimeMinutes: 0, basePay: 200000, extraHoursBasePay: 0, allowances: [{ name: '職務手当', amount: 10000 }], transport: 10000, grossPay: 220000, deductionTotal: 30000, netPay: 190000 });
    const acks = [...ea.issues, ...eb.issues].filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    const r = h.ownerOk<any>('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    const ra = r.confirmed.find((x: any) => x.employeeId === a);
    const rb = r.confirmed.find((x: any) => x.employeeId === b);
    expect(ra.netPay).toBe(42500);
    expect(rb.netPay).toBe(190000);
  });
});
