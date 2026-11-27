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
  /** シート名 → 列数（グリッドの幅）。旧スキーマのシートは列が少ないため、読み取り範囲をこの幅に制限する */
  private colCounts = new Map<string, number>();
  /** シート名 → (id → 行番号 1始まり) */
  private index = new Map<string, Map<string, number>>();
  private lastRow = new Map<string, number>();

  constructor(private readonly spreadsheetId: () => string) {}

  private sheetTitles(): Set<string> {
    if (!this.titles) {
      const ss = Sheets.Spreadsheets.get(this.spreadsheetId(), { fields: 'sheets.properties(title,gridProperties.columnCount)' });
      this.titles = new Set<string>((ss.sheets ?? []).map((s: any) => s.properties.title as string));
      this.colCounts.clear();
      for (const s of ss.sheets ?? []) {
        const n = Number(s.properties?.gridProperties?.columnCount);
        if (Number.isFinite(n) && n > 0) this.colCounts.set(s.properties.title as string, n);
      }
    }
    return this.titles;
  }

  /** 読み取る列数: スキーマの列数とシートの列数（グリッドの幅）の小さい方（不足列は既定値で補う） */
  private readWidth(def: TableDef, name: string): number {
    const g = this.colCounts.get(name);
    return g ? Math.min(def.columns.length, g) : def.columns.length;
  }

  read(def: TableDef, partition: string | null): RawRow[] {
    const name = sheetNameFor(def, partition);
    if (!this.sheetTitles().has(name)) return [];
    const res = Sheets.Spreadsheets.Values.get(this.spreadsheetId(), `${q(name)}!A2:${colLetter(this.readWidth(def, name))}`, {
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
        ranges: present.map((r) => `${q(r.name)}!A2:${colLetter(this.readWidth(r.def, r.name))}`),
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
    this.colCounts.clear();
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
    this.colCounts.set(name, Math.max(26, def.columns.length));
    this.index.set(name, new Map());
    this.lastRow.set(name, 1);
  }

  /**
   * 旧スキーマのシート（列が少ない）に書き込む前に、グリッドの列を追加し、ヘッダーに新しい列名を追記する
   * （スキーマの列追加は末尾のみのため、既存の列・値は変更しない）
   */
  private ensureColumns(def: TableDef, name: string) {
    const have = this.colCounts.get(name);
    if (have !== undefined && have < def.columns.length) {
      const ss = Sheets.Spreadsheets.get(this.spreadsheetId(), { fields: 'sheets.properties(sheetId,title)' });
      const sheet = (ss.sheets ?? []).find((s: any) => s.properties.title === name);
      Sheets.Spreadsheets.batchUpdate({ requests: [{ appendDimension: { sheetId: sheet.properties.sheetId, dimension: 'COLUMNS', length: def.columns.length - have } }] }, this.spreadsheetId());
      this.colCounts.set(name, def.columns.length);
    }
    this.ensureHeader(def, name);
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
      if ((this.colCounts.get(name) ?? c.def.columns.length) < c.def.columns.length) this.ensureColumns(c.def, name);
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
    const data: Array<{ range: string; values: RawRow[] }> = [];
    const placed: Array<{ name: string; rows: RawRow[]; start: number; end: number }> = [];
    for (const [name, a] of appends) {
      // ロック内のため行番号を計算して書き込む（append の自動範囲検出に依存しない）
      const start = (this.lastRow.get(name) ?? 1) + 1;
      const end = start + a.rows.length - 1;
      this.ensureRows(name, end);
      data.push({ range: `${q(name)}!A${start}:${colLetter(a.def.columns.length)}${end}`, values: a.rows });
      placed.push({ name, rows: a.rows, start, end });
    }
    // 追記と既存行の更新を 1 回の batchUpdate にまとめる（Sheets API の書き込み回数＝割当の消費を抑える）。
    // 途中失敗時はジャーナル（UnitOfWork.flush）による再適用で回復する
    data.push(...updates);
    if (data.length) Sheets.Spreadsheets.Values.batchUpdate({ valueInputOption: 'RAW', data }, this.spreadsheetId());
    for (const x of placed) {
      x.rows.forEach((r, i) => this.index.get(x.name)!.set(String(r[0]), x.start + i));
      this.lastRow.set(x.name, x.end);
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
