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
  BreakDeclaration,
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

/**
 * 同時刻の打刻の並び順。終了系（休憩終了・退勤）を開始系（出勤・休憩開始）より先に並べる。
 * 例: 同時刻の「退勤→再出勤」で再出勤を重複出勤として捨てない／休憩中の退勤（休憩終了→退勤）。
 */
function typeOrder(t: PunchType): number {
  return { break_end: 0, clock_out: 1, clock_in: 2, break_start: 3 }[t];
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
  /**
   * v1.3: 休憩の取得申告（勤務キー=出勤打刻の有効 ID ごとの最新の反映済み申告）。
   * 指定した場合、シフトの予定休憩は「予定どおり取得（as_scheduled）」と申告された勤務にだけ控除する
   * （予定休憩の存在だけで控除しない。shift.applyFixedBreak は使わない）。
   * 未指定の場合は v1.2 の動作（applyFixedBreak の指定で、打刻休憩がない勤務に予定休憩を適用）
   */
  breakDeclarations?: BreakDeclaration[];
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
          if (e.at - cur.start > opt.missingClockOutHours * HOUR_MS) {
            // 前回の退勤打刻漏れ: 前の勤務は未退勤（打刻漏れ）のまま確定し、新しい勤務を開始
            if (openBreak) cur.anomalies.push('break_not_ended');
            cur.anomalies.push('missing_clock_out');
            close(cur);
          } else {
            cur.anomalies.push('duplicate_clock_in');
            continue; // 二重出勤: 後の出勤は無視（原本は残る）
          }
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

  if (opt.breakDeclarations) {
    applyDeclarations(employeeId, sessions, shifts, opt.breakDeclarations);
  } else {
    // v1.2 の動作（純粋関数としての互換）: 打刻/手動休憩が 1 件もないセッションに限り、シフトで「固定休憩を適用」が指定されている場合のみ
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

/** 勤務キー（出勤打刻の有効 ID）。休憩申告・勤怠修正・早出残業申請で勤務を指す */
export function sessionKeyOf(s: WorkSession): string {
  return s.eventIds[0] ?? `${s.employeeId}:${s.start}`;
}

/** 勤務に対応する予定休憩（公開済みシフトの休憩。開始時刻が未設定なら start=null） */
export function plannedBreakFor(s: WorkSession, shifts: Shift[]): { shiftId: string; start: Instant | null; end: Instant | null; minutes: number } | null {
  const end = s.end ?? s.start;
  const cands = shifts.filter((sh) => sh.employeeId === s.employeeId && sh.status === 'published' && sh.breakMinutes > 0);
  // 勤務と時間が重なるシフトを優先し、なければ労働日が同じシフト
  const overlap = cands.find((sh) => localDateTime(sh.date, sh.start) < end && localDateTime(sh.date, sh.end) > s.start);
  const sh = overlap ?? cands.find((x) => x.date === s.laborDate);
  if (!sh) return null;
  if (!sh.fixedBreakStart) return { shiftId: sh.id, start: null, end: null, minutes: sh.breakMinutes };
  const bs = localDateTime(sh.date, sh.fixedBreakStart);
  return { shiftId: sh.id, start: bs, end: bs + sh.breakMinutes * MINUTE_MS, minutes: sh.breakMinutes };
}

/**
 * v1.3 の休憩合成
 * - as_scheduled: 予定休憩を控除（打刻・手動休憩がある場合は二重控除を避けて予定休憩を加えない）
 * - not_taken: 休憩なし（打刻休憩があれば申告を優先し、矛盾として記録）
 * - custom: 申告した休憩区間を実際の休憩とする（打刻休憩・予定休憩は使わない。管理者登録の手動休憩は残す）
 * - 申告なし: 予定休憩は控除しない（予定休憩がある勤務は「取得未確認」として記録）
 */
function applyDeclarations(employeeId: Id, sessions: WorkSession[], shifts: Shift[], decls: BreakDeclaration[]) {
  const byKey = new Map<string, BreakDeclaration>();
  for (const d of decls) if (d.employeeId === employeeId && d.status === 'applied') {
    const prev = byKey.get(d.sessionKey);
    if (!prev || prev.createdAt <= d.createdAt) byKey.set(d.sessionKey, d);
  }
  for (const s of sessions) {
    const d = byKey.get(sessionKeyOf(s));
    const planned = plannedBreakFor(s, shifts);
    const hasPunch = s.breaks.some((b) => b.source === 'punch');
    if (!d) {
      if (planned && s.end !== null && s.breaks.length === 0) s.anomalies.push('planned_break_unconfirmed');
      continue;
    }
    if (d.kind === 'as_scheduled') {
      if (!planned) {
        s.anomalies.push('planned_break_missing');
        continue;
      }
      if (planned.start === null || planned.end === null) {
        s.anomalies.push('planned_break_time_unset');
        continue;
      }
      if (s.breaks.length > 0) {
        // 打刻・手動休憩がある勤務に予定休憩を重ねない（二重控除の防止）
        s.anomalies.push('planned_break_not_added_due_to_punch');
        continue;
      }
      if (s.end === null || planned.start < s.start || planned.end > s.end) {
        s.anomalies.push('fixed_break_outside_work');
        continue;
      }
      s.breaks.push({ start: planned.start, end: planned.end, source: 'fixed' });
      s.anomalies.push('planned_break_confirmed');
    } else if (d.kind === 'not_taken') {
      if (hasPunch) s.anomalies.push('break_declaration_overrides_punch');
      s.breaks = s.breaks.filter((b) => b.source === 'manual');
      s.anomalies.push('break_not_taken_declared');
    } else {
      if (hasPunch) s.anomalies.push('break_declaration_overrides_punch');
      s.breaks = s.breaks.filter((b) => b.source === 'manual');
      for (const iv of d.intervals) {
        const bs = parseIso(iv.start);
        const be = parseIso(iv.end);
        if (be <= bs) continue;
        if (bs < s.start || (s.end !== null && be > s.end)) {
          s.anomalies.push('declared_break_outside_work');
          continue;
        }
        s.breaks.push({ start: bs, end: be, source: 'declared' });
      }
      s.anomalies.push('breaks_declared');
    }
    if (d.identityVerified === false) s.anomalies.push('break_declared_unverified');
  }
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
  opts: { endBreakConfirmed?: boolean; now?: Instant; staleHours?: number } = {},
): { ok: true; autoBreakEnd: boolean; staleOpenSession?: boolean } | { ok: false; code: string; message: string } {
  const r = validateTransition(events, punch, opts);
  // 打刻時刻は秒単位。直前の打刻と同じ秒（以前）の打刻は順序が確定できないため受け付けない
  if (r.ok && opts.now !== undefined && events.length > 0 && events[events.length - 1]!.at >= opts.now) {
    return { ok: false, code: 'TOO_SOON', message: '直前の打刻と同じ時刻です。少し待ってからもう一度打刻してください' };
  }
  return r;
}

function validateTransition(
  events: EffectiveEvent[],
  punch: PunchType,
  opts: { endBreakConfirmed?: boolean; now?: Instant; staleHours?: number },
): { ok: true; autoBreakEnd: boolean; staleOpenSession?: boolean } | { ok: false; code: string; message: string } {
  const st = currentState(events);
  // 長時間（既定16時間超）退勤されていない勤務がある場合の出勤は、前回の打刻漏れとして新しい勤務を開始する
  if (punch === 'clock_in' && (st === 'working' || st === 'on_break') && opts.now !== undefined) {
    const os = openSessionStart(events);
    if (os !== null && opts.now - os > (opts.staleHours ?? 16) * HOUR_MS) return { ok: true, autoBreakEnd: false, staleOpenSession: true };
  }
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

/** 表示・操作用の状態: 長時間未退勤の勤務は「打刻漏れ」とみなし未出勤として扱う */
export function effectiveState(events: EffectiveEvent[], now: Instant, staleHours = 16): { state: WorkState; staleOpenSince: Instant | null } {
  const st = currentState(events);
  if (st === 'working' || st === 'on_break') {
    const os = openSessionStart(events);
    if (os !== null && now - os > staleHours * HOUR_MS) return { state: 'off', staleOpenSince: os };
  }
  return { state: st, staleOpenSince: null };
}
