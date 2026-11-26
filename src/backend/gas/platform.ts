/**
 * Google Apps Script 実行環境の Platform 実装
 *
 * スコープ方針（appsscript.json の oauthScopes で明示）:
 * - drive.file: Shiftly 自身が作成したファイル・フォルダのみ（管理者の他の Drive ファイルにはアクセスしない）
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
import { SheetsAdapter } from './sheets-adapter';

declare const Drive: any;
declare const Sheets: any;

export const PROP = {
  dbId: 'SHIFTLY_DB_ID',
  folders: 'SHIFTLY_FOLDERS',
  rootFolder: 'SHIFTLY_ROOT_FOLDER',
  envFile: 'SHIFTLY_ENV_FILE_ID',
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
  prepareRestoreCopy(backupFileId: string) {
    const f = Drive.Files.copy({ name: `Shiftly Database (restore candidate ${new Date().toISOString().slice(0, 19)})`, parents: [folders()['01_Database']] }, backupFileId, { fields: 'id' });
    const id = f.id as string;
    return { candidateId: id, adapter: new SheetsAdapter(() => id) };
  }
  activate(candidateId: string) {
    const prev = this.currentId();
    // 旧 DB は削除せず名前を変更して保持（ロールバック可能）
    Drive.Files.update({ name: `Shiftly Database (replaced ${new Date().toISOString().slice(0, 19)})` }, prev);
    Drive.Files.update({ name: `Shiftly Database (restored ${new Date().toISOString().slice(0, 19)})` }, candidateId);
    PropertiesService.getScriptProperties().setProperty(PROP.dbId, candidateId);
    return { previousId: prev };
  }
  discard(candidateId: string) {
    if (candidateId === this.currentId()) throw new Error('稼働中の DB は破棄できません');
    this.trashFile('01_Database', candidateId);
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

/** 作成中の目印（構成物のキー → 作成の要求の開始時刻）。作成の結果が分からない間、作り直さないために使う */
const STORAGE_CREATING = 'SHIFTLY_STORAGE_CREATING';

/** 検索に失敗した場合は「存在しない」と見なさず、そのまま失敗させる（S1、D-025） */
function findOne(q: string): string | null {
  const r = Drive.Files.list({ q: `${q} and trashed = false`, fields: 'files(id)', pageSize: 2 });
  return r.files?.[0]?.id ?? null;
}

/**
 * 一度だけ作る Drive の構成物（Shiftly のフォルダ・DB・環境情報ファイル）を、二重に作らずに用意する（D-025 S1。Codex 監査22 #3）。
 * 作成の要求の前に目印を保存し、作成が終わったら外す。目印が残っている（前回の作成の結果が分からない）間は、検索で見つからなくても
 * 作らずに止める（作成済みでも、検索に反映されるまで時間がかかることがあるため）。Google ドライブで作られていないことを確認したら、
 * 所有者がエディタで shiftlyConfirmStorageNotCreated を実行して目印を外す
 */
function ensureOnce(key: string, label: string, savedId: string | null, query: string, create: () => string): { id: string; created: boolean } {
  if (savedId) return { id: savedId, created: false };
  const props = PropertiesService.getScriptProperties();
  const pending = JSON.parse(props.getProperty(STORAGE_CREATING) ?? '{}') as Record<string, string>;
  const savePending = () => props.setProperty(STORAGE_CREATING, JSON.stringify(pending));
  const found = findOne(query);
  if (found) {
    if (pending[key]) {
      delete pending[key];
      savePending();
    }
    return { id: found, created: false };
  }
  if (pending[key])
    throw new Error(
      `前回の「${label}」の作成の結果を確認できません（作成済みでも、Google ドライブの検索に反映されるまで時間がかかることがあります）。数分おいてから shiftlyAuthorize を再実行してください。Google ドライブに「${label}」がないこと（またはゴミ箱に移動したこと）を確認した場合は、shiftlyConfirmStorageNotCreated を実行してから shiftlyAuthorize を再実行してください`,
    );
  pending[key] = new Date().toISOString();
  savePending();
  const id = create();
  delete pending[key];
  savePending();
  return { id, created: true };
}

/** 作成中の目印を外す（Google ドライブで構成物が作られていないことを所有者が確認した後に、エディタから実行する） */
export function clearStorageCreatingMarkers(): string[] {
  const props = PropertiesService.getScriptProperties();
  const keys = Object.keys(JSON.parse(props.getProperty(STORAGE_CREATING) ?? '{}') as Record<string, string>);
  props.deleteProperty(STORAGE_CREATING);
  return keys;
}

/** 初回: フォルダ構成と DB スプレッドシートを作成（冪等。1 つ作るごとに ID を保存し、既存は appProperties で再検出する） */
export function provisionStorage(storeLabel: string): { rootId: string; dbId: string; created: boolean } {
  const props = PropertiesService.getScriptProperties();
  const FOLDER = 'application/vnd.google-apps.folder';
  let created = false;
  const root = ensureOnce('root', 'Shiftly（フォルダ）', props.getProperty(PROP.rootFolder), "appProperties has { key='shiftly' and value='root' }", () =>
    Drive.Files.create({ name: 'Shiftly', mimeType: FOLDER, appProperties: { shiftly: 'root' } }, null, { fields: 'id' }).id as string,
  );
  const rootId = root.id;
  created = created || root.created;
  props.setProperty(PROP.rootFolder, rootId);
  const fmap: Record<string, string> = JSON.parse(props.getProperty(PROP.folders) ?? '{}') as Record<string, string>;
  for (const k of FOLDER_KEYS) {
    const f = ensureOnce(`folder:${k}`, `Shiftly/${k}（フォルダ）`, fmap[k] ?? null, `'${rootId}' in parents and appProperties has { key='shiftly' and value='${k}' }`, () =>
      Drive.Files.create({ name: k, mimeType: FOLDER, parents: [rootId], appProperties: { shiftly: k } }, null, { fields: 'id' }).id as string,
    );
    fmap[k] = f.id;
    props.setProperty(PROP.folders, JSON.stringify(fmap));
  }
  const dbName = `Shiftly Database - ${storeLabel}`.slice(0, 100);
  const db = ensureOnce('database', `${dbName}（スプレッドシート）`, props.getProperty(PROP.dbId), `'${fmap['01_Database']}' in parents and appProperties has { key='shiftly' and value='database' }`, () =>
    Drive.Files.create({ name: dbName, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [fmap['01_Database']], appProperties: { shiftly: 'database' } }, null, { fields: 'id' }).id as string,
  );
  const dbId = db.id;
  created = created || db.created;
  props.setProperty(PROP.dbId, dbId);
  // タイムゾーン設定（冪等）
  Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSpreadsheetProperties: { properties: { timeZone: 'Asia/Tokyo', locale: 'ja_JP' }, fields: 'timeZone,locale' } }] }, dbId);
  return { rootId, dbId, created };
}

/** 環境情報ファイル（00_System）。端末キャッシュではなく Drive 上の情報で初回/既存を判定する */
export function writeEnvironmentFile(info: Record<string, unknown>) {
  const f = folders();
  const body = JSON.stringify(info, null, 2);
  const blob = Utilities.newBlob(body, 'application/json', 'shiftly-environment.json');
  const props = PropertiesService.getScriptProperties();
  const env = ensureOnce('environment', 'Shiftly/00_System/shiftly-environment.json', props.getProperty(PROP.envFile), `'${f['00_System']}' in parents and appProperties has { key='shiftly' and value='environment' }`, () =>
    Drive.Files.create({ name: 'shiftly-environment.json', mimeType: 'application/json', parents: [f['00_System']], appProperties: { shiftly: 'environment', envId: String(info.envId ?? '') } }, blob, { fields: 'id' }).id as string,
  );
  props.setProperty(PROP.envFile, env.id);
  if (!env.created) Drive.Files.update({}, env.id, blob);
}
