/**
 * シフト・有給休暇
 * F10 シフト作成・編集・公開 / F20 有給休暇管理
 */
import { defineOps } from '../api';
import { audit, has, isOwner, settings, staff, today, type Ctx } from '../context';
import { E } from '../errors';
import * as v from '../validate';
import type { Employee, EmploymentHistory, LeaveGrant, LeaveTransaction, Shift, ShiftPattern } from '../../shared/types';
import { addDays, parseTimeToMinutes } from '../../shared/time';
import { addYears, fiveDayObligation, grantSchedule, leaveBalance, validateLeaveTake } from '../../shared/leave';
import { activeEmployees } from '../services';

function readShift(a: v.Args) {
  const date = v.date(a, 'date', { label: '勤務日' });
  const start = v.time(a, 'start', { allowNextDay: false, label: '開始時刻' });
  const end = v.time(a, 'end', { allowNextDay: true, label: '終了時刻' });
  if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) throw E.invalid('終了時刻は開始時刻より後にしてください（翌日にまたがる場合は 26:00 のように入力）');
  if (parseTimeToMinutes(end) - parseTimeToMinutes(start) > 20 * 60) throw E.invalid('1回のシフトは20時間以内で入力してください');
  const breakMinutes = v.int(a, 'breakMinutes', { min: 0, max: 240, label: '休憩（分）' });
  const applyFixedBreak = v.bool(a, 'applyFixedBreak');
  const fixedBreakStart = applyFixedBreak ? v.time(a, 'fixedBreakStart', { allowNextDay: true, label: '固定休憩の開始時刻' }) : null;
  if (fixedBreakStart && (parseTimeToMinutes(fixedBreakStart) < parseTimeToMinutes(start) || parseTimeToMinutes(fixedBreakStart) + breakMinutes > parseTimeToMinutes(end)))
    throw E.invalid('固定休憩はシフト時間内に設定してください');
  return { date, start, end, breakMinutes, applyFixedBreak, fixedBreakStart, note: v.optStr(a, 'note', 200) };
}

function history(ctx: Ctx, shiftId: string, action: string, before: unknown, after: unknown) {
  ctx.uow.insert('shift_history', { shiftId, action, before: JSON.stringify(before ?? null), after: JSON.stringify(after ?? null), actorId: isOwner(ctx) ? 'owner' : staff(ctx).employeeId } as never, 'shh');
}

function overlaps(a: Pick<Shift, 'date' | 'start' | 'end'>, b: Pick<Shift, 'date' | 'start' | 'end'>): boolean {
  const base = (d: string) => Date.parse(d) / 60000;
  const as = base(a.date) + parseTimeToMinutes(a.start);
  const ae = base(a.date) + parseTimeToMinutes(a.end);
  const bs = base(b.date) + parseTimeToMinutes(b.start);
  const be = base(b.date) + parseTimeToMinutes(b.end);
  return as < be && bs < ae;
}

defineOps([
  {
    name: 'shifts.published',
    auth: 'session',
    perms: ['shift_view_published'],
    mutating: false,
    handler: (ctx, raw) => {
      const { from, to } = v.range(v.obj(raw), 62);
      // スタッフは公開済みシフトのみ（全員分の勤務予定。給与情報は含めない）
      const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e.displayName]));
      return ctx.uow
        .list<Shift>('shifts')
        .filter((s) => s.status === 'published' && s.date >= from && s.date <= to)
        .map((s) => ({ id: s.id, employeeId: s.employeeId, displayName: names.get(s.employeeId) ?? '', date: s.date, start: s.start, end: s.end, breakMinutes: s.breakMinutes }));
    },
  },
  {
    name: 'shifts.list',
    auth: 'staff_or_owner',
    perms: ['shift_edit', 'shift_publish'],
    mutating: false,
    handler: (ctx, raw) => {
      const { from, to } = v.range(v.obj(raw), 62);
      return ctx.uow.list<Shift>('shifts').filter((s) => s.date >= from && s.date <= to && s.status !== 'cancelled');
    },
  },
  {
    name: 'shifts.upsert',
    auth: 'staff_or_owner',
    perms: ['shift_edit'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      const emp = ctx.uow.get<Employee>('employees', employeeId);
      if (!emp || emp.status !== 'active') throw E.notFound('スタッフ');
      // 公開シフトは給与計算（固定休憩・所定時間）に影響するため、スタッフは自分のシフトを編集できない
      if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身のシフトの編集');
      const d = readShift(a);
      const id = typeof a.id === 'string' && a.id ? v.id(a, 'id') : null;
      const others = ctx.uow.list<Shift>('shifts').filter((s) => s.employeeId === employeeId && s.id !== id && s.status !== 'cancelled' && Math.abs(Date.parse(s.date) - Date.parse(d.date)) <= 86400000);
      if (others.some((o) => overlaps(o, d))) throw E.invalid('同じスタッフの別のシフトと時間が重なっています');
      if (id) {
        const cur = ctx.uow.get<Shift>('shifts', id);
        if (!cur || cur.status === 'cancelled') throw E.notFound('シフト');
        // 公開済みシフトの変更は下書きに戻す（再公開が必要）
        const next = ctx.uow.update('shifts', { ...cur, ...d, employeeId, status: cur.status === 'published' && !has(ctx, 'shift_publish') ? 'draft' : cur.status, version: typeof a.version === 'number' ? a.version : cur.version });
        history(ctx, id, 'update', cur, next);
        audit(ctx, 'shift.update', 'shift', id, `${d.date}`);
        return next;
      }
      const s = ctx.uow.insert<Shift>('shifts', { ...d, employeeId, status: 'draft', publishedAt: null }, 'shf');
      history(ctx, s.id, 'create', null, s);
      audit(ctx, 'shift.create', 'shift', s.id, `${d.date}`);
      return s;
    },
  },
  {
    name: 'shifts.delete',
    auth: 'staff_or_owner',
    perms: ['shift_edit'],
    mutating: true,
    handler: (ctx, raw) => {
      const id = v.id(v.obj(raw), 'id');
      const cur = ctx.uow.get<Shift>('shifts', id);
      if (!cur) throw E.notFound('シフト');
      if (!isOwner(ctx) && staff(ctx).employeeId === cur.employeeId) throw E.forbidden('自分自身のシフトの取消');
      if (cur.status === 'published' && !has(ctx, 'shift_publish')) throw E.forbidden('公開済みシフトの削除');
      // 物理削除はせず取消状態で残す（変更履歴の追跡のため）
      ctx.uow.update('shifts', { ...cur, status: 'cancelled' });
      history(ctx, id, 'cancel', cur, null);
      audit(ctx, 'shift.cancel', 'shift', id, '取消');
      return { ok: true };
    },
  },
  {
    name: 'shifts.copyWeek',
    auth: 'staff_or_owner',
    perms: ['shift_edit'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const src = v.date(a, 'fromWeekStart', { label: '複製元の週' });
      const dst = v.date(a, 'toWeekStart', { label: '複製先の週' });
      const diff = Math.round((Date.parse(dst) - Date.parse(src)) / 86400000);
      if (diff === 0 || diff % 7 !== 0) throw E.invalid('複製先は別の週の同じ曜日を指定してください');
      const srcShifts = ctx.uow.list<Shift>('shifts').filter((s) => s.date >= src && s.date <= addDays(src, 6) && s.status !== 'cancelled');
      const existing = ctx.uow.list<Shift>('shifts').filter((s) => s.date >= dst && s.date <= addDays(dst, 6) && s.status !== 'cancelled');
      let created = 0;
      let skipped = 0;
      for (const s of srcShifts) {
        const nd = { ...s, date: addDays(s.date, diff) };
        if (existing.some((e) => e.employeeId === s.employeeId && overlaps(e, nd))) {
          skipped++;
          continue;
        }
        const n = ctx.uow.insert<Shift>('shifts', { employeeId: s.employeeId, date: nd.date, start: s.start, end: s.end, breakMinutes: s.breakMinutes, applyFixedBreak: s.applyFixedBreak, fixedBreakStart: s.fixedBreakStart, status: 'draft', publishedAt: null, note: s.note }, 'shf');
        history(ctx, n.id, 'copy', null, n);
        created++;
      }
      audit(ctx, 'shift.copy_week', 'shift', null, `${src} → ${dst} 作成${created} スキップ${skipped}`);
      return { created, skipped };
    },
  },
  {
    name: 'shifts.publish',
    auth: 'staff_or_owner',
    perms: ['shift_publish'],
    mutating: true,
    handler: (ctx, raw) => {
      const { from, to } = v.range(v.obj(raw), 62);
      let n = 0;
      let skippedOwn = 0;
      const self = isOwner(ctx) ? null : staff(ctx).employeeId;
      for (const s of ctx.uow.list<Shift>('shifts').filter((x) => x.date >= from && x.date <= to && x.status === 'draft')) {
        // スタッフは自分のシフトを公開できない（店長が公開）
        if (self && s.employeeId === self) {
          skippedOwn++;
          continue;
        }
        const next = ctx.uow.update('shifts', { ...s, status: 'published', publishedAt: ctx.uow.nowIso() });
        history(ctx, s.id, 'publish', s, next);
        n++;
      }
      audit(ctx, 'shift.publish', 'shift', null, `${from}〜${to} ${n}件公開`);
      return { published: n, skippedOwn };
    },
  },
  {
    name: 'shiftPatterns.list',
    auth: 'staff_or_owner',
    perms: ['shift_edit'],
    mutating: false,
    handler: (ctx) => ctx.uow.list<ShiftPattern>('shift_patterns'),
  },
  {
    name: 'shiftPatterns.upsert',
    auth: 'staff_or_owner',
    perms: ['shift_edit'],
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const name = v.str(a, 'name', { max: 30, label: 'パターン名' });
      const start = v.time(a, 'start', { label: '開始' });
      const end = v.time(a, 'end', { allowNextDay: true, label: '終了' });
      if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) throw E.invalid('終了は開始より後にしてください');
      const breakMinutes = v.int(a, 'breakMinutes', { min: 0, max: 240 });
      const id = typeof a.id === 'string' && a.id ? v.id(a, 'id') : null;
      if (id) {
        const cur = ctx.uow.get<ShiftPattern>('shift_patterns', id);
        if (!cur) throw E.notFound('パターン');
        return ctx.uow.update('shift_patterns', { ...cur, name, start, end, breakMinutes });
      }
      return ctx.uow.insert<ShiftPattern>('shift_patterns', { name, start, end, breakMinutes }, 'pat');
    },
  },
  {
    name: 'shifts.history',
    auth: 'staff_or_owner',
    perms: ['shift_edit', 'shift_publish'],
    mutating: false,
    handler: (ctx, raw) => {
      const id = v.id(v.obj(raw), 'shiftId');
      return ctx.uow.list<{ shiftId: string; createdAt: string }>('shift_history').filter((h) => h.shiftId === id).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
  },
  // ------------------------------------------------------------ 有給
  {
    name: 'leave.mine',
    auth: 'session',
    perms: ['leave_view_self'],
    mutating: false,
    handler: (ctx) => leaveSummary(ctx, staff(ctx).employeeId),
  },
  {
    name: 'leave.overview',
    auth: 'staff_or_owner',
    perms: ['leave_manage'],
    sensitive: true,
    mutating: false,
    handler: (ctx) => activeEmployees(ctx).map((e) => ({ employeeId: e.id, displayName: e.displayName, ...leaveSummary(ctx, e.id) })),
  },
  {
    name: 'leave.detail',
    auth: 'staff_or_owner',
    perms: ['leave_manage'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const employeeId = v.id(v.obj(raw), 'employeeId');
      const emp = ctx.uow.get<Employee>('employees', employeeId);
      if (!emp) throw E.notFound('スタッフ');
      const hist = ctx.uow.list<EmploymentHistory>('employment_history').filter((x) => x.employeeId === employeeId && x.effectiveFrom <= today(ctx)).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
      const grants = ctx.uow.list<LeaveGrant>('leave_grants').filter((g) => g.employeeId === employeeId);
      const proposals = emp.hireDate ? grantSchedule(emp.hireDate, addDays(today(ctx), 31), hist).filter((p) => !grants.some((g) => g.grantDate === p.grantDate && g.kind !== 'initial_balance')) : [];
      return { ...leaveSummary(ctx, employeeId), proposals, hireDate: emp.hireDate, employment: hist };
    },
  },
  {
    name: 'leave.grant',
    auth: 'staff_or_owner',
    perms: ['leave_manage'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      if (!ctx.uow.get<Employee>('employees', employeeId)) throw E.notFound('スタッフ');
      if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身の有給付与');
      const kind = v.oneOf(a, 'kind', ['statutory', 'proportional', 'initial_balance', 'extra'] as const, '付与種別');
      const grantDate = v.date(a, 'grantDate', { label: '付与日' });
      const days = v.num(a, 'days', { min: 0.5, max: 40, label: '付与日数' });
      if (Math.round(days * 2) !== days * 2) throw E.invalid('付与日数は0.5日単位で入力してください');
      const attendanceRateConfirmed = v.bool(a, 'attendanceRateConfirmed');
      if ((kind === 'statutory' || kind === 'proportional') && !attendanceRateConfirmed) throw E.invalid('出勤率8割以上であることを確認してください');
      const note = v.str(a, 'note', { optional: kind !== 'initial_balance', min: kind === 'initial_balance' ? 2 : 0, max: 300, label: '根拠・メモ' });
      if (kind === 'initial_balance' && !note) throw E.invalid('既存残日数の登録には根拠（紙台帳等）を記入してください');
      const g = ctx.uow.insert<LeaveGrant>('leave_grants', { employeeId, grantDate, days, expiresOn: addYears(grantDate, 2), kind, attendanceRateConfirmed, note }, 'lgr');
      audit(ctx, 'leave.grant', 'leave_grant', g.id, `${kind} ${days}日 対象=${employeeId}`);
      return g;
    },
  },
  {
    name: 'leave.take',
    auth: 'staff_or_owner',
    perms: ['leave_manage'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      if (!ctx.uow.get<Employee>('employees', employeeId)) throw E.notFound('スタッフ');
      if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身の有給登録');
      const date = v.date(a, 'date', { label: '取得日' });
      const days = v.num(a, 'days', { min: 0.5, max: 1 });
      const err = validateLeaveTake(days, settings(ctx).halfDayLeaveAllowed);
      if (err) throw E.invalid(err);
      const scheduledMinutes = v.intOrNull(a, 'scheduledMinutes', { min: 0, max: 1440, label: '所定労働時間（分）' });
      const grants = ctx.uow.list<LeaveGrant>('leave_grants').filter((g) => g.employeeId === employeeId);
      const txs = ctx.uow.list<LeaveTransaction>('leave_transactions').filter((t) => t.employeeId === employeeId);
      if (txs.some((t) => t.kind === 'take' && t.date === date)) throw E.invalid('同じ日の有給がすでに登録されています');
      // 登録済みの未来日の取得も差し引いた残日数で判定（日付順を入れ替えた超過登録の防止）
      const bal = leaveBalance(grants, txs.map((t) => (t.kind === 'take' && t.date > date ? { ...t, date } : t)), date);
      if (bal.total < days) throw E.invalid(`有給残日数が不足しています（残 ${bal.total}日）`);
      const t = ctx.uow.insert<LeaveTransaction>('leave_transactions', { employeeId, date, days, kind: 'take', scheduledMinutes, grantId: null, reason: v.optStr(a, 'reason', 200), actorId: isOwner(ctx) ? 'owner' : staff(ctx).employeeId }, 'ltx');
      audit(ctx, 'leave.take', 'leave_transaction', t.id, `取得 ${days}日 対象=${employeeId}`);
      return t;
    },
  },
  {
    name: 'leave.adjust',
    auth: 'staff_or_owner',
    perms: ['leave_manage'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const employeeId = v.id(a, 'employeeId');
      if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身の有給調整');
      const days = v.num(a, 'days', { min: -40, max: 40 });
      if (days === 0 || Math.round(days * 2) !== days * 2) throw E.invalid('調整日数は0.5日単位で入力してください');
      const t = ctx.uow.insert<LeaveTransaction>('leave_transactions', { employeeId, date: v.date(a, 'date'), days, kind: 'adjust', scheduledMinutes: null, grantId: null, reason: v.str(a, 'reason', { min: 2, max: 300, label: '理由' }), actorId: isOwner(ctx) ? 'owner' : staff(ctx).employeeId }, 'ltx');
      audit(ctx, 'leave.adjust', 'leave_transaction', t.id, `調整 ${days}日 対象=${employeeId}`);
      return t;
    },
  },
]);

export function leaveSummary(ctx: Ctx, employeeId: string) {
  const grants = ctx.uow.list<LeaveGrant>('leave_grants').filter((g) => g.employeeId === employeeId);
  const txs = ctx.uow.list<LeaveTransaction>('leave_transactions').filter((t) => t.employeeId === employeeId);
  // 取得予定（未来日）の有給も残日数から差し引いて表示する
  const d = today(ctx);
  const bal = leaveBalance(grants, txs.map((t) => (t.date > d && t.kind === 'take' ? { ...t, date: d } : t)), d);
  return {
    balance: bal.total,
    scheduled: txs.filter((t) => t.kind === 'take' && t.date > d).reduce((a, t) => a + t.days, 0),
    overdrawn: bal.overdrawn,
    grants: bal.byGrant.map((b) => ({ id: b.grant.id, grantDate: b.grant.grantDate, days: b.grant.days, remaining: b.remaining, used: b.used, expiresOn: b.grant.expiresOn, expired: b.expired, kind: b.grant.kind })),
    transactions: txs.sort((a, b) => (a.date < b.date ? 1 : -1)).map((t) => ({ id: t.id, date: t.date, days: t.days, kind: t.kind, reason: t.reason })),
    fiveDay: fiveDayObligation(grants, txs),
  };
}
