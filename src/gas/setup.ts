/**
 * Shiftly Setup（自動インストーラー）GAS エントリ
 *
 * 配信方式（docs/installer-guide.md）:
 *  A) 自己ホスト: 店長の Google アカウントに Setup プロジェクトを 1 つ置き（clasp またはファイル 1 つの貼り付け）、
 *     アクセス=自分のみ・実行=自分 でデプロイ
 *  B) ホスト型: 配布者のアカウントで 実行=アクセスしたユーザー・アクセス=Google アカウントを持つ全員 でデプロイ
 * いずれも Setup のコードは店長本人の権限で動作し、店長のアカウント内に GAS・Drive・DB を作成する。
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
    return { ok: false, error: { code: 'CORE_UNAVAILABLE', message: 'Shiftly-Kiosk に接続できません（権限承認が未完了の可能性）' } };
  }
}

function findRegistryFile(): string | null {
  try {
    const r = Drive.Files.list({ q: "appProperties has { key='shiftlySetup' and value='registry' } and trashed = false", fields: 'files(id)', pageSize: 5 });
    return r.files?.[0]?.id ?? null;
  } catch {
    return null;
  }
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
        // UserProperties が空でも Drive のレジストリファイルから既存環境を再検出
        const id = findRegistryFile();
        if (id) {
          const res = UrlFetchApp.fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true });
          if (res.getResponseCode() === 200) reg = res.getContentText();
        }
      }
      return { reg: reg ? (JSON.parse(reg) as Registry) : null, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
    },
    save: (reg, sec) => {
      up.setProperty(REG_KEY, JSON.stringify(reg));
      up.setProperty(SEC_KEY, JSON.stringify(sec));
      const blob = Utilities.newBlob(JSON.stringify(reg, null, 2), 'application/json', REG_FILE);
      const id = findRegistryFile();
      if (id) Drive.Files.update({}, id, blob);
      else Drive.Files.create({ name: REG_FILE, mimeType: 'application/json', appProperties: { shiftlySetup: 'registry', envId: reg.envId } }, blob);
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
        inst.retry(String(a.step) as never);
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
