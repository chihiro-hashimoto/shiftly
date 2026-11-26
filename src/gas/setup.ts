/**
 * Shiftly Setup（自動インストーラー）GAS エントリ
 *
 * 配信方式（docs/installer-guide.md）:
 *  A) 自己ホスト: 管理者の Google アカウントに Setup プロジェクトを 1 つ置き（clasp またはファイル 1 つの貼り付け）、
 *     アクセス=自分のみ・実行=自分 でデプロイ
 *  B) ホスト型: 配布者のアカウントで 実行=アクセスしたユーザー・アクセス=Google アカウントを持つ全員 でデプロイ
 * いずれも Setup のコードは管理者本人の権限で動作し、管理者のアカウント内に GAS・Drive・DB を作成する。
 * Apps Script API の呼び出しには、Setup に紐づく標準 Cloud プロジェクトで API を有効化しておく必要がある。
 *
 * 秘密情報（ペアリングコード・Setup 鍵）は UserProperties のみに保存し、Drive のレジストリファイルには書かない。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppsScriptApi, type Http } from '../setup/apps-script-api';
import { Installer, type InstallerDeps, type Registry, type ReleaseBundle, type SecretRegistry } from '../setup/installer';
import { createGasPlatform, fromJavaBytes } from '../backend/gas/platform';
import { signOwnerEnvelope } from '../backend/auth';
import { fromHex, toHex } from '../shared/crypto';

declare const SHIFTLY_RELEASE: ReleaseBundle;
declare const Drive: any;

const REG_KEY = 'SHIFTLY_SETUP_REGISTRY';
const SEC_KEY = 'SHIFTLY_SETUP_SECRETS';
const REG_FILE = 'Shiftly Setup Registry.json';
/** Drive 上のレジストリファイルの ID（作成・使用したもの。以後はこの ID で更新する） */
const REG_FILE_ID_KEY = 'SHIFTLY_SETUP_REGISTRY_FILE_ID';

export function doGet() {
  return HtmlService.createHtmlOutputFromFile('setup').setTitle('Shiftly Setup').addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

const http: Http = (method, url, body) => {
  const res = UrlFetchApp.fetch(url, {
    method: method.toLowerCase() as GoogleAppsScript.URL_Fetch.HttpMethod,
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    muteHttpExceptions: true,
  });
  return { status: res.getResponseCode(), body: res.getContentText() };
};

function postJson(url: string, body: unknown) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) return { ok: false, error: { code: 'BAD_URL', message: '接続先 URL が不正です' } };
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: true });
  try {
    return JSON.parse(res.getContentText());
  } catch {
    return { ok: false, error: { code: 'CORE_UNAVAILABLE', message: 'Shiftly-Staff（旧名称 Shiftly-Kiosk）に接続できません（権限承認が未完了の可能性）' } };
  }
}

/**
 * Drive 上のレジストリファイル（Setup の記録）を探す。検索に失敗した場合は「存在しない」と見なさず、そのまま失敗させる
 * （既存の環境を新規と取り違えてプロジェクトを二重に作る・レジストリファイルを二重に作ることを防ぐ。S1、D-025）。
 * setupApi がエラーとして画面に返し、利用者は再読み込み・再実行する
 */
function findRegistryFiles(): string[] {
  const r = Drive.Files.list({ q: "appProperties has { key='shiftlySetup' and value='registry' } and trashed = false", fields: 'files(id)', pageSize: 20 });
  return (r.files ?? []).map((f: { id: string }) => f.id);
}

/** レジストリファイルの内容を読む。読めない場合は新規の環境として扱わずに止める（二重作成の防止。S1） */
function readRegistryFile(id: string): { id: string; text: string; reg: Registry } {
  const res = UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`Setup の記録ファイルを読み込めませんでした（HTTP ${res.getResponseCode()}）。時間をおいて再読み込みしてください`);
  const text = res.getContentText();
  let reg: Registry;
  try {
    reg = JSON.parse(text) as Registry;
  } catch {
    throw new Error('Setup の記録ファイルの内容を読み取れませんでした。Google ドライブの「Shiftly Setup Registry.json」を確認してください');
  }
  return { id, text, reg };
}

/**
 * Drive 上のレジストリファイルから、最新の記録を選ぶ（独立した点検 S1-3）。
 * Drive の検索への反映の遅れなどで同じ環境の記録ファイルが複数ある場合は、最後に保存したもの（updatedAt が最新）を使う。
 * 別々の環境を指す記録ファイルがある場合は、どちらで再開すべきか分からないため止める
 */
function latestRegistryFile(): { id: string; text: string; reg: Registry } | null {
  const files = findRegistryFiles().map(readRegistryFile);
  if (!files.length) return null;
  if (new Set(files.map((f) => f.reg.envId)).size > 1)
    throw new Error('Google ドライブに、別々の環境を指す Setup の記録ファイル（Shiftly Setup Registry.json）が複数あります。使わない環境の記録ファイルをゴミ箱に移動してから、再読み込みしてください');
  return files.reduce((a, b) => (String(b.reg.updatedAt ?? '') > String(a.reg.updatedAt ?? '') ? b : a));
}

function deps(): InstallerDeps {
  const up = PropertiesService.getUserProperties();
  const p = createGasPlatform();
  return {
    api: new AppsScriptApi(http),
    release: SHIFTLY_RELEASE,
    load: () => {
      let reg = up.getProperty(REG_KEY);
      const sec = up.getProperty(SEC_KEY);
      if (!reg) {
        // UserProperties が空でも Drive のレジストリファイルから既存環境を再検出（複数あれば最新の記録。以後はそのファイルを ID で更新する）
        const f = latestRegistryFile();
        if (f) {
          reg = f.text;
          up.setProperty(REG_FILE_ID_KEY, f.id);
        }
      }
      return { reg: reg ? (JSON.parse(reg) as Registry) : null, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
    },
    save: (reg, sec) => {
      up.setProperty(REG_KEY, JSON.stringify(reg));
      up.setProperty(SEC_KEY, JSON.stringify(sec));
      const blob = Utilities.newBlob(JSON.stringify(reg, null, 2), 'application/json', REG_FILE);
      // 記録ファイルは ID で扱う（Codex 監査22 #3、D-025 S1）。作成するときは、先に Drive で ID を予約して保存し（generateIds）、
      // その ID で作成する。作成の応答を失っても、次の保存は同じ ID で更新（なければ同じ ID で作成）するため、検索への反映の遅れに
      // 左右されず、二重に作らない（同じ ID のファイルは 1 つしか作れない）
      const createWithId = (id: string) => Drive.Files.create({ id, name: REG_FILE, mimeType: 'application/json', appProperties: { shiftlySetup: 'registry', envId: reg.envId } }, blob, { fields: 'id' });
      const known = up.getProperty(REG_FILE_ID_KEY);
      if (known) {
        try {
          Drive.Files.update({}, known, blob);
          return;
        } catch {
          // 更新できない: 予約した ID でまだ作られていない（前回の作成が失敗した）可能性。同じ ID で作成する（作成済みなら失敗する）
          try {
            createWithId(known);
            return;
          } catch (e) {
            // どちらもできない（削除された・一時的な失敗）: 次の保存で検索し直す。今回は止める（迷ったら止める）
            up.deleteProperty(REG_FILE_ID_KEY);
            throw e;
          }
        }
      }
      const latest = latestRegistryFile();
      if (latest) {
        up.setProperty(REG_FILE_ID_KEY, latest.id);
        Drive.Files.update({}, latest.id, blob);
        return;
      }
      const reserved = (Drive.Files.generateIds({ count: 1, space: 'drive' }).ids as string[])[0];
      if (!reserved) throw new Error('Google ドライブで記録ファイルの ID を予約できませんでした。時間をおいて再実行してください');
      up.setProperty(REG_FILE_ID_KEY, reserved);
      createWithId(reserved);
    },
    userEmail: () => {
      try {
        return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || null;
      } catch {
        return null;
      }
    },
    randomHex: (n) => p.randomHex(n),
    sha256Hex: (s) => toHex(fromJavaBytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8) as unknown as number[])),
    now: () => new Date().toISOString(),
    postCore: postJson,
    callCoreAsSetup: (url, keyHex, req) => postJson(url, { kind: 'owner', envelope: signOwnerEnvelope(p, fromHex(keyHex), JSON.stringify(req), 'setup') }),
  };
}

/** Setup 画面からの呼び出し（同一ユーザーの同時実行はロックで防止） */
export function setupApi(reqJson: string): string {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(20000)) return JSON.stringify({ ok: false, error: { code: 'BUSY', message: '別の画面でセットアップを実行中です。完了してから再度お試しください' } });
  try {
    const req = JSON.parse(reqJson) as { action: string; args?: Record<string, unknown> };
    const inst = new Installer(deps());
    const a = req.args ?? {};
    switch (req.action) {
      case 'state':
        return ok(inst.state());
      case 'run':
        return ok(inst.runUntilBlocked({ storeName: typeof a.storeName === 'string' ? a.storeName : undefined }, 4));
      case 'retry':
        inst.retry(String(a.step) as never, a.confirmedNoDuplicate === true);
        return ok(inst.runUntilBlocked({ storeName: typeof a.storeName === 'string' ? a.storeName : undefined }, 4));
      case 'checkUpdate':
        return ok(inst.checkUpdate());
      case 'applyUpdate':
        return ok(inst.applyUpdate({ approveDestructive: a.approveDestructive === true }));
      case 'rollback':
        return ok({ message: inst.rollbackCode() });
      default:
        return JSON.stringify({ ok: false, error: { code: 'UNKNOWN', message: '不明な操作です' } });
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: { code: 'SETUP_ERROR', message: e instanceof Error ? e.message.slice(0, 300) : 'エラー' } });
  } finally {
    lock.releaseLock();
  }
}

function ok(data: unknown) {
  return JSON.stringify({ ok: true, data });
}
