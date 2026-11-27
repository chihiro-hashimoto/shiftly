/**
 * 実行環境の抽象化（GAS / ブラウザ上のモック / テスト）
 * すべて同期 API（GAS が同期実行のため）。
 */
import type { Bytes } from '../shared/crypto';

export interface SecretStore {
  /** Script Properties 等、業務DB・バックアップと分離されたサーバー側の保存場所 */
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface Cache {
  get(key: string): string | null;
  put(key: string, value: string, ttlSec: number): void;
  remove(key: string): void;
}

export interface FileStore {
  /** アプリが作成したフォルダ配下にのみ作成する（任意のファイルIDは受け付けない） */
  createFile(folder: FolderKey, name: string, mimeType: string, data: Bytes): { fileId: string; url: string | null };
  readFile(fileId: string): Bytes | null;
  /** スプレッドシート（DB）のコピーを作成（バックアップ用） */
  copyDatabase(folder: FolderKey, name: string): { fileId: string; sizeBytes: number | null };
  /** Drive の空き容量（バイト）。取得不能なら null */
  storageQuota(): { limit: number | null; usage: number } | null;
  /** HTML を PDF に変換（GAS: Utilities.newBlob(...).getAs）。不可なら null */
  htmlToPdf(html: string): Bytes | null;
  listFiles(folder: FolderKey): Array<{ fileId: string; name: string; createdAt: string; sizeBytes: number | null }>;
  trashFile(folder: FolderKey, fileId: string): void;
}

export type FolderKey = '00_System' | '01_Database' | '02_Payslips' | '03_Exports' | '04_Audit' | '05_Backup';
export const FOLDER_KEYS: FolderKey[] = ['00_System', '01_Database', '02_Payslips', '03_Exports', '04_Audit', '05_Backup'];

/**
 * 稼働中の DB の識別（D-027 B案）。v1.3 では稼働中の DB を切り替える処理（復元の候補の作成・切替・破棄）を提供しない
 * （アプリ内の自動復元・稼働中の DB の自動切替は次の版以降に延期。データの復元は Google 所有者の保守作業として行う）
 */
export interface DatabaseControl {
  /** 現在の DB 識別子 */
  currentId(): string;
}

export interface Platform {
  database: DatabaseControl;
  kind: 'gas' | 'mock' | 'test';
  now(): number;
  /** 暗号学的に十分な乱数（16進） */
  randomHex(bytes: number): string;
  hmacSha256(key: Bytes, data: Bytes): Bytes;
  sha256Hex(s: string): string;
  /** スクリプト単位の排他ロック。timeoutMs 内に取得できなければ例外 */
  withLock<T>(timeoutMs: number, fn: () => T): T;
  secrets: SecretStore;
  cache: Cache;
  files: FileStore;
  /** 実行者（オーナー）のメールアドレス。取得できない場合は null（取得できる前提にしない） */
  effectiveUserEmail(): string | null;
  /**
   * 構築の完了前の保管先の点検（D-026 S1。Google ドライブの構成物が 1 つずつで、保存済みの ID と一致し、作成中の目印がないこと）。
   * 点検できない環境では undefined（点検済みとして扱わない）
   */
  storageReport?(): { ok: boolean; issues: string[]; items: Array<{ key: string; saved: boolean; found: number }> };
  log(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, string | number | boolean | null>): void;
}
