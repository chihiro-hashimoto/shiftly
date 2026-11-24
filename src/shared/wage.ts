/**
 * 時給ルールの解決
 * - 曜日・祝日・特定日の判定は「営業日」で行う（例: 金曜営業の深夜1時は金曜扱い）
 * - 時間帯は営業日 0:00 からの経過分（'22:00'〜'29:00' のように翌日表記可）
 * - 優先度が最も高いルールを採用。同一優先度で時給が異なるルールが重なる場合は矛盾として報告し、
 *   暫定的に労働者に有利な高い時給を採用する（確定は禁止）。
 */
import type { WageRule } from './types';
import { MINUTE_MS, dayOfWeek, parseTimeToMinutes, startOfLocalDate, type Instant, type LocalDate } from './time';

export interface ResolvedRate {
  rule: WageRule;
  rate: number;
  /** 割増賃金の算定基礎となる時給（深夜割増込み時給の場合は premiumBaseRate） */
  premiumBase: number;
  nightIncluded: boolean;
  conflict: WageRule[] | null;
}

function effective(r: WageRule, d: LocalDate): boolean {
  return r.effectiveFrom <= d && (r.effectiveTo === null || d <= r.effectiveTo);
}

function matches(r: WageRule, bd: LocalDate, minuteFromBd: number, holidays: Set<string>): boolean {
  const dow = dayOfWeek(bd);
  switch (r.kind) {
    case 'base':
      return true;
    case 'weekday':
      return r.weekdays.includes(dow);
    case 'holiday':
      return holidays.has(bd);
    case 'special_date':
      return r.specialDates.includes(bd);
    case 'timeband': {
      if (r.weekdays.length > 0 && !r.weekdays.includes(dow)) return false;
      if (!r.timeFrom || !r.timeTo) return false;
      const f = parseTimeToMinutes(r.timeFrom);
      const t = parseTimeToMinutes(r.timeTo);
      return minuteFromBd >= f && minuteFromBd < t;
    }
  }
}

export function resolveRate(
  rules: WageRule[],
  bd: LocalDate,
  minuteFromBd: number,
  publicHolidays: string[],
): ResolvedRate | null {
  const hs = new Set(publicHolidays);
  const cands = rules.filter((r) => effective(r, bd) && matches(r, bd, minuteFromBd, hs));
  if (cands.length === 0) return null;
  const top = Math.max(...cands.map((r) => r.priority));
  const best = cands.filter((r) => r.priority === top);
  best.sort((a, b) => b.hourlyRate - a.hourlyRate);
  const chosen = best[0]!;
  const distinct = new Set(best.map((r) => `${r.hourlyRate}/${r.includesNightPremium}/${r.premiumBaseRate}`));
  return {
    rule: chosen,
    rate: chosen.hourlyRate,
    premiumBase: chosen.includesNightPremium ? (chosen.premiumBaseRate ?? chosen.hourlyRate) : chosen.hourlyRate,
    nightIncluded: chosen.includesNightPremium,
    conflict: distinct.size > 1 ? best : null,
  };
}

/** 営業日 bd の時間帯ルール境界（Instant） */
export function timebandCuts(rules: WageRule[], bd: LocalDate): Instant[] {
  const base = startOfLocalDate(bd);
  const out: Instant[] = [];
  for (const r of rules) {
    if (r.kind !== 'timeband' || !effective(r, bd)) continue;
    if (r.timeFrom) out.push(base + parseTimeToMinutes(r.timeFrom) * MINUTE_MS);
    if (r.timeTo) out.push(base + parseTimeToMinutes(r.timeTo) * MINUTE_MS);
  }
  return out;
}

/** 設定時の静的検証（矛盾・不正値） */
export function validateWageRule(r: Partial<WageRule>): string[] {
  const e: string[] = [];
  if (typeof r.hourlyRate !== 'number' || !Number.isSafeInteger(r.hourlyRate) || r.hourlyRate <= 0) e.push('時給は1円以上の整数で入力してください');
  if (r.kind === 'timeband') {
    if (!r.timeFrom || !r.timeTo) e.push('時間帯の開始・終了を入力してください');
    else if (parseTimeToMinutes(r.timeFrom) >= parseTimeToMinutes(r.timeTo)) e.push('時間帯の終了は開始より後にしてください（翌日は24:00以降で表記）');
  }
  if (r.kind === 'weekday' && (!r.weekdays || r.weekdays.length === 0)) e.push('曜日を選択してください');
  if (r.kind === 'special_date' && (!r.specialDates || r.specialDates.length === 0)) e.push('特定日を入力してください');
  if (r.includesNightPremium) {
    if (typeof r.premiumBaseRate !== 'number' || r.premiumBaseRate <= 0) e.push('深夜割増込みの時給には割増算定基礎となる通常時給を入力してください');
    else if (typeof r.hourlyRate === 'number' && r.hourlyRate * 100 < r.premiumBaseRate * 125) e.push('深夜割増込みの時給が通常時給×1.25を下回っています');
  }
  if (r.effectiveTo && r.effectiveFrom && r.effectiveTo < r.effectiveFrom) e.push('適用終了日は開始日以降にしてください');
  return e;
}

/** 同一優先度で適用期間・条件が重なり時給が異なるルールの組を列挙（設定画面の警告用） */
export function findConflicts(rules: WageRule[]): Array<[WageRule, WageRule]> {
  const out: Array<[WageRule, WageRule]> = [];
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (a.employeeId !== b.employeeId || a.priority !== b.priority || a.hourlyRate === b.hourlyRate) continue;
      const aTo = a.effectiveTo ?? '9999-12-31';
      const bTo = b.effectiveTo ?? '9999-12-31';
      if (a.effectiveFrom > bTo || b.effectiveFrom > aTo) continue;
      if (a.kind !== b.kind) continue;
      if (a.kind === 'weekday' && !a.weekdays.some((d) => b.weekdays.includes(d))) continue;
      if (a.kind === 'special_date' && !a.specialDates.some((d) => b.specialDates.includes(d))) continue;
      if (a.kind === 'timeband' && a.timeFrom && a.timeTo && b.timeFrom && b.timeTo) {
        const overlap =
          parseTimeToMinutes(a.timeFrom) < parseTimeToMinutes(b.timeTo) &&
          parseTimeToMinutes(b.timeFrom) < parseTimeToMinutes(a.timeTo);
        const dayOverlap = a.weekdays.length === 0 || b.weekdays.length === 0 || a.weekdays.some((d) => b.weekdays.includes(d));
        if (!overlap || !dayOverlap) continue;
      }
      out.push([a, b]);
    }
  }
  return out;
}
