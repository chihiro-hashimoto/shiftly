/**
 * 日時ユーティリティ（Asia/Tokyo 固定）
 *
 * 方針:
 * - 内部表現は UTC エポックミリ秒（number）。保存時は ISO 8601（+09:00 付き）文字列。
 * - 日本標準時は夏時間がなく UTC+9 固定のため、Intl に依存せず +9h のオフセット演算で暦を計算する。
 *   （GAS V8 / ブラウザ / Node で同一結果になることを優先）
 * - 「暦日（LocalDate: YYYY-MM-DD）」と「瞬間（Instant: epoch ms）」を型で区別する。
 */

export type Instant = number; // epoch milliseconds (UTC)
export type LocalDate = string; // 'YYYY-MM-DD' (Asia/Tokyo の暦日)
export type LocalTime = string; // 'HH:MM' (00:00〜47:59 を許容: 翌日にまたがる営業時間表現用)

export const TZ = 'Asia/Tokyo';
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function isLocalDate(s: unknown): s is LocalDate {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function isLocalTime(s: unknown, allowNextDay = false): s is LocalTime {
  if (typeof s !== 'string') return false;
  const m = TIME_RE.exec(s);
  if (!m) return false;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return mi < 60 && h < (allowNextDay ? 48 : 24);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** LocalDate の 00:00 JST に相当する Instant */
export function startOfLocalDate(d: LocalDate): Instant {
  const m = DATE_RE.exec(d);
  if (!m || !isLocalDate(d)) throw new Error(`不正な日付: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - JST_OFFSET_MS;
}

/** Instant が属する JST の暦日 */
export function toLocalDate(t: Instant): LocalDate {
  const d = new Date(t + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Instant の JST 時刻（0:00 からの経過分） */
export function minuteOfDay(t: Instant): number {
  const ms = (t + JST_OFFSET_MS) % DAY_MS;
  return Math.floor((ms < 0 ? ms + DAY_MS : ms) / MINUTE_MS);
}

export function toLocalTimeString(t: Instant): LocalTime {
  const m = minuteOfDay(t);
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** 0=日曜 … 6=土曜（JST） */
export function dayOfWeek(d: LocalDate): number {
  return new Date(startOfLocalDate(d) + JST_OFFSET_MS).getUTCDay();
}

export function addDays(d: LocalDate, n: number): LocalDate {
  return toLocalDate(startOfLocalDate(d) + n * DAY_MS + 12 * HOUR_MS);
}

export function diffDays(a: LocalDate, b: LocalDate): number {
  return Math.round((startOfLocalDate(a) - startOfLocalDate(b)) / DAY_MS);
}

export function compareDate(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 'HH:MM'（48時間表記可）を分に変換 */
export function parseTimeToMinutes(t: LocalTime): number {
  const m = TIME_RE.exec(t);
  if (!m) throw new Error(`不正な時刻: ${t}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(min: number): LocalTime {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** LocalDate + 'HH:MM'（24時以降は翌日扱い）→ Instant */
export function localDateTime(d: LocalDate, t: LocalTime): Instant {
  return startOfLocalDate(d) + parseTimeToMinutes(t) * MINUTE_MS;
}

/** ISO 8601（+09:00）文字列 */
export function toIsoJst(t: Instant): string {
  const d = new Date(t + JST_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+09:00`
  );
}

export function parseIso(s: string): Instant {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`不正な日時: ${s}`);
  return t;
}

export function formatJst(t: Instant, withSeconds = false): string {
  const d = new Date(t + JST_OFFSET_MS);
  const base = `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad2(d.getUTCSeconds())}` : base;
}

export function formatMinutes(min: number): string {
  const sign = min < 0 ? '-' : '';
  const a = Math.abs(min);
  return `${sign}${Math.floor(a / 60)}:${pad2(a % 60)}`;
}

export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 期間 [from, to]（両端含む）の暦日を列挙 */
export function eachDate(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthKey(d: LocalDate): string {
  return d.slice(0, 7);
}

/** 'YYYY-MM' の前月（暦月で求める。日数の減算による推定は月の長さで誤る） */
export function prevMonthKey(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

/** 区間 [a1,a2) と [b1,b2) の重なり（ms） */
export function overlapMs(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}
