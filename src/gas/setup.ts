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
 *
 * 共通の Setup（A案・D-029。開発者が B のホスト型で公開し、複数の利用者が開く）での利用者の間の分離:
 *  - 記録・秘密情報は UserProperties（Google アカウントごと・このスクリプトごとに分かれる）と、利用者自身の Google ドライブだけに保存する
 *  - Script Properties・Script Cache（全利用者で共有）は使わない（createGasPlatform ではなく createGasCrypto を使う。テストで確認）
 *  - 同時実行の防止は LockService.getUserLock（利用者ごと）
 *  - OAuth トークン（ScriptApp.getOAuthToken）はサーバー側の UrlFetch でだけ使い、画面・ログ・記録に出さない
 *  - 例外のログ（exceptionLogging）は共通の Setup のマニフェストでは NONE（開発者の Cloud のログに利用者の情報を残さない）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { AppsScriptApi, type Http } from '../setup/apps-script-api';
import { Installer, type InstallerDeps, type Registry, type ReleaseBundle, type SecretRegistry } from '../setup/installer';
import { createGasCrypto, listAllDriveFiles } from '../backend/gas/platform';
import { signOwnerEnvelope } from '../backend/auth';
import { fromHex } from '../shared/crypto';

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

const REG_QUERY = "appProperties has { key='shiftlySetup' and value='registry' } and trashed = false";

/**
 * Drive 上のレジストリファイル（Setup の記録）を探す。全ページを取得する（D-027。Codex 監査24 A4）。検索に失敗した場合
 * （途中のページを含む）は「存在しない」と見なさず、そのまま失敗させる（既存の環境を新規と取り違えて二重に作ることを防ぐ。S1）
 */
function findRegistryFiles(): Array<{ id: string; envId: string | null }> {
  return listAllDriveFiles<{ id: string; appProperties?: Record<string, string> }>(REG_QUERY, 'id, appProperties').map((f) => ({ id: f.id, envId: f.appProperties?.envId ?? null }));
}

function driveGet(url: string) {
  return UrlFetchApp.fetch(url, { headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }, muteHttpExceptions: true });
}

/**
 * 保存している ID で記録ファイルを直接照会する（検索を使わない。D-027。Codex 監査24 A3）。
 * 'missing' は応答が 404 の場合だけ。それ以外の失敗（一時的なエラー・権限）は例外で止める。ゴミ箱にある・Setup の記録ファイルでない場合も止める
 */
function registryMeta(id: string): { status: 'ok'; envId: string | null } | { status: 'missing' } {
  const res = driveGet(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,trashed,appProperties`);
  const code = res.getResponseCode();
  if (code === 404) return { status: 'missing' };
  if (code !== 200) throw new Error(`Setup の記録ファイル（ID: ${id}）を確認できませんでした（HTTP ${code}）。時間をおいて再読み込みしてください`);
  let m: { trashed?: boolean; appProperties?: Record<string, string> };
  try {
    m = JSON.parse(res.getContentText()) as typeof m;
  } catch {
    throw new Error(`Setup の記録ファイル（ID: ${id}）の情報を読み取れませんでした。時間をおいて再読み込みしてください`);
  }
  if (m.trashed) throw new Error(`Setup の記録ファイル（Google ドライブの「${REG_FILE}」、ID: ${id}）がゴミ箱にあります。ゴミ箱から元に戻してから再読み込みしてください（新しい環境としては扱いません）`);
  if (m.appProperties?.shiftlySetup !== 'registry') throw new Error(`保存している ID（${id}）のファイルは Setup の記録ファイルではありません。Setup の記録の不整合のため停止しました（自動では作り直しません）`);
  return { status: 'ok', envId: m.appProperties?.envId ?? null };
}

/** 記録ファイルの内容を読む。読めない場合は新規の環境として扱わずに止める（二重作成の防止。S1） */
function readRegistryFile(id: string): { id: string; text: string; reg: Registry } {
  const res = driveGet(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
  if (res.getResponseCode() !== 200) throw new Error(`Setup の記録ファイルを読み込めませんでした（HTTP ${res.getResponseCode()}）。時間をおいて再読み込みしてください`);
  const text = res.getContentText();
  let reg: Registry;
  try {
    reg = JSON.parse(text) as Registry;
  } catch {
    throw new Error('Setup の記録ファイルの内容を読み取れませんでした。Google ドライブの「Shiftly Setup Registry.json」を確認してください');
  }
  if (!reg || typeof reg.envId !== 'string') throw new Error('Setup の記録ファイルの内容が不正です。Google ドライブの「Shiftly Setup Registry.json」を確認してください');
  return { id, text, reg };
}

/**
 * Drive 上のレジストリファイルから、最新の記録を選ぶ（保存している ID がない場合だけ使う。独立した点検 S1-3）。
 * 同じ環境の記録ファイルが複数ある場合は最後に保存したもの（updatedAt が最新）を使い、構築の完了前の点検（registryReport）で
 * 重複として所有者に確認を求める（自動では削除しない）。別々の環境を指す記録ファイルがある場合は、どちらで再開すべきか分からないため止める
 */
function latestRegistryFile(): { id: string; text: string; reg: Registry } | null {
  const files = findRegistryFiles().map((f) => readRegistryFile(f.id));
  if (!files.length) return null;
  if (new Set(files.map((f) => f.reg.envId)).size > 1)
    throw new Error('Google ドライブに、別々の環境を指す Setup の記録ファイル（Shiftly Setup Registry.json）が複数あります。使わない環境の記録ファイルをゴミ箱に移動してから、再読み込みしてください');
  return files.reduce((a, b) => (String(b.reg.updatedAt ?? '') > String(a.reg.updatedAt ?? '') ? b : a));
}

/**
 * 構築の完了前の Setup の記録ファイルの点検（D-027。Codex 監査24 A4）: 全ページを一覧し、この環境の記録ファイルが 1 つだけで、
 * 保存している ID と一致すること。一覧の途中の失敗は例外（点検できない＝完了しない）。重複は所有者に確認を求め、自動では削除しない
 */
export function registryReport(envId: string): { ok: boolean; issues: string[] } {
  const files = findRegistryFiles();
  const known = PropertiesService.getUserProperties().getProperty(REG_FILE_ID_KEY);
  const mine = files.filter((f) => f.envId === envId);
  const others = files.filter((f) => f.envId !== envId);
  const issues: string[] = [];
  if (mine.length !== 1) issues.push(`Google ドライブに、この環境の Setup の記録ファイル（${REG_FILE}）が ${mine.length} つあります（1 つのはず。保存している ID: ${known ?? 'なし'}。使わないほうは自動では削除しません）`);
  else if (mine[0]!.id !== known) issues.push(`Google ドライブの Setup の記録ファイル（ID: ${mine[0]!.id}）が、保存している ID（${known ?? 'なし'}）と一致しません`);
  if (others.length) issues.push(`Google ドライブに、別の環境の Setup の記録ファイルが ${others.length} つあります（二重に構築した可能性。使わない環境の記録ファイルを確認してください）`);
  return { ok: issues.length === 0, issues };
}

function deps(): InstallerDeps {
  const up = PropertiesService.getUserProperties();
  const p = createGasCrypto();
  return {
    api: new AppsScriptApi(http),
    release: SHIFTLY_RELEASE,
    load: () => {
      const local = up.getProperty(REG_KEY);
      const sec = up.getProperty(SEC_KEY);
      const known = up.getProperty(REG_FILE_ID_KEY);
      const parsedLocal = local ? (JSON.parse(local) as Registry) : null;
      if (known) {
        // 保存している ID があれば、検索ではなく ID で直接照会する（D-027。Codex 監査24 A3）。照会できない場合は止める（例外）
        const m = registryMeta(known);
        if (m.status === 'ok') {
          if (parsedLocal) {
            // Setup の中の記録とファイルが別々の環境を指す: どちらが正しいか分からないため止める（自動では選ばない）
            if (m.envId !== parsedLocal.envId)
              throw new Error(`Setup の記録（環境 ${parsedLocal.envId}）と、Google ドライブの記録ファイル（ID: ${known}、環境 ${m.envId ?? '不明'}）が一致しません。Setup の記録の不整合のため停止しました（自動では作り直しません）`);
            return { reg: parsedLocal, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
          }
          const f = readRegistryFile(known);
          if (f.reg.envId !== m.envId) throw new Error(`Setup の記録ファイル（ID: ${known}）の内容と目印の環境が一致しません。Setup の記録の不整合のため停止しました`);
          return { reg: f.reg, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
        }
        // 404: 予約した ID でまだ作られていない（前回の作成の失敗）なら、Setup の中の記録で続ける（次の保存で同じ ID で作成する）。
        // Setup の中の記録もない場合は、記録の本体を失っている: 新しい環境とは推測せずに止める
        if (parsedLocal) return { reg: parsedLocal, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
        throw new Error(
          `保存している Setup の記録ファイル（ID: ${known}）が見つかりません。Google ドライブのゴミ箱に「${REG_FILE}」がないか確認し、ある場合は元に戻してから再読み込みしてください（記録の本体がない状態を、新しい環境としては扱いません）`,
        );
      }
      if (parsedLocal) return { reg: parsedLocal, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
      // Setup の中に記録も ID もない: Drive の記録ファイルから既存環境を再検出（全ページ。検索の失敗は例外で止める）
      const f = latestRegistryFile();
      if (f) up.setProperty(REG_FILE_ID_KEY, f.id);
      return { reg: f ? f.reg : null, secrets: sec ? (JSON.parse(sec) as SecretRegistry) : null };
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
        // 上書きの前に、そのファイルがこの環境の記録ファイルであることを ID の照会で確かめる（別の環境の記録を上書きしない。Codex 監査24 A3）
        const m = registryMeta(known);
        if (m.status === 'ok') {
          if (m.envId !== reg.envId) throw new Error(`保存している ID（${known}）の記録ファイルは別の環境（${m.envId ?? '不明'}）のものです。上書きせずに停止しました（自動では作り直しません）`);
          Drive.Files.update({}, known, blob);
          return;
        }
        // 404: 予約した ID でまだ作られていない（前回の作成が失敗した）。同じ ID で作成する。失敗した場合は ID を消さずに残して止める
        // （ID を消すと、検索に反映されていない間に新しい ID で二重に作り得る。Codex 監査23 #3、D-026 S1）
        try {
          createWithId(known);
          return;
        } catch {
          throw new Error(
            `Setup の記録ファイル（Google ドライブの「${REG_FILE}」、ID: ${known}）を保存できませんでした。時間をおいて再読み込みし、もう一度実行してください。解決しない場合は、Google ドライブでこのファイルがゴミ箱にないか確認してください（記録は Setup の中にも保存されています）`,
          );
        }
      }
      const latest = latestRegistryFile();
      if (latest) {
        if (latest.reg.envId !== reg.envId) throw new Error(`Google ドライブの Setup の記録ファイルは別の環境（${latest.reg.envId}）のものです。上書きせずに停止しました`);
        up.setProperty(REG_FILE_ID_KEY, latest.id);
        Drive.Files.update({}, latest.id, blob);
        return;
      }
      const reserved = (Drive.Files.generateIds({ count: 1, space: 'drive' }).ids as string[])[0];
      if (!reserved) throw new Error('Google ドライブで記録ファイルの ID を予約できませんでした。時間をおいて再実行してください');
      up.setProperty(REG_FILE_ID_KEY, reserved);
      createWithId(reserved);
    },
    registryReport: (envId) => registryReport(envId),
    userEmail: () => {
      try {
        return Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail() || null;
      } catch {
        return null;
      }
    },
    randomHex: (n) => p.randomHex(n),
    sha256Hex: (s) => p.sha256Hex(s),
    now: () => new Date().toISOString(),
    postCore: postJson,
    callCoreAsSetup: (url, keyHex, req) => postJson(url, { kind: 'owner', envelope: signOwnerEnvelope(p, fromHex(keyHex), JSON.stringify(req), 'setup') }),
  };
}

/**
 * Setup の記録（UserProperties・Google ドライブの記録ファイル）が見つからない場合は、検索の 0 件だけを根拠に新しい環境を作らない
 * （以前の環境の記録が見えていないだけの可能性がある。D-026 S1・独立した点検 #9）。所有者が「初めての構築」であることを確認してから作る
 */
export const FIRST_INSTALL_CONFIRM = 'この Google アカウントで Shiftly を構築するのは初めてです（以前に構築した環境はありません）';
export function firstInstallPrompt(state: unknown) {
  return {
    state,
    waitingFor: null,
    error: {
      step: 'account',
      message: 'Setup の記録が見つかりません。初めての構築として進めてよいかの確認が必要です',
      fix: '以前にこの Google アカウントで Shiftly を構築した場合は、Google ドライブの「Shiftly Setup Registry.json」がゴミ箱にないか確認し、ある場合は元に戻してから画面を再読み込みしてください（新しく構築すると、Staff・Admin・DB が二重にできます）。初めての構築の場合は、確認のチェックを付けて実行してください',
      confirm: FIRST_INSTALL_CONFIRM,
    },
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
        if (!inst.hasRegistry()) return ok(firstInstallPrompt(inst.state()));
        return ok(inst.runUntilBlocked({ storeName: typeof a.storeName === 'string' ? a.storeName : undefined }, 4));
      case 'retry':
        if (!inst.hasRegistry()) {
          // 記録がない状態での実行は、「初めての構築」の確認を明示した場合だけ（アカウントの確認の工程から始める）
          if (a.step !== 'account' || a.confirmedNoDuplicate !== true) return ok(firstInstallPrompt(inst.state()));
          return ok(inst.runUntilBlocked({ storeName: typeof a.storeName === 'string' ? a.storeName : undefined }, 4));
        }
        inst.retry(String(a.step) as never, a.confirmedNoDuplicate === true);
        return ok(inst.runUntilBlocked({ storeName: typeof a.storeName === 'string' ? a.storeName : undefined }, 4));
      case 'attach':
        return ok(inst.attach(String(a.step) as never, typeof a.id === 'string' ? a.id : ''));
      case 'checkUpdate':
      case 'applyUpdate':
      case 'rollback':
        // v1.3 では Setup による既存環境の自動更新・自動ロールバックを提供しない（D-027。処理は配布物に含めない）
        return JSON.stringify({ ok: false, error: { code: 'NOT_IN_THIS_RELEASE', message: 'アプリの更新・ロールバックは v1.3 では Setup から行いません。安全性確保のため、Google 所有者による保守作業として行います（docs/update-rollback.md）' } });
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
