import { describe, expect, it } from 'vitest';
import { addMonths, fiveDayObligation, grantSchedule, leaveBalance, proportionalCategory } from '../../src/shared/leave';
import type { EmploymentHistory, LeaveGrant, LeaveTransaction } from '../../src/shared/types';

const meta = { createdAt: '', updatedAt: '', version: 1 };
const emp = (o: Partial<EmploymentHistory>): EmploymentHistory => ({ ...meta, id: 'h', employeeId: 'e1', effectiveFrom: '2020-01-01', effectiveTo: null, payType: 'hourly', weeklyScheduledDays: null, weeklyScheduledMinutes: null, yearlyScheduledDays: null, dailyScheduledMinutes: null, monthlyAverageScheduledMinutes: null, note: '', ...o });
const grant = (id: string, grantDate: string, days: number): LeaveGrant => ({ ...meta, id, employeeId: 'e1', grantDate, days, expiresOn: addMonths(grantDate, 24), kind: 'statutory', attendanceRateConfirmed: true, note: '' });
const take = (date: string, days = 1): LeaveTransaction => ({ ...meta, id: `t${date}`, employeeId: 'e1', date, days, kind: 'take', scheduledMinutes: 480, grantId: null, reason: '', actorId: 'owner' });

describe('有給付与', () => {
  it('通常付与（労基法39条の表: 10,11,12,14,16,18,20）', () => {
    const g = grantSchedule('2019-04-01', '2026-11-01', emp({ weeklyScheduledDays: 5, weeklyScheduledMinutes: 2400 }));
    expect(g.map((x) => x.days)).toEqual([10, 11, 12, 14, 16, 18, 20, 20]);
    expect(g[0]!.grantDate).toBe('2019-10-01');
  });
  it('比例付与（週3日・週30時間未満）', () => {
    const g = grantSchedule('2025-01-15', '2026-11-01', emp({ weeklyScheduledDays: 3, weeklyScheduledMinutes: 18 * 60 }));
    expect(g.map((x) => x.days)).toEqual([5, 6]);
  });
  it('週4日でも週30時間以上なら通常付与', () => {
    expect(proportionalCategory(emp({ weeklyScheduledDays: 4, weeklyScheduledMinutes: 32 * 60 }))).toBeNull();
  });
  it('所定条件が未設定なら付与日数を決定しない', () => {
    const g = grantSchedule('2025-01-15', '2026-11-01', null);
    expect(g[0]!.days).toBe(0);
    expect(g[0]!.note).toContain('未設定');
  });
  it('8月31日入社など月末の加算', () => {
    expect(addMonths('2025-08-31', 6)).toBe('2026-02-28');
  });
});

describe('残日数・時効・年5日', () => {
  it('古い付与から消化し、2年で時効', () => {
    const gs = [grant('g1', '2024-10-01', 10), grant('g2', '2025-10-01', 11)];
    const tx = [take('2025-11-01'), take('2025-11-02'), take('2026-09-30')];
    const b1 = leaveBalance(gs, tx, '2026-09-30');
    expect(b1.total).toBe(10 - 3 + 11);
    const b2 = leaveBalance(gs, tx, '2026-10-01');
    expect(b2.byGrant[0]!.expired).toBe(true);
    expect(b2.total).toBe(11);
  });
  it('年5日取得義務（付与10日以上）', () => {
    const gs = [grant('g1', '2025-10-01', 10)];
    const st = fiveDayObligation(gs, [take('2025-12-01'), take('2026-03-01', 0.5)]);
    expect(st[0]!.taken).toBe(1.5);
    expect(st[0]!.shortfall).toBe(3.5);
    expect(st[0]!.deadline).toBe('2026-10-01');
  });
});
