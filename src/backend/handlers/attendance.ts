/**
 * 勤怠
 * F06 出勤・退勤打刻 / F07 休憩 / F08 勤務時間・勤怠確認 / F09 勤怠修正・修正履歴 / F11 遅刻・早退・欠勤検出
 */
import { defineOps } from '../api';
import { audit, isOwner, settings, staff, today, type Ctx } from '../context';
import { ApiError, E } from '../errors';
import * as v from '../validate';
import type { AttendanceCorrection, AttendanceEvent, Employee, ManualBreak, PayrollPeriod, PayrollResult, PunchType, Shift, WorkSession } from '../../shared/types';
import { allowedPunches, breakMs, effectiveState, netWorkMs, PUNCH_LABEL, STATE_LABEL, validatePunch } from '../../shared/attendance';
import { addDays, localDateTime, MINUTE_MS, toIsoJst, type LocalDate } from '../../shared/time';
import { activeEmployees, loadEffective, loadEvents, sessionsFor } from '../services';
import { detectAttendanceNotifications } from '../../shared/notifications';

const PUNCH_TYPES = ['clock_in', 'clock_out', 'break_start', 'break_end'] as const;

/** 'YYYY-MM-DDTHH:MM'（JST）を ISO に変換 */
function localDateTimeArg(a: v.Args, k: string, label: string): number {
  const s = a[k];
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) throw E.invalid(`${label}は YYYY-MM-DDTHH:MM 形式で入力してください`);
  return localDateTime(s.slice(0, 10), s.slice(11, 16));
}

export function sessionView(s: WorkSession, now: number) {
  return {
    employeeId: s.employeeId,
    laborDate: s.laborDate,
    businessDate: s.businessDate,
    start: toIsoJst(s.start),
    end: s.end === null ? null : toIsoJst(s.end),
    breakMinutes: Math.round(breakMs(s, now) / MINUTE_MS),
    workMinutes: Math.round(netWorkMs(s, now) / MINUTE_MS),
    breaks: s.breaks.map((b) => ({ start: toIsoJst(b.start), end: b.end === null ? null : toIsoJst(b.end), source: b.source })),
    anomalies: s.anomalies,
    open: s.end === null,
  };
}

function confirmedPeriodFor(ctx: Ctx, d: LocalDate): PayrollPeriod | null {
  const p = ctx.uow.list<PayrollPeriod>('payroll_periods').find((x) => x.from <= d && d <= x.to);
  if (!p) return null;
  const confirmed = ctx.uow.list<PayrollResult>('payroll_results').some((r) => r.periodId === p.id && (r.status === 'confirmed' || r.status === 'issued'));
  return confirmed ? p : null;
}

defineOps([
  {
    name: 'attendance.punch',
    auth: 'session',
    perms: ['punch_self'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const me = staff(ctx);
      if (!ctx.requestId) throw E.invalid('requestId が必要です');
      const type = v.oneOf(a, 'type', PUNCH_TYPES, '打刻種別') as PunchType;
      const endBreakConfirmed = v.bool(a, 'endBreakConfirmed');
      // 正式な打刻時刻はサーバー時刻（端末の時刻は使用しない）。秒未満は切り捨て
      const at = Math.floor(ctx.now / 1000) * 1000;
      const evs = loadEffective(ctx, me.employeeId, addDays(today(ctx), -3), today(ctx));
      const check = validatePunch(evs, type, { endBreakConfirmed, now: at });
      if (!check.ok) throw new ApiError(check.code, check.message, 409);
      const insert = (t: PunchType, note: string) =>
        ctx.uow.insert<AttendanceEvent>(
          'attendance_events',
          { employeeId: me.employeeId, type: t, at: toIsoJst(at), deviceId: me.deviceId, source: 'kiosk', requestId: ctx.requestId!, actorId: null, note },
          'evt',
        );
      if (check.autoBreakEnd) insert('break_end', '休憩中の退勤（本人確認済み）');
      const ev = insert(type, check.staleOpenSession ? '前回勤務の退勤打刻漏れあり' : '');
      audit(ctx, 'attendance.punch', 'attendance_event', ev.id, `${PUNCH_LABEL[type]}`);
      const after = effectiveState([...evs, ...(check.autoBreakEnd ? [{ id: 'x', employeeId: me.employeeId, type: 'break_end' as const, at, origin: 'original' as const }] : []), { id: ev.id, employeeId: me.employeeId, type, at, origin: 'original' as const }], at);
      return {
        eventId: ev.id,
        type,
        label: PUNCH_LABEL[type],
        at: ev.at,
        state: after.state,
        stateLabel: STATE_LABEL[after.state],
        staleOpenSession: !!check.staleOpenSession,
      };
    },
  },
  {
    name: 'attendance.lookup',
    auth: 'session',
    perms: ['punch_self'],
    mutating: false,
    handler: (ctx, raw) => {
      // 保存結果が不明な場合の確認（自分の打刻のみ）
      const me = staff(ctx);
      const rid = v.str(v.obj(raw), 'requestId', { max: 64, pattern: /^[A-Za-z0-9_-]{8,64}$/ });
      const ev = loadEvents(ctx, addDays(today(ctx), -1), today(ctx)).find((e) => e.requestId === rid && e.employeeId === me.employeeId);
      return ev ? { saved: true, type: ev.type, at: ev.at } : { saved: false };
    },
  },
  {
    name: 'attendance.mine',
    auth: 'session',
    perms: ['attendance_view_self'],
    mutating: false,
    handler: (ctx, raw) => {
      const me = staff(ctx);
      const { from, to } = v.range(v.obj(raw), 62);
      const evs = loadEffective(ctx, me.employeeId, addDays(today(ctx), -3), today(ctx));
      const st = effectiveState(evs, ctx.now);
      return {
        state: st.state,
        stateLabel: STATE_LABEL[st.state],
        allowedPunches: allowedPunches(st.state),
        sessions: sessionsFor(ctx, me.employeeId, from, to).map((s) => sessionView(s, ctx.now)),
      };
    },
  },
  {
    name: 'attendance.list',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all'],
    mutating: false,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const { from, to } = v.range(a, 62);
      const only = typeof a.employeeId === 'string' ? v.id(a, 'employeeId') : null;
      const emps = ctx.uow.list<Employee>('employees').filter((e) => (only ? e.id === only : e.status === 'active'));
      const s = settings(ctx);
      return emps.map((e) => ({
        employeeId: e.id,
        displayName: e.displayName,
        sessions: sessionsFor(ctx, e.id, from, to, s).map((x) => sessionView(x, ctx.now)),
      }));
    },
  },
  {
    name: 'attendance.today',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all'],
    mutating: false,
    handler: (ctx) => {
      const d = today(ctx);
      return activeEmployees(ctx).map((e) => {
        const evs = loadEffective(ctx, e.id, addDays(d, -3), d);
        const st = effectiveState(evs, ctx.now);
        return { employeeId: e.id, displayName: e.displayName, state: st.state, stateLabel: STATE_LABEL[st.state], staleOpenSince: st.staleOpenSince ? toIsoJst(st.staleOpenSince) : null };
      });
    },
  },
  {
    name: 'attendance.detail',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all', 'attendance_edit'],
    mutating: false,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      const { from, to } = v.range(a, 62);
      const originals = loadEvents(ctx, from, to).filter((e) => e.employeeId === employeeId);
      const corrections = ctx.uow.list<AttendanceCorrection>('attendance_corrections').filter((c) => c.employeeId === employeeId);
      const breaks = ctx.uow.list<ManualBreak>('manual_breaks').filter((b) => b.employeeId === employeeId);
      return {
        originals: originals.sort((x, y) => (x.at < y.at ? -1 : 1)),
        corrections: corrections.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)),
        manualBreaks: breaks,
        sessions: sessionsFor(ctx, employeeId, from, to).map((s) => sessionView(s, ctx.now)),
      };
    },
  },
  {
    name: 'attendance.correct',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      const emp = ctx.uow.get<Employee>('employees', employeeId);
      if (!emp) throw E.notFound('スタッフ');
      if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身の勤怠修正');
      const action = v.oneOf(a, 'action', ['add', 'void', 'replace'] as const, '修正種別');
      const reason = v.str(a, 'reason', { min: 2, max: 300, label: '修正理由' });
      const source = a.source === 'paper_recovery' ? 'paper_recovery' : 'correction';
      let targetEventId: string | null = null;
      let before = '';
      let newType: PunchType | null = null;
      let newAt: string | null = null;
      if (action !== 'add') {
        targetEventId = v.str(a, 'targetEventId', { max: 80, label: '対象打刻' });
        const tgt = targetEventId.startsWith('corr:')
          ? null
          : loadEvents(ctx, addDays(today(ctx), -400), today(ctx)).find((e) => e.id === targetEventId && e.employeeId === employeeId);
        if (!tgt) throw E.notFound('対象の打刻（原本）');
        before = JSON.stringify({ type: tgt.type, at: tgt.at });
      }
      if (action !== 'void') {
        newType = v.oneOf(a, 'type', PUNCH_TYPES, '打刻種別') as PunchType;
        const t = localDateTimeArg(a, 'at', '日時');
        if (t > ctx.now + 60_000) throw E.invalid('未来の日時は登録できません');
        newAt = toIsoJst(t);
      }
      const day = (newAt ?? JSON.parse(before || '{}').at ?? toIsoJst(ctx.now)).slice(0, 10) as LocalDate;
      const confirmed = confirmedPeriodFor(ctx, day);
      const c = ctx.uow.insert<AttendanceCorrection>(
        'attendance_corrections',
        {
          employeeId,
          action,
          targetEventId,
          newType,
          newAt,
          reason: source === 'paper_recovery' ? `【紙タイムカードから登録】${reason}` : reason,
          actorId: isOwner(ctx) ? 'owner' : staff(ctx).employeeId,
          actorKind: isOwner(ctx) ? 'owner' : 'staff',
          status: 'applied',
          before,
          after: JSON.stringify({ type: newType, at: newAt }),
        },
        'cor',
      );
      audit(ctx, 'attendance.correct', 'attendance_correction', c.id, `${action} 対象スタッフ=${employeeId}`);
      return { correction: c, warning: confirmed ? `この日は給与確定済みの期間（${confirmed.periodKey}）です。給与の訂正が必要です` : null };
    },
  },
  {
    name: 'attendance.addBreak',
    auth: 'staff_or_owner',
    perms: ['attendance_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身の勤怠修正');
      const start = localDateTimeArg(a, 'start', '休憩開始');
      const end = localDateTimeArg(a, 'end', '休憩終了');
      if (end <= start) throw E.invalid('休憩終了は開始より後にしてください');
      if (end - start > 6 * 3600_000) throw E.invalid('休憩時間が長すぎます');
      const reason = v.str(a, 'reason', { min: 2, max: 300, label: '理由' });
      const ss = sessionsFor(ctx, employeeId, addDays(toIsoJst(start).slice(0, 10), -1), toIsoJst(start).slice(0, 10));
      const inside = ss.find((s) => s.end !== null && start >= s.start && end <= s.end);
      if (!inside) throw E.invalid('休憩は勤務時間内で登録してください');
      const b = ctx.uow.insert<ManualBreak>('manual_breaks', { employeeId, start: toIsoJst(start), end: toIsoJst(end), reason, actorId: isOwner(ctx) ? 'owner' : staff(ctx).employeeId }, 'brk');
      audit(ctx, 'attendance.add_break', 'manual_break', b.id, `対象スタッフ=${employeeId}`);
      return b;
    },
  },
  {
    name: 'attendance.compareShifts',
    auth: 'staff_or_owner',
    perms: ['attendance_view_all'],
    mutating: false,
    handler: (ctx, raw) => {
      const { from, to } = v.range(v.obj(raw), 62);
      const emps = activeEmployees(ctx);
      const shifts = ctx.uow.list<Shift>('shifts').filter((s) => s.status === 'published' && s.date >= from && s.date <= to);
      const s = settings(ctx);
      const sessionsByEmployee: Record<string, WorkSession[]> = {};
      for (const e of emps) sessionsByEmployee[e.id] = sessionsFor(ctx, e.id, addDays(from, -1), to, s);
      const drafts = detectAttendanceNotifications({ now: ctx.now, today: today(ctx), employees: emps, sessionsByEmployee, publishedShifts: shifts, lateGraceMinutes: 1, absenceGraceMinutes: 30 });
      return {
        rows: shifts.map((sh) => {
          const ps = localDateTime(sh.date, sh.start);
          const pe = localDateTime(sh.date, sh.end);
          const sess = (sessionsByEmployee[sh.employeeId] ?? []).filter((x) => x.start < pe + 4 * 3600_000 && (x.end ?? ctx.now) > ps - 4 * 3600_000);
          return {
            shiftId: sh.id,
            employeeId: sh.employeeId,
            date: sh.date,
            plannedStart: sh.start,
            plannedEnd: sh.end,
            actual: sess.map((x) => sessionView(x, ctx.now)),
            flags: drafts.filter((d) => d.dedupeKey.endsWith(`:${sh.id}`)).map((d) => d.kind),
          };
        }),
      };
    },
  },
]);
