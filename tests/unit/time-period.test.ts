import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, localDateTime, minuteOfDay, toIsoJst, toLocalDate, isLocalDate, startOfLocalDate } from '../../src/shared/time';
import { periodForDate, periodForKey } from '../../src/shared/period';

describe('time (Asia/Tokyo)', () => {
  it('JST の暦日境界', () => {
    // 2026-11-01T15:00:00Z = 2026-11-02 00:00 JST
    expect(toLocalDate(Date.parse('2026-11-01T14:59:59Z'))).toBe('2026-11-01');
    expect(toLocalDate(Date.parse('2026-11-01T15:00:00Z'))).toBe('2026-11-02');
  });
  it('24時以降表記は翌日', () => {
    expect(toIsoJst(localDateTime('2026-11-02', '26:30'))).toBe('2026-11-03T02:30:00+09:00');
  });
  it('曜日・日付演算', () => {
    expect(dayOfWeek('2026-11-01')).toBe(0); // 日曜
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(minuteOfDay(localDateTime('2026-11-02', '22:15'))).toBe(22 * 60 + 15);
  });
  it('日付検証', () => {
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(() => startOfLocalDate('2026-13-01')).toThrow();
  });
});

describe('給与計算期間', () => {
  it('末日締め・翌月25日払い', () => {
    const p = periodForKey('2026-11', { closingDay: 0, payMonthOffset: 1, payDay: 25 });
    expect(p).toEqual({ periodKey: '2026-11', from: '2026-11-01', to: '2026-11-30', payDate: '2026-12-25' });
  });
  it('20日締め・当月末払い', () => {
    const p = periodForKey('2026-03', { closingDay: 20, payMonthOffset: 0, payDay: 0 });
    expect(p).toEqual({ periodKey: '2026-03', from: '2026-02-21', to: '2026-03-20', payDate: '2026-03-31' });
  });
  it('日付から期間を求める（締め日翌日は翌期）', () => {
    const c = { closingDay: 20, payMonthOffset: 1, payDay: 10 };
    expect(periodForDate('2026-03-20', c).periodKey).toBe('2026-03');
    expect(periodForDate('2026-03-21', c).periodKey).toBe('2026-04');
    expect(periodForDate('2026-12-25', c).periodKey).toBe('2027-01');
  });
});
