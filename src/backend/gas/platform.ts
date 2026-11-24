/**
 * Google Apps Script 実行環境の Platform 実装
 *
 * スコープ方針（appsscript.json の oauthScopes で明示）:
 * - drive.file: Shiftly 自身が作成したファイル・フォルダのみ（店長の他の Drive ファイルにはアクセスしない）
 * - script.external_request: Drive のファイル本体取得（REST）等
 * - script.scriptapp: 日次トリガーの登録
 * - userinfo.email: 所有者アカウントの確認（取り違え防止）
 * Sheets / Drive は高度なサービス（Advanced Service）経由で呼び出す。
 * 【実環境未検証】drive.file での Sheets API 操作・高度なサービスの自動有効化は docs/technical-verification.md 参照。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Cache, DatabaseControl, FileStore, FolderKey, Platform, SecretStore } from '../platform';
import { FOLDER_KEYS } from '../platform';
import { toHex, type Bytes } from '../../shared/crypto';

declare const Drive: any;
declare const Sheets: any;

export const PROP = {
  dbId: 'SHIFTLY_DB_ID',
  folders: 'SHIFTLY_FOLDERS',
  rootFolder: 'SHIFTLY_ROOT_FOLDER',
} as const;

/** GAS の Byte[]（-128..127）→ Uint8Array */
export function fromJavaBytes(b: number[]): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i]! & 0xff;
  return out;
}

/** Uint8Array → GAS の Byte[] */
export function toJavaBytes(b: Uint8Array): number[] {
  const out = new Array<number>(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i]! > 127 ? b[i]! - 256 : b[i]!;
  return out;
}

class GasSecrets implements SecretStore {
  private props = PropertiesService.getScriptProperties();
  get(k: string) {
    return this.props.getProperty(k);
  }
  set(k: string, v: string) {
    this.props.setProperty(k, v);
  }
  delete(k: string) {
    this.props.deleteProperty(k);
  }
}

class GasCache implements Cache {
  private c = CacheService.getScriptCache();
  get(k: string) {
    return this.c.get(k);
  }
  put(k: string, v: string, ttl: number) {
    this.c.put(k, v, Math.max(1, Math.min(21600, Math.ceil(ttl))));
  }
  remove(k: string) {
    this.c.remove(k);
  }
}

function folders(): Record<FolderKey, string> {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP.folders);
  if (!raw) throw new Error('Shiftly のフォルダが未作成です');
  return JSON.parse(raw) as Record<FolderKey, string>;
}

class GasFiles implements FileStore, DatabaseControl {
  createFile(folder: FolderKey, name: string, mimeType: string, data: Bytes) {
    const blob = Utilities.newBlob(toJavaBytes(data), mimeType, name);
    const f = Drive.Files.create({ name, mimeType, parents: [folders()[folder]] }, blob, { fields: 'id,webViewLink' });
    return { fileId: f.id as string, url: (f.webViewLink as string) ?? null };
  }
  readFile(fileId: string): Bytes | null {
    try {
      const res = UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) return null;
      return fromJavaBytes(res.getContent() as unknown as number[]);
    } catch {
      return null;
    }
  }
  copyDatabase(folder: FolderKey, name: string) {
    const id = PropertiesService.getScriptProperties().getProperty(PROP.dbId);
    if (!id) throw new Error('DB が未作成です');
    const f = Drive.Files.copy({ name, parents: [folders()[folder]] }, id, { fields: 'id,size' });
    return { fileId: f.id as string, sizeBytes: f.size ? Number(f.size) : null };
  }
  storageQuota() {
    try {
      const a = Drive.About.get({ fields: 'storageQuota' });
      const q = a.storageQuota ?? {};
      return { limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage ?? 0) };
    } catch {
      return null;
    }
  }
  htmlToPdf(html: string): Bytes | null {
    try {
      const pdf = Utilities.newBlob(html, 'text/html', 'payslip.html').getAs('application/pdf');
      return fromJavaBytes(pdf.getBytes() as unknown as number[]);
    } catch {
      return null;
    }
  }
  listFiles(folder: FolderKey) {
    const res = Drive.Files.list({ q: `'${folders()[folder]}' in parents and trashed = false`, fields: 'files(id,name,createdTime,size)', pageSize: 200 });
    return (res.files ?? []).map((f: any) => ({ fileId: f.id, name: f.name, createdAt: f.createdTime, sizeBytes: f.size ? Number(f.size) : null }));
  }
  trashFile(folder: FolderKey, fileId: string) {
    // アプリ管理フォルダ配下のファイルであることを確認してからゴミ箱へ（完全削除はしない）
    const f = Drive.Files.get(fileId, { fields: 'parents' });
    if (!(f.parents ?? []).includes(folders()[folder])) throw new Error('対象フォルダ外のファイルは削除できません');
    Drive.Files.update({ trashed: true }, fileId);
  }
  currentId() {
    const id = PropertiesService.getScriptProperties().getProperty(PROP.dbId);
    if (!id) throw new Error('DB が未作成です');
    return id;
  }
  activateCopyOf(backupFileId: string) {
    const prev = this.currentId();
    const f = Drive.Files.copy({ name: `Shiftly Database (restored ${new Date().toISOString().slice(0, 19)})`, parents: [folders()['01_Database']] }, backupFileId, { fields: 'id' });
    // 旧 DB は削除せず名前を変更して保持（ロールバック可能）
    Drive.Files.update({ name: `Shiftly Database (replaced ${new Date().toISOString().slice(0, 19)})` }, prev);
    PropertiesService.getScriptProperties().setProperty(PROP.dbId, f.id);
    return { newId: f.id as string, previousId: prev };
  }
}

export function createGasPlatform(): Platform {
  const files = new GasFiles();
  return {
    kind: 'gas',
    now: () => Date.now(),
    randomHex: (n: number) => {
      // Utilities.getUuid() は UUID v4（122bit の乱数）。必要バイト数を満たすまで連結し SHA-256 で整形
      // 【要確認】getUuid の乱数源の暗号学的品質は公式に明記されていない（docs/security.md）
      let acc = '';
      while (acc.length < n * 2 + 64) acc += Utilities.getUuid().replace(/-/g, '');
      const digest = fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc) as unknown as number[]);
      const extra = fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc + 'x') as unknown as number[]);
      return toHex(new Uint8Array([...digest, ...extra])).slice(0, n * 2);
    },
    hmacSha256: (key: Bytes, data: Bytes) => fromJavaBytes(Utilities.computeHmacSha256Signature(toJavaBytes(data), toJavaBytes(key)) as unknown as number[]),
    sha256Hex: (s: string) => toHex(fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8) as unknown as number[])),
    withLock: <T>(timeoutMs: number, fn: () => T): T => {
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(timeoutMs)) throw new Error('他の処理が実行中です。少し待ってから再度お試しください');
      try {
        return fn();
      } finally {
        lock.releaseLock();
      }
    },
    secrets: new GasSecrets(),
    cache: new GasCache(),
    files,
    database: files,
    effectiveUserEmail: () => {
      try {
        return Session.getEffectiveUser().getEmail() || null;
      } catch {
        return null;
      }
    },
    log: (level, message, meta) => {
      // 個人情報・秘密情報は meta に含めない運用（呼び出し側で制御）
      console.log(JSON.stringify({ level, message, meta: meta ?? null }));
    },
  };
}

/** 初回: フォルダ構成と DB スプレッドシートを作成（冪等） */
export function provisionStorage(storeLabel: string): { rootId: string; dbId: string; created: boolean } {
  const props = PropertiesService.getScriptProperties();
  const existingDb = props.getProperty(PROP.dbId);
  const existingRoot = props.getProperty(PROP.rootFolder);
  if (existingDb && existingRoot) return { rootId: existingRoot, dbId: existingDb, created: false };
  const FOLDER = 'application/vnd.google-apps.folder';
  const root = existingRoot ? { id: existingRoot } : Drive.Files.create({ name: 'Shiftly', mimeType: FOLDER, appProperties: { shiftly: 'root' } }, null, { fields: 'id' });
  props.setProperty(PROP.rootFolder, root.id);
  const fmap: Record<string, string> = {};
  for (const k of FOLDER_KEYS) {
    const f = Drive.Files.create({ name: k, mimeType: FOLDER, parents: [root.id], appProperties: { shiftly: k } }, null, { fields: 'id' });
    fmap[k] = f.id;
  }
  props.setProperty(PROP.folders, JSON.stringify(fmap));
  const db = Drive.Files.create(
    { name: `Shiftly Database - ${storeLabel}`.slice(0, 100), mimeType: 'application/vnd.google-apps.spreadsheet', parents: [fmap['01_Database']], appProperties: { shiftly: 'database' } },
    null,
    { fields: 'id' },
  );
  Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSpreadsheetProperties: { properties: { timeZone: 'Asia/Tokyo', locale: 'ja_JP' }, fields: 'timeZone,locale' } }] }, db.id);
  props.setProperty(PROP.dbId, db.id);
  return { rootId: root.id, dbId: db.id, created: true };
}

/** 環境情報ファイル（00_System）。端末キャッシュではなく Drive 上の情報で初回/既存を判定する */
export function writeEnvironmentFile(info: Record<string, unknown>) {
  const f = folders();
  const body = JSON.stringify(info, null, 2);
  const blob = Utilities.newBlob(body, 'application/json', 'shiftly-environment.json');
  const existing = Drive.Files.list({ q: `'${f['00_System']}' in parents and name = 'shiftly-environment.json' and trashed = false`, fields: 'files(id)' });
  if (existing.files && existing.files[0]) Drive.Files.update({}, existing.files[0].id, blob);
  else Drive.Files.create({ name: 'shiftly-environment.json', mimeType: 'application/json', parents: [f['00_System']], appProperties: { shiftly: 'environment', envId: String(info.envId ?? '') } }, blob);
}
