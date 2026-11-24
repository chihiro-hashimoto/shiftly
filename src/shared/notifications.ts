/**
 * アプリ内通知の検出（純粋関数）
 * - dedupeKey で重複生成を防止（同じ事象は1件のみ）
 * - 検出は日次トリガーまたは関連操作時に実行（過剰なポーリングはしない）
 */
import type { Employee, LeaveGrant, LeaveTransaction, NotificationKind, NotificationRow, Shift, WorkSession } from './types';
import { MINUTE_MS, addDays, formatJst, localDateTime, type Instant, type LocalDate } from './time';
import { fiveDayObligation, leaveBalance } from './leave';

export type NotificationDraft = Pick<NotificationRow, 'kind' | 'dedupeKey' | 'audience' | 'employeeId' | 'title' | 'body' | 'severity' | 'relatedDate'>;

export interface DetectInput {
  now: Instant;
  today: LocalDate;
  employees: Employee[];
  sessionsByEmployee: Record<string, WorkSession[]>;
  publishedShifts: Shift[];
  lateGraceMinutes: number;
  /** 出勤予定時刻を過ぎても出勤打刻がない場合に「出勤打刻漏れ/欠勤」とみなす猶予 */
  absenceGraceMinutes: number;
}

function n(kind: NotificationKind, key: string, e: Employee | null, title: string, body: string, severity: NotificationRow['severity'], date: LocalDate | null, audience: NotificationRow['audience'] = 'managers'): NotificationDraft {
  return { kind, dedupeKey: `${kind}:${key}`, audience, employeeId: e?.id ?? null, title, body, severity, relatedDate: date };
}

export function detectAttendanceNotifications(inp: DetectInput): NotificationDraft[] {
  const out: NotificationDraft[] = [];
  const empById = new Map(inp.employees.map((e) => [e.id, e]));
  for (const [eid, sessions] of Object.entries(inp.sessionsByEmployee)) {
    const e = empById.get(eid);
    if (!e) continue;
    for (const s of sessions) {
      const key = `${eid}:${s.start}`;
      if (s.anomalies.includes('missing_clock_out'))
        out.push(n('missing_clock_out', key, e, '退勤打刻漏れ', `${e.displayName}さん: ${formatJst(s.start)} 出勤の退勤打刻がありません`, 'warning', s.laborDate));
      if (s.anomalies.includes('break_not_ended') && s.end === null && inp.now - s.start > 12 * 3600 * 1000)
        out.push(n('missing_break_end', key, e, '休憩終了打刻漏れ', `${e.displayName}さん: 休憩終了の打刻がありません`, 'warning', s.laborDate));
      if (s.anomalies.includes('abnormal_hours'))
        out.push(n('abnormal_hours', key, e, '異常な勤務時間', `${e.displayName}さん: ${s.laborDate} の勤務時間が長すぎます`, 'warning', s.laborDate));
      if (s.anomalies.includes('insufficient_break'))
        out.push(n('insufficient_break', key, e, '休憩不足', `${e.displayName}さん: ${s.laborDate} の休憩が法定時間に不足しています`, 'warning', s.laborDate));
    }
  }
  // シフトとの比較（遅刻・早退・欠勤・出勤打刻漏れ）
  for (const sh of inp.publishedShifts) {
    const e = empById.get(sh.employeeId);
    if (!e || e.status !== 'active') continue;
    const plannedStart = localDateTime(sh.date, sh.start);
    const plannedEnd = localDateTime(sh.date, sh.end);
    const sessions = (inp.sessionsByEmployee[sh.employeeId] ?? []).filter((s) => s.start < plannedEnd + 4 * 3600 * 1000 && (s.end ?? inp.now) > plannedStart - 4 * 3600 * 1000);
    const key = `${sh.id}`;
    if (sessions.length === 0) {
      if (inp.now > plannedStart + inp.absenceGraceMinutes * MINUTE_MS) {
        const kind: NotificationKind = inp.now > plannedEnd ? 'absence' : 'missing_clock_in';
        out.push(n(kind, key, e, kind === 'absence' ? '欠勤（打刻なし）' : '出勤打刻漏れ', `${e.displayName}さん: ${sh.date} ${sh.start}〜 のシフトに出勤打刻がありません`, 'warning', sh.date));
      }
      continue;
    }
    const first = sessions.reduce((a, b) => (a.start < b.start ? a : b));
    const last = sessions.reduce((a, b) => ((a.end ?? 0) > (b.end ?? 0) ? a : b));
    if (first.start > plannedStart + inp.lateGraceMinutes * MINUTE_MS)
      out.push(n('late', key, e, '遅刻', `${e.displayName}さん: ${sh.date} 予定 ${sh.start} / 出勤 ${formatJst(first.start).slice(11)}`, 'info', sh.date));
    if (last.end !== null && last.end < plannedEnd - inp.lateGraceMinutes * MINUTE_MS)
      out.push(n('early_leave', key, e, '早退', `${e.displayName}さん: ${sh.date} 予定 ${sh.end} / 退勤 ${formatJst(last.end).slice(11)}`, 'info', sh.date));
  }
  return out;
}

export function detectLeaveNotifications(employees: Employee[], grants: LeaveGrant[], txs: LeaveTransaction[], today: LocalDate): NotificationDraft[] {
  const out: NotificationDraft[] = [];
  for (const e of employees.filter((x) => x.status === 'active')) {
    const g = grants.filter((x) => x.employeeId === e.id);
    const t = txs.filter((x) => x.employeeId === e.id);
    const bal = leaveBalance(g, t, today);
    for (const b of bal.byGrant) {
      if (!b.expired && b.remaining > 0 && b.grant.expiresOn <= addDays(today, 60))
        out.push(n('leave_expiring', `${b.grant.id}`, e, '有給の時効が近づいています', `${e.displayName}さん: ${b.remaining}日が ${b.grant.expiresOn} に時効を迎えます`, 'info', b.grant.expiresOn));
    }
    for (const f of fiveDayObligation(g, t)) {
      if (f.shortfall > 0 && f.deadline > today && f.deadline <= addDays(today, 90))
        out.push(n('leave_5day_obligation', `${f.grantId}`, e, '年5日の有給取得義務', `${e.displayName}さん: ${f.deadline} までにあと${f.shortfall}日の取得が必要です`, 'warning', f.deadline));
    }
  }
  return out;
}

/** 既存通知と突き合わせ、新規分のみ返す */
export function newOnly(drafts: NotificationDraft[], existing: Pick<NotificationRow, 'dedupeKey'>[]): NotificationDraft[] {
  const seen = new Set(existing.map((x) => x.dedupeKey));
  const out: NotificationDraft[] = [];
  for (const d of drafts) {
    if (seen.has(d.dedupeKey)) continue;
    seen.add(d.dedupeKey);
    out.push(d);
  }
  return out;
}
