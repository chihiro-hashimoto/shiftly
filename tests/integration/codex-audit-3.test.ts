/**
 * Codex 独立監査 3 回目（docs/reviews/codex-audit-3.md。C-2 の修正後の再監査）の指摘に対する回帰テスト
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { UnitOfWork } from '../../src/backend/store';

function store() {
  const h = new Harness();
  h.setupStore({ timeBasis: 'shift' });
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  return { h, a };
}
function shift(h: Harness, a: string, date: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  const s = h.ownerOk('shifts.upsert', { employeeId: a, date, start, end, breakMinutes: 0, ...extra });
  h.ownerOk('shifts.publish', { from: date, to: date });
  return s.id as string;
}
function compute(h: Harness, a: string) {
  const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
  return h.ownerOk('payroll.compute', { periodId: p.id }).employees.find((e: any) => e.employeeId === a);
}
const codes = (r: any) => r.issues.map((i: any) => i.code);
const at = (h: Harness, a: string, t: string, sec: number, type: string) => {
  h.setNow('2026-11-03', t);
  h.advance(sec * 1000);
  h.login(a, '482913');
  const r = h.punch(type);
  if (!r.ok) throw new Error(r.error.message);
};

describe('Codex 監査3 #2: 同じ分にある別のシフト外の候補区間を確認済みにしない', () => {
  it('17:00:00–17:00:10 を実労働なし（秒まで指定）→ 休憩後の 17:00:20–17:00:40 は未確認のまま。実労働と確認すると 9,607 円', () => {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00');
    at(h, a, '09:00', 0, 'clock_in');
    at(h, a, '17:00', 10, 'break_start');
    at(h, a, '17:00', 20, 'break_end');
    at(h, a, '17:00', 40, 'clock_out');
    h.setNow('2026-11-04', '10:00');
    h.ownerOk('offshift.confirm', { comment: '着替え', items: [{ employeeId: a, start: '2026-11-03T17:00:00', end: '2026-11-03T17:00:10', result: 'no_work', category: 'late' }] });
    let r = compute(h, a);
    expect(r.issues.find((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
    expect(r.totals.basePay).toBe(9600);
    h.ownerOk('offshift.confirm', { comment: 'レジ締め', items: [{ employeeId: a, start: '2026-11-03T17:00:20', end: '2026-11-03T17:00:40', result: 'work', category: 'late' }] });
    r = compute(h, a);
    expect(codes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
    // 8時間＋20秒 × 1,200円 = 9,606.67 → 9,607円
    expect(r.totals.basePay).toBe(9607);
  });
});

describe('Codex 監査3 #3: 一部承認の再審査で、以前の「残りは実労働なし」を失効させる', () => {
  it('残りを実労働なし → 再審査で未確認に変更 → 確定不可（仮 485 分・9,700 円）', () => {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:10', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    h.login(a, '482913');
    const req = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T17:00', end: '2026-11-03T17:10', reason: '閉店作業' });
    h.ownerOk('overtime.review', { requestId: req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '残りは私的滞在', remainder: 'no_work' });
    expect(codes(compute(h, a))).not.toContain('OFF_SHIFT_UNCONFIRMED');
    h.ownerOk('overtime.review', { requestId: req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '残りは再確認', remainder: 'unconfirmed' });
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(485);
    expect(r.totals.basePay).toBe(9700);
    expect(r.issues.find((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
    // 失効した確認は履歴に残る
    const all = h.ownerOk('overtime.list', { status: 'cancelled' });
    expect(all.some((x: any) => x.parentRequestId === req.id)).toBe(true);
  });
});

describe('Codex 監査3 #4: 時刻未設定で「予定どおり」と申告した休憩に、後から設定した区間を控除しない', () => {
  it('予定休憩 30 分（時刻なし）で申告 → 後でシフトを 12:00–13:00 に変更 → 480 分・9,600 円のまま（時刻未設定の確認項目）', () => {
    const { h, a } = store();
    const id = shift(h, a, '2026-11-03', '09:00', '17:00', { breakMinutes: 30 });
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:00', 'clock_out', { breakDeclaration: { kind: 'as_scheduled', expectedPlanned: { start: null, end: null, minutes: 30 } } });
    h.setNow('2026-11-04', '10:00');
    expect(compute(h, a).totals.workMinutes).toBe(480);
    h.ownerOk('shifts.upsert', { id, employeeId: a, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 60, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(480);
    expect(r.totals.basePay).toBe(9600);
    expect(codes(r)).toContain('PLANNED_BREAK_TIME_UNSET');
  });
});

describe('Codex 監査3 #6: 退職済みのスタッフの勤務もシフト外の確認一覧に表示する', () => {
  it('シフト 09:00–17:00・17:10 まで勤務した後に退職 → 一覧に表示され、実労働と確認すると 9,800 円', () => {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:10', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    const e = h.ownerOk('employees.list', {}).find((x: any) => x.id === a);
    h.ownerOk('employees.retire', { employeeId: a, retireDate: '2026-11-04', version: e.version });
    const list = h.ownerOk('offshift.list', { from: '2026-11-01', to: '2026-11-04', unresolvedOnly: true });
    expect(list.rows.map((r: any) => r.employeeId)).toContain(a);
    h.ownerOk('offshift.confirm', { comment: '閉店作業', items: [{ employeeId: a, start: '2026-11-03T17:00', end: '2026-11-03T17:10', result: 'work', category: 'late' }] });
    expect(compute(h, a).totals.basePay).toBe(9800);
  });
});

describe('Codex 監査4: 退勤確認の表示後に予定休憩が変わった場合は、確認し直すまで記録しない', () => {
  it('表示 30 分（12:00–12:30）→ 管理者が 60 分に変更 → 30 分の表示のまま「予定どおり」は拒否（退勤も記録しない）→ 60 分を確認して退勤', () => {
    const { h, a } = store();
    const id = shift(h, a, '2026-11-03', '09:00', '17:00', { breakMinutes: 30, fixedBreakStart: '12:00' });
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.setNow('2026-11-03', '17:00');
    h.login(a, '482913');
    const ctxShown = h.staffOk('attendance.clockOutContext');
    expect(ctxShown.plannedBreak.minutes).toBe(30);
    h.ownerOk('shifts.upsert', { id, employeeId: a, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 60, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    const r = h.punch('clock_out', { breakDeclaration: { kind: 'as_scheduled', expectedPlanned: { start: '2026-11-03T12:00', end: '2026-11-03T12:30', minutes: 30 } } }) as any;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('PLANNED_BREAK_CHANGED');
    expect(h.staffOk('auth.me').state).toBe('working'); // 退勤は記録されていない
    h.advance(2000);
    expect(h.punch('clock_out', { breakDeclaration: { kind: 'as_scheduled', expectedPlanned: { start: '2026-11-03T12:00', end: '2026-11-03T13:00', minutes: 60 } } }).ok).toBe(true);
    h.setNow('2026-11-04', '10:00');
    expect(compute(h, a).totals.workMinutes).toBe(420);
  });
  it('「予定どおり」の申告に、表示した予定休憩がない（古い画面からの送信）は拒否', () => {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00', { breakMinutes: 30, fixedBreakStart: '12:00' });
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.setNow('2026-11-03', '17:00');
    h.login(a, '482913');
    const r = h.punch('clock_out', { breakDeclaration: { kind: 'as_scheduled' } }) as any;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('INVALID_INPUT');
  });
});

describe('Codex 監査4: 旧形式（元の申請へのひも付けの列がない）の「残りは実労働なし」も再審査で失効させる', () => {
  it('理由欄の申請 ID でひも付く旧形式の確認行は、元の申請の再審査で取消になる', () => {
    const { h, a } = store();
    shift(h, a, '2026-11-03', '09:00', '17:00');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:10', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    h.login(a, '482913');
    const req = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T17:00', end: '2026-11-03T17:10', reason: '閉店作業' });
    h.ownerOk('overtime.review', { requestId: req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '一部', remainder: 'unconfirmed' });
    // 旧形式の残りの確認行（parentRequestId なし・理由欄に申請 ID）を直接作る
    const uow = new UnitOfWork(h.env.adapter, { now: () => h.env.clock.now, newId: (p) => `${p}_legacy0001` });
    uow.insert('overtime_requests', {
      employeeId: a, sessionKey: null, workDate: '2026-11-03', shiftId: null, category: 'late', requestedStart: '2026-11-03T17:05:00+09:00', requestedEnd: '2026-11-03T17:10:00+09:00',
      reason: `一部承認の残り（申請 ${req.id}）: 私的滞在`, identityVerified: true, requestedBy: 'owner', requestedByKind: 'owner', status: 'confirmed', workConfirmation: 'no_work',
      approvedStart: null, approvedEnd: null, reviewedBy: 'owner', reviewedAt: '2026-11-04T10:00:00+09:00', reviewComment: '私的滞在',
    } as never, 'otr');
    uow.flush();
    expect(codes(compute(h, a))).not.toContain('OFF_SHIFT_UNCONFIRMED');
    h.ownerOk('overtime.review', { requestId: req.id, action: 'partial', approvedStart: '2026-11-03T17:00', approvedEnd: '2026-11-03T17:05', comment: '残りは再確認', remainder: 'unconfirmed' });
    expect(compute(h, a).issues.find((i: any) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
  });
});

describe('Codex 監査5: 同じ日に複数のシフトがある場合、退勤確認の予定休憩と保存時の予定休憩が一致する', () => {
  it('09:00–12:00（休憩 10:00–10:15）と 15:00–18:00（休憩 16:00–16:30）。15:00 出勤 → 18:00 の退勤確認は午後の 30 分 → 予定どおりで退勤（150 分）', () => {
    const { h, a } = store();
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-03', start: '09:00', end: '12:00', breakMinutes: 15, fixedBreakStart: '10:00' });
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-03', start: '15:00', end: '18:00', breakMinutes: 30, fixedBreakStart: '16:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    h.punchAt(a, '482913', '2026-11-03', '15:00', 'clock_in');
    h.setNow('2026-11-03', '18:00');
    h.login(a, '482913');
    const c = h.staffOk('attendance.clockOutContext');
    expect(c.plannedBreak).toMatchObject({ minutes: 30 });
    expect(c.plannedBreak.start.slice(11, 16)).toBe('16:00');
    const r = h.punch('clock_out', { breakDeclaration: { kind: 'as_scheduled', expectedPlanned: { start: c.plannedBreak.start.slice(0, 16), end: c.plannedBreak.end.slice(0, 16), minutes: 30 } } });
    expect(r.ok).toBe(true);
    h.setNow('2026-11-04', '10:00');
    expect(compute(h, a).totals.workMinutes).toBe(150);
  });
});
