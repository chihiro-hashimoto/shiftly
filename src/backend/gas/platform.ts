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
    // 複製には元の DB の目印（appProperties の shiftly=database）を引き継がせず、バックアップの目印を付ける（D-026 S1。保管先の点検で DB と数えない）
    const f = Drive.Files.copy({ name, parents: [folders()[folder]], appProperties: { shiftly: 'backup' } }, id, { fields: 'id,size' });
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
}

/**
 * 乱数・ハッシュ・HMAC だけの GAS 実装（Script Properties・Script Cache・Drive に触れない）。
 * 共通の Setup（ホスト型。複数の Google アカウントが使う）は、利用者の間で共有される Script Properties・Script Cache を使わない
 * ため、createGasPlatform ではなくこちらを使う（A案・D-029）
 */
export function createGasCrypto(): Pick<Platform, 'now' | 'randomHex' | 'hmacSha256' | 'sha256Hex'> {
  return {
    now: () => Date.now(),
    randomHex: (n: number) => {
      // Utilities.getUuid() は UUID v4（122bit の乱数）。必要バイト数を満たすまで連結し SHA-256 で整形
      let acc = '';
      while (acc.length < n * 2 + 64) acc += Utilities.getUuid().replace(/-/g, '');
      const digest = fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc) as unknown as number[]);
      const extra = fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, acc + 'x') as unknown as number[]);
      return toHex(new Uint8Array([...digest, ...extra])).slice(0, n * 2);
    },
    hmacSha256: (key: Bytes, data: Bytes) => fromJavaBytes(Utilities.computeHmacSha256Signature(toJavaBytes(data), toJavaBytes(key)) as unknown as number[]),
    sha256Hex: (s: string) => toHex(fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8) as unknown as number[])),
  };
}

export function createGasPlatform(): Platform {
  const files = new GasFiles();
  const crypto = createGasCrypto();
  return {
    storageReport: () => storageReport(),
    kind: 'gas',
    // 乱数・ハッシュ・HMAC は createGasCrypto と同じ実装（A案・D-029 で共通化。処理は変えていない）
    now: crypto.now,
    // 【要確認】getUuid の乱数源の暗号学的品質は公式に明記されていない（docs/security.md）
    randomHex: crypto.randomHex,
    hmacSha256: crypto.hmacSha256,
    sha256Hex: crypto.sha256Hex,
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
/**
 * Google ドライブの検索の全ページを取得する（D-027。Codex 監査24 A4）。1 ページ目だけで判断しない。
 * 途中のページで失敗した場合は例外のまま止める（一部の結果で「見つからない」「1 つだけ」と判断しない）。ページ数の上限を超えた場合も止める
 */
export function listAllDriveFiles<T = { id: string }>(q: string, fields = 'id'): T[] {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = Drive.Files.list({ q, fields: `nextPageToken, files(${fields})`, pageSize: 100, ...(pageToken ? { pageToken } : {}) });
    out.push(...((r.files ?? []) as T[]));
    pageToken = typeof r.nextPageToken === 'string' && r.nextPageToken ? r.nextPageToken : undefined;
    if (!pageToken) return out;
  }
  throw new Error('Google ドライブの検索の結果が多すぎるため、確認できませんでした');
}

function findAll(q: string): string[] {
  return listAllDriveFiles(`${q} and trashed = false`).map((f) => f.id);
}

/** Core の Drive の構成物（一度だけ作るもの）。キー・表示名・検索条件・保存先 */
interface StorageItem {
  key: string;
  label: string;
  query: () => string;
  /** 保存済みの ID */
  saved: () => string | null;
  /** ID を保存する（保存後に saved() で読み直して確かめる） */
  persist: (id: string) => void;
}

const pendingMarkers = (): Record<string, string> => JSON.parse(PropertiesService.getScriptProperties().getProperty(STORAGE_CREATING) ?? '{}') as Record<string, string>;
const savePendingMarkers = (m: Record<string, string>) => {
  const props = PropertiesService.getScriptProperties();
  if (Object.keys(m).length) props.setProperty(STORAGE_CREATING, JSON.stringify(m));
  else props.deleteProperty(STORAGE_CREATING);
};

/** ID を保存し、読み直して一致することを確かめてから目印を外す（保存に失敗した場合は目印を残す。Codex 監査23 #2） */
function persistThenClear(item: StorageItem, id: string) {
  item.persist(id);
  if (item.saved() !== id) throw new Error(`「${item.label}」の ID を保存できませんでした。時間をおいて shiftlyAuthorize を再実行してください`);
  const m = pendingMarkers();
  if (m[item.key]) {
    delete m[item.key];
    savePendingMarkers(m);
  }
}

/**
 * 一度だけ作る Drive の構成物（Shiftly のフォルダ・DB・環境情報ファイル）を、二重に作らずに用意する（D-026 S1）。状態:
 * - 完了: ID が保存済み（保存済みの ID を使う）
 * - 作成予定・結果不明: 目印あり（作成の要求の前に保存し、ID の保存を確かめた後にだけ外す）
 * - 要確認: 目印があり、検索で見つからない（作成済みでも検索に反映されるまで時間がかかるため、作らずに止める）
 * - 未作成: 目印も ID もなく、検索でも見つからない（目印を保存してから作る）
 * 検索で 2 つ以上見つかった場合も、どれを使うか決められないため止める
 */
function ensureOnce(item: StorageItem, create: () => string): { id: string; created: boolean } {
  const saved = item.saved();
  if (saved) {
    // 保存済みの ID があるのに目印が残っている（ID の保存の後、目印を外す前に止まった）: 目印だけを外す
    if (pendingMarkers()[item.key]) persistThenClear(item, saved);
    return { id: saved, created: false };
  }
  const found = findAll(item.query());
  if (found.length > 1)
    throw new Error(
      `Google ドライブに「${item.label}」が ${found.length} つあります（二重に作られた可能性）。Google ドライブで、Shiftly のフォルダ内の同じ名前のフォルダ・ファイルを確認し、使わないほうをゴミ箱に移動してから shiftlyAuthorize を再実行してください（自動では選びません）`,
    );
  if (found.length === 1) {
    persistThenClear(item, found[0]!);
    return { id: found[0]!, created: false };
  }
  if (pendingMarkers()[item.key])
    throw new Error(
      `前回の「${item.label}」の作成の結果を確認できません（作成済みでも、Google ドライブの検索に反映されるまで時間がかかることがあります）。数分おいてから shiftlyAuthorize を再実行してください。Google ドライブに「${item.label}」がないこと（またはゴミ箱に移動したこと）を確認した場合は、shiftlyConfirmStorageNotCreated を実行してから shiftlyAuthorize を再実行してください`,
    );
  const m = pendingMarkers();
  m[item.key] = new Date().toISOString();
  savePendingMarkers(m);
  if (!pendingMarkers()[item.key]) throw new Error(`「${item.label}」の作成の目印を保存できませんでした。時間をおいて shiftlyAuthorize を再実行してください`);
  const id = create();
  persistThenClear(item, id);
  return { id, created: true };
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Core の Drive の構成物の一覧（作成の順。フォルダの一覧はルートの ID の保存後に使う） */
function storageItems(): StorageItem[] {
  const props = PropertiesService.getScriptProperties();
  const fmap = (): Record<string, string> => JSON.parse(props.getProperty(PROP.folders) ?? '{}') as Record<string, string>;
  const rootId = () => props.getProperty(PROP.rootFolder) ?? '';
  const items: StorageItem[] = [
    {
      key: 'root',
      label: 'Shiftly（フォルダ）',
      query: () => "appProperties has { key='shiftly' and value='root' }",
      saved: () => props.getProperty(PROP.rootFolder),
      persist: (id) => props.setProperty(PROP.rootFolder, id),
    },
  ];
  for (const k of FOLDER_KEYS)
    items.push({
      key: `folder:${k}`,
      label: `Shiftly/${k}（フォルダ）`,
      query: () => `'${rootId()}' in parents and appProperties has { key='shiftly' and value='${k}' }`,
      saved: () => fmap()[k] ?? null,
      persist: (id) => props.setProperty(PROP.folders, JSON.stringify({ ...fmap(), [k]: id })),
    });
  items.push({
    key: 'database',
    label: 'Shiftly Database（DB のスプレッドシート）',
    query: () => `'${fmap()['01_Database'] ?? ''}' in parents and appProperties has { key='shiftly' and value='database' }`,
    saved: () => props.getProperty(PROP.dbId),
    persist: (id) => props.setProperty(PROP.dbId, id),
  });
  items.push({
    key: 'environment',
    label: 'Shiftly/00_System/shiftly-environment.json',
    query: () => `'${fmap()['00_System'] ?? ''}' in parents and appProperties has { key='shiftly' and value='environment' }`,
    saved: () => props.getProperty(PROP.envFile),
    persist: (id) => props.setProperty(PROP.envFile, id),
  });
  return items;
}

/**
 * 作成中の目印を外す（所有者がエディタで shiftlyConfirmStorageNotCreated を実行。呼び出し側でロックを取る）。
 * 目印のある構成物ごとに検索し直し、見つかった場合は目印を外さずにその ID を保存して使う（関連付け）。
 * 見つからない構成物の目印だけを外す（Google ドライブで作られていないことを所有者が確認した後の操作）
 */
export function clearStorageCreatingMarkers(): { cleared: string[]; adopted: string[] } {
  const m = pendingMarkers();
  const cleared: string[] = [];
  const adopted: string[] = [];
  for (const item of storageItems()) {
    if (!m[item.key]) continue;
    const found = item.saved() ? [item.saved()!] : findAll(item.query());
    if (found.length === 1) {
      persistThenClear(item, found[0]!);
      adopted.push(item.key);
      continue;
    }
    if (found.length > 1) continue; // 重複は所有者が整理するまで目印を残す
    const cur = pendingMarkers();
    delete cur[item.key];
    savePendingMarkers(cur);
    cleared.push(item.key);
  }
  return { cleared, adopted };
}

/**
 * 構築の完了前の点検（D-026 S1）。保存済みの ID と、Google ドライブの検索で見つかる構成物（appProperties）が 1 つずつ一致し、
 * 作成中の目印が残っていないことを確かめる。検索は Core が作成したファイルだけが対象（drive.file）
 */
export function storageReport(): { ok: boolean; issues: string[]; items: Array<{ key: string; saved: boolean; found: number }> } {
  const issues: string[] = [];
  const items: Array<{ key: string; saved: boolean; found: number }> = [];
  const pend = pendingMarkers();
  for (const item of storageItems()) {
    const saved = item.saved();
    const found = findAll(item.query());
    items.push({ key: item.key, saved: !!saved, found: found.length });
    if (pend[item.key]) issues.push(`「${item.label}」の作成の結果が確認されていません（作成中の目印が残っています）`);
    if (!saved) issues.push(`「${item.label}」の ID が保存されていません`);
    if (found.length !== 1) issues.push(`「${item.label}」が Google ドライブに ${found.length} つあります（1 つのはず）`);
    else if (saved && found[0] !== saved) issues.push(`「${item.label}」の保存済みの ID と、Google ドライブの検索で見つかったものが一致しません`);
  }
  return { ok: issues.length === 0, issues, items };
}

/** 初回: フォルダ構成と DB スプレッドシートを作成（冪等。1 つ作るごとに ID を保存し、既存は appProperties で再検出する） */
export function provisionStorage(storeLabel: string): { rootId: string; dbId: string; created: boolean } {
  const items = storageItems();
  const by = (k: string) => items.find((i) => i.key === k)!;
  let created = false;
  const root = ensureOnce(by('root'), () => Drive.Files.create({ name: 'Shiftly', mimeType: FOLDER_MIME, appProperties: { shiftly: 'root' } }, null, { fields: 'id' }).id as string);
  created = created || root.created;
  for (const k of FOLDER_KEYS) {
    const f = ensureOnce(by(`folder:${k}`), () => Drive.Files.create({ name: k, mimeType: FOLDER_MIME, parents: [root.id], appProperties: { shiftly: k } }, null, { fields: 'id' }).id as string);
    created = created || f.created;
  }
  const dbFolder = by('folder:01_Database').saved()!;
  const db = ensureOnce(by('database'), () =>
    Drive.Files.create({ name: `Shiftly Database - ${storeLabel}`.slice(0, 100), mimeType: 'application/vnd.google-apps.spreadsheet', parents: [dbFolder], appProperties: { shiftly: 'database' } }, null, { fields: 'id' }).id as string,
  );
  created = created || db.created;
  const dbId = db.id;
  // タイムゾーン設定（冪等）
  Sheets.Spreadsheets.batchUpdate({ requests: [{ updateSpreadsheetProperties: { properties: { timeZone: 'Asia/Tokyo', locale: 'ja_JP' }, fields: 'timeZone,locale' } }] }, dbId);
  return { rootId: root.id, dbId, created };
}

/** 環境情報ファイル（00_System）。端末キャッシュではなく Drive 上の情報で初回/既存を判定する */
export function writeEnvironmentFile(info: Record<string, unknown>) {
  const f = folders();
  const body = JSON.stringify(info, null, 2);
  const blob = Utilities.newBlob(body, 'application/json', 'shiftly-environment.json');
  const item = storageItems().find((i) => i.key === 'environment')!;
  const env = ensureOnce(item, () =>
    Drive.Files.create({ name: 'shiftly-environment.json', mimeType: 'application/json', parents: [f['00_System']], appProperties: { shiftly: 'environment', envId: String(info.envId ?? '') } }, blob, { fields: 'id' }).id as string,
  );
  if (!env.created) Drive.Files.update({}, env.id, blob);
}
