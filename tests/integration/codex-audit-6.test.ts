/**
 * Codex 独立監査 6 回目（docs/reviews/codex-audit-6.md。マージ可否の判定）の指摘に対する回帰テスト
 * （#1・#3 は Setup の更新処理のため tests/integration/installer.test.ts にある）
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

describe('Codex 監査6 #2: バックアップの復元で、メンテナンス中の状態を解除しない', () => {
  it('メンテナンス解除中に取得したバックアップを、メンテナンス中に復元 → メンテナンスは継続し、スタッフの打刻は停止したまま', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.setNow('2026-11-02', '10:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '11:00');
    h.ownerOk('system.setMaintenance', { on: true });
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    expect(h.ownerOk('system.info').maintenance).toBe(true);
    h.setNow('2026-11-02', '11:05');
    // スタッフの利用（ログイン・打刻）はメンテナンスで停止したまま
    const login = h.staff('auth.login', { employeeId: a, pin: '482913' }, { session: '' });
    expect(login.ok).toBe(false);
    expect(!login.ok && login.error.code).toBe('MAINTENANCE');
  });
});

describe('Codex 監査6 #4: 前日の退勤打刻漏れがあっても、当日の休憩申告は当日の勤務に付く', () => {
  it('前日 09:00 出勤（退勤なし・予定休憩 60 分）、当日 09:00 出勤（予定休憩 30 分 12:00）→ 17:00 の退勤確認は 30 分 → 予定どおりで当日は 450 分', () => {
    const h = new Harness();
    h.setupStore({ timeBasis: 'shift' });
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-02', start: '09:00', end: '17:00', breakMinutes: 60, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 30, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-02', to: '2026-11-03' });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.setNow('2026-11-03', '17:00');
    h.login(a, '482913');
    const c = h.staffOk('attendance.clockOutContext');
    expect(c.open).toBe(true);
    expect(c.plannedBreak).toMatchObject({ minutes: 30 });
    expect(c.plannedBreak.start.slice(0, 16)).toBe('2026-11-03T12:00');
    const r = h.punch('clock_out', { breakDeclaration: { kind: 'as_scheduled', expectedPlanned: { start: c.plannedBreak.start.slice(0, 16), end: c.plannedBreak.end.slice(0, 16), minutes: 30 } } });
    expect(r.ok).toBe(true);
    // 当日の勤務: 09:00–17:00 − 予定休憩 30 分 = 450 分
    const list = h.ownerOk<any[]>('attendance.list', { employeeId: a, from: '2026-11-02', to: '2026-11-03' })[0].sessions;
    const today = list.find((s: any) => s.laborDate === '2026-11-03');
    expect(today.start.slice(0, 16)).toBe('2026-11-03T09:00');
    expect(today.end.slice(0, 16)).toBe('2026-11-03T17:00');
    expect(today.workMinutes).toBe(450);
  });
});
