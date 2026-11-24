/**
 * CSV 出力
 * - 数式インジェクション対策: 文字列セルが = + - @ TAB CR で始まる場合は先頭に ' を付与
 *   （数値型セルは対象外。負の数値は number として渡すこと）
 * - Excel での文字化け防止に UTF-8 BOM を付与（オプション）
 * - 改行は CRLF（RFC 4180）
 */
export type Cell = string | number | boolean | null | undefined;

const DANGEROUS = /^[=+\-@\t\r]/;

export function neutralizeFormula(s: string): string {
  return DANGEROUS.test(s) ? `'${s}` : s;
}

export function csvEscape(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const s = neutralizeFormula(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][], opts: { bom?: boolean } = {}): string {
  const lines = [header.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))];
  return (opts.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
}
