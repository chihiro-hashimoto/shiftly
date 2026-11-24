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
  getProperty(k: string) {
    return this.m.get(k) ?? null;
  }
  setProperty(k: string, v: string) {
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
  kioskApi: (...a: unknown[]) => any;
  shiftlyAuthorize: (...a: unknown[]) => any;
  shiftlyDailyJob: (...a: unknown[]) => any;
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
  /** エディタ実行（店長）を模す場合は店長のメール。匿名 Web アプリ経由は空文字 */
  activeUser = 'owner@example.invalid';
  apiCalls = 0;
  private seq = 0;
  now = Date.now();

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
          return { sheets: ss.sheets.map((s) => ({ properties: { title: s.title, sheetId: s.sheetId, gridProperties: { rowCount: s.rowCount } } })) };
        },
        batchUpdate(body: { requests: Array<Record<string, any>> }, id: string) {
          self.apiCalls++;
          const ss = self.spreadsheets.get(id)!;
          for (const r of body.requests) {
            if (r.addSheet) {
              const t = r.addSheet.properties.title;
              if (ss.sheets.some((s) => s.title === t)) throw new Error(`A sheet with the name "${t}" already exists.`);
              ss.sheets.push({ title: t, sheetId: self.seq++, rowCount: 1000, rows: [] });
            } else if (r.appendDimension) {
              const sh = ss.sheets.find((s) => s.sheetId === r.appendDimension.sheetId)!;
              sh.rowCount += r.appendDimension.length;
            } else if (r.updateSpreadsheetProperties) {
              Object.assign(ss.props, r.updateSpreadsheetProperties.properties);
            }
          }
          return {};
        },
        Values: {
          get(id: string, range: string) {
            self.apiCalls++;
            const r = self.parseRange(range);
            const sh = self.sheetOf(id, r.sheet);
            const end = r.r2 === null ? sh.rows.length - 1 : Math.min(r.r2, sh.rows.length - 1);
            const out: Cell[][] = [];
            for (let i = r.r1; i <= end; i++) {
              const row = sh.rows[i] ?? [];
              const sliced = row.slice(r.c1, r.c2 === null ? undefined : r.c2 + 1);
              while (sliced.length && sliced[sliced.length - 1] === '') sliced.pop();
              out.push(sliced);
            }
            while (out.length && out[out.length - 1]!.length === 0) out.pop();
            return out.length ? { values: out } : {};
          },
          batchGet(id: string, opts: { ranges: string[] }) {
            self.apiCalls++;
            const valueRanges = opts.ranges.map((range) => {
              const r = Sheets.Spreadsheets.Values.get(id, range) as { values?: Cell[][] };
              self.apiCalls--;
              return { range, values: r.values };
            });
            return { valueRanges };
          },
          update(body: { values: Cell[][] }, id: string, range: string, opts: { valueInputOption: string }) {
            self.apiCalls++;
            if (opts.valueInputOption !== 'RAW') throw new Error('RAW 以外は使用しない');
            self.writeValues(id, range, body.values);
            return {};
          },
          batchUpdate(body: { valueInputOption: string; data: Array<{ range: string; values: Cell[][] }> }, id: string) {
            self.apiCalls++;
            if (body.valueInputOption !== 'RAW') throw new Error('RAW 以外は使用しない');
            for (const d of body.data) self.writeValues(id, d.range, d.values);
            return {};
          },
        },
      },
    };
    const Drive = {
      Files: {
        create(res: { name: string; mimeType: string; parents?: string[]; appProperties?: Record<string, string> }, b: ReturnType<typeof blob> | null) {
          const id = self.newId('f');
          self.files.set(id, { name: res.name, mimeType: res.mimeType, parents: res.parents ?? [], data: b ? b._data : null, appProperties: res.appProperties });
          if (res.mimeType === 'application/vnd.google-apps.spreadsheet') self.spreadsheets.set(id, { sheets: [{ title: 'Sheet1', sheetId: 0, rowCount: 1000, rows: [] }], props: {} });
          return { id, webViewLink: `https://drive.example/${id}` };
        },
        copy(res: { name: string; parents: string[] }, srcId: string) {
          const id = self.newId('f');
          const src = self.files.get(srcId)!;
          self.files.set(id, { ...src, name: res.name, parents: res.parents });
          const ss = self.spreadsheets.get(srcId);
          if (ss) self.spreadsheets.set(id, structuredClone(ss));
          return { id, size: '1234' };
        },
        list(q: { q: string }) {
          const parent = /'([^']+)' in parents/.exec(q.q)?.[1];
          const name = /name = '([^']+)'/.exec(q.q)?.[1];
          const ap = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q.q);
          const files = [...self.files.entries()].filter(([, f]) => !f.trashed && (!parent || f.parents.includes(parent)) && (!name || f.name === name) && (!ap || f.appProperties?.[ap[1]!] === ap[2])).map(([id, f]) => ({ id, name: f.name, createdTime: new Date().toISOString(), size: f.data ? String(f.data.length) : null }));
          return { files };
        },
        get(id: string) {
          return { parents: self.files.get(id)?.parents ?? [] };
        },
        update(res: { trashed?: boolean; name?: string }, id: string, b?: ReturnType<typeof blob>) {
          const f = self.files.get(id)!;
          if (res.trashed) f.trashed = true;
          if (res.name) f.name = res.name;
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
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }), getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
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
          const id = /files\/([^?]+)\?alt=media/.exec(url)?.[1];
          const f = id ? self.files.get(id) : null;
          return { getResponseCode: () => (f?.data ? 200 : 404), getContent: () => (f?.data ? toSigned(f.data) : []), getContentText: () => f?.data?.toString('utf8') ?? '' };
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
