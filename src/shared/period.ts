/**
 * 給与計算期間
 * closingDay: 1〜28 または 0（末日）。payMonthOffset: 0=当月, 1=翌月。payDay: 1〜28 または 0（末日）
 * periodKey は「締め日が属する月」（YYYY-MM）。
 */
import { addDays, daysInMonth, pad2, type LocalDate } from './time';

export interface PeriodConfig {
  closingDay: number;
  payMonthOffset: number;
  payDay: number;
}

export interface PeriodRange {
  periodKey: string;
  from: LocalDate;
  to: LocalDate;
  payDate: LocalDate;
}

export function validatePeriodConfig(c: Partial<PeriodConfig>): string[] {
  const errs: string[] = [];
  const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 28;
  if (!ok(c.closingDay)) errs.push('締め日は1〜28日または末日を指定してください');
  if (!ok(c.payDay)) errs.push('支払日は1〜28日または末日を指定してください');
  if (c.payMonthOffset !== 0 && c.payMonthOffset !== 1) errs.push('支払月は当月または翌月を指定してください');
  return errs;
}

function dayOf(year: number, month: number, day: number): LocalDate {
  const dim = daysInMonth(year, month);
  const d = day === 0 ? dim : Math.min(day, dim);
  return `${year}-${pad2(month)}-${pad2(d)}`;
}

function shiftMonth(year: number, month: number, delta: number): [number, number] {
  const idx = year * 12 + (month - 1) + delta;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

export function periodForKey(periodKey: string, c: PeriodConfig): PeriodRange {
  const m = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (!m) throw new Error(`不正な期間キー: ${periodKey}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const to = dayOf(y, mo, c.closingDay);
  const [py, pm] = shiftMonth(y, mo, -1);
  const from = addDays(dayOf(py, pm, c.closingDay), 1);
  const [ay, am] = shiftMonth(y, mo, c.payMonthOffset);
  const payDate = dayOf(ay, am, c.payDay);
  return { periodKey, from, to, payDate };
}

/** 日付が属する給与期間 */
export function periodForDate(d: LocalDate, c: PeriodConfig): PeriodRange {
  const y = Number(d.slice(0, 4));
  const mo = Number(d.slice(5, 7));
  const thisKey = `${y}-${pad2(mo)}`;
  const p = periodForKey(thisKey, c);
  if (d >= p.from && d <= p.to) return p;
  const [ny, nm] = shiftMonth(y, mo, 1);
  return periodForKey(`${ny}-${pad2(nm)}`, c);
}
