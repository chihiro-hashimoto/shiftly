/**
 * 年次有給休暇（労基法39条）
 * - 付与日数表（通常・比例付与）、時効2年、年5日取得義務（付与10日以上）
 * - 出勤率8割以上の判定は管理者の確認を必須とする（自動確定しない）
 * - 既存残日数は根拠なく自動決定しない（initial_balance を理由付きで手動登録）
 * - 時間単位年休は労使協定が必要なため未対応。半日単位は店舗設定で許可した場合のみ。
 */
import type { EmploymentHistory, LeaveGrant, LeaveTransaction } from './types';
import { daysInMonth, pad2, type LocalDate } from './time';

/** 継続勤務 0.5,1.5,…,6.5年以上 */
export const STATUTORY_GRANT_TABLE = [10, 11, 12, 14, 16, 18, 20];

/** 比例付与（週所定日数 4,3,2,1） */
export const PROPORTIONAL_GRANT_TABLE: Record<number, number[]> = {
  4: [7, 8, 9, 10, 12, 13, 15],
  3: [5, 6, 6, 8, 9, 10, 11],
  2: [3, 4, 4, 5, 6, 6, 7],
  1: [1, 2, 2, 2, 3, 3, 3],
};

export function addMonths(d: LocalDate, months: number): LocalDate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${pad2(nm)}-${pad2(Math.min(day, daysInMonth(ny, nm)))}`;
}

export function addYears(d: LocalDate, years: number): LocalDate {
  return addMonths(d, years * 12);
}

/** 比例付与の区分（週所定日数換算）。null=通常付与 */
export function proportionalCategory(e: Pick<EmploymentHistory, 'weeklyScheduledDays' | 'weeklyScheduledMinutes' | 'yearlyScheduledDays'>): number | null | 'unknown' {
  if (e.weeklyScheduledMinutes !== null && e.weeklyScheduledMinutes >= 30 * 60) return null;
  if (e.weeklyScheduledDays !== null) {
    if (e.weeklyScheduledDays >= 5) return null;
    if (e.weeklyScheduledMinutes === null) return 'unknown';
    return Math.max(1, Math.min(4, e.weeklyScheduledDays));
  }
  if (e.yearlyScheduledDays !== null) {
    if (e.weeklyScheduledMinutes === null) return 'unknown';
    const y = e.yearlyScheduledDays;
    if (y >= 217) return null;
    if (y >= 169) return 4;
    if (y >= 121) return 3;
    if (y >= 73) return 2;
    if (y >= 48) return 1;
    return 0;
  }
  return 'unknown';
}

export interface GrantProposal {
  grantDate: LocalDate;
  serviceIndex: number; // 0=6か月, 1=1年6か月 …
  days: number;
  kind: 'statutory' | 'proportional';
  /** 付与には出勤率8割以上の確認が必要 */
  requiresAttendanceConfirmation: true;
  note: string;
}

/** 入社日から asOf までに到来する付与日の一覧（提案） */
export function grantSchedule(hireDate: LocalDate, asOf: LocalDate, employment: EmploymentHistory | null): GrantProposal[] {
  const out: GrantProposal[] = [];
  for (let i = 0; i < 60; i++) {
    const gd = addMonths(hireDate, 6 + 12 * i);
    if (gd > asOf) break;
    const idx = Math.min(i, 6);
    const cat = employment ? proportionalCategory(employment) : 'unknown';
    if (cat === 'unknown') {
      out.push({ grantDate: gd, serviceIndex: i, days: 0, kind: 'statutory', requiresAttendanceConfirmation: true, note: '所定労働日数・時間が未設定のため付与日数を決定できません' });
    } else if (cat === null) {
      out.push({ grantDate: gd, serviceIndex: i, days: STATUTORY_GRANT_TABLE[idx]!, kind: 'statutory', requiresAttendanceConfirmation: true, note: '' });
    } else if (cat === 0) {
      out.push({ grantDate: gd, serviceIndex: i, days: 0, kind: 'proportional', requiresAttendanceConfirmation: true, note: '年間所定労働日数48日未満のため付与対象外' });
    } else {
      out.push({ grantDate: gd, serviceIndex: i, days: PROPORTIONAL_GRANT_TABLE[cat]![idx]!, kind: 'proportional', requiresAttendanceConfirmation: true, note: '' });
    }
  }
  return out;
}

export interface GrantBalance {
  grant: LeaveGrant;
  used: number;
  remaining: number;
  expired: boolean;
}

/**
 * 残日数（古い付与から消化: FIFO）。asOf 時点で時効を迎えた付与の残は失効。
 * adjust は正なら加算（付与と同じ扱いではなく、最も新しい有効付与への加算）、負なら減算。
 */
export function leaveBalance(grants: LeaveGrant[], txs: LeaveTransaction[], asOf: LocalDate): { total: number; byGrant: GrantBalance[]; overdrawn: number } {
  const gs = [...grants].filter((g) => g.grantDate <= asOf).sort((a, b) => (a.grantDate < b.grantDate ? -1 : 1));
  const bal: GrantBalance[] = gs.map((g) => ({ grant: g, used: 0, remaining: g.days, expired: false }));
  let overdrawn = 0;
  const sorted = [...txs].filter((t) => t.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const t of sorted) {
    if (t.kind === 'expire') continue;
    if (t.kind === 'adjust' && t.days > 0) {
      const target = [...bal].reverse().find((b) => b.grant.grantDate <= t.date && b.grant.expiresOn > t.date);
      if (target) target.remaining += t.days;
      continue;
    }
    let need = t.kind === 'take' ? t.days : -t.days; // adjust 負 → 減算
    for (const b of bal) {
      if (need <= 0) break;
      if (b.grant.grantDate > t.date || b.grant.expiresOn <= t.date) continue;
      const use = Math.min(b.remaining, need);
      b.remaining -= use;
      b.used += use;
      need -= use;
    }
    if (need > 0) overdrawn += need;
  }
  for (const b of bal) if (b.grant.expiresOn <= asOf) b.expired = true;
  const total = bal.filter((b) => !b.expired).reduce((a, b) => a + b.remaining, 0);
  return { total, byGrant: bal, overdrawn };
}

export interface FiveDayStatus {
  grantId: string;
  grantDate: LocalDate;
  deadline: LocalDate; // 付与日から1年
  taken: number;
  shortfall: number;
}

/** 年5日取得義務（付与日数10日以上の付与ごと） */
export function fiveDayObligation(grants: LeaveGrant[], txs: LeaveTransaction[]): FiveDayStatus[] {
  return grants
    .filter((g) => (g.kind === 'statutory' || g.kind === 'proportional') && g.days >= 10)
    .map((g) => {
      const deadline = addYears(g.grantDate, 1);
      const taken = txs.filter((t) => t.kind === 'take' && t.date >= g.grantDate && t.date < deadline).reduce((a, t) => a + t.days, 0);
      return { grantId: g.id, grantDate: g.grantDate, deadline, taken, shortfall: Math.max(0, 5 - taken) };
    });
}

export function validateLeaveTake(days: number, halfDayAllowed: boolean): string | null {
  if (days === 1) return null;
  if (days === 0.5) return halfDayAllowed ? null : '半日単位の年休は店舗設定で許可されていません';
  return '取得日数は1日（または許可されている場合は0.5日）で登録してください';
}
