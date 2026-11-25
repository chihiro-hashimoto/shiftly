/**
 * Codex 独立監査 2 回目（docs/reviews/codex-audit-2.md）の指摘に対する回帰テスト
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

function store(opts: { closingDay?: number } = {}) {
  const h = new Harness();
  h.setupStore({ timeBasis: 'shift' });
  if (opts.closingDay !== undefined) {
    h.ownerOk('settings.update', { payrollClosingDay: opts.closingDay, payMonthOffset: 1, payDay: 10 });
    h.ownerOk('settings.confirmPayrollRules');
  }
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  return { h, a };
}
function shift(h: Harness, a: string, date: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  h.ownerOk('shifts.upsert', { employeeId: a, date, start, end, breakMinutes: 0, ...extra });
  h.ownerOk('shifts.publish', { from: date, to: date });
}
function compute(h: Harness, a: string, periodKey = '2026-11') {
  const p = h.ownerOk('payroll.openPeriod', { periodKey });
  return h.ownerOk('payroll.compute', { periodId: p.id }).employees.find((e: any) => e.employeeId === a);
}
const codes = (r: any) => r.issues.map((i: any) => i.code);

describe('Codex 監査2 #4: 1 分未満の未確認のシフト外時間も確定を止める', () => {
  it('シフト 09:00–17:00、打刻 09:00:00–17:00:20 → 未確認（20秒）で確定不可。実労働と確認すると 8時間20秒 = 9,607円（9,606.67 円を円未満四捨五入）', () => {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.setNow('2026-11-03', '17:00');
    h.advance(20_000);
    h.login(a, '482913');
    expect(code(h.punch('clock_out'))).toBe('OK');
    h.setNow('2026-11-04', '10:00');
    let r = compute(h, a);
    expect(r.issues.find((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
    expect(r.totals.basePay).toBe(9600);
    // 分単位の確認（17:00〜17:01）でも、実際のシフト外の 20 秒だけが加わる
    h.ownerOk('offshift.confirm', { comment: '閉店作業', items: [{ employeeId: a, start: '2026-11-03T17:00', end: '2026-11-03T17:01', result: 'work', category: 'late' }] });
    r = compute(h, a);
    expect(codes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
    expect(r.totals.basePay).toBe(9607);
  });
});

describe('Codex 監査2 #5: 前の給与期間の未確認時間が当期の時間外判定に影響する場合は確定を止める', () => {
  it('20日締め・週は日曜始まり: 11/16〜19 各8h、11/20 シフト外1h未確認、11/21 2h → 当期は確定不可。1h を実労働と確認すると当期の時間外 120 分（2h×1,200×1.25 = 3,000円）', () => {
    const { h, a } = store({ closingDay: 20 });
    for (const d of ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']) {
      shift(h, a, d, '09:00', '17:00');
      h.punchAt(a, '482913', d, '09:00', 'clock_in');
      h.punchAt(a, '482913', d, '17:00', 'clock_out');
    }
    shift(h, a, '2026-11-20', '09:00', '16:00');
    h.punchAt(a, '482913', '2026-11-20', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-20', '17:00', 'clock_out');
    shift(h, a, '2026-11-21', '09:00', '11:00');
    h.punchAt(a, '482913', '2026-11-21', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-21', '11:00', 'clock_out');
    h.setNow('2026-11-22', '10:00');
    let r = compute(h, a, '2026-12');
    expect(r.issues.find((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED_PRIOR')).toMatchObject({ severity: 'blocking', date: '2026-11-20' });
    h.ownerOk('offshift.confirm', { comment: '棚卸し', items: [{ employeeId: a, start: '2026-11-20T16:00', end: '2026-11-20T17:00', result: 'work', category: 'late' }] });
    r = compute(h, a, '2026-12');
    expect(codes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED_PRIOR');
    expect(r.totals.overtimeMinutes).toBe(120);
    expect(r.totals.basePay + r.totals.overtimePremium).toBe(3000);
  });
});

describe('Codex 監査2 #6: 一部承認の残りは明示的に確認するまで未確認', () => {
  function scenario() {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:10', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    h.login(a, '482913');
    const req = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T17:00', end: '2026-11-03T17:10', reason: '閉店作業' });
    return { h, a, req };
  }
  it('残りの扱いの指定は必須', () => {
    const { h, req } = scenario();
    expect(code(h.owner('overtime.review', { requestId: req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '一部' }))).toBe('INVALID_INPUT');
  });
  it('17:00–17:05 を一部承認・残りは未確認 → 確定不可（仮 485 分）', () => {
    const { h, a, req } = scenario();
    h.ownerOk('overtime.review', { requestId: req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '残りは確認中', remainder: 'unconfirmed' });
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(485);
    expect(r.issues.find((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
  });
  it('残りを実労働なしと確認 → 485 分・9,700 円で確定可能／全部承認なら 490 分・9,800 円', () => {
    const a1 = scenario();
    a1.h.ownerOk('overtime.review', { requestId: a1.req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '残りは私的滞在（本人確認）', remainder: 'no_work' });
    const r1 = compute(a1.h, a1.a);
    expect(r1.totals.basePay).toBe(9700);
    expect(codes(r1)).not.toContain('OFF_SHIFT_UNCONFIRMED');
    const a2 = scenario();
    a2.h.ownerOk('overtime.review', { requestId: a2.req.id, action: 'approve' });
    expect(compute(a2.h, a2.a).totals.basePay).toBe(9800);
  });
});

describe('Codex 監査2 #7: 休憩の取得確認後にシフトの予定休憩を編集しても控除は増えない', () => {
  it('予定休憩 12:00–12:30 を「予定どおり」と申告後、シフトの休憩を 60 分に編集 → 450 分・9,000 円（確認した 30 分で計算）', () => {
    const { h, a } = store();
    const s = h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 30, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:00', 'clock_out', { breakDeclaration: { kind: 'as_scheduled' } });
    h.setNow('2026-11-04', '10:00');
    h.ownerOk('shifts.upsert', { id: s.id, employeeId: a, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 60, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(450);
    expect(r.totals.basePay).toBe(9000);
    expect(codes(r)).toContain('PLANNED_BREAK_CHANGED');
  });
});

describe('Codex 監査2 #8: PIN 未設定のスタッフの事後の「予定どおり」申告は承認待ち', () => {
  it('過去の勤務（予定休憩 12:00–12:30、実際は休憩なし）に事後申告 → 承認待ちで 480 分・9,600 円を維持', () => {
    const h = new Harness();
    h.setupStore({ timeBasis: 'shift' });
    const e = h.ownerOk('employees.create', { displayName: '佐藤', kana: 'さとう', payType: 'hourly', hireDate: '2025-01-01' });
    h.ownerOk('payconf.upsertWageRule', { employeeId: e.id, kind: 'base', hourlyRate: 1200, effectiveFrom: '2025-01-01', priority: 0 });
    h.ownerOk('payconf.upsertTransport', { employeeId: e.id, method: 'none', effectiveFrom: '2025-01-01' });
    h.ownerOk('shifts.upsert', { employeeId: e.id, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 30, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    const login = () => (h.session = h.staffOk('auth.login', { employeeId: e.id, pin: null }, { session: '' }).sessionToken);
    h.setNow('2026-11-03', '09:00');
    login();
    h.punch('clock_in');
    h.setNow('2026-11-03', '17:00');
    login();
    h.punch('clock_out');
    h.setNow('2026-11-04', '10:00');
    login();
    expect(h.staffOk('breaks.declare', { workDate: '2026-11-03', kind: 'as_scheduled' })).toEqual({ status: 'pending' });
    const r = compute(h, e.id);
    expect(r.totals.workMinutes).toBe(480);
    expect(r.totals.basePay).toBe(9600);
    expect(codes(r)).toContain('BREAK_DECLARATION_PENDING');
  });
  it('退勤と同時の「予定どおり」（本人未確認）は反映し、確認項目にする', () => {
    const h = new Harness();
    h.setupStore({ timeBasis: 'shift' });
    const e = h.ownerOk('employees.create', { displayName: '佐藤', kana: 'さとう', payType: 'hourly', hireDate: '2025-01-01' });
    h.ownerOk('shifts.upsert', { employeeId: e.id, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 30, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    const login = () => (h.session = h.staffOk('auth.login', { employeeId: e.id, pin: null }, { session: '' }).sessionToken);
    h.setNow('2026-11-03', '09:00');
    login();
    h.punch('clock_in');
    h.setNow('2026-11-03', '17:00');
    login();
    expect(h.staffOk('attendance.punch', { type: 'clock_out', breakDeclaration: { kind: 'as_scheduled' } }).breakDeclaration).toBe('applied');
  });
});

describe('Codex 監査2 #10: 人件費の実績は確認待ちのシフト外の勤務も含めて概算する', () => {
  it('シフト未登録で 10:00–14:00 勤務（時給 1,200 円・確認前）→ 実績 4,800 円', () => {
    const { h, a } = store();
    h.punchAt(a, '482913', '2026-11-03', '10:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '14:00', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    const r = h.ownerOk('analytics.laborCost', { month: '2026-11' });
    expect(r.actual.total).toBe(4800);
  });
});
