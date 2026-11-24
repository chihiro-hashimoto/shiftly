/** サーバー側入力検証（クライアント検証には依存しない） */
import { E } from './errors';
import { isLocalDate, isLocalTime, type LocalDate, type LocalTime } from '../shared/time';

export type Args = Record<string, unknown>;

export function obj(x: unknown): Args {
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw E.invalid('リクエスト形式が不正です');
  return x as Args;
}

export function str(a: Args, k: string, o: { min?: number; max?: number; optional?: boolean; pattern?: RegExp; label?: string } = {}): string {
  const v = a[k];
  const label = o.label ?? k;
  if (v === undefined || v === null || v === '') {
    if (o.optional) return '';
    throw E.invalid(`${label}を入力してください`);
  }
  if (typeof v !== 'string') throw E.invalid(`${label}の形式が不正です`);
  const s = v.trim();
  if (o.min !== undefined && s.length < o.min) throw E.invalid(`${label}は${o.min}文字以上で入力してください`);
  if (s.length > (o.max ?? 200)) throw E.invalid(`${label}は${o.max ?? 200}文字以内で入力してください`);
  if (o.pattern && !o.pattern.test(s)) throw E.invalid(`${label}の形式が不正です`);
  return s;
}

export function optStr(a: Args, k: string, max = 500): string {
  return str(a, k, { optional: true, max });
}

export function int(a: Args, k: string, o: { min?: number; max?: number; optional?: boolean; label?: string } = {}): number {
  const v = a[k];
  const label = o.label ?? k;
  if (v === undefined || v === null || v === '') {
    if (o.optional) return NaN;
    throw E.invalid(`${label}を入力してください`);
  }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw E.invalid(`${label}は整数で入力してください`);
  if (o.min !== undefined && v < o.min) throw E.invalid(`${label}は${o.min}以上で入力してください`);
  if (o.max !== undefined && v > o.max) throw E.invalid(`${label}は${o.max}以下で入力してください`);
  return v;
}

export function intOrNull(a: Args, k: string, o: { min?: number; max?: number; label?: string } = {}): number | null {
  const v = a[k];
  if (v === undefined || v === null || v === '') return null;
  return int(a, k, o);
}

export function num(a: Args, k: string, o: { min?: number; max?: number; label?: string } = {}): number {
  const v = a[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw E.invalid(`${o.label ?? k}は数値で入力してください`);
  if (o.min !== undefined && v < o.min) throw E.invalid(`${o.label ?? k}は${o.min}以上で入力してください`);
  if (o.max !== undefined && v > o.max) throw E.invalid(`${o.label ?? k}は${o.max}以下で入力してください`);
  return v;
}

export function bool(a: Args, k: string, def = false): boolean {
  const v = a[k];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw E.invalid(`${k}の形式が不正です`);
  return v;
}

export function date(a: Args, k: string, o: { optional?: boolean; label?: string } = {}): LocalDate {
  const v = a[k];
  if ((v === undefined || v === null || v === '') && o.optional) return '';
  if (!isLocalDate(v)) throw E.invalid(`${o.label ?? k}の日付が不正です（YYYY-MM-DD）`);
  return v;
}

export function dateOrNull(a: Args, k: string, label?: string): LocalDate | null {
  const v = a[k];
  if (v === undefined || v === null || v === '') return null;
  return date(a, k, { label: label ?? k });
}

export function time(a: Args, k: string, o: { allowNextDay?: boolean; label?: string; optional?: boolean } = {}): LocalTime {
  const v = a[k];
  if ((v === undefined || v === null || v === '') && o.optional) return '';
  if (!isLocalTime(v, o.allowNextDay)) throw E.invalid(`${o.label ?? k}の時刻が不正です（HH:MM）`);
  return v;
}

export function oneOf<T extends string>(a: Args, k: string, values: readonly T[], label?: string): T {
  const v = a[k];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw E.invalid(`${label ?? k}の値が不正です`);
  return v as T;
}

export function id(a: Args, k: string, label?: string): string {
  return str(a, k, { max: 64, pattern: /^[A-Za-z0-9_:-]+$/, label: label ?? k });
}

export function intArray(a: Args, k: string, o: { min: number; max: number }): number[] {
  const v = a[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < o.min || x > o.max)) throw E.invalid(`${k}の形式が不正です`);
  return [...new Set(v as number[])].sort((x, y) => x - y);
}

export function dateArray(a: Args, k: string): LocalDate[] {
  const v = a[k];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 400 || v.some((x) => !isLocalDate(x))) throw E.invalid(`${k}の日付形式が不正です`);
  return [...new Set(v as string[])].sort();
}

export function range(a: Args, maxDays = 400): { from: LocalDate; to: LocalDate } {
  const from = date(a, 'from', { label: '開始日' });
  const to = date(a, 'to', { label: '終了日' });
  if (to < from) throw E.invalid('終了日は開始日以降にしてください');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > maxDays) throw E.invalid(`期間は${maxDays}日以内で指定してください`);
  return { from, to };
}
