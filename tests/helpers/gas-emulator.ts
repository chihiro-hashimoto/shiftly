/**
 * GAS 実行環境のエミュレータ（テスト専用）
 * ビルド済みの dist/gas/<project>/Code.js を Node の vm で実行し、Sheets/Drive/Properties 等を
 * メモリ上で模擬する。実際の Google API の挙動（レスポンス形式・上限・権限）とは異なりうるため、
 * これは「実環境検証」ではなく「バンドルとアダプタ実装の検証」である。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

type Cell = string | number | boolean;
const toSigned = (b: Buffer) => Array.from(b, (x) => (x > 127 ? x - 256 : x));
const fromSigned = (a: number[]) => Buffer.from(a.map((x) => x & 0xff));

class Props {
  m = new Map<string, string>();
  /** 保存の失敗の注入（テスト専用）: 該当するキーの setProperty を例外にする */
  failSet?: (k: string, v: string) => boolean;
  getProperty(k: string) {
    return this.m.get(k) ?? null;
  }
  setProperty(k: string, v: string) {
    if (this.failSet?.(k, v)) throw new Error(`PropertiesService: 保存に失敗しました（${k}）`);
    this.m.set(k, v);
    return this;
  }
  deleteProperty(k: string) {
    this.m.delete(k);
    return this;
  }
}

function colIndex(letters: string) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

interface Sheet {
  title: string;
  sheetId: number;
  rowCount: number;
  /** 列数（グリッドの幅）。Sheets と同じく、範囲がこれを超える読み書きはエラー */
  colCount?: number;
  rows: Cell[][];
}
interface Spreadsheet {
  sheets: Sheet[];
  props: Record<string, unknown>;
}

/** バンドルが公開するトップレベル関数（テストで呼び出すもの） */
export interface GasFns {
  doGet: (...a: unknown[]) => any;
  doPost: (...a: unknown[]) => any;
  staffApi: (...a: unknown[]) => any;
  /** 互換（v1.2 までの関数名） */
  kioskApi: (...a: unknown[]) => any;
  shiftlyAuthorize: (...a: unknown[]) => any;
  /** ブラウザでの初期化（A案・D-029） */
  shiftlyWebInitialize: (...a: unknown[]) => any;
  shiftlyDailyJob: (...a: unknown[]) => any;
  shiftlyResetAdminPairing: (...a: unknown[]) => any;
  shiftlyConfirmStorageNotCreated: (...a: unknown[]) => any;
  shiftlyMaintenanceBegin: (...a: unknown[]) => any;
  shiftlyMaintenanceFinish: (...a: unknown[]) => any;
  shiftlyMaintenanceStatus: (...a: unknown[]) => any;
  adminApi: (...a: unknown[]) => any;
  setupApi: (...a: unknown[]) => any;
}

export class GasEmulator {
  scriptProps = new Props();
  userProps = new Props();
  cache = new Map<string, string>();
  files = new Map<string, { name: string; mimeType: string; parents: string[]; data: Buffer | null; appProperties?: Record<string, string>; trashed?: boolean }>();
  spreadsheets = new Map<string, Spreadsheet>();
  triggers: string[] = [];
  /** エディタ実行（管理者）を模す場合は管理者のメール。匿名 Web アプリ経由は空文字 */
  activeUser = 'owner@example.invalid';
  apiCalls = 0;
  /** Sheets API の書き込み系呼び出し回数（割当の消費の目安） */
  writeCalls = 0;
  private seq = 0;
  now = Date.now();
  /** 新規シートの行数（Google Sheets の既定は 1000 行。テストでは行の自動拡張を少ない件数で確認するため変更可能） */
  defaultRows = 1000;
  /**
   * Drive の失敗の注入（テスト専用）。listFail: 該当する検索を例外にする。loseCreate: 作成は行われたが応答を失った（例外）とする。
   * mediaStatus: ファイルの内容の取得（alt=media）の応答コードを置き換える。listHide: 該当する検索が、まだ反映されていないかのように 0 件を返す。
   * failCreate: 作成されずに例外になる
   */
  /** generateIds で予約した ID */
  reservedIds = new Set<string>();
  /** スクリプトロックを保持している数（入れ子の検出・ロックの中での作成の確認に使う） */
  scriptLockHeld = 0;
  /** Drive の作成の記録（作成した時点でスクリプトロックを保持していたか） */
  createLog: Array<{ name: string; appProperties?: Record<string, string>; underLock: boolean }> = [];
  driveFaults: {
    listFail?: (q: string) => boolean;
    /** 検索の指定したページ（0 始まり）だけを例外にする（全ページの取得の途中の失敗。D-027・Codex 監査24 A4） */
    listFailPage?: (q: string, page: number) => boolean;
    loseCreate?: (name: string, appProperties?: Record<string, string>) => boolean;
    mediaStatus?: number;
    /** ファイルの情報の取得（?fields=）の応答コードを置き換える（ID による直接の照会の失敗。Codex 監査24 A3） */
    metaStatus?: number;
    listHide?: (q: string) => boolean;
    failCreate?: (name: string, appProperties?: Record<string, string>) => boolean;
    updateFail?: (id: string) => boolean;
  } = {};
  /** 数式の入ったセル（`シートID|シート名|行|列`（0 始まり）→ 数式）。Values.get の valueRenderOption: 'FORMULA' のときだけ数式を返す */
  formulas = new Map<string, string>();
  /** 検索の 1 ページの最大件数（実際の Drive は要求の pageSize 以下で返す。テストで小さくして複数ページを確かめる） */
  maxPageSize = 100;

  private newId(p: string) {
    return `${p}${++this.seq}`;
  }

  private parseRange(range: string): { sheet: string; r1: number; c1: number; r2: number | null; c2: number | null } {
    const m = /^'((?:[^']|'')+)'!(.+)$/.exec(range);
    if (!m) throw new Error(`range ${range}`);
    const sheet = m[1]!.replace(/''/g, "'");
    const ref = m[2]!;
    let mm = /^(\d+):(\d+)$/.exec(ref);
    if (mm) return { sheet, r1: Number(mm[1]) - 1, c1: 0, r2: Number(mm[2]) - 1, c2: null };
    mm = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/.exec(ref);
    if (!mm) throw new Error(`ref ${ref}`);
    return { sheet, r1: Number(mm[2]) - 1, c1: colIndex(mm[1]!), r2: mm[4] ? Number(mm[4]) - 1 : mm[3] ? null : Number(mm[2]) - 1, c2: mm[3] ? colIndex(mm[3]) : null };
  }

  private sheetOf(ssId: string, title: string): Sheet {
    const ss = this.spreadsheets.get(ssId);
    if (!ss) throw new Error(`spreadsheet ${ssId} not found`);
    const sh = ss.sheets.find((s) => s.title === title);
    if (!sh) throw new Error(`Unable to parse range: ${title}`);
    return sh;
  }

  private writeValues(ssId: string, range: string, values: Cell[][]) {
    const r = this.parseRange(range);
    const sh = this.sheetOf(ssId, r.sheet);
    const width = Math.max(0, ...values.map((v) => v.length));
    if (r.c1 + width > (sh.colCount ?? 26)) throw new Error(`Range (${range}) exceeds grid limits. Max columns: ${sh.colCount ?? 26}`);
    values.forEach((row, i) => {
      const ri = r.r1 + i;
      if (ri >= sh.rowCount) throw new Error(`Range exceeds grid limits (${ri + 1} > ${sh.rowCount})`);
      while (sh.rows.length <= ri) sh.rows.push([]);
      row.forEach((v, j) => {
        const target = sh.rows[ri]!;
        while (target.length <= r.c1 + j) target.push('');
        if (typeof v === 'string' && v.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
        target[r.c1 + j] = v;
      });
    });
  }

  globals(extra: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 模擬 API の各メソッドから参照するため
    const self = this;
    const blob = (data: Buffer, mime: string, name: string) => ({
      getBytes: () => toSigned(data),
      getDataAsString: () => data.toString('utf8'),
      getContentType: () => mime,
      getName: () => name,
      getAs: (m: string) => blob(Buffer.from(`%PDF-EMU ${data.length}`), m, name),
      _data: data,
    });
    const Sheets = {
      Spreadsheets: {
        get(id: string) {
          self.apiCalls++;
          const ss = self.spreadsheets.get(id)!;
          return { sheets: ss.sheets.map((s) => ({ properties: { title: s.title, sheetId: s.sheetId, gridProperties: { rowCount: s.rowCount, columnCount: s.colCount ?? 26 } } })) };
        },
        batchUpdate(body: { requests: Array<Record<string, any>> }, id: string) {
          self.apiCalls++;
          self.writeCalls++;
          const ss = self.spreadsheets.get(id)!;
          for (const r of body.requests) {
            if (r.addSheet) {
              const t = r.addSheet.properties.title;
              if (ss.sheets.some((s) => s.title === t)) throw new Error(`A sheet with the name "${t}" already exists.`);
              ss.sheets.push({ title: t, sheetId: self.seq++, rowCount: self.defaultRows, colCount: r.addSheet.properties.gridProperties?.columnCount ?? 26, rows: [] });
            } else if (r.appendDimension) {
              const sh = ss.sheets.find((s) => s.sheetId === r.appendDimension.sheetId)!;
              if (r.appendDimension.dimension === 'COLUMNS') sh.colCount = (sh.colCount ?? 26) + r.appendDimension.length;
              else sh.rowCount += r.appendDimension.length;
            } else if (r.updateSpreadsheetProperties) {
              Object.assign(ss.props, r.updateSpreadsheetProperties.properties);
            }
          }
          return {};
        },
        Values: {
          get(id: string, range: string, opts?: { valueRenderOption?: string }) {
            self.apiCalls++;
            const r = self.parseRange(range);
            const sh = self.sheetOf(id, r.sheet);
            if (r.c2 !== null && r.c2 >= (sh.colCount ?? 26)) throw new Error(`Range (${range}) exceeds grid limits. Max rows: ${sh.rowCount}, max columns: ${sh.colCount ?? 26}`);
            const end = r.r2 === null ? sh.rows.length - 1 : Math.min(r.r2, sh.rows.length - 1);
            const out: Cell[][] = [];
            for (let i = r.r1; i <= end; i++) {
              const row = sh.rows[i] ?? [];
              const sliced = row.slice(r.c1, r.c2 === null ? undefined : r.c2 + 1);
              if (opts?.valueRenderOption === 'FORMULA')
                sliced.forEach((_, j) => {
                  const fm = self.formulas.get(`${id}|${r.sheet}|${i}|${r.c1 + j}`);
                  if (fm !== undefined) sliced[j] = fm;
                });
              while (sliced.length && sliced[sliced.length - 1] === '') sliced.pop();
              out.push(sliced);
            }
            while (out.length && out[out.length - 1]!.length === 0) out.pop();
            return out.length ? { values: out } : {};
          },
          batchGet(id: string, opts: { ranges: string[]; valueRenderOption?: string }) {
            self.apiCalls++;
            const valueRanges = opts.ranges.map((range) => {
              const r = Sheets.Spreadsheets.Values.get(id, range, opts) as { values?: Cell[][] };
              self.apiCalls--;
              return { range, values: r.values };
            });
            return { valueRanges };
          },
          update(body: { values: Cell[][] }, id: string, range: string, opts: { valueInputOption: string }) {
            self.apiCalls++;
            self.writeCalls++;
            if (opts.valueInputOption !== 'RAW') throw new Error('RAW 以外は使用しない');
            self.writeValues(id, range, body.values);
            return {};
          },
          batchUpdate(body: { valueInputOption: string; data: Array<{ range: string; values: Cell[][] }> }, id: string) {
            self.apiCalls++;
            self.writeCalls++;
            if (body.valueInputOption !== 'RAW') throw new Error('RAW 以外は使用しない');
            for (const d of body.data) self.writeValues(id, d.range, d.values);
            return {};
          },
        },
      },
    };
    const Drive = {
      Files: {
        create(res: { id?: string; name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> }, b: ReturnType<typeof blob> | null) {
          if (self.driveFaults.failCreate?.(res.name, res.appProperties)) throw new Error('Drive: 作成に失敗しました（作成されていない）');
          self.createLog.push({ name: res.name, appProperties: res.appProperties, underLock: self.scriptLockHeld > 0 });
          // 予約した ID（generateIds）での作成。予約していない ID・同じ ID のファイルがある場合は失敗する（実際の Drive の動作の想定。実環境では未検証）
          if (res.id !== undefined && (!self.reservedIds.has(res.id) || self.files.has(res.id))) throw new Error(`Drive: ID ${res.id} では作成できません`);
          const id = res.id ?? self.newId('f');
          self.files.set(id, { name: res.name, mimeType: res.mimeType, parents: res.parents ?? [], data: b ? b._data : null, appProperties: res.appProperties });
          if (res.mimeType === 'application/vnd.google-apps.spreadsheet') self.spreadsheets.set(id, { sheets: [{ title: 'Sheet1', sheetId: 0, rowCount: 1000, rows: [] }], props: {} });
          if (self.driveFaults.loseCreate?.(res.name, res.appProperties)) throw new Error('Drive: 応答を受け取れませんでした（作成は完了）');
          return { id, webViewLink: `https://drive.example/${id}` };
        },
        copy(res: { name: string; parents: string[]; appProperties?: Record<string, string> }, srcId: string) {
          const id = self.newId('f');
          const src = self.files.get(srcId)!;
          // 実際の Drive と同じく、指定した appProperties は元のファイルの値を上書きする（指定しない場合は引き継ぐ想定）
          self.files.set(id, { ...src, name: res.name, parents: res.parents, appProperties: res.appProperties ? { ...(src.appProperties ?? {}), ...res.appProperties } : src.appProperties });
          const ss = self.spreadsheets.get(srcId);
          if (ss) self.spreadsheets.set(id, structuredClone(ss));
          return { id, size: '1234' };
        },
        list(q: { q: string; pageSize?: number; pageToken?: string }) {
          if (self.driveFaults.listFail?.(q.q)) throw new Error('Drive: 検索に失敗しました（一時的なエラー）');
          if (self.driveFaults.listHide?.(q.q)) return { files: [] };
          const parent = /'([^']+)' in parents/.exec(q.q)?.[1];
          const name = /name = '([^']+)'/.exec(q.q)?.[1];
          const ap = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q.q);
          const all = [...self.files.entries()].filter(([, f]) => !f.trashed && (!parent || f.parents.includes(parent)) && (!name || f.name === name) && (!ap || f.appProperties?.[ap[1]!] === ap[2])).map(([id, f]) => ({ id, name: f.name, createdTime: new Date().toISOString(), size: f.data ? String(f.data.length) : null, appProperties: f.appProperties }));
          // ページ分け（pageToken は次の先頭の位置）
          const size = Math.min(q.pageSize ?? 100, self.maxPageSize);
          const start = q.pageToken ? Number(q.pageToken) : 0;
          if (self.driveFaults.listFailPage?.(q.q, Math.floor(start / size))) throw new Error('Drive: 検索の途中のページで失敗しました（一時的なエラー）');
          const files = all.slice(start, start + size);
          return start + size < all.length ? { files, nextPageToken: String(start + size) } : { files };
        },
        generateIds(opts: { count: number }) {
          const ids = Array.from({ length: opts.count }, () => self.newId('rsv'));
          for (const i of ids) self.reservedIds.add(i);
          return { ids };
        },
        get(id: string) {
          const f = self.files.get(id);
          return { parents: f?.parents ?? [], name: f?.name, appProperties: f?.appProperties };
        },
        update(res: { trashed?: boolean; name?: string; appProperties?: Record<string, string> }, id: string, b?: ReturnType<typeof blob>) {
          if (self.driveFaults.updateFail?.(id)) throw new Error('Drive: 更新に失敗しました（一時的なエラー）');
          const f = self.files.get(id);
          if (!f) throw new Error(`Drive: File not found: ${id}`);
          if (res.trashed) f.trashed = true;
          if (res.name) f.name = res.name;
          if (res.appProperties) f.appProperties = { ...(f.appProperties ?? {}), ...res.appProperties };
          if (b) f.data = b._data;
          return { id };
        },
      },
      About: { get: () => ({ storageQuota: { limit: String(15 * 1024 ** 3), usage: String(3 * 1024 ** 3) } }) },
    };
    const output = (content: string) => {
      const o = { content, mime: '', setMimeType: (m: string) => ((o.mime = m), o), setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o, getContent: () => content };
      return o;
    };
    return {
      console: { log: () => {} },
      PropertiesService: { getScriptProperties: () => self.scriptProps, getUserProperties: () => self.userProps },
      CacheService: { getScriptCache: () => ({ get: (k: string) => self.cache.get(k) ?? null, put: (k: string, v: string) => self.cache.set(k, v), remove: (k: string) => self.cache.delete(k) }) },
      // スクリプトロック: 単一スレッドのため排他は模擬しないが、ロックを保持しているか（scriptLockHeld）を記録する
      LockService: {
        getScriptLock: () => ({
          tryLock: () => {
            self.scriptLockHeld++;
            return true;
          },
          releaseLock: () => {
            self.scriptLockHeld--;
          },
        }),
        getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
      },
      Utilities: {
        getUuid: () => randomUUID(),
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: (_a: string, v: string | number[]) => toSigned(createHash('sha256').update(typeof v === 'string' ? Buffer.from(v, 'utf8') : fromSigned(v)).digest()),
        computeHmacSha256Signature: (v: number[], k: number[]) => toSigned(createHmac('sha256', fromSigned(k)).update(fromSigned(v)).digest()),
        newBlob: (d: string | number[], mime: string, name: string) => blob(typeof d === 'string' ? Buffer.from(d, 'utf8') : fromSigned(d), mime, name),
      },
      Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }), getActiveUser: () => ({ getEmail: () => self.activeUser }) },
      ScriptApp: {
        getOAuthToken: () => 'emu-token',
        getScriptId: () => 'emu-script',
        getProjectTriggers: () => self.triggers.map((h, i) => ({ getHandlerFunction: () => h, getUniqueId: () => `trg${i}` })),
        newTrigger: (h: string) => {
          const chain = { timeBased: () => chain, everyDays: () => chain, atHour: () => chain, inTimezone: () => chain, create: () => self.triggers.push(h) };
          return chain;
        },
      },
      UrlFetchApp: {
        fetch: (url: string) => {
          // ファイルの情報の取得（ID による直接の照会。?fields=）
          const metaId = /files\/([^?]+)\?fields=/.exec(url)?.[1];
          if (metaId) {
            const m = self.files.get(decodeURIComponent(metaId));
            const status = self.driveFaults.metaStatus ?? (m ? 200 : 404);
            const text = m && status === 200 ? JSON.stringify({ id: decodeURIComponent(metaId), trashed: !!m.trashed, appProperties: m.appProperties ?? {} }) : '{"error":{}}';
            return { getResponseCode: () => status, getContent: () => [], getContentText: () => text };
          }
          const id = /files\/([^?]+)\?alt=media/.exec(url)?.[1];
          const f = id ? self.files.get(decodeURIComponent(id)) : null;
          return { getResponseCode: () => (f?.data ? (self.driveFaults.mediaStatus ?? 200) : 404), getContent: () => (f?.data ? toSigned(f.data) : []), getContentText: () => f?.data?.toString('utf8') ?? '' };
        },
      },
      HtmlService: { createHtmlOutputFromFile: (n: string) => output(`html:${n}`), XFrameOptionsMode: { DEFAULT: 'DEFAULT' } },
      ContentService: { createTextOutput: (s: string) => output(s), MimeType: { JSON: 'json' } },
      Drive,
      Sheets,
      Date,
      ...extra,
    };
  }

  /** ビルド済み Code.js を読み込み、トップレベル関数を返す */
  load(project: 'core' | 'admin' | 'setup', extra: Record<string, unknown>): GasFns {
    const ctx = vm.createContext(this.globals(extra));
    const code = readFileSync(`dist/gas/${project}/Code.js`, 'utf8');
    vm.runInContext(code, ctx, { filename: `${project}/Code.js` });
    return ctx as unknown as GasFns;
  }
}
