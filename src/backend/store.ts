/**
 * データアクセス層
 *
 * - TableAdapter: 物理ストレージ（Google Sheets / メモリ）への読み書き
 * - UnitOfWork: 1リクエスト内の読み取りキャッシュと書き込みバッファ。flush() でまとめて書き込む
 * - 部分失敗対策: 書き込み前に operation_journal へ変更内容を記録し（started）、書き込み後に committed にする。
 *   次回の更新処理開始時に started のまま残った記録を再適用（upsert のため冪等）する。
 * - Google Sheets は RDB と同等のトランザクションを持たないため、排他は Platform.withLock（スクリプトロック）で行う。
 */
import { TABLE_BY_NAME, partitionKeyOf, type ColType, type TableDef, type TableName } from './schema';
import { toIsoJst } from '../shared/time';
import type { RowMeta } from '../shared/types';

export type Cell = string | number | boolean;
export type RawRow = Cell[];

export interface Change {
  table: TableName;
  partition: string | null;
  op: 'upsert';
  row: Record<string, unknown>;
}

export interface TableAdapter {
  /** 指定パーティションの行（ヘッダー除く）。テーブル（シート）が無ければ空配列 */
  read(def: TableDef, partition: string | null): RawRow[];
  /** 存在するパーティション一覧（'YYYY-MM'） */
  partitions(def: TableDef): string[];
  /** 変更をまとめて書き込む（id 一致行は上書き、なければ追加） */
  write(changes: Array<{ def: TableDef; partition: string | null; id: string; raw: RawRow }>): void;
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** 1セルの最大文字数（Google Sheets の上限 50,000 文字に余裕を持たせる） */
export const MAX_CELL_CHARS = 45000;

export function encodeCell(type: ColType, v: unknown, col: string): Cell {
  switch (type) {
    case 'string':
      if (typeof v !== 'string') throw new Error(`列 ${col} は文字列が必要です`);
      return v;
    case 'string_nullable':
      if (v === null || v === undefined) return '';
      if (typeof v !== 'string') throw new Error(`列 ${col} は文字列が必要です`);
      return v;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`列 ${col} は数値が必要です`);
      return v;
    case 'number_nullable':
      if (v === null || v === undefined) return '';
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`列 ${col} は数値が必要です`);
      return v;
    case 'boolean':
      return v === true;
    case 'json':
      return JSON.stringify(v ?? null);
  }
}

export function decodeCell(type: ColType, v: Cell | undefined): unknown {
  switch (type) {
    case 'string':
      return v === undefined || v === null ? '' : String(v);
    case 'string_nullable':
      return v === undefined || v === '' ? null : String(v);
    case 'number':
      return typeof v === 'number' ? v : v === '' || v === undefined ? 0 : Number(v);
    case 'number_nullable':
      return v === '' || v === undefined ? null : typeof v === 'number' ? v : Number(v);
    case 'boolean':
      return v === true || v === 'TRUE' || v === 'true';
    case 'json':
      if (v === '' || v === undefined) return null;
      try {
        return JSON.parse(String(v));
      } catch {
        return null;
      }
  }
}

export function encodeRow(def: TableDef, obj: Record<string, unknown>): RawRow {
  return def.columns.map(([c, ty]) => {
    const cell = encodeCell(ty, obj[c], `${def.name}.${c}`);
    if (typeof cell === 'string' && cell.length > MAX_CELL_CHARS) throw new Error(`${def.name}.${c} がセルの上限文字数を超えています`);
    return cell;
  });
}

export function decodeRow<T>(def: TableDef, raw: RawRow): T {
  const o: Record<string, unknown> = {};
  def.columns.forEach(([c, ty], i) => {
    o[c] = decodeCell(ty, raw[i]);
  });
  return o as T;
}

export interface UnitOfWorkOptions {
  now: () => number;
  newId: (prefix: string) => string;
}

export class UnitOfWork {
  private cache = new Map<string, Record<string, unknown>[]>();
  private pending = new Map<string, Change>();
  private updatedKeys = new Set<string>();
  constructor(
    readonly adapter: TableAdapter,
    private readonly opts: UnitOfWorkOptions,
  ) {}

  private key(table: TableName, partition: string | null) {
    return `${table}|${partition ?? ''}`;
  }

  private load(table: TableName, partition: string | null): Record<string, unknown>[] {
    const k = this.key(table, partition);
    let rows = this.cache.get(k);
    if (!rows) {
      const def = TABLE_BY_NAME[table];
      rows = this.adapter.read(def, partition).filter((r) => r[0] !== '' && r[0] !== undefined).map((r) => decodeRow<Record<string, unknown>>(def, r));
      this.cache.set(k, rows);
    }
    return rows;
  }

  /** 全件（パーティションテーブルは partitions 指定、未指定なら全パーティション） */
  list<T>(table: TableName, opts: { partitions?: string[] } = {}): T[] {
    const def = TABLE_BY_NAME[table];
    if (!def.partitionBy) return this.load(table, null).map((r) => ({ ...r })) as T[];
    const parts = opts.partitions ?? this.adapter.partitions(def);
    const out: Record<string, unknown>[] = [];
    for (const p of parts) out.push(...this.load(table, p));
    return out.map((r) => ({ ...r })) as T[];
  }

  find<T>(table: TableName, pred: (r: T) => boolean, opts: { partitions?: string[] } = {}): T[] {
    return this.list<T>(table, opts).filter(pred);
  }

  get<T>(table: TableName, id: string, opts: { partitions?: string[] } = {}): T | null {
    return this.list<T>(table, opts).find((r) => (r as unknown as RowMeta).id === id) ?? null;
  }

  newId(prefix: string): string {
    return this.opts.newId(prefix);
  }

  nowIso(): string {
    return toIsoJst(this.opts.now());
  }

  /** 直近 2 か月のパーティション（短期間のみ有効なデータ: セッション・ジャーナル・冪等性キー） */
  recentPartitions(): string[] {
    const cur = toIsoJst(this.opts.now()).slice(0, 7);
    const prev = toIsoJst(this.opts.now() - 35 * 86400000).slice(0, 7);
    return prev === cur ? [cur] : [prev, cur];
  }

  insert<T extends RowMeta>(table: TableName, row: Omit<T, keyof RowMeta> & Partial<RowMeta>, prefix = table.slice(0, 3)): T {
    const now = this.nowIso();
    const full = { ...row, id: row.id ?? this.newId(prefix), createdAt: row.createdAt ?? now, updatedAt: now, version: 1 } as unknown as T;
    this.stage(table, full as unknown as Record<string, unknown>);
    return full;
  }

  /** 楽観的排他: 渡された row.version が保存中の version と一致しなければ ConflictError */
  update<T extends RowMeta>(table: TableName, row: T): T {
    const def = TABLE_BY_NAME[table];
    const part = partitionKeyOf(def, row as unknown as Record<string, unknown>);
    const current = this.load(table, part).find((r) => r.id === row.id);
    if (!current) throw new ConflictError(`${table} の対象データが見つかりません`);
    if (current.version !== row.version) throw new ConflictError('他の操作で更新されています。画面を更新してやり直してください');
    const next = { ...row, updatedAt: this.nowIso(), version: row.version + 1 } as T;
    this.updatedKeys.add(`${table}|${row.id}`);
    this.stage(table, next as unknown as Record<string, unknown>);
    return next;
  }

  private stage(table: TableName, row: Record<string, unknown>) {
    const def = TABLE_BY_NAME[table];
    const part = partitionKeyOf(def, row);
    encodeRow(def, row); // 早期検証
    const rows = this.load(table, part);
    const i = rows.findIndex((r) => r.id === row.id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    this.pending.set(`${table}|${row.id as string}`, { table, partition: part, op: 'upsert', row });
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** 保留中の変更が新規追加のみか（ロック外で読んだ行を上書きしないための確認） */
  onlyInserts(): boolean {
    return this.updatedKeys.size === 0;
  }

  /** 書き込み（ジャーナル付き） */
  flush(): number {
    if (this.pending.size === 0) return 0;
    const changes = [...this.pending.values()];
    const journalId = this.newId('jnl');
    const now = this.nowIso();
    const detail = JSON.stringify(changes.map((c) => ({ t: c.table, p: c.partition, r: c.row })));
    const journalable = detail.length <= MAX_CELL_CHARS;
    const jdef = TABLE_BY_NAME.operation_journal;
    const journalRow = (state: string) => ({
      id: journalId, createdAt: now, updatedAt: this.nowIso(), version: state === 'started' ? 1 : 2,
      op: 'flush', state, detail: journalable ? detail : JSON.stringify({ tooLarge: true, tables: changes.map((c) => c.table) }),
    });
    const jpart = now.slice(0, 7);
    this.adapter.write([{ def: jdef, partition: jpart, id: journalId, raw: encodeRow(jdef, journalRow('started')) }]);
    this.adapter.write(
      changes.map((c) => {
        const def = TABLE_BY_NAME[c.table];
        return { def, partition: c.partition, id: c.row.id as string, raw: encodeRow(def, c.row) };
      }),
    );
    this.adapter.write([{ def: jdef, partition: jpart, id: journalId, raw: encodeRow(jdef, journalRow('committed')) }]);
    const n = this.pending.size;
    this.pending.clear();
    this.updatedKeys.clear();
    return n;
  }

  /** started のまま残ったジャーナルを再適用（ロック取得後・処理前に呼ぶ） */
  recoverJournal(): { replayed: number; unrecoverable: number } {
    const jdef = TABLE_BY_NAME.operation_journal;
    const rows = this.recentPartitions().flatMap((p) => this.adapter.read(jdef, p).map((r) => ({ p, ...decodeRow<{ id: string; state: string; detail: string; createdAt: string; version: number; op: string }>(jdef, r) })));
    let replayed = 0;
    let unrecoverable = 0;
    for (const j of rows.filter((r) => r.state === 'started')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(j.detail);
      } catch {
        parsed = null;
      }
      if (!Array.isArray(parsed)) {
        unrecoverable++;
        this.adapter.write([{ def: jdef, partition: j.p, id: j.id, raw: encodeRow(jdef, { ...j, state: 'failed', updatedAt: this.nowIso(), version: j.version + 1 }) }]);
        continue;
      }
      const writes = (parsed as Array<{ t: TableName; p: string | null; r: Record<string, unknown> }>).map((c) => {
        const def = TABLE_BY_NAME[c.t];
        return { def, partition: c.p, id: c.r.id as string, raw: encodeRow(def, c.r) };
      });
      this.adapter.write(writes);
      this.adapter.write([{ def: jdef, partition: j.p, id: j.id, raw: encodeRow(jdef, { ...j, state: 'committed', updatedAt: this.nowIso(), version: j.version + 1 }) }]);
      replayed++;
    }
    if (replayed || unrecoverable) this.cache.clear();
    return { replayed, unrecoverable };
  }
}

/** メモリ上のアダプタ（プレビュー・テスト用）。Sheets と同じく RawRow でエンコードして保持する */
export class MemoryAdapter implements TableAdapter {
  readonly sheets = new Map<string, RawRow[]>();
  /** テスト用: n 回目の write で例外を投げる */
  failOnWrite: number | null = null;
  private writes = 0;

  private name(def: TableDef, p: string | null) {
    return p ? `${def.name}__${p.replace('-', '_')}` : def.name;
  }
  read(def: TableDef, partition: string | null): RawRow[] {
    return (this.sheets.get(this.name(def, partition)) ?? []).map((r) => [...r]);
  }
  partitions(def: TableDef): string[] {
    const prefix = `${def.name}__`;
    return [...this.sheets.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).replace('_', '-')).sort();
  }
  write(changes: Array<{ def: TableDef; partition: string | null; id: string; raw: RawRow }>): void {
    this.writes++;
    if (this.failOnWrite !== null && this.writes === this.failOnWrite) throw new Error('模擬的な書き込み失敗');
    for (const c of changes) {
      const n = this.name(c.def, c.partition);
      const rows = this.sheets.get(n) ?? [];
      const i = rows.findIndex((r) => r[0] === c.id);
      if (i >= 0) rows[i] = [...c.raw];
      else rows.push([...c.raw]);
      this.sheets.set(n, rows);
    }
  }
  /** バックアップ用スナップショット */
  snapshot(): Record<string, RawRow[]> {
    return Object.fromEntries([...this.sheets.entries()].map(([k, v]) => [k, v.map((r) => [...r])]));
  }
  restore(s: Record<string, RawRow[]>) {
    this.sheets.clear();
    for (const [k, v] of Object.entries(s)) this.sheets.set(k, v.map((r) => [...r]));
  }
}
