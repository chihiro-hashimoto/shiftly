/**
 * 労働時間の区分（法定時間外・法定休日・深夜・月60時間超）
 *
 * 前提（通常の労働時間制のみ対応。変形労働時間制等は対応外で、給与確定を禁止する）:
 * - 1日の法定労働時間 8 時間: 労働日（始業日）単位。日付をまたぐ連続勤務は始業日に属する。
 *   ただし翌日が法定休日の場合、午前0時以降は法定休日労働として扱う。
 * - 法定休日: 暦日（0:00〜24:00）単位。法定休日の労働時間は時間外労働に算入しない。
 * - 週の法定労働時間 40 時間（特例確認済みの場合 44 時間）: 1日単位の時間外を除いた時間を
 *   時系列に累計し、上限を超えた時刻以降を週の時間外とする（日次・週次の二重計上なし）。
 * - 月60時間超: 起算日から1か月の時間外労働（法定休日労働を除く）を時系列に累計し、60時間を超えた部分。
 * - 深夜: 実時刻 22:00〜5:00。他の区分と重複して加算。
 */
import type { WorkSession } from './types';
import { workIntervals } from './attendance';
import {
  MINUTE_MS,
  addDays,
  dayOfWeek,
  minuteOfDay,
  startOfLocalDate,
  toLocalDate,
  type Instant,
  type LocalDate,
} from './time';

export interface LaborConfig {
  statutoryHolidayWeekday: number; // 0=日
  weekStartDay: number;
  weeklyLimitMinutes: number; // 2400 or 2640
  dailyLimitMinutes: number; // 480
  /** 月60時間の起算日（日にち 1〜28、0=末日の翌日=1日）。null は期間初日 */
  overtime60StartDay: number | null;
  /** 期間初日（overtime60StartDay が null の場合の起算に使用） */
  periodFrom: LocalDate;
  businessDayCutoffMinutes: number;
}

export type OvertimeKind = 'none' | 'daily' | 'weekly';

export interface LaborPiece {
  start: Instant;
  end: Instant;
  /** 分（小数を含みうる。表示・集計用） */
  minutes: number;
  /** 秒（整数。金額計算はこちらを使う） */
  seconds: number;
  laborDate: LocalDate;
  calendarDate: LocalDate;
  businessDate: LocalDate;
  holiday: boolean;
  night: boolean;
  overtime: OvertimeKind;
  over60: boolean;
}

const NIGHT_START = 22 * 60;
const NIGHT_END = 5 * 60;

/** 区間を暦日境界・深夜境界・追加境界で分割 */
function splitInterval(a: Instant, b: Instant, extraCuts: Instant[]): Array<[Instant, Instant]> {
  const cuts = new Set<number>();
  // 暦日 0:00, 5:00, 22:00 の境界
  let day = toLocalDate(a);
  while (startOfLocalDate(day) < b) {
    const base = startOfLocalDate(day);
    for (const m of [0, NIGHT_END, NIGHT_START, 24 * 60]) {
      const t = base + m * MINUTE_MS;
      if (t > a && t < b) cuts.add(t);
    }
    day = addDays(day, 1);
  }
  for (const t of extraCuts) if (t > a && t < b) cuts.add(t);
  const pts = [a, ...[...cuts].sort((x, y) => x - y), b];
  const out: Array<[Instant, Instant]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i]!;
    const e = pts[i + 1]!;
    if (e > s) out.push([s, e]);
  }
  return out;
}

export function weekStartOf(d: LocalDate, weekStartDay: number): LocalDate {
  const dow = dayOfWeek(d);
  const back = (dow - weekStartDay + 7) % 7;
  return addDays(d, -back);
}

export function overtime60WindowStart(d: LocalDate, cfg: LaborConfig): LocalDate {
  if (cfg.overtime60StartDay === null) return cfg.periodFrom;
  const day = cfg.overtime60StartDay === 0 ? 1 : cfg.overtime60StartDay;
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const thisMonth = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (d >= thisMonth) return thisMonth;
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** piece を時刻 t で 2 分割 */
function splitPieceAt(p: LaborPiece, t: Instant): [LaborPiece, LaborPiece] {
  const a: LaborPiece = { ...p, end: t, minutes: (t - p.start) / MINUTE_MS, seconds: Math.round((t - p.start) / 1000) };
  const b: LaborPiece = { ...p, start: t, minutes: (p.end - t) / MINUTE_MS, seconds: Math.round((p.end - t) / 1000) };
  return [a, b];
}

/**
 * 区間の累計が limit を超えた部分に mark を適用する（時系列順）。
 * pieces は対象のみ（同一グループ内）を渡す。戻り値は分割後の全 piece。
 */
function markBeyond(
  pieces: LaborPiece[],
  limitMinutes: number,
  mark: (p: LaborPiece) => LaborPiece,
): LaborPiece[] {
  const sorted = [...pieces].sort((x, y) => x.start - y.start);
  const out: LaborPiece[] = [];
  const limit = limitMinutes * MINUTE_MS;
  let acc = 0; // ms で累計（浮動小数点誤差を避ける）
  for (const p of sorted) {
    const len = p.end - p.start;
    if (acc >= limit) {
      out.push(mark(p));
      continue;
    }
    if (acc + len <= limit) {
      acc += len;
      out.push(p);
      continue;
    }
    const [a, b] = splitPieceAt(p, p.start + (limit - acc));
    acc = limit;
    out.push(a, mark(b));
  }
  return out;
}

/**
 * セッション群（完了済み）を区分済み piece に変換。
 * 週・月60時間の判定のため、対象期間より前の週初・起算日からのセッションも渡すこと。
 */
export function classifyLabor(
  sessions: WorkSession[],
  cfg: LaborConfig,
  extraCutsFor: (s: WorkSession) => Instant[] = () => [],
): LaborPiece[] {
  let pieces: LaborPiece[] = [];
  for (const s of sessions) {
    if (s.end === null) continue;
    const cuts = extraCutsFor(s);
    for (const [a, b] of workIntervals(s)) {
      for (const [x, y] of splitInterval(a, b, cuts)) {
        const cal = toLocalDate(x);
        const mod = minuteOfDay(x);
        pieces.push({
          start: x,
          end: y,
          minutes: (y - x) / MINUTE_MS,
          seconds: Math.round((y - x) / 1000),
          laborDate: s.laborDate,
          calendarDate: cal,
          businessDate: toLocalDate(x - cfg.businessDayCutoffMinutes * MINUTE_MS),
          holiday: dayOfWeek(cal) === cfg.statutoryHolidayWeekday,
          night: mod >= NIGHT_START || mod < NIGHT_END,
          overtime: 'none',
          over60: false,
        });
      }
    }
  }

  // 1) 1日単位の時間外（法定休日労働を除く）
  const byDay = groupBy(pieces.filter((p) => !p.holiday), (p) => p.laborDate);
  const holidayPieces = pieces.filter((p) => p.holiday);
  pieces = [...holidayPieces];
  for (const group of byDay.values()) {
    pieces.push(...markBeyond(group, cfg.dailyLimitMinutes, (p) => ({ ...p, overtime: 'daily' })));
  }

  // 2) 週単位の時間外（1日単位の時間外・法定休日労働を除く）
  const regular = pieces.filter((p) => !p.holiday && p.overtime === 'none');
  const others = pieces.filter((p) => p.holiday || p.overtime !== 'none');
  const byWeek = groupBy(regular, (p) => weekStartOf(p.laborDate, cfg.weekStartDay));
  pieces = [...others];
  for (const group of byWeek.values()) {
    pieces.push(...markBeyond(group, cfg.weeklyLimitMinutes, (p) => ({ ...p, overtime: 'weekly' })));
  }

  // 3) 月60時間超（時間外労働のみ。法定休日労働は含めない）
  const ot = pieces.filter((p) => p.overtime !== 'none');
  const nonOt = pieces.filter((p) => p.overtime === 'none');
  const byWindow = groupBy(ot, (p) => overtime60WindowStart(p.laborDate, cfg));
  pieces = [...nonOt];
  for (const group of byWindow.values()) {
    pieces.push(...markBeyond(group, 60 * 60, (p) => ({ ...p, over60: true })));
  }

  return pieces.sort((x, y) => x.start - y.start);
}

export function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export interface LaborSummary {
  workMinutes: number;
  overtimeMinutes: number; // 法定時間外（60h超を含む）
  over60Minutes: number;
  nightMinutes: number;
  holidayMinutes: number;
  workDays: number;
}

export function summarize(pieces: LaborPiece[]): LaborSummary {
  const days = new Set<string>();
  const s: LaborSummary = { workMinutes: 0, overtimeMinutes: 0, over60Minutes: 0, nightMinutes: 0, holidayMinutes: 0, workDays: 0 };
  for (const p of pieces) {
    s.workMinutes += p.minutes;
    if (p.overtime !== 'none') s.overtimeMinutes += p.minutes;
    if (p.over60) s.over60Minutes += p.minutes;
    if (p.night) s.nightMinutes += p.minutes;
    if (p.holiday) s.holidayMinutes += p.minutes;
    if (p.minutes > 0) days.add(p.laborDate);
  }
  s.workDays = days.size;
  return s;
}
