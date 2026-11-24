import { describe, expect, it } from 'vitest';
import { buildSessions, currentState, effectiveEvents, netWorkMs, validatePunch, type EffectiveEvent } from '../../src/shared/attendance';
import { localDateTime, toIsoJst, MINUTE_MS } from '../../src/shared/time';
import type { AttendanceCorrection, AttendanceEvent, PunchType, Shift } from '../../src/shared/types';

const meta = { createdAt: '2026-11-01T00:00:00+09:00', updatedAt: '2026-11-01T00:00:00+09:00', version: 1 };
let seq = 0;
function ev(type: PunchType, d: string, t: string, emp = 'e1'): AttendanceEvent {
  seq++;
  return { ...meta, id: `ev${seq}`, employeeId: emp, type, at: toIsoJst(localDateTime(d, t)), deviceId: 'd1', source: 'kiosk', requestId: `r${seq}`, actorId: null, note: '' };
}
const opt = { businessDayCutoff: '05:00', now: localDateTime('2026-11-10', '12:00'), missingClockOutHours: 16, abnormalHours: 14 };

describe('打刻の状態遷移', () => {
  it('正常な遷移と不正な遷移', () => {
    const evs: EffectiveEvent[] = effectiveEvents([ev('clock_in', '2026-11-02', '09:00')], []);
    expect(currentState(evs)).toBe('working');
    expect(validatePunch(evs, 'clock_in')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(validatePunch(evs, 'break_end')).toMatchObject({ ok: false });
    expect(validatePunch(evs, 'break_start')).toMatchObject({ ok: true });
  });
  it('休憩中の退勤は確認が必要', () => {
    const evs = effectiveEvents([ev('clock_in', '2026-11-02', '09:00'), ev('break_start', '2026-11-02', '12:00')], []);
    expect(validatePunch(evs, 'clock_out')).toMatchObject({ ok: false, code: 'BREAK_END_CONFIRM_REQUIRED' });
    expect(validatePunch(evs, 'clock_out', { endBreakConfirmed: true })).toMatchObject({ ok: true, autoBreakEnd: true });
  });
  it('退勤後の再出勤は可能', () => {
    const evs = effectiveEvents([ev('clock_in', '2026-11-02', '09:00'), ev('clock_out', '2026-11-02', '12:00')], []);
    expect(currentState(evs)).toBe('clocked_out');
    expect(validatePunch(evs, 'clock_in')).toMatchObject({ ok: true });
  });
});

describe('勤務の再構築', () => {
  it('日付をまたぐ勤務は始業日の労働日・営業日', () => {
    const evs = effectiveEvents([ev('clock_in', '2026-11-02', '20:00'), ev('clock_out', '2026-11-02', '27:30')], []);
    const [s] = buildSessions('e1', evs, [], [], opt);
    expect(s!.laborDate).toBe('2026-11-02');
    expect(s!.businessDate).toBe('2026-11-02');
    expect(netWorkMs(s!, opt.now)).toBe(7.5 * 60 * MINUTE_MS);
  });
  it('深夜0時で自動退勤しない（未退勤のまま継続）', () => {
    const now = localDateTime('2026-11-03', '01:00');
    const evs = effectiveEvents([ev('clock_in', '2026-11-02', '20:00')], []);
    const [s] = buildSessions('e1', evs, [], [], { ...opt, now });
    expect(s!.end).toBeNull();
    expect(s!.anomalies).not.toContain('missing_clock_out');
  });
  it('複数休憩・再出勤', () => {
    const evs = effectiveEvents(
      [
        ev('clock_in', '2026-11-02', '09:00'),
        ev('break_start', '2026-11-02', '11:00'),
        ev('break_end', '2026-11-02', '11:15'),
        ev('break_start', '2026-11-02', '13:00'),
        ev('break_end', '2026-11-02', '13:45'),
        ev('clock_out', '2026-11-02', '15:00'),
        ev('clock_in', '2026-11-02', '18:00'),
        ev('clock_out', '2026-11-02', '21:00'),
      ],
      [],
    );
    const ss = buildSessions('e1', evs, [], [], opt);
    expect(ss).toHaveLength(2);
    expect(netWorkMs(ss[0]!, opt.now) / MINUTE_MS).toBe(360 - 60);
    expect(ss[0]!.breaks).toHaveLength(2);
  });
  it('休憩不足を検出（自動追加しない）', () => {
    const evs = effectiveEvents([ev('clock_in', '2026-11-02', '09:00'), ev('clock_out', '2026-11-02', '16:30')], []);
    const [s] = buildSessions('e1', evs, [], [], opt);
    expect(s!.anomalies).toContain('insufficient_break');
    expect(s!.breaks).toHaveLength(0);
  });
  it('固定休憩と打刻休憩を二重控除しない', () => {
    const shift: Shift = { ...meta, id: 's1', employeeId: 'e1', date: '2026-11-02', start: '09:00', end: '18:00', breakMinutes: 60, applyFixedBreak: true, fixedBreakStart: '12:00', status: 'published', publishedAt: null, note: '' };
    const withPunch = effectiveEvents(
      [ev('clock_in', '2026-11-02', '09:00'), ev('break_start', '2026-11-02', '12:00'), ev('break_end', '2026-11-02', '13:00'), ev('clock_out', '2026-11-02', '18:00')],
      [],
    );
    const [a] = buildSessions('e1', withPunch, [], [shift], opt);
    expect(netWorkMs(a!, opt.now) / MINUTE_MS).toBe(480);
    expect(a!.anomalies).not.toContain('fixed_break_applied');
    const noPunch = effectiveEvents([ev('clock_in', '2026-11-02', '09:00'), ev('clock_out', '2026-11-02', '18:00')], []);
    const [b] = buildSessions('e1', noPunch, [], [shift], opt);
    expect(netWorkMs(b!, opt.now) / MINUTE_MS).toBe(480);
    expect(b!.anomalies).toContain('fixed_break_applied');
  });
  it('修正（置換・無効化・追加）を原本を変えずに反映', () => {
    const e1 = ev('clock_in', '2026-11-02', '09:10');
    const e2 = ev('clock_out', '2026-11-02', '18:00');
    const dup = ev('clock_in', '2026-11-02', '09:11');
    const c = (o: Partial<AttendanceCorrection>): AttendanceCorrection => ({ ...meta, id: `c${++seq}`, employeeId: 'e1', action: 'add', targetEventId: null, newType: null, newAt: null, reason: 'test', actorId: 'owner', actorKind: 'owner', status: 'applied', before: '', after: '', ...o });
    const evs = effectiveEvents([e1, dup, e2], [
      c({ action: 'replace', targetEventId: e1.id, newType: 'clock_in', newAt: toIsoJst(localDateTime('2026-11-02', '09:00')) }),
      c({ action: 'void', targetEventId: dup.id }),
      c({ action: 'add', newType: 'break_start', newAt: toIsoJst(localDateTime('2026-11-02', '12:00')) }),
      c({ action: 'add', newType: 'break_end', newAt: toIsoJst(localDateTime('2026-11-02', '13:00')) }),
      c({ action: 'add', newType: 'break_end', newAt: toIsoJst(localDateTime('2026-11-02', '13:30')), status: 'pending' }),
    ]);
    const [s] = buildSessions('e1', evs, [], [], opt);
    expect(netWorkMs(s!, opt.now) / MINUTE_MS).toBe(480);
    expect(e1.at).toBe(toIsoJst(localDateTime('2026-11-02', '09:10'))); // 原本は不変
  });
});
