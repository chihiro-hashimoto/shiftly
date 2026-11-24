/**
 * Google Sheets（Sheets API v4 / 高度なサービス）による TableAdapter
 * - 1テーブル=1シート。1行目ヘッダー。A列=id
 * - 書き込みは valueInputOption=RAW（'=' で始まる文字列を数式として評価させない）
 * - 1 回の write() で: 不足シートの追加 → 既存行の更新（values.batchUpdate）→ 新規行の追記（values.append）
 * - 呼び出しは必ず Platform.withLock 内（api.ts）で行われる
 * 【実環境未検証】API 応答形式・上限（docs/technical-verification.md）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RawRow, TableAdapter } from '../store';
import type { TableDef } from '../schema';
import { sheetNameFor } from '../schema';

declare const Sheets: any;

function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function q(name: string) {
  return `'${name.replace(/'/g, "''")}'`;
}

export class SheetsAdapter implements TableAdapter {
  private titles: Set<string> | null = null;
  /** シート名 → (id → 行番号 1始まり) */
  private index = new Map<string, Map<string, number>>();
  private lastRow = new Map<string, number>();

  constructor(private readonly spreadsheetId: () => string) {}

  private sheetTitles(): Set<string> {
    if (!this.titles) {
      const ss = Sheets.Spreadsheets.get(this.spreadsheetId(), { fields: 'sheets.properties.title' });
      this.titles = new Set<string>((ss.sheets ?? []).map((s: any) => s.properties.title as string));
    }
    return this.titles;
  }

  read(def: TableDef, partition: string | null): RawRow[] {
    const name = sheetNameFor(def, partition);
    if (!this.sheetTitles().has(name)) return [];
    const res = Sheets.Spreadsheets.Values.get(this.spreadsheetId(), `${q(name)}!A2:${colLetter(def.columns.length)}`, {
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    const rows: RawRow[] = (res.values ?? []) as RawRow[];
    const idx = new Map<string, number>();
    rows.forEach((r, i) => {
      if (r[0] !== undefined && r[0] !== '') idx.set(String(r[0]), i + 2);
    });
    this.index.set(name, idx);
    this.lastRow.set(name, rows.length + 1);
    return rows;
  }

  readMany(reqs: Array<{ def: TableDef; partition: string | null }>): RawRow[][] {
    const titles = this.sheetTitles();
    const present = reqs.map((r) => ({ ...r, name: sheetNameFor(r.def, r.partition) })).filter((r) => titles.has(r.name));
    const out = new Map<string, RawRow[]>();
    if (present.length) {
      const res = Sheets.Spreadsheets.Values.batchGet(this.spreadsheetId(), {
        ranges: present.map((r) => `${q(r.name)}!A2:${colLetter(r.def.columns.length)}`),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
      present.forEach((r, i) => {
        const rows: RawRow[] = ((res.valueRanges?.[i]?.values ?? []) as RawRow[]);
        const idx = new Map<string, number>();
        rows.forEach((row, j) => {
          if (row[0] !== undefined && row[0] !== '') idx.set(String(row[0]), j + 2);
        });
        this.index.set(r.name, idx);
        this.lastRow.set(r.name, rows.length + 1);
        out.set(r.name, rows);
      });
    }
    return reqs.map((r) => out.get(sheetNameFor(r.def, r.partition)) ?? []);
  }

  reset() {
    this.titles = null;
    this.index.clear();
    this.lastRow.clear();
    this.gridRows.clear();
  }

  partitions(def: TableDef): string[] {
    const prefix = `${def.name}__`;
    return [...this.sheetTitles()].filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length).replace('_', '-')).sort();
  }

  private ensureSheet(def: TableDef, name: string) {
    if (this.sheetTitles().has(name)) return;
    Sheets.Spreadsheets.batchUpdate(
      { requests: [{ addSheet: { properties: { title: name, gridProperties: { frozenRowCount: 1, columnCount: Math.max(26, def.columns.length) } } } }] },
      this.spreadsheetId(),
    );
    Sheets.Spreadsheets.Values.update({ values: [def.columns.map(([c]) => c)] }, this.spreadsheetId(), `${q(name)}!A1`, { valueInputOption: 'RAW' });
    this.sheetTitles().add(name);
    this.index.set(name, new Map());
    this.lastRow.set(name, 1);
  }

  /** ヘッダーが古い（列が少ない）場合は末尾に列名を追加（後方互換のマイグレーション） */
  ensureHeader(def: TableDef, name: string) {
    const res = Sheets.Spreadsheets.Values.get(this.spreadsheetId(), `${q(name)}!1:1`);
    const header: string[] = (res.values?.[0] ?? []) as string[];
    const want = def.columns.map(([c]) => c);
    for (let i = 0; i < Math.min(header.length, want.length); i++) {
      if (header[i] !== want[i]) throw new Error(`シート ${name} の列構成が想定と異なります（${i + 1}列目: ${header[i]}）`);
    }
    if (header.length < want.length) {
      Sheets.Spreadsheets.Values.update({ values: [want] }, this.spreadsheetId(), `${q(name)}!A1`, { valueInputOption: 'RAW' });
    }
  }

  write(changes: Array<{ def: TableDef; partition: string | null; id: string; raw: RawRow }>): void {
    const updates: Array<{ range: string; values: RawRow[] }> = [];
    const appends = new Map<string, { def: TableDef; rows: RawRow[] }>();
    for (const c of changes) {
      const name = sheetNameFor(c.def, c.partition);
      this.ensureSheet(c.def, name);
      if (!this.index.has(name)) this.read(c.def, c.partition);
      const row = this.index.get(name)!.get(c.id);
      if (row) {
        updates.push({ range: `${q(name)}!A${row}:${colLetter(c.def.columns.length)}${row}`, values: [c.raw] });
      } else {
        const a = appends.get(name) ?? { def: c.def, rows: [] };
        // 同一 write 内の同一 id は最後の値のみ
        const dup = a.rows.findIndex((r) => r[0] === c.id);
        if (dup >= 0) a.rows[dup] = c.raw;
        else a.rows.push(c.raw);
        appends.set(name, a);
      }
    }
    for (const [name, a] of appends) {
      // ロック内のため行番号を計算して書き込む（append の自動範囲検出に依存しない）
      const start = (this.lastRow.get(name) ?? 1) + 1;
      const end = start + a.rows.length - 1;
      this.ensureRows(name, end);
      Sheets.Spreadsheets.Values.update({ values: a.rows }, this.spreadsheetId(), `${q(name)}!A${start}:${colLetter(a.def.columns.length)}${end}`, { valueInputOption: 'RAW' });
      a.rows.forEach((r, i) => this.index.get(name)!.set(String(r[0]), start + i));
      this.lastRow.set(name, end);
    }
    // 追記を先に行い、既存行の更新を後にする（途中失敗時に「旧版を無効化したが新版がない」状態を避ける）
    if (updates.length) {
      Sheets.Spreadsheets.Values.batchUpdate({ valueInputOption: 'RAW', data: updates }, this.spreadsheetId());
    }
  }

  private gridRows = new Map<string, number>();
  private ensureRows(name: string, needed: number) {
    let rows = this.gridRows.get(name);
    if (rows === undefined) {
      const ss = Sheets.Spreadsheets.get(this.spreadsheetId(), { fields: 'sheets.properties(sheetId,title,gridProperties.rowCount)' });
      for (const s of ss.sheets ?? []) this.gridRows.set(s.properties.title, s.properties.gridProperties.rowCount);
      rows = this.gridRows.get(name) ?? 1000;
    }
    if (needed <= rows) return;
    const ss = Sheets.Spreadsheets.get(this.spreadsheetId(), { fields: 'sheets.properties(sheetId,title)' });
    const sheet = (ss.sheets ?? []).find((s: any) => s.properties.title === name);
    const add = Math.max(1000, needed - rows);
    Sheets.Spreadsheets.batchUpdate({ requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', length: add } }] }, this.spreadsheetId());
    this.gridRows.set(name, rows + add);
  }
}
