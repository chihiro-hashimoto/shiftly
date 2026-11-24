/**
 * メモリ上のモック実行環境（単体・統合テストとブラウザ上のプレビュー用）
 * 業務データはメモリ上のみに保持し、端末へ永続保存しない。
 */
import type { Cache, DatabaseControl, FileStore, FolderKey, Platform, SecretStore } from './platform';
import { MemoryAdapter, type RawRow } from './store';
import { hmacSha256, sha256 } from '../shared/sha256';
import { toHex, utf8, type Bytes } from '../shared/crypto';
import { toIsoJst } from '../shared/time';

export class MemorySecrets implements SecretStore {
  readonly m = new Map<string, string>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
  delete(k: string) {
    this.m.delete(k);
  }
}

export class MemoryCache implements Cache {
  readonly m = new Map<string, { v: string; exp: number }>();
  constructor(private readonly clock: () => number) {}
  get(k: string) {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp < this.clock()) {
      this.m.delete(k);
      return null;
    }
    return e.v;
  }
  put(k: string, v: string, ttl: number) {
    this.m.set(k, { v, exp: this.clock() + ttl * 1000 });
  }
  remove(k: string) {
    this.m.delete(k);
  }
}

interface MemFile {
  id: string;
  folder: FolderKey;
  name: string;
  mimeType: string;
  data: Bytes | null;
  dbSnapshot: Record<string, RawRow[]> | null;
  createdAt: string;
  trashed: boolean;
}

export class MemoryFiles implements FileStore, DatabaseControl {
  readonly files = new Map<string, MemFile>();
  private dbId = 'db_primary';
  quota: { limit: number | null; usage: number } | null = { limit: 15 * 1024 ** 3, usage: 2 * 1024 ** 3 };
  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly clock: () => number,
    private readonly rnd: () => string,
  ) {}
  createFile(folder: FolderKey, name: string, mimeType: string, data: Bytes) {
    const id = `file_${this.rnd()}`;
    this.files.set(id, { id, folder, name, mimeType, data, dbSnapshot: null, createdAt: toIsoJst(this.clock()), trashed: false });
    return { fileId: id, url: null };
  }
  readFile(fileId: string) {
    const f = this.files.get(fileId);
    return f && !f.trashed ? f.data : null;
  }
  copyDatabase(folder: FolderKey, name: string) {
    const id = `file_${this.rnd()}`;
    const snap = this.adapter.snapshot();
    this.files.set(id, { id, folder, name, mimeType: 'application/vnd.google-apps.spreadsheet', data: null, dbSnapshot: snap, createdAt: toIsoJst(this.clock()), trashed: false });
    return { fileId: id, sizeBytes: JSON.stringify(snap).length };
  }
  storageQuota() {
    return this.quota;
  }
  htmlToPdf(html: string): Bytes | null {
    // モックでは PDF 変換を行わず、HTML を格納した擬似 PDF を返す
    return utf8(`%PDF-MOCK\n${html.length}`);
  }
  listFiles(folder: FolderKey) {
    return [...this.files.values()].filter((f) => f.folder === folder && !f.trashed).map((f) => ({ fileId: f.id, name: f.name, createdAt: f.createdAt, sizeBytes: f.data ? f.data.length : null }));
  }
  trashFile(folder: FolderKey, fileId: string) {
    const f = this.files.get(fileId);
    if (!f || f.folder !== folder) throw new Error('対象ファイルが見つかりません');
    f.trashed = true;
  }
  currentId() {
    return this.dbId;
  }
  private readonly candidates = new Map<string, MemoryAdapter>();
  prepareRestoreCopy(backupFileId: string) {
    const f = this.files.get(backupFileId);
    if (!f || !f.dbSnapshot || f.trashed) throw new Error('バックアップが見つかりません');
    const adapter = new MemoryAdapter();
    adapter.restore(f.dbSnapshot);
    const candidateId = `db_${this.rnd()}`;
    this.candidates.set(candidateId, adapter);
    return { candidateId, adapter };
  }
  activate(candidateId: string) {
    const c = this.candidates.get(candidateId);
    if (!c) throw new Error('復元候補が見つかりません');
    const prev = this.dbId;
    this.adapter.restore(c.snapshot());
    this.candidates.delete(candidateId);
    this.dbId = candidateId;
    return { previousId: prev };
  }
  discard(candidateId: string) {
    this.candidates.delete(candidateId);
  }
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export interface MockEnv {
  platform: Platform;
  adapter: MemoryAdapter;
  files: MemoryFiles;
  secrets: MemorySecrets;
  cache: MemoryCache;
  clock: { now: number; auto: boolean };
  logs: Array<{ level: string; message: string; meta?: unknown }>;
}

export function createMockEnv(opts: { now?: number; autoClock?: boolean; kind?: 'mock' | 'test' } = {}): MockEnv {
  const clock = { now: opts.now ?? Date.now(), auto: opts.autoClock ?? false };
  const now = () => (clock.auto ? Date.now() : clock.now);
  const adapter = new MemoryAdapter();
  const secrets = new MemorySecrets();
  const cache = new MemoryCache(now);
  const rnd = () => toHex(randomBytes(8));
  const files = new MemoryFiles(adapter, now, rnd);
  const logs: MockEnv['logs'] = [];
  const platform: Platform = {
    kind: opts.kind ?? 'test',
    now,
    randomHex: (n) => toHex(randomBytes(n)),
    hmacSha256: (k, d) => hmacSha256(k, d),
    sha256Hex: (s) => toHex(sha256(utf8(s))),
    // 単一スレッドのため排他は不要（GAS では LockService.getScriptLock を使用）
    withLock: (_t, fn) => fn(),
    secrets,
    cache,
    files,
    database: files,
    effectiveUserEmail: () => 'owner@example.invalid',
    log: (level, message, meta) => {
      logs.push({ level, message, meta });
    },
  };
  return { platform, adapter, files, secrets, cache, clock, logs };
}
