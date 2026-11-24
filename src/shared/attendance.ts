/**
 * 勤怠ドメイン: 打刻の状態遷移、原本＋修正の合成、勤務の再構築
 *
 * - 打刻原本は追記専用。修正は AttendanceCorrection として別に保存し、
 *   effectiveEvents() で「修正後の勤務実績」を毎回再構築する。
 * - 労働日（laborDate）は「始業時刻の暦日」。日付をまたぐ連続勤務は始業日の勤務として扱う
 *   （昭和63年1月1日基発1号の考え方）。営業日（businessDate）は店舗の切替時刻で別途算出。
 */
import type {
  AttendanceCorrection,
  AttendanceEvent,
  BreakInterval,
  Id,
  ManualBreak,
  PunchType,
  Shift,
  WorkSession,
  WorkState,
} from './types';
import {
  HOUR_MS,
  MINUTE_MS,
  localDateTime,
  parseIso,
  parseTimeToMinutes,
  toLocalDate,
  type Instant,
  type LocalDate,
  type LocalTime,
} from './time';

export interface EffectiveEvent {
  id: Id;
  employeeId: Id;
  type: PunchType;
  at: Instant;
  origin: 'original' | 'correction';
}

/** 状態遷移表 */
const TRANSITIONS: Record<WorkState, Partial<Record<PunchType, WorkState>>> = {
  off: { clock_in: 'working' },
  clocked_out: { clock_in: 'working' },
  working: { clock_out: 'clocked_out', break_start: 'on_break' },
  on_break: { break_end: 'working' },
};

export const PUNCH_LABEL: Record<PunchType, string> = {
  clock_in: '出勤',
  clock_out: '退勤',
  break_start: '休憩開始',
  break_end: '休憩終了',
};

export const STATE_LABEL: Record<WorkState, string> = {
  off: '未出勤',
  working: '勤務中',
  on_break: '休憩中',
  clocked_out: '退勤済み',
};

export function nextState(state: WorkState, punch: PunchType): WorkState | null {
  return TRANSITIONS[state][punch] ?? null;
}

export function allowedPunches(state: WorkState): PunchType[] {
  return Object.keys(TRANSITIONS[state]) as PunchType[];
}

/**
 * 原本＋修正 → 有効な打刻列（時刻順）
 * - void: 対象原本を無効化
 * - replace: 対象原本を新しい種別/時刻に置換
 * - add: 追加
 * status !== 'applied' の修正は反映しない。
 */
export function effectiveEvents(
  events: AttendanceEvent[],
  corrections: AttendanceCorrection[],
): EffectiveEvent[] {
  const map = new Map<Id, EffectiveEvent>();
  for (const e of events) {
    map.set(e.id, { id: e.id, employeeId: e.employeeId, type: e.type, at: parseIso(e.at), origin: 'original' });
  }
  const applied = corrections
    .filter((c) => c.status === 'applied')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const c of applied) {
    if (c.action === 'void' && c.targetEventId) {
      map.delete(c.targetEventId);
    } else if (c.action === 'replace' && c.targetEventId) {
      const t = map.get(c.targetEventId);
      if (t && c.newType && c.newAt) map.set(c.targetEventId, { ...t, type: c.newType, at: parseIso(c.newAt), origin: 'correction' });
    } else if (c.action === 'add' && c.newType && c.newAt) {
      map.set(`corr:${c.id}`, { id: `corr:${c.id}`, employeeId: c.employeeId, type: c.newType, at: parseIso(c.newAt), origin: 'correction' });
    }
  }
  return [...map.values()].sort((a, b) => a.at - b.at || typeOrder(a.type) - typeOrder(b.type));
}

function typeOrder(t: PunchType): number {
  return { clock_in: 0, break_start: 1, break_end: 2, clock_out: 3 }[t];
}

/** 打刻列から現在の勤務状態を求める（不正な遷移はスキップせず検出のため別関数で扱う） */
export function currentState(events: EffectiveEvent[]): WorkState {
  let s: WorkState = 'off';
  for (const e of events) {
    const n = nextState(s, e.type);
    if (n) s = n;
  }
  return s;
}

export interface SessionBuildOptions {
  businessDayCutoff: LocalTime;
  /** 現在時刻（未退勤の判定用） */
  now: Instant;
  /** 退勤打刻なしで「打刻漏れ」とみなす経過時間 */
  missingClockOutHours: number;
  /** 異常に長い勤務とみなす時間 */
  abnormalHours: number;
}

export const DEFAULT_SESSION_OPTIONS: Omit<SessionBuildOptions, 'now'> = {
  businessDayCutoff: '05:00',
  missingClockOutHours: 16,
  abnormalHours: 14,
};

export function businessDateOf(t: Instant, cutoff: LocalTime): LocalDate {
  return toLocalDate(t - parseTimeToMinutes(cutoff) * MINUTE_MS);
}

/**
 * 有効な打刻列（1従業員分）から勤務セッションを再構築
 * 固定休憩・手動休憩もここで合成する（打刻休憩と固定休憩は二重控除しない）。
 */
export function buildSessions(
  employeeId: Id,
  events: EffectiveEvent[],
  manualBreaks: ManualBreak[],
  shifts: Shift[],
  opt: SessionBuildOptions,
): WorkSession[] {
  const sessions: WorkSession[] = [];
  let cur: WorkSession | null = null;
  let openBreak: BreakInterval | null = null;
  const evs = events.filter((e) => e.employeeId === employeeId);

  const close = (s: WorkSession) => sessions.push(s);

  for (const e of evs) {
    switch (e.type) {
      case 'clock_in':
        if (cur) {
          cur.anomalies.push('duplicate_clock_in');
          continue; // 二重出勤: 後の出勤は無視（原本は残る）
        }
        cur = {
          employeeId,
          start: e.at,
          end: null,
          breaks: [],
          laborDate: toLocalDate(e.at),
          businessDate: businessDateOf(e.at, opt.businessDayCutoff),
          eventIds: [e.id],
          anomalies: [],
        };
        openBreak = null;
        break;
      case 'break_start':
        if (!cur) continue;
        cur.eventIds.push(e.id);
        if (openBreak) {
          cur.anomalies.push('duplicate_break_start');
          continue;
        }
        openBreak = { start: e.at, end: null, source: 'punch' };
        cur.breaks.push(openBreak);
        break;
      case 'break_end':
        if (!cur) continue;
        cur.eventIds.push(e.id);
        if (!openBreak) {
          cur.anomalies.push('break_end_without_start');
          continue;
        }
        openBreak.end = e.at;
        openBreak = null;
        break;
      case 'clock_out':
        if (!cur) continue; // 出勤なしの退勤は別途 orphan として検出
        cur.eventIds.push(e.id);
        if (openBreak) {
          // 休憩中の退勤: 休憩は退勤時刻で終了したものとして扱い、異常として記録
          openBreak.end = e.at;
          openBreak = null;
          cur.anomalies.push('clock_out_during_break');
        }
        cur.end = e.at;
        close(cur);
        cur = null;
        break;
    }
  }
  if (cur) {
    if (openBreak) cur.anomalies.push('break_not_ended');
    if (opt.now - cur.start > opt.missingClockOutHours * HOUR_MS) cur.anomalies.push('missing_clock_out');
    close(cur);
  }

  // 手動休憩の合成
  for (const mb of manualBreaks.filter((b) => b.employeeId === employeeId)) {
    const s = parseIso(mb.start);
    const en = parseIso(mb.end);
    const target = sessions.find((x) => s >= x.start && (x.end === null || en <= x.end));
    if (!target) continue;
    target.breaks.push({ start: s, end: en, source: 'manual' });
  }

  // 固定休憩: 打刻/手動休憩が 1 件もないセッションに限り、シフトで「固定休憩を適用」が指定されている場合のみ
  for (const s of sessions) {
    if (s.breaks.length > 0) continue;
    const shift = shifts.find(
      (sh) => sh.employeeId === employeeId && sh.date === s.laborDate && sh.status === 'published' && sh.applyFixedBreak,
    );
    if (!shift || shift.breakMinutes <= 0 || !shift.fixedBreakStart) continue;
    const bs = localDateTime(shift.date, shift.fixedBreakStart);
    const be = bs + shift.breakMinutes * MINUTE_MS;
    if (s.end === null || bs < s.start || be > s.end) {
      s.anomalies.push('fixed_break_outside_work');
      continue;
    }
    s.breaks.push({ start: bs, end: be, source: 'fixed' });
    s.anomalies.push('fixed_break_applied');
  }

  for (const s of sessions) {
    s.breaks.sort((a, b) => a.start - b.start);
    mergeOverlappingBreaks(s);
    const net = netWorkMs(s, opt.now);
    if (s.end !== null && net > opt.abnormalHours * HOUR_MS) s.anomalies.push('abnormal_hours');
    if (s.end !== null) {
      const br = breakMs(s, opt.now);
      if (net + br > 0) {
        const required = requiredBreakMinutes(net / MINUTE_MS);
        if (br / MINUTE_MS < required) s.anomalies.push('insufficient_break');
      }
    }
  }
  return sessions;
}

/** 重複する休憩区間を統合（固定＋打刻の二重控除防止の最終防衛線） */
function mergeOverlappingBreaks(s: WorkSession) {
  const out: BreakInterval[] = [];
  for (const b of s.breaks) {
    const last = out[out.length - 1];
    if (last && last.end !== null && b.start < last.end) {
      if (b.end === null || b.end > last.end) last.end = b.end;
      if (!s.anomalies.includes('overlapping_breaks')) s.anomalies.push('overlapping_breaks');
    } else {
      out.push({ ...b });
    }
  }
  s.breaks = out;
}

/** 労基法34条: 6時間超→45分、8時間超→60分（実労働時間で判定） */
export function requiredBreakMinutes(netWorkMinutes: number): number {
  if (netWorkMinutes > 8 * 60) return 60;
  if (netWorkMinutes > 6 * 60) return 45;
  return 0;
}

export function breakMs(s: WorkSession, now: Instant): number {
  const end = s.end ?? now;
  return s.breaks.reduce((acc, b) => {
    const bs = Math.max(b.start, s.start);
    const be = Math.min(b.end ?? end, end);
    return acc + Math.max(0, be - bs);
  }, 0);
}

export function netWorkMs(s: WorkSession, now: Instant): number {
  const end = s.end ?? now;
  return Math.max(0, end - s.start - breakMs(s, now));
}

/** 実労働区間（休憩を除いた区間）の列挙 */
export function workIntervals(s: WorkSession): Array<[Instant, Instant]> {
  if (s.end === null) return [];
  const out: Array<[Instant, Instant]> = [];
  let cursor = s.start;
  for (const b of s.breaks) {
    const bs = Math.max(b.start, s.start);
    const be = Math.min(b.end ?? s.end, s.end);
    if (be <= bs) continue;
    if (bs > cursor) out.push([cursor, bs]);
    cursor = Math.max(cursor, be);
  }
  if (s.end > cursor) out.push([cursor, s.end]);
  return out;
}

/** 打刻可否の検証（サーバー側で使用） */
export function validatePunch(
  events: EffectiveEvent[],
  punch: PunchType,
  opts: { endBreakConfirmed?: boolean } = {},
): { ok: true; autoBreakEnd: boolean } | { ok: false; code: string; message: string } {
  const st = currentState(events);
  if (punch === 'clock_out' && st === 'on_break') {
    if (!opts.endBreakConfirmed) {
      return { ok: false, code: 'BREAK_END_CONFIRM_REQUIRED', message: '休憩中です。休憩を終了して退勤しますか？' };
    }
    return { ok: true, autoBreakEnd: true };
  }
  if (!nextState(st, punch)) {
    const msg: Record<PunchType, string> = {
      clock_in: 'すでに出勤しています',
      clock_out: st === 'off' || st === 'clocked_out' ? 'まだ出勤していません' : '退勤できない状態です',
      break_start: st === 'on_break' ? 'すでに休憩中です' : '勤務中ではないため休憩を開始できません',
      break_end: '休憩中ではありません',
    };
    return { ok: false, code: 'INVALID_TRANSITION', message: msg[punch] };
  }
  return { ok: true, autoBreakEnd: false };
}

/** 退勤後の出勤（再出勤）を含め、最新のオープン勤務が何日前から続いているか */
export function openSessionStart(events: EffectiveEvent[]): Instant | null {
  let start: Instant | null = null;
  let s: WorkState = 'off';
  for (const e of events) {
    const n = nextState(s, e.type);
    if (!n) continue;
    if (e.type === 'clock_in') start = e.at;
    if (e.type === 'clock_out') start = null;
    s = n;
  }
  return start;
}
