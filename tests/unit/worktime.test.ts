/** シフト基準の時間区分（v1.3）と休憩の申告の単体テスト。期待値は手計算 */
import { describe, expect, it } from 'vitest';
import { buildSessions, effectiveEvents } from '../../src/shared/attendance';
import { applyTimeBasis, intersect, normalize, subtract, totalMinutes } from '../../src/shared/worktime';
import { localDateTime, toIsoJst } from '../../src/shared/time';
import type { AttendanceEvent, BreakDeclaration, OvertimeRequest, PunchType, Shift } from '../../src/shared/types';

const meta = { createdAt: '2026-11-01T00:00:00+09:00', updatedAt: '2026-11-01T00:00:00+09:00', version: 1 };
let seq = 0;
const ev = (type: PunchType, d: string, t: string): AttendanceEvent => ({ ...meta, id: `ev${++seq}`, employeeId: 'e1', type, at: toIsoJst(localDateTime(d, t)), deviceId: 'd1', source: 'kiosk', requestId: `r${seq}`, actorId: null, note: '' });
const shift = (date: string, start: string, end: string, o: Partial<Shift> = {}): Shift => ({ ...meta, id: `s${++seq}`, employeeId: 'e1', date, start, end, breakMinutes: 0, applyFixedBreak: false, fixedBreakStart: null, status: 'published', publishedAt: null, note: '', ...o });
const opt = { businessDayCutoff: '05:00', now: localDateTime('2026-11-10', '12:00'), missingClockOutHours: 16, abnormalHours: 14 };
const M = 60_000;
const req = (s: string, e: string, wc: OvertimeRequest['workConfirmation'], status: OvertimeRequest['status'] = 'confirmed', approved?: [string, string]): OvertimeRequest => ({
  ...meta, id: `o${++seq}`, employeeId: 'e1', sessionKey: null, workDate: '2026-11-03', shiftId: null, category: 'late', requestedStart: toIsoJst(localDateTime('2026-11-03', s)), requestedEnd: toIsoJst(localDateTime('2026-11-03', e)),
  reason: '', identityVerified: true, requestedBy: 'owner', requestedByKind: 'owner', status, workConfirmation: wc,
  approvedStart: wc === 'work' ? toIsoJst(localDateTime('2026-11-03', (approved ?? [s, e])[0])) : null, approvedEnd: wc === 'work' ? toIsoJst(localDateTime('2026-11-03', (approved ?? [s, e])[1])) : null,
  reviewedBy: null, reviewedAt: null, reviewComment: '',
});

describe('区間演算', () => {
  it('和集合・積・差', () => {
    expect(normalize([[0, 10], [5, 20], [30, 40]])).toEqual([[0, 20], [30, 40]]);
    expect(intersect([[0, 20]], [[10, 30]])).toEqual([[10, 20]]);
    expect(subtract([[0, 30]], [[10, 20]])).toEqual([[0, 10], [20, 30]]);
    expect(totalMinutes([[0, 5 * M], [3 * M, 8 * M]])).toBe(8);
  });
});

describe('シフト基準の給与対象（§9.2）', () => {
  const sessions = () => buildSessions('e1', effectiveEvents([ev('clock_in', '2026-11-03', '17:55'), ev('clock_out', '2026-11-03', '23:10')], []), [], [], { ...opt, breakDeclarations: [] });
  const sh = [shift('2026-11-03', '18:00', '23:00')];
  const payable = (reqs: OvertimeRequest[]) => applyTimeBasis(sessions(), sh, reqs, 'shift');
  const mins = (r: ReturnType<typeof payable>) => r.details[0]!.payableMinutes;
  it('未確認: 300分・未確認15分', () => {
    const r = payable([]);
    expect(mins(r)).toBe(300);
    expect(r.details[0]!.unresolvedMinutes).toBe(15);
    expect(r.details[0]!.candidates.map((c) => c.category)).toEqual(['early', 'late']);
  });
  it('実労働なし確認: 300 / 早出のみ: 305 / 残業のみ: 310 / 両方: 315', () => {
    expect(mins(payable([req('17:55', '18:00', 'no_work'), req('23:00', '23:10', 'no_work')]))).toBe(300);
    expect(mins(payable([req('17:55', '18:00', 'work'), req('23:00', '23:10', 'no_work')]))).toBe(305);
    expect(mins(payable([req('17:55', '18:00', 'no_work'), req('23:00', '23:10', 'work')]))).toBe(310);
    expect(mins(payable([req('17:55', '18:00', 'work'), req('23:00', '23:10', 'work')]))).toBe(315);
  });
  it('重複した確認でも二重に加算しない', () => {
    expect(mins(payable([req('23:00', '23:10', 'work'), req('23:00', '23:10', 'work'), req('23:05', '23:10', 'work'), req('17:55', '18:00', 'no_work')]))).toBe(310);
  });
  it('申請中・差戻し・取消は未確認のまま（承認状態と実労働の確認を区別）', () => {
    const r = payable([req('23:00', '23:10', 'unconfirmed', 'pending'), req('17:55', '18:00', 'work', 'cancelled')]);
    expect(r.details[0]!.unresolvedMinutes).toBe(15);
    expect(mins(r)).toBe(300);
  });
  it('一部承認の残りは、明示的に実労働なしと確認するまで未確認（Codex 監査2 #6）', () => {
    const r = payable([req('23:00', '23:10', 'work', 'approved', ['23:00', '23:05']), req('17:55', '18:00', 'no_work')]);
    expect(mins(r)).toBe(305);
    expect(r.details[0]!.unresolvedMinutes).toBe(5);
    const r2 = payable([req('23:00', '23:10', 'work', 'approved', ['23:00', '23:05']), req('23:05', '23:10', 'no_work'), req('17:55', '18:00', 'no_work')]);
    expect(mins(r2)).toBe(305);
    expect(r2.details[0]!.unresolvedMs).toBe(0);
  });
  it("basis='actual' は打刻どおり（315分）", () => {
    const r = applyTimeBasis(sessions(), sh, [], 'actual');
    expect(r.sessions[0]!.end! - r.sessions[0]!.start).toBe(315 * M);
  });
});

describe('予定休憩（v1.3: 取得を確認したものだけ控除）', () => {
  const sh = [shift('2026-11-02', '09:00', '17:00', { breakMinutes: 60, fixedBreakStart: '12:00', applyFixedBreak: true })];
  const evs = () => effectiveEvents([ev('clock_in', '2026-11-02', '09:00'), ev('clock_out', '2026-11-02', '17:00')], []);
  const decl = (kind: BreakDeclaration['kind'], key: string, intervals: Array<[string, string]> = []): BreakDeclaration => ({
    ...meta, id: `b${++seq}`, employeeId: 'e1', sessionKey: key, laborDate: '2026-11-02', shiftId: null, kind,
    intervals: intervals.map(([s, e]) => ({ start: toIsoJst(localDateTime('2026-11-02', s)), end: toIsoJst(localDateTime('2026-11-02', e)) })),
    reason: '', identityVerified: true, actorId: 'e1', actorKind: 'staff', status: 'applied', reviewStatus: 'unreviewed', reviewedAt: null, reviewedBy: null, reviewComment: '',
  });
  const work = (decls: BreakDeclaration[]) => {
    const e = evs();
    const [s] = buildSessions('e1', e, [], sh, { ...opt, breakDeclarations: decls.map((d) => ({ ...d, sessionKey: d.sessionKey || e[0]!.id })) });
    const br = s!.breaks.reduce((x, b) => x + ((b.end ?? 0) - b.start), 0);
    return { minutes: (s!.end! - s!.start - br) / M, anomalies: s!.anomalies };
  };
  it('Codex 監査1 #8: 申告なしでは予定休憩（applyFixedBreak=true でも）を控除しない', () => {
    const r = work([]);
    expect(r.minutes).toBe(480);
    expect(r.anomalies).toContain('planned_break_unconfirmed');
  });
  it('予定どおり 420（申告に確認時点の区間 12:00–13:00 を保存）/ 取得なし 480 / 短縮 450', () => {
    expect(work([decl('as_scheduled', '', [['12:00', '13:00']])]).minutes).toBe(420);
    expect(work([decl('not_taken', '')]).minutes).toBe(480);
    expect(work([decl('custom', '', [['12:00', '12:30']])]).minutes).toBe(450);
  });
  it('承認待ち（pending）の申告は反映しない', () => {
    expect(work([{ ...decl('as_scheduled', '', [['12:00', '13:00']]), status: 'pending' }]).minutes).toBe(480);
  });
  it('申告の時点で予定休憩の時刻が未設定（区間なし）の「予定どおり」は、現在のシフトの区間で補わず控除しない（Codex 監査3 #4）', () => {
    const r = work([decl('as_scheduled', '')]);
    expect(r.minutes).toBe(480);
    expect(r.anomalies).toContain('planned_break_time_unset');
  });
});
