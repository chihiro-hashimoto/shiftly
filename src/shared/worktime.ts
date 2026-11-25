/**
 * シフト基準の給与対象時間（v1.3）— 純粋関数
 *
 * 時間区分（docs/payroll-specification.md §2.5）
 *   A 登録シフト時間 / B 元の打刻（原本）/ C 修正後の勤怠 / D 実際の休憩 /
 *   E シフト外の勤務候補 / F 申請・確認された実労働 / G 給与計算対象
 *
 * - G = (C ∩ A ∪ F) − D。打刻原本・修正後の勤怠は書き換えない（給与計算用の派生データのみ作る）
 * - E は「C − A − D」。早出（最初のシフトより前）・残業（最後のシフトより後）・シフト間・シフト未登録に分類
 * - E のうち、実労働と確認された区間（F）だけを G に加える。確認されていない区間は「未確認」として残し、
 *   給与確定を止める（未申請・未承認を理由に実労働を無給扱いにしない／未確認のまま機械的に確定しない）
 * - 同じ時刻を複数の申請・確認で重ねて加算しない（区間の和集合で扱う）
 */
import type { OvertimeRequest, Shift, WorkSession } from './types';
import { MINUTE_MS, localDateTime, parseIso, toIsoJst, type Instant, type LocalDate } from './time';
import { sessionKeyOf, workIntervals } from './attendance';

export type Interval = [Instant, Instant];

export type CandidateCategory = 'early' | 'late' | 'between' | 'no_shift';

export interface OffShiftCandidate {
  category: CandidateCategory;
  start: Instant;
  end: Instant;
  minutes: number;
  /** work=実労働として確認 / no_work=実労働なしと確認 / unresolved=未確認 */
  segments: Array<{ start: Instant; end: Instant; minutes: number; resolution: 'work' | 'no_work' | 'unresolved' }>;
}

export interface SessionTimeBasis {
  sessionKey: string;
  employeeId: string;
  laborDate: LocalDate;
  /** A: 勤務と重なる公開済みシフト */
  shifts: Array<{ id: string; start: Instant; end: Instant; breakMinutes: number }>;
  /** C: 修正後の勤怠（出勤〜退勤） */
  actualStart: Instant;
  actualEnd: Instant;
  /** D: 実際の休憩（分） */
  breakMinutes: number;
  /** 実労働（C − D）の分 */
  actualWorkMinutes: number;
  /** シフト内の実労働（C ∩ A − D） */
  inShiftMinutes: number;
  /** E: シフト外の勤務候補 */
  candidates: OffShiftCandidate[];
  /** F: 実労働と確認されたシフト外の分 */
  confirmedExtraMinutes: number;
  /** 未確認のシフト外の分 */
  unresolvedMinutes: number;
  /** G: 給与計算対象の分 */
  payableMinutes: number;
}

// ------------------------------------------------------------------ 区間演算
export function normalize(xs: Interval[]): Interval[] {
  const s = xs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function intersect(xs: Interval[], ys: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a, b] of normalize(xs)) for (const [c, d] of normalize(ys)) {
    const s = Math.max(a, c);
    const e = Math.min(b, d);
    if (e > s) out.push([s, e]);
  }
  return normalize(out);
}

export function subtract(xs: Interval[], ys: Interval[]): Interval[] {
  let cur = normalize(xs);
  for (const [c, d] of normalize(ys)) {
    const next: Interval[] = [];
    for (const [a, b] of cur) {
      if (d <= a || c >= b) next.push([a, b]);
      else {
        if (c > a) next.push([a, c]);
        if (d < b) next.push([d, b]);
      }
    }
    cur = next;
  }
  return cur;
}

export function totalMinutes(xs: Interval[]): number {
  return Math.round(normalize(xs).reduce((s, [a, b]) => s + (b - a), 0) / MINUTE_MS);
}

// ------------------------------------------------------------------ 確認の解決
/** 実労働として確認された区間と、実労働なしと確認された区間（申請・管理者確認から） */
export function resolutionIntervals(employeeId: string, requests: OvertimeRequest[]): { work: Interval[]; noWork: Interval[] } {
  const work: Interval[] = [];
  const decided: Interval[] = [];
  for (const r of requests) {
    if (r.employeeId !== employeeId) continue;
    if (r.workConfirmation === 'unconfirmed') continue;
    // 取消・差戻し・申請中は判断されていない（未確認のまま）
    if (r.status === 'cancelled' || r.status === 'returned' || r.status === 'pending') continue;
    const req: Interval = [parseIso(r.requestedStart), parseIso(r.requestedEnd)];
    decided.push(req);
    if (r.workConfirmation === 'work' && r.approvedStart && r.approvedEnd) {
      work.push([parseIso(r.approvedStart), parseIso(r.approvedEnd)]);
      // 承認区間が申請区間の外にある場合も、承認区間は判断済みとして扱う
      decided.push([parseIso(r.approvedStart), parseIso(r.approvedEnd)]);
    }
  }
  const w = normalize(work);
  // 判断済みの区間のうち実労働でない部分 = 実労働なし（一部承認の残りを含む）
  return { work: w, noWork: subtract(decided, w) };
}

function shiftIntervalsFor(s: WorkSession, shifts: Shift[]): Array<{ id: string; start: Instant; end: Instant; breakMinutes: number }> {
  const end = s.end ?? s.start;
  return shifts
    .filter((sh) => sh.employeeId === s.employeeId && sh.status === 'published')
    .map((sh) => ({ id: sh.id, start: localDateTime(sh.date, sh.start), end: localDateTime(sh.date, sh.end), breakMinutes: sh.breakMinutes }))
    .filter((x) => x.start < end && x.end > s.start)
    .sort((a, b) => a.start - b.start);
}

/**
 * 1 勤務の時間区分と、給与計算用の勤務（シフト外の未確認・実労働なしの時間を excluded として除外したもの）
 * 退勤していない勤務は対象外（給与確定は別途ブロックされる）
 */
export function timeBasisOf(s: WorkSession, shifts: Shift[], resolution: { work: Interval[]; noWork: Interval[] }): { basis: SessionTimeBasis; payable: WorkSession } | null {
  if (s.end === null) return null;
  const sh = shiftIntervalsFor(s, shifts);
  const work = normalize(workIntervals(s)); // C − D
  const shiftUnion = normalize(sh.map((x) => [x.start, x.end] as Interval));
  const inShift = intersect(work, shiftUnion);
  const off = subtract(work, shiftUnion); // E
  const firstStart = sh[0]?.start ?? null;
  const lastEnd = sh.length ? Math.max(...sh.map((x) => x.end)) : null;
  const candidates: OffShiftCandidate[] = off.map(([a, b]) => {
    const category: CandidateCategory = !sh.length ? 'no_shift' : b <= firstStart! ? 'early' : a >= lastEnd! ? 'late' : 'between';
    const w = intersect([[a, b]], resolution.work);
    const nw = subtract(intersect([[a, b]], resolution.noWork), w);
    const un = subtract([[a, b]], [...w, ...nw]);
    const segs = [
      ...w.map(([x, y]) => ({ start: x, end: y, minutes: totalMinutes([[x, y]]), resolution: 'work' as const })),
      ...nw.map(([x, y]) => ({ start: x, end: y, minutes: totalMinutes([[x, y]]), resolution: 'no_work' as const })),
      ...un.map(([x, y]) => ({ start: x, end: y, minutes: totalMinutes([[x, y]]), resolution: 'unresolved' as const })),
    ].sort((p, q) => p.start - q.start);
    return { category, start: a, end: b, minutes: totalMinutes([[a, b]]), segments: segs };
  });
  const confirmed = intersect(off, resolution.work); // F
  const payableIntervals = normalize([...inShift, ...confirmed]); // G
  const unresolved = subtract(off, [...resolution.work, ...resolution.noWork]);

  // 給与計算用の勤務: 実労働（C − D）のうち G 以外を excluded として除外する
  const excluded = subtract(work, payableIntervals);
  const payable: WorkSession = {
    ...s,
    breaks: [...s.breaks.map((b) => ({ ...b })), ...excluded.map(([a, b]) => ({ start: a, end: b, source: 'excluded' as const }))].sort((x, y) => x.start - y.start),
    anomalies: [...s.anomalies],
  };
  if (payableIntervals.length) {
    // 前後の除外区間は勤務の開始・終了を詰める（休憩としては数えない）
    payable.start = payableIntervals[0]![0];
    payable.end = payableIntervals[payableIntervals.length - 1]![1];
    payable.breaks = payable.breaks.filter((b) => (b.end ?? payable.end!) > payable.start && b.start < payable.end!);
  } else {
    payable.end = payable.start; // 給与対象 0 分
    payable.breaks = [];
  }
  const breakMinutes = totalMinutes(subtract([[s.start, s.end]], work));
  return {
    payable,
    basis: {
      sessionKey: sessionKeyOf(s),
      employeeId: s.employeeId,
      laborDate: s.laborDate,
      shifts: sh,
      actualStart: s.start,
      actualEnd: s.end,
      breakMinutes,
      actualWorkMinutes: totalMinutes(work),
      inShiftMinutes: totalMinutes(inShift),
      candidates,
      confirmedExtraMinutes: totalMinutes(confirmed),
      unresolvedMinutes: totalMinutes(unresolved),
      payableMinutes: totalMinutes(payableIntervals),
    },
  };
}

export interface TimeBasisResult {
  /** 給与計算に渡す勤務（basis='actual' の場合は入力と同じ） */
  sessions: WorkSession[];
  details: SessionTimeBasis[];
}

/**
 * 給与計算用の勤務へ変換
 * basis='shift': シフト基準（v1.3 標準）/ basis='actual': 打刻（修正後）の実績どおり
 */
export function applyTimeBasis(sessions: WorkSession[], shifts: Shift[], requests: OvertimeRequest[], basis: 'shift' | 'actual'): TimeBasisResult {
  if (basis === 'actual') return { sessions, details: [] };
  const out: WorkSession[] = [];
  const details: SessionTimeBasis[] = [];
  const resByEmp = new Map<string, { work: Interval[]; noWork: Interval[] }>();
  for (const s of sessions) {
    if (!resByEmp.has(s.employeeId)) resByEmp.set(s.employeeId, resolutionIntervals(s.employeeId, requests));
    const r = timeBasisOf(s, shifts, resByEmp.get(s.employeeId)!);
    if (!r) {
      out.push(s);
      continue;
    }
    out.push(r.payable);
    details.push(r.basis);
  }
  return { sessions: out, details };
}

/** 表示用（ISO 文字列） */
export function timeBasisView(b: SessionTimeBasis) {
  return {
    ...b,
    actualStart: toIsoJst(b.actualStart),
    actualEnd: toIsoJst(b.actualEnd),
    shifts: b.shifts.map((x) => ({ ...x, start: toIsoJst(x.start), end: toIsoJst(x.end) })),
    candidates: b.candidates.map((c) => ({
      ...c,
      start: toIsoJst(c.start),
      end: toIsoJst(c.end),
      segments: c.segments.map((g) => ({ ...g, start: toIsoJst(g.start), end: toIsoJst(g.end) })),
    })),
  };
}
