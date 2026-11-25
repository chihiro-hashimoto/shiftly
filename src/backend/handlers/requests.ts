/**
 * 本人による勤怠修正・休憩の申告・早出残業申請と、その管理者確認（v1.3）
 * F09 勤怠修正・修正履歴（拡張）/ F07 休憩（拡張）/ F39 スタッフ本人の勤怠修正 / F40 早出・残業申請 / F41 シフト外勤務の確認
 *
 * 原則
 * - 打刻原本は変更しない。修正は attendance_corrections に差分として追記し、修正前後・理由・修正者・本人確認の有無を残す
 * - スタッフは自分の勤務だけを対象にできる（対象はサーバー側で本人の打刻から特定する。他人の ID を指定しても使わない）
 * - PIN 未設定（本人未確認）の申告は「承認待ち」として保存し、管理者の確認まで反映しない。応答に勤怠の詳細を含めない
 * - 給与確定済みの期間への修正は反映せず「訂正の申告」として保存する（確定済み給与は直接変更しない。給与の訂正フローで処理）
 * - 早出・残業申請の承認状態（status）と、実労働として確認されたか（workConfirmation）は別に保持する
 *   却下・差戻しは実労働の賃金不払いを意味しない（未確認のシフト外時間は給与確定を止める）
 */
import { defineOps } from '../api';
import { actorId, actorKindForRecord, audit, identityVerified, isOwner, nowIso, settings, staff, today, type Ctx } from '../context';
import { ApiError, E } from '../errors';
import * as v from '../validate';
import type { AttendanceCorrection, BreakDeclaration, Employee, OvertimeRequest, OvertimeRequestHistory, Shift, WorkSession } from '../../shared/types';
import { buildSessions, DEFAULT_SESSION_OPTIONS, effectiveEvents, plannedBreakFor, sessionKeyOf, type EffectiveEvent } from '../../shared/attendance';
import { addDays, HOUR_MS, localDateTime, parseIso, toIsoJst, toLocalDate, type LocalDate } from '../../shared/time';
import { applyTimeBasis, timeBasisView } from '../../shared/worktime';
import { confirmedPeriodFor, correctionDate, employeesInPeriod, loadEffective, loadEvents, reviewStatusOf, sessionsFor } from '../services';
import { sessionView } from './attendance';

const MAX_PAST_DAYS = 62;

function dt(a: v.Args, k: string, label: string): number {
  const s = a[k];
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) throw E.invalid(`${label}は YYYY-MM-DDTHH:MM 形式で入力してください`);
  return localDateTime(s.slice(0, 10), s.slice(11, 16));
}

/** 'YYYY-MM-DDTHH:MM' または 'YYYY-MM-DDTHH:MM:SS'（秒まで。シフト外の候補区間を正確に確認するため） */
function dtSec(a: v.Args, k: string, label: string): number {
  const s = a[k];
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) throw E.invalid(`${label}は YYYY-MM-DDTHH:MM(:SS) 形式で入力してください`);
  const sec = s.length === 19 ? Number(s.slice(17, 19)) : 0;
  if (sec > 59) throw E.invalid(`${label}の秒が不正です`);
  return localDateTime(s.slice(0, 10), s.slice(11, 16)) + sec * 1000;
}

function checkPastFuture(ctx: Ctx, t: number, label: string) {
  if (t > ctx.now + 60_000) throw E.invalid(`${label}に未来の日時は指定できません`);
  if (toLocalDate(t) < addDays(today(ctx), -MAX_PAST_DAYS)) throw E.invalid(`${label}は${MAX_PAST_DAYS}日以内の日時を指定してください`);
}

/** スタッフ本人の申告か（staff 以外＝管理者・Google 所有者） */
function self(ctx: Ctx): { employeeId: string; verified: boolean } {
  const s = staff(ctx);
  return { employeeId: s.employeeId, verified: s.verified };
}

function employeeOr404(ctx: Ctx, id: string): Employee {
  const e = ctx.uow.get<Employee>('employees', id);
  if (!e) throw E.notFound('スタッフ');
  return e;
}

/** 管理者側の操作で、スタッフ（委任）が自分自身を対象にすることを禁止 */
function forbidSelf(ctx: Ctx, employeeId: string, what: string) {
  if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden(`自分自身の${what}`);
}

function sessionsAround(ctx: Ctx, employeeId: string, d: LocalDate): WorkSession[] {
  return sessionsFor(ctx, employeeId, addDays(d, -1), addDays(d, 1));
}

function shiftsAround(ctx: Ctx, employeeId: string, d: LocalDate): Shift[] {
  return ctx.uow.list<Shift>('shifts').filter((s) => s.employeeId === employeeId && s.status === 'published' && s.date >= addDays(d, -1) && s.date <= addDays(d, 1));
}

// ------------------------------------------------------------------ 休憩の申告
export interface BreakDeclarationInput {
  kind: BreakDeclaration['kind'];
  intervals: Array<{ start: number; end: number }>;
  reason: string;
  /**
   * 「予定どおり」で、画面に表示していた予定休憩（undefined は未送信）。
   * 表示から送信までにシフトが変わった場合に、確認していない休憩を控除しないよう照合する（Codex 監査4）
   */
  expectedPlanned?: { start: string | null; end: string | null; minutes: number } | null;
}

export function readBreakDeclaration(a: v.Args): BreakDeclarationInput {
  const kind = v.oneOf(a, 'kind', ['as_scheduled', 'not_taken', 'custom'] as const, '休憩の取得状況');
  const raw = a.intervals;
  const intervals: Array<{ start: number; end: number }> = [];
  if (kind === 'custom') {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) throw E.invalid('実際の休憩時間を1〜6件入力してください');
    for (const x of raw) {
      const o = v.obj(x);
      const start = dt(o, 'start', '休憩開始');
      const end = dt(o, 'end', '休憩終了');
      if (end <= start) throw E.invalid('休憩終了は休憩開始より後にしてください');
      if (end - start > 6 * 3600_000) throw E.invalid('1回の休憩が長すぎます（6時間以内）');
      intervals.push({ start, end });
    }
    const sorted = [...intervals].sort((p, q) => p.start - q.start);
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.start < sorted[i - 1]!.end) throw E.invalid('休憩時間が重なっています');
  }
  const reason = kind === 'as_scheduled' ? v.optStr(a, 'reason', 300) : v.str(a, 'reason', { min: 2, max: 300, label: '理由' });
  let expectedPlanned: BreakDeclarationInput['expectedPlanned'];
  if (Object.prototype.hasOwnProperty.call(a, 'expectedPlanned')) {
    if (a.expectedPlanned === null) expectedPlanned = null;
    else {
      const o = v.obj(a.expectedPlanned);
      const hhmm = (k: string) => (o[k] === null || o[k] === undefined || o[k] === '' ? null : v.str(o, k, { max: 16, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, label: '予定休憩' }));
      expectedPlanned = { start: hhmm('start'), end: hhmm('end'), minutes: v.int(o, 'minutes', { min: 0, max: 600, label: '予定休憩（分）' }) };
    }
  }
  return { kind, intervals, reason, expectedPlanned };
}

/**
 * 休憩の申告を保存する。本人未確認の「予定どおり以外」の申告・確定済み期間の申告は承認待ち（未反映）
 * 予定どおり（as_scheduled）は通常の退勤操作で記録されるため、本人未確認でも反映する（本人未確認として記録・給与確定時に確認）
 */
export function saveBreakDeclaration(ctx: Ctx, employeeId: string, s: WorkSession, d: BreakDeclarationInput, shifts: Shift[], opts: { atClockOut?: boolean } = {}): BreakDeclaration {
  if (s.end !== null) {
    for (const iv of d.intervals) if (iv.start < s.start || iv.end > s.end) throw E.invalid('休憩は出勤から退勤までの時間内で入力してください');
    const total = d.intervals.reduce((x, iv) => x + (iv.end - iv.start), 0);
    if (total >= s.end - s.start) throw E.invalid('休憩時間が勤務時間以上になっています');
  }
  const verified = identityVerified(ctx);
  const confirmed = confirmedPeriodFor(ctx, s.laborDate);
  const byStaff = ctx.principal.kind === 'staff';
  if (d.kind === 'as_scheduled') {
    // 画面に表示した予定休憩と、現在の予定休憩が一致することを確認してから「予定どおり」を記録する（Codex 監査4）
    const cur = plannedBreakFor(s, shifts);
    const curView = cur ? { start: cur.start === null ? null : toIsoJst(cur.start).slice(0, 16), end: cur.end === null ? null : toIsoJst(cur.end).slice(0, 16), minutes: cur.minutes } : null;
    if (d.expectedPlanned === undefined) {
      if (byStaff) throw E.invalid('表示した予定休憩の情報がありません。画面を開き直してからもう一度操作してください');
    } else if (JSON.stringify(d.expectedPlanned) !== JSON.stringify(curView)) {
      throw new ApiError('PLANNED_BREAK_CHANGED', '予定休憩が変更されました。表示を更新しましたので、内容を確認してからもう一度操作してください', 409);
    }
  }
  // 本人未確認の申告で即時に反映するのは、退勤打刻と同じ処理で受け付けた「予定どおり」だけ（事後の申告はすべて承認待ち。Codex 監査2 #8）
  const pending = !!confirmed || (byStaff && !verified && !(d.kind === 'as_scheduled' && opts.atClockOut === true));
  const planned = plannedBreakFor(s, shifts);
  // 「予定どおり」は、申告の時点の予定休憩の区間を保存する（後からシフトを編集しても、確認した区間で控除する。Codex 監査2 #7）
  const intervals =
    d.kind === 'as_scheduled'
      ? planned && planned.start !== null && planned.end !== null
        ? [{ start: toIsoJst(planned.start), end: toIsoJst(planned.end) }]
        : []
      : d.intervals.map((iv) => ({ start: toIsoJst(iv.start), end: toIsoJst(iv.end) }));
  const decl = ctx.uow.insert<BreakDeclaration>(
    'break_declarations',
    {
      employeeId,
      sessionKey: sessionKeyOf(s),
      laborDate: s.laborDate,
      shiftId: planned?.shiftId ?? null,
      kind: d.kind,
      intervals,
      reason: d.reason,
      identityVerified: verified,
      actorId: actorId(ctx),
      actorKind: actorKindForRecord(ctx),
      status: pending ? 'pending' : 'applied',
      reviewStatus: pending ? 'pending' : byStaff ? 'unreviewed' : 'not_required',
      reviewedAt: null,
      reviewedBy: null,
      reviewComment: '',
    },
    'bdc',
  );
  if (!pending) supersedeOlderDeclarations(ctx, decl);
  audit(ctx, 'break.declare', 'break_declaration', decl.id, `${d.kind}${pending ? '（承認待ち）' : ''} 対象スタッフ=${employeeId}`);
  return decl;
}

function supersedeOlderDeclarations(ctx: Ctx, decl: BreakDeclaration) {
  for (const o of ctx.uow.list<BreakDeclaration>('break_declarations')) {
    if (o.id !== decl.id && o.employeeId === decl.employeeId && o.sessionKey === decl.sessionKey && o.status === 'applied') ctx.uow.update('break_declarations', { ...o, status: 'superseded' });
  }
}

/**
 * 打刻列から、現在開いている勤務の出勤打刻 ID（退勤時の休憩申告の対象）
 * 勤務の区切り方は buildSessions と同じにする: 勤務中の出勤でも、前の出勤から missingClockOutHours を超えていれば
 * 前の勤務は退勤打刻漏れとして閉じ、新しい勤務を開始する（前日の退勤漏れに当日の申告を付けない。Codex 監査6 #4）
 */
export function openSessionKey(evs: EffectiveEvent[], missingClockOutHours = DEFAULT_SESSION_OPTIONS.missingClockOutHours): string | null {
  let key: string | null = null;
  let start = 0;
  let working = false;
  for (const e of evs) {
    if (e.type === 'clock_in' && (!working || e.at - start > missingClockOutHours * HOUR_MS)) {
      key = e.id;
      start = e.at;
      working = true;
    } else if (e.type === 'clock_out' && working) {
      working = false;
    }
  }
  return working ? key : null;
}

// ------------------------------------------------------------------ 勤怠修正（本人）
interface SelfCorrectionResult {
  status: 'applied' | 'pending';
  groupId: string;
  warning: string | null;
}

function selfCorrect(ctx: Ctx, employeeId: string, a: v.Args): SelfCorrectionResult {
  const clockIn = dt(a, 'clockIn', '出勤日時');
  const clockOut = a.clockOut === null || a.clockOut === undefined || a.clockOut === '' ? null : dt(a, 'clockOut', '退勤日時');
  const reason = v.str(a, 'reason', { min: 2, max: 300, label: '修正理由' });
  checkPastFuture(ctx, clockIn, '出勤日時');
  if (clockOut !== null) {
    checkPastFuture(ctx, clockOut, '退勤日時');
    if (clockOut <= clockIn) throw E.invalid('退勤日時は出勤日時より後にしてください');
    if (clockOut - clockIn > 24 * 3600_000) throw E.invalid('1回の勤務は24時間以内で入力してください');
  }
  const d = toLocalDate(clockIn);
  const sessions = sessionsAround(ctx, employeeId, d);
  const requestedKey = typeof a.sessionKey === 'string' && a.sessionKey ? v.str(a, 'sessionKey', { max: 80 }) : null;
  // 対象勤務は本人の勤務からのみ特定する（他人の勤務キーを指定しても一致しない）
  let target: WorkSession | null = null;
  if (requestedKey) {
    target = sessions.find((s) => sessionKeyOf(s) === requestedKey) ?? null;
    if (!target) throw E.notFound('対象の勤務');
  } else {
    const end = clockOut ?? clockIn + 60_000;
    target = sessions.find((s) => s.start < end && (s.end ?? ctx.now) > clockIn) ?? null;
  }
  // 他の勤務と重ならない
  const others = sessions.filter((s) => s !== target);
  const newEnd = clockOut ?? ctx.now;
  if (others.some((s) => s.start < newEnd && (s.end ?? ctx.now) > clockIn)) throw E.invalid('他の勤務と時間が重なっています');

  const evs = loadEffective(ctx, employeeId, addDays(d, -2), addDays(d, 2));
  const groupId = `grp_${ctx.p.randomHex(8)}`;
  const confirmed = confirmedPeriodFor(ctx, d) ?? (target ? confirmedPeriodFor(ctx, target.laborDate) : null);
  const byStaff = ctx.principal.kind === 'staff';
  const verified = identityVerified(ctx);
  const pending = !!confirmed || (byStaff && !verified);
  const drafts: Array<Pick<AttendanceCorrection, 'action' | 'targetEventId' | 'newType' | 'newAt' | 'before'>> = [];
  const evById = new Map(evs.map((e) => [e.id, e]));
  if (target) {
    const inId = sessionKeyOf(target);
    const inEv = evById.get(inId);
    if (inEv && inEv.at !== clockIn) drafts.push({ action: 'replace', targetEventId: inId, newType: 'clock_in', newAt: toIsoJst(clockIn), before: JSON.stringify({ type: 'clock_in', at: toIsoJst(inEv.at) }) });
    if (target.end !== null) {
      const outEv = evs.find((e) => e.type === 'clock_out' && e.at === target!.end && target!.eventIds.includes(e.id));
      if (clockOut === null) throw E.invalid('退勤済みの勤務です。退勤日時を入力してください');
      if (outEv && outEv.at !== clockOut) drafts.push({ action: 'replace', targetEventId: outEv.id, newType: 'clock_out', newAt: toIsoJst(clockOut), before: JSON.stringify({ type: 'clock_out', at: toIsoJst(outEv.at) }) });
    } else if (clockOut !== null) {
      drafts.push({ action: 'add', targetEventId: null, newType: 'clock_out', newAt: toIsoJst(clockOut), before: '' });
    }
  } else {
    // 打刻漏れ（出勤・退勤とも記録がない）
    drafts.push({ action: 'add', targetEventId: null, newType: 'clock_in', newAt: toIsoJst(clockIn), before: '' });
    if (clockOut !== null) drafts.push({ action: 'add', targetEventId: null, newType: 'clock_out', newAt: toIsoJst(clockOut), before: '' });
  }
  if (!drafts.length) throw E.invalid('修正内容が現在の記録と同じです');

  // 修正後の勤務が正しく構成されるか検証（反映前に模擬）
  const meta = { createdAt: nowIso(ctx), updatedAt: nowIso(ctx), version: 1 };
  const simCors: AttendanceCorrection[] = [
    ...ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.employeeId === employeeId),
    ...drafts.map((x, i) => ({ ...meta, id: `sim${i}`, employeeId, ...x, reason, actorId: 'sim', actorKind: 'staff' as const, status: 'applied' as const, after: '' })),
  ];
  const originals = loadEvents(ctx, addDays(d, -2), addDays(d, 2)).filter((e) => e.employeeId === employeeId);
  const sim = buildSessions(employeeId, effectiveEvents(originals, simCors), [], [], { ...DEFAULT_SESSION_OPTIONS, businessDayCutoff: settings(ctx).businessDayCutoff, now: ctx.now });
  const ok = sim.some((s) => s.start === clockIn && (clockOut === null ? s.end === null : s.end === clockOut) && !s.anomalies.includes('duplicate_clock_in'));
  if (!ok) throw E.invalid('修正後の勤務を正しく組み立てられません（出勤・退勤の順序や他の打刻との関係を確認してください）');

  const sessionKey = target ? sessionKeyOf(target) : null;
  for (const x of drafts) {
    ctx.uow.insert<AttendanceCorrection>(
      'attendance_corrections',
      {
        employeeId,
        ...x,
        reason,
        actorId: actorId(ctx),
        actorKind: actorKindForRecord(ctx),
        status: pending ? 'pending' : 'applied',
        after: JSON.stringify({ type: x.newType, at: x.newAt }),
        identityVerified: verified,
        reviewStatus: pending ? 'pending' : byStaff ? 'unreviewed' : 'not_required',
        reviewedAt: null,
        reviewedBy: null,
        reviewComment: '',
        groupId,
        sessionKey,
      },
      'cor',
    );
  }
  audit(ctx, 'attendance.self_correct', 'attendance_correction', groupId, `${drafts.length}件${pending ? '（承認待ち）' : ''}${verified ? '' : '（本人未確認）'}`);
  return {
    status: pending ? 'pending' : 'applied',
    groupId,
    warning: confirmed ? `給与確定済みの期間（${confirmed.periodKey}）のため、訂正の申告として保存しました。管理者が確認し、給与の訂正を行います` : null,
  };
}

// ------------------------------------------------------------------ 早出・残業申請
function overlapsActive(ctx: Ctx, employeeId: string, s: number, e: number, exceptId?: string): OvertimeRequest | null {
  return (
    ctx.uow
      .list<OvertimeRequest>('overtime_requests')
      .filter((r) => r.employeeId === employeeId && r.id !== exceptId && (r.status === 'pending' || r.status === 'approved' || r.status === 'confirmed' || r.status === 'returned'))
      .find((r) => parseIso(r.requestedStart) < e && parseIso(r.requestedEnd) > s) ?? null
  );
}

function history(ctx: Ctx, req: OvertimeRequest, action: OvertimeRequestHistory['action'], before: OvertimeRequest | null, comment: string) {
  const pick = (r: OvertimeRequest | null) =>
    r ? JSON.stringify({ status: r.status, workConfirmation: r.workConfirmation, requestedStart: r.requestedStart, requestedEnd: r.requestedEnd, approvedStart: r.approvedStart, approvedEnd: r.approvedEnd, category: r.category }) : '';
  ctx.uow.insert<OvertimeRequestHistory>('overtime_request_history', { requestId: req.id, action, actorId: actorId(ctx), actorKind: actorKindForRecord(ctx), before: pick(before), after: pick(req), comment }, 'orh');
}

const CATEGORIES = ['early', 'late', 'no_shift', 'between', 'other'] as const;

function readRequestInterval(ctx: Ctx, a: v.Args) {
  const start = dt(a, 'start', '勤務開始日時');
  const end = dt(a, 'end', '勤務終了日時');
  if (end <= start) throw E.invalid('勤務終了日時は開始日時より後にしてください');
  if (end - start > 12 * 3600_000) throw E.invalid('1件の申請は12時間以内で入力してください');
  checkPastFuture(ctx, start, '勤務開始日時');
  checkPastFuture(ctx, end, '勤務終了日時');
  return { start, end };
}

/** 申請区間と重なる本人の勤務・シフト（サーバー側で特定） */
function locate(ctx: Ctx, employeeId: string, start: number, end: number): { sessionKey: string | null; shiftId: string | null; workDate: LocalDate } {
  const d = toLocalDate(start);
  const ss = sessionsAround(ctx, employeeId, d);
  const s = ss.find((x) => x.start < end + 1 && (x.end ?? ctx.now) > start - 1) ?? null;
  const shifts = shiftsAround(ctx, employeeId, d);
  const sh = shifts.find((x) => localDateTime(x.date, x.start) <= end + 12 * 3600_000 && localDateTime(x.date, x.end) >= start - 12 * 3600_000 && (s ? x.date === s.laborDate : true)) ?? null;
  return { sessionKey: s ? sessionKeyOf(s) : null, shiftId: sh?.id ?? null, workDate: s?.laborDate ?? d };
}

function submitRequest(ctx: Ctx, employeeId: string, a: v.Args): OvertimeRequest {
  const category = v.oneOf(a, 'category', CATEGORIES, '申請区分');
  const { start, end } = readRequestInterval(ctx, a);
  const reason = v.str(a, 'reason', { min: 2, max: 300, label: '申請理由' });
  const dup = overlapsActive(ctx, employeeId, start, end);
  if (dup) throw E.conflict('同じ時間帯の申請・確認がすでにあります（重複して申請できません）');
  const loc = locate(ctx, employeeId, start, end);
  const r = ctx.uow.insert<OvertimeRequest>(
    'overtime_requests',
    {
      employeeId,
      sessionKey: loc.sessionKey,
      workDate: loc.workDate,
      shiftId: loc.shiftId,
      category,
      requestedStart: toIsoJst(start),
      requestedEnd: toIsoJst(end),
      reason,
      identityVerified: identityVerified(ctx),
      requestedBy: actorId(ctx),
      requestedByKind: actorKindForRecord(ctx),
      status: 'pending',
      workConfirmation: 'unconfirmed',
      approvedStart: null,
      approvedEnd: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewComment: '',
      parentRequestId: null,
    },
    'otr',
  );
  history(ctx, r, 'submit', null, reason);
  audit(ctx, 'overtime.request', 'overtime_request', r.id, `${category}${r.identityVerified ? '' : '（本人未確認）'} 対象スタッフ=${employeeId}`);
  return r;
}

function requestView(r: OvertimeRequest, names?: Map<string, string>) {
  const mins = (s: string | null, e: string | null) => (s && e ? Math.round((parseIso(e) - parseIso(s)) / 60000) : 0);
  return {
    ...r,
    displayName: names?.get(r.employeeId) ?? undefined,
    requestedMinutes: mins(r.requestedStart, r.requestedEnd),
    approvedMinutes: r.workConfirmation === 'work' ? mins(r.approvedStart, r.approvedEnd) : 0,
    partial: r.workConfirmation === 'work' && (r.approvedStart !== r.requestedStart || r.approvedEnd !== r.requestedEnd),
  };
}

// ------------------------------------------------------------------ 勤務の詳細（本人・管理者共通）
function sessionDetails(ctx: Ctx, employeeId: string, from: LocalDate, to: LocalDate) {
  const st = settings(ctx);
  const sessions = sessionsFor(ctx, employeeId, from, to, st);
  const shifts = ctx.uow.list<Shift>('shifts').filter((x) => x.employeeId === employeeId && x.status === 'published' && x.date >= addDays(from, -1) && x.date <= addDays(to, 1));
  const reqs = ctx.uow.list<OvertimeRequest>('overtime_requests').filter((r) => r.employeeId === employeeId);
  const tb = applyTimeBasis(sessions, shifts, reqs, 'shift');
  const originals = loadEvents(ctx, from, addDays(to, 1)).filter((e) => e.employeeId === employeeId);
  const origById = new Map(originals.map((e) => [e.id, e]));
  const cors = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.employeeId === employeeId);
  const decls = ctx.uow.list<BreakDeclaration>('break_declarations').filter((d) => d.employeeId === employeeId);
  const rows = sessions.map((s) => {
    const key = sessionKeyOf(s);
    const detail = tb.details.find((x) => x.sessionKey === key) ?? null;
    const planned = plannedBreakFor(s, shifts);
    const decl = decls.filter((d) => d.sessionKey === key && d.status !== 'superseded').sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0] ?? null;
    const relatedCors = cors.filter((c) => c.sessionKey === key || (c.targetEventId !== null && s.eventIds.includes(c.targetEventId)));
    const inOrig = origById.get(key) ?? null;
    const outOrig = s.eventIds.map((id) => origById.get(id)).find((e) => e && e.type === 'clock_out') ?? null;
    return {
      sessionKey: key,
      ...sessionView(s, ctx.now),
      original: { clockIn: inOrig?.at ?? null, clockOut: outOrig?.at ?? null },
      corrected: relatedCors.some((c) => c.status === 'applied'),
      corrections: relatedCors.map((c) => ({ id: c.id, groupId: c.groupId ?? null, action: c.action, newType: c.newType, newAt: c.newAt, before: c.before, reason: c.reason, status: c.status, reviewStatus: reviewStatusOf(c), identityVerified: c.identityVerified !== false, createdAt: c.createdAt, actorKind: c.actorKind })),
      plannedBreak: planned ? { minutes: planned.minutes, start: planned.start === null ? null : toIsoJst(planned.start), end: planned.end === null ? null : toIsoJst(planned.end) } : null,
      breakDeclaration: decl ? { id: decl.id, kind: decl.kind, status: decl.status, reviewStatus: decl.reviewStatus, intervals: decl.intervals, reason: decl.reason, identityVerified: decl.identityVerified } : null,
      timeBasis: detail ? timeBasisView(detail) : null,
      requests: reqs.filter((r) => r.sessionKey === key || (s.end !== null && parseIso(r.requestedStart) < s.end && parseIso(r.requestedEnd) > s.start)).map((r) => requestView(r)),
    };
  });
  // 出勤記録のない公開シフト（打刻漏れの申告用）
  const missing = shifts
    .filter((sh) => sh.date >= from && sh.date <= to && localDateTime(sh.date, sh.end) <= ctx.now)
    .filter((sh) => !sessions.some((s) => s.start < localDateTime(sh.date, sh.end) && (s.end ?? ctx.now) > localDateTime(sh.date, sh.start)))
    .map((sh) => ({ shiftId: sh.id, date: sh.date, start: sh.start, end: sh.end, breakMinutes: sh.breakMinutes }));
  return { basis: st.payrollTimeBasis, breakMode: st.breakMode, sessions: rows, shiftsWithoutAttendance: missing };
}

// ------------------------------------------------------------------ 管理者の確認
function reviewCorrectionGroup(ctx: Ctx, key: string, action: 'approve' | 'reject', comment: string) {
  const all = ctx.uow.list<AttendanceCorrection>('attendance_corrections');
  const group = all.filter((c) => c.groupId === key || c.id === key);
  if (!group.length) throw E.notFound('勤怠修正');
  const employeeId = group[0]!.employeeId;
  forbidSelf(ctx, employeeId, '勤怠修正の確認');
  let warning: string | null = null;
  for (const c of group) {
    const rs = reviewStatusOf(c);
    if (rs !== 'pending' && rs !== 'unreviewed') continue;
    const d = correctionDate(c);
    const cp = d ? confirmedPeriodFor(ctx, d) : null;
    if (cp) warning = `給与確定済みの期間（${cp.periodKey}）の勤怠です。給与計算画面で訂正を行ってください`;
    ctx.uow.update('attendance_corrections', {
      ...c,
      status: action === 'approve' ? 'applied' : 'rejected',
      reviewStatus: action === 'approve' ? 'approved' : 'rejected',
      reviewedAt: nowIso(ctx),
      reviewedBy: actorId(ctx),
      reviewComment: comment,
    });
  }
  audit(ctx, `attendance.review_${action}`, 'attendance_correction', key, `対象スタッフ=${employeeId}`);
  return { ok: true, warning };
}

function reviewDeclaration(ctx: Ctx, id: string, action: 'approve' | 'reject', comment: string) {
  const d = ctx.uow.get<BreakDeclaration>('break_declarations', id);
  if (!d) throw E.notFound('休憩の申告');
  forbidSelf(ctx, d.employeeId, '休憩申告の確認');
  if (d.status === 'superseded') throw E.conflict('新しい申告に置き換えられています');
  const next: BreakDeclaration = {
    ...d,
    status: action === 'approve' ? 'applied' : 'rejected',
    reviewStatus: action === 'approve' ? 'approved' : 'rejected',
    reviewedAt: nowIso(ctx),
    reviewedBy: actorId(ctx),
    reviewComment: comment,
  };
  ctx.uow.update('break_declarations', next);
  if (action === 'approve') supersedeOlderDeclarations(ctx, next);
  const cp = confirmedPeriodFor(ctx, d.laborDate);
  audit(ctx, `break.review_${action}`, 'break_declaration', id, `対象スタッフ=${d.employeeId}`);
  return { ok: true, warning: cp ? `給与確定済みの期間（${cp.periodKey}）の勤怠です。給与計算画面で訂正を行ってください` : null };
}

defineOps([
  // ============================================================ スタッフ本人
  {
    // 退勤時の休憩確認に使う予定休憩（公開シフトの情報のみ。本人未確認でも可）
    name: 'attendance.clockOutContext',
    auth: 'session',
    allowUnverified: true,
    perms: ['punch_self'],
    mutating: false,
    handler: (ctx) => {
      const me = self(ctx);
      const st = settings(ctx);
      const d = today(ctx);
      const sessions = sessionsFor(ctx, me.employeeId, addDays(d, -1), d, st);
      // 退勤時に申告を保存する勤務（openSessionKey）と同じ勤務を選ぶ（前日の退勤打刻漏れの勤務を選ばない。Codex 監査6 #4）
      const openKey = openSessionKey(loadEffective(ctx, me.employeeId, addDays(d, -3), d));
      const open = (openKey && sessions.find((s) => s.end === null && sessionKeyOf(s) === openKey)) || null;
      if (!open) return { breakMode: st.breakMode, open: false, plannedBreak: null, hasPunchedBreaks: false };
      // 退勤時の保存と同じ勤務区間（出勤〜現在）で予定休憩を選ぶ（同じ日に複数のシフトがある場合の取り違え防止）
      const planned = plannedBreakFor(open, shiftsAround(ctx, me.employeeId, open.laborDate), Math.floor(ctx.now / 1000) * 1000);
      return {
        breakMode: st.breakMode,
        open: true,
        plannedBreak: planned ? { minutes: planned.minutes, start: planned.start === null ? null : toIsoJst(planned.start), end: planned.end === null ? null : toIsoJst(planned.end) } : null,
        hasPunchedBreaks: open.breaks.some((b) => b.source === 'punch'),
      };
    },
  },
  {
    // 自分の勤怠の詳細（登録シフト・元の打刻・修正後・休憩・シフト外の候補・申請状況）。本人確認済みのみ
    name: 'attendance.myDetails',
    auth: 'session',
    perms: ['attendance_view_self'],
    mutating: false,
    handler: (ctx, raw) => {
      const { from, to } = v.range(v.obj(raw), MAX_PAST_DAYS);
      return sessionDetails(ctx, self(ctx).employeeId, from, to);
    },
  },
  {
    // 本人による勤怠修正（出勤・退勤・打刻漏れ）。本人未確認・確定済み期間は承認待ち
    name: 'attendance.selfCorrect',
    auth: 'session',
    allowUnverified: true,
    perms: ['punch_self'],
    mutating: true,
    handler: (ctx, raw) => {
      const me = self(ctx);
      const r = selfCorrect(ctx, me.employeeId, v.obj(raw));
      // 本人未確認の場合は勤怠の詳細を返さない
      return me.verified ? r : { status: r.status };
    },
  },
  {
    // 休憩の取得状況の申告（予定どおり・取れなかった・短い/長い/時間帯が違う/追加）
    name: 'breaks.declare',
    auth: 'session',
    allowUnverified: true,
    perms: ['punch_self'],
    mutating: true,
    handler: (ctx, raw) => {
      const me = self(ctx);
      const a = v.obj(raw);
      const d = readBreakDeclaration(a);
      const day = v.date(a, 'workDate', { label: '勤務日' });
      if (day < addDays(today(ctx), -MAX_PAST_DAYS) || day > today(ctx)) throw E.invalid(`勤務日は${MAX_PAST_DAYS}日以内で指定してください`);
      const sessions = sessionsAround(ctx, me.employeeId, day);
      const key = typeof a.sessionKey === 'string' && a.sessionKey ? v.str(a, 'sessionKey', { max: 80 }) : null;
      const s = key
        ? sessions.find((x) => sessionKeyOf(x) === key)
        : sessions.find((x) => x.laborDate === day && (d.intervals.length === 0 || (x.start <= d.intervals[0]!.start && (x.end ?? ctx.now) >= d.intervals[0]!.end)));
      if (!s) throw E.notFound('対象の勤務');
      const decl = saveBreakDeclaration(ctx, me.employeeId, s, d, shiftsAround(ctx, me.employeeId, s.laborDate));
      return me.verified ? { id: decl.id, status: decl.status } : { status: decl.status };
    },
  },
  {
    name: 'overtime.request',
    auth: 'session',
    allowUnverified: true,
    perms: ['punch_self'],
    mutating: true,
    handler: (ctx, raw) => {
      const me = self(ctx);
      const r = submitRequest(ctx, me.employeeId, v.obj(raw));
      return me.verified ? requestView(r) : { status: r.status };
    },
  },
  {
    name: 'overtime.mine',
    auth: 'session',
    perms: ['attendance_view_self'],
    mutating: false,
    handler: (ctx) => {
      const me = self(ctx);
      const since = addDays(today(ctx), -90);
      return ctx.uow
        .list<OvertimeRequest>('overtime_requests')
        .filter((r) => r.employeeId === me.employeeId && r.workDate >= since)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((r) => requestView(r));
    },
  },
  {
    // 自分の申請の取消（申請中・差戻しのみ）
    name: 'overtime.cancel',
    auth: 'session',
    perms: ['attendance_view_self'],
    mutating: true,
    handler: (ctx, raw) => {
      const me = self(ctx);
      const r = ctx.uow.get<OvertimeRequest>('overtime_requests', v.id(v.obj(raw), 'requestId'));
      if (!r || r.employeeId !== me.employeeId) throw E.notFound('申請');
      if (r.status !== 'pending' && r.status !== 'returned') throw E.conflict('処理済みの申請は取り消せません');
      const next = { ...r, status: 'cancelled' as const };
      ctx.uow.update('overtime_requests', next);
      history(ctx, next, 'cancel', r, '本人による取消');
      audit(ctx, 'overtime.cancel', 'overtime_request', r.id, '本人による取消');
      return requestView(next);
    },
  },
  {
    // 差戻しされた申請の修正・再申請
    name: 'overtime.resubmit',
    auth: 'session',
    perms: ['attendance_view_self'],
    mutating: true,
    handler: (ctx, raw) => {
      const me = self(ctx);
      const a = v.obj(raw);
      const r = ctx.uow.get<OvertimeRequest>('overtime_requests', v.id(a, 'requestId'));
      if (!r || r.employeeId !== me.employeeId) throw E.notFound('申請');
      if (r.status !== 'returned') throw E.conflict('差戻しされた申請のみ再申請できます');
      const { start, end } = readRequestInterval(ctx, a);
      if (overlapsActive(ctx, me.employeeId, start, end, r.id)) throw E.conflict('同じ時間帯の申請・確認がすでにあります');
      const loc = locate(ctx, me.employeeId, start, end);
      const next: OvertimeRequest = {
        ...r,
        ...loc,
        category: v.oneOf(a, 'category', CATEGORIES, '申請区分'),
        requestedStart: toIsoJst(start),
        requestedEnd: toIsoJst(end),
        reason: v.str(a, 'reason', { min: 2, max: 300, label: '申請理由' }),
        status: 'pending',
        identityVerified: identityVerified(ctx),
      };
      ctx.uow.update('overtime_requests', next);
      history(ctx, next, 'resubmit', r, next.reason);
      audit(ctx, 'overtime.resubmit', 'overtime_request', r.id, '再申請');
      return requestView(next);
    },
  },
  // ============================================================ 管理者
  {
    name: 'overtime.list',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all', 'attendance_edit'],
    mutating: false,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const status = typeof a.status === 'string' && a.status !== 'all' ? v.oneOf(a, 'status', ['pending', 'approved', 'returned', 'rejected', 'cancelled', 'confirmed'] as const) : null;
      const hasRange = typeof a.from === 'string';
      const rng = hasRange ? v.range(a, 400) : null;
      const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e.displayName]));
      const hist = ctx.uow.list<OvertimeRequestHistory>('overtime_request_history');
      return ctx.uow
        .list<OvertimeRequest>('overtime_requests')
        .filter((r) => (!status || r.status === status) && (!rng || (r.workDate >= rng.from && r.workDate <= rng.to)))
        .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
        .slice(0, 500)
        .map((r) => ({ ...requestView(r, names), history: hist.filter((h) => h.requestId === r.id).sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1)) }));
    },
  },
  {
    // 承認・一部承認・差戻し・却下・取消（管理者の確認）
    name: 'overtime.review',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const r = ctx.uow.get<OvertimeRequest>('overtime_requests', v.id(a, 'requestId'));
      if (!r) throw E.notFound('申請');
      forbidSelf(ctx, r.employeeId, '早出・残業申請の確認');
      const action = v.oneOf(a, 'action', ['approve', 'partial', 'return', 'reject', 'cancel'] as const, '処理');
      // 一部承認の残りの扱い（明示的に選ぶ。既定で「実労働なし」にしない。Codex 監査2 #6）
      const remainder = action === 'partial' ? v.oneOf(a, 'remainder', ['no_work', 'unconfirmed'] as const, '残りの時間の扱い') : null;
      const comment = action === 'approve' ? v.optStr(a, 'comment', 300) : v.str(a, 'comment', { min: 2, max: 300, label: 'コメント・理由' });
      if (r.status === 'cancelled') throw E.conflict('取り消された申請です');
      if (r.parentRequestId) throw E.invalid('一部承認の残りの確認は、元の申請から処理してください');
      // 再審査: 以前の一部承認で作った「残りは実労働なし」の確認を失効させてから新しい判断を反映する（履歴は残す。Codex 監査3 #3）
      // 互換: parentRequestId の列がない形式（開発中の版）で作った残りの確認は、理由欄の申請 ID でひも付ける
      const isChild = (x: OvertimeRequest) => x.parentRequestId === r.id || (!x.parentRequestId && x.reason.startsWith(`一部承認の残り（申請 ${r.id}）`));
      for (const child of ctx.uow.list<OvertimeRequest>('overtime_requests').filter((x) => x.id !== r.id && isChild(x) && x.status !== 'cancelled')) {
        const cancelled: OvertimeRequest = { ...child, status: 'cancelled', reviewedBy: actorId(ctx), reviewedAt: nowIso(ctx), reviewComment: `元の申請の再審査により失効: ${comment}` };
        ctx.uow.update('overtime_requests', cancelled);
        history(ctx, cancelled, 'cancel', child, '元の申請の再審査により失効');
      }
      const base = { ...r, reviewedBy: actorId(ctx), reviewedAt: nowIso(ctx), reviewComment: comment };
      let next: OvertimeRequest;
      let act: OvertimeRequestHistory['action'];
      if (action === 'approve' || action === 'partial') {
        let s = parseIso(r.requestedStart);
        let e = parseIso(r.requestedEnd);
        if (action === 'partial') {
          s = dt(a, 'approvedStart', '承認する開始日時');
          e = dt(a, 'approvedEnd', '承認する終了日時');
          if (e <= s) throw E.invalid('承認する終了日時は開始日時より後にしてください');
          if (s < parseIso(r.requestedStart) || e > parseIso(r.requestedEnd)) throw E.invalid('一部承認は申請された時間の範囲内で指定してください（範囲外の勤務は管理者の勤務確認で登録してください）');
        }
        next = { ...base, status: 'approved', workConfirmation: 'work', approvedStart: toIsoJst(s), approvedEnd: toIsoJst(e) };
        act = action === 'partial' ? 'partial_approve' : 'approve';
      } else if (action === 'return') {
        next = { ...base, status: 'returned', workConfirmation: 'unconfirmed', approvedStart: null, approvedEnd: null };
        act = 'return';
      } else if (action === 'reject') {
        // 却下: 申請内容の扱い。実労働の有無は別に確認する（未確認のままなら給与確定を止める）
        const wc = v.oneOf(a, 'workConfirmation', ['no_work', 'unconfirmed'] as const, '実労働の確認');
        next = { ...base, status: 'rejected', workConfirmation: wc, approvedStart: null, approvedEnd: null };
        act = 'reject';
      } else {
        next = { ...base, status: 'cancelled', workConfirmation: 'unconfirmed', approvedStart: null, approvedEnd: null };
        act = 'cancel';
      }
      ctx.uow.update('overtime_requests', next);
      history(ctx, next, act, r, comment);
      if (remainder === 'no_work' && next.approvedStart && next.approvedEnd) {
        // 残りの時間を「実労働なし」と確認した記録を別に残す（承認した区間と明示的に区別する）
        const rest: Array<[number, number]> = [
          [parseIso(r.requestedStart), parseIso(next.approvedStart)],
          [parseIso(next.approvedEnd), parseIso(r.requestedEnd)],
        ];
        for (const [rs, re] of rest.filter(([x, y]) => y > x)) {
          const c = ctx.uow.insert<OvertimeRequest>(
            'overtime_requests',
            {
              employeeId: r.employeeId,
              sessionKey: r.sessionKey,
              workDate: r.workDate,
              shiftId: r.shiftId,
              category: r.category,
              requestedStart: toIsoJst(rs),
              requestedEnd: toIsoJst(re),
              reason: `一部承認の残り: ${comment}`,
              parentRequestId: r.id,
              identityVerified: true,
              requestedBy: actorId(ctx),
              requestedByKind: actorKindForRecord(ctx),
              status: 'confirmed',
              workConfirmation: 'no_work',
              approvedStart: null,
              approvedEnd: null,
              reviewedBy: actorId(ctx),
              reviewedAt: nowIso(ctx),
              reviewComment: comment,
            },
            'otr',
          );
          history(ctx, c, 'confirm_no_work', null, comment);
        }
      }
      audit(ctx, `overtime.${act}`, 'overtime_request', r.id, `対象スタッフ=${r.employeeId}${remainder ? ` 残り=${remainder}` : ''}`);
      const cp = confirmedPeriodFor(ctx, r.workDate);
      return { request: requestView(next), warning: cp ? `給与確定済みの期間（${cp.periodKey}）の勤務です。給与計算画面で訂正を行ってください` : null };
    },
  },
  {
    // シフト外の勤務候補（未申請を含む）と確認状況
    name: 'offshift.list',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all', 'attendance_edit'],
    mutating: false,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const { from, to } = v.range(a, MAX_PAST_DAYS);
      const only = typeof a.employeeId === 'string' ? v.id(a, 'employeeId') : null;
      const unresolvedOnly = v.bool(a, 'unresolvedOnly');
      // 期間内に在籍したスタッフ（退職者を含む。退職前の勤務の確認ができるように。Codex 監査3 #6）
      const emps = employeesInPeriod(ctx, from, to).filter((e) => !only || e.id === only);
      const rows: unknown[] = [];
      for (const e of emps) {
        const det = sessionDetails(ctx, e.id, from, to);
        for (const s of det.sessions) {
          const tb = s.timeBasis;
          if (!tb || !tb.candidates.length) continue;
          if (unresolvedOnly && tb.unresolvedMs === 0) continue;
          rows.push({ employeeId: e.id, displayName: e.displayName, laborDate: s.laborDate, sessionKey: s.sessionKey, start: s.start, end: s.end, original: s.original, timeBasis: tb, requests: s.requests });
        }
      }
      return { basis: settings(ctx).payrollTimeBasis, rows };
    },
  },
  {
    // 管理者による実労働の確認・登録（申請がなくても可）。items で一括
    name: 'offshift.confirm',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const items = a.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw E.invalid('確認する項目を1〜100件指定してください');
      const comment = v.str(a, 'comment', { min: 2, max: 300, label: '確認内容・理由' });
      const out: OvertimeRequest[] = [];
      for (const x of items) {
        const o = v.obj(x);
        const employeeId = v.id(o, 'employeeId');
        employeeOr404(ctx, employeeId);
        forbidSelf(ctx, employeeId, '勤務確認');
        const result = v.oneOf(o, 'result', ['work', 'no_work'] as const, '確認結果');
        const category = v.oneOf(o, 'category', CATEGORIES, '区分');
        // 秒まで受け付ける（同じ分にある別の候補区間まで確認済みにしない。Codex 監査3 #2）
        const start = dtSec(o, 'start', '開始日時');
        const end = dtSec(o, 'end', '終了日時');
        if (end <= start || end - start > 24 * 3600_000) throw E.invalid('確認する時間帯が不正です');
        if (end > ctx.now + 60_000) throw E.invalid('未来の時間は確認できません');
        const loc = locate(ctx, employeeId, start, end);
        const r = ctx.uow.insert<OvertimeRequest>(
          'overtime_requests',
          {
            employeeId,
            sessionKey: loc.sessionKey,
            workDate: loc.workDate,
            shiftId: loc.shiftId,
            category,
            requestedStart: toIsoJst(start),
            requestedEnd: toIsoJst(end),
            reason: comment,
            identityVerified: true,
            requestedBy: actorId(ctx),
            requestedByKind: actorKindForRecord(ctx),
            status: 'confirmed',
            workConfirmation: result,
            approvedStart: result === 'work' ? toIsoJst(start) : null,
            approvedEnd: result === 'work' ? toIsoJst(end) : null,
            reviewedBy: actorId(ctx),
            reviewedAt: nowIso(ctx),
            reviewComment: comment,
            parentRequestId: null,
          },
          'otr',
        );
        history(ctx, r, result === 'work' ? 'confirm_work' : 'confirm_no_work', null, comment);
        out.push(r);
      }
      audit(ctx, 'offshift.confirm', 'overtime_request', null, `${out.length}件（実労働 ${out.filter((r) => r.workConfirmation === 'work').length}件）`);
      const warn = out.map((r) => confirmedPeriodFor(ctx, r.workDate)).find((p) => p);
      return { confirmed: out.map((r) => requestView(r)), warning: warn ? `給与確定済みの期間（${warn.periodKey}）を含みます。給与計算画面で訂正を行ってください` : null };
    },
  },
  {
    // スタッフの勤怠詳細（管理者）
    name: 'attendance.staffDetails',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all', 'attendance_edit'],
    mutating: false,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      employeeOr404(ctx, employeeId);
      const { from, to } = v.range(a, MAX_PAST_DAYS);
      return sessionDetails(ctx, employeeId, from, to);
    },
  },
  {
    // 確認が必要な本人修正・休憩申告
    name: 'attendance.reviewList',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all', 'attendance_edit'],
    mutating: false,
    handler: (ctx, raw) => {
      const all = v.bool(v.obj(raw), 'includeReviewed');
      const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e.displayName]));
      const cors = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.actorKind === 'staff' && (all || reviewStatusOf(c) === 'pending' || reviewStatusOf(c) === 'unreviewed'));
      const groups = new Map<string, AttendanceCorrection[]>();
      for (const c of cors) groups.set(c.groupId ?? c.id, [...(groups.get(c.groupId ?? c.id) ?? []), c]);
      const decls = ctx.uow
        .list<BreakDeclaration>('break_declarations')
        .filter((d) => d.actorKind === 'staff' && d.status !== 'superseded' && (all || d.reviewStatus === 'pending' || (d.reviewStatus === 'unreviewed' && d.kind !== 'as_scheduled') || (!d.identityVerified && d.reviewStatus === 'unreviewed')));
      return {
        corrections: [...groups.entries()]
          .map(([groupId, cs]) => ({
            groupId,
            employeeId: cs[0]!.employeeId,
            displayName: names.get(cs[0]!.employeeId) ?? '',
            createdAt: cs[0]!.createdAt,
            reason: cs[0]!.reason,
            identityVerified: cs[0]!.identityVerified !== false,
            status: cs[0]!.status,
            reviewStatus: reviewStatusOf(cs[0]!),
            reviewComment: cs[0]!.reviewComment ?? '',
            items: cs.map((c) => ({ id: c.id, action: c.action, newType: c.newType, newAt: c.newAt, before: c.before })),
          }))
          .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
          .slice(0, 300),
        breakDeclarations: decls
          .map((d) => ({ ...d, displayName: names.get(d.employeeId) ?? '' }))
          .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
          .slice(0, 300),
      };
    },
  },
  {
    name: 'attendance.review',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const kind = v.oneOf(a, 'kind', ['correction', 'break'] as const, '種別');
      const action = v.oneOf(a, 'action', ['approve', 'reject'] as const, '処理');
      const comment = action === 'approve' ? v.optStr(a, 'comment', 300) : v.str(a, 'comment', { min: 2, max: 300, label: '却下の理由' });
      const id = v.str(a, 'id', { max: 80, label: '対象' });
      return kind === 'correction' ? reviewCorrectionGroup(ctx, id, action, comment) : reviewDeclaration(ctx, id, action, comment);
    },
  },
  {
    // 管理者による休憩の登録（予定どおり取得・未取得・実際の休憩）
    name: 'breaks.adminDeclare',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      employeeOr404(ctx, employeeId);
      forbidSelf(ctx, employeeId, '休憩の登録');
      const key = v.str(a, 'sessionKey', { max: 80, label: '対象の勤務' });
      const day = v.date(a, 'workDate', { label: '勤務日' });
      const s = sessionsAround(ctx, employeeId, day).find((x) => sessionKeyOf(x) === key);
      if (!s) throw E.notFound('対象の勤務');
      const d = readBreakDeclaration(a);
      const decl = saveBreakDeclaration(ctx, employeeId, s, d, shiftsAround(ctx, employeeId, s.laborDate));
      return { id: decl.id, status: decl.status, warning: confirmedPeriodFor(ctx, s.laborDate) ? '給与確定済みの期間です（承認待ちとして保存しました）' : null };
    },
  },
  {
    // 管理者による勤怠修正（勤務単位: 出勤・退勤）。本人修正と同じ検証で、管理者の修正として反映
    name: 'attendance.adminCorrectSession',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      employeeOr404(ctx, employeeId);
      forbidSelf(ctx, employeeId, '勤怠修正');
      return selfCorrect(ctx, employeeId, a);
    },
  },
  {
    // ダッシュボード・通知用の件数
    name: 'requests.summary',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all', 'attendance_edit'],
    mutating: false,
    handler: (ctx) => {
      const reqs = ctx.uow.list<OvertimeRequest>('overtime_requests');
      const cors = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.actorKind === 'staff');
      const groups = (pred: (c: AttendanceCorrection) => boolean) => new Set(cors.filter(pred).map((c) => c.groupId ?? c.id)).size;
      const d = today(ctx);
      let unresolvedMinutes = 0;
      let unresolvedSessions = 0;
      for (const e of employeesInPeriod(ctx, addDays(d, -31), d)) {
        const det = sessionDetails(ctx, e.id, addDays(d, -31), d);
        for (const s of det.sessions) if (s.timeBasis && s.timeBasis.unresolvedMs > 0) {
          unresolvedMinutes += Math.max(1, s.timeBasis.unresolvedMinutes);
          unresolvedSessions++;
        }
      }
      return {
        overtimePending: reqs.filter((r) => r.status === 'pending').length,
        overtimeUnverified: reqs.filter((r) => r.status === 'pending' && !r.identityVerified).length,
        correctionsPending: groups((c) => reviewStatusOf(c) === 'pending'),
        correctionsUnreviewed: groups((c) => reviewStatusOf(c) === 'unreviewed'),
        breakDeclarationsPending: ctx.uow.list<BreakDeclaration>('break_declarations').filter((x) => x.status === 'pending').length,
        offShiftUnresolvedSessions: unresolvedSessions,
        offShiftUnresolvedMinutes: unresolvedMinutes,
        basis: settings(ctx).payrollTimeBasis,
      };
    },
  },
]);
