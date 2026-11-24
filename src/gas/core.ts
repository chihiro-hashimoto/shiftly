/**
 * Shiftly-Kiosk（Core）GAS エントリ
 * - Web アプリ: 実行=デプロイユーザー（店長）、アクセス=全員（匿名）
 * - スタッフ用画面（HtmlService）と業務データへの唯一の更新経路（Core API）を持つ
 * - doPost: 店長用 Admin からの署名付きリクエスト／Admin との初回ペアリング／死活確認
 * - 公開関数: doGet, doPost, kioskApi, shiftlyAuthorize, shiftlyDailyJob（ビルド時にトップレベル関数として生成）
 */
import { handleRequest, verifyEnvelope, SECRET_KEYS, APP_VERSION, type Backend } from '../backend/index';
import { createGasPlatform, provisionStorage, writeEnvironmentFile } from '../backend/gas/platform';
import { SheetsAdapter } from '../backend/gas/sheets-adapter';
import { ensureSecrets, windowBump, windowCount } from '../backend/auth';
import { timingSafeEqualHex } from '../shared/crypto';
import { SCHEMA_VERSION } from '../backend/schema';

interface BootstrapConfig {
  envId: string;
  storeName: string;
  /** Admin とのペアリングコードの SHA-256（平文は Admin 側のみ） */
  adminPairingHash: string;
  /** Shiftly Setup とのペアリングコードの SHA-256（平文は Setup 側のみ） */
  setupPairingHash: string;
}
declare const SHIFTLY_BOOTSTRAP: BootstrapConfig;

let backend: Backend | null = null;
function be(): Backend {
  if (!backend) {
    const p = createGasPlatform();
    backend = { p, adapter: () => new SheetsAdapter(() => p.database.currentId()) };
  }
  return backend;
}

function json(o: unknown) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

export function doGet(_e: GoogleAppsScript.Events.DoGet) {
  return HtmlService.createHtmlOutputFromFile('kiosk')
    .setTitle('Shiftly')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** スタッフ画面からの API 呼び出し（google.script.run） */
export function kioskApi(reqJson: string): string {
  let req: unknown;
  try {
    req = JSON.parse(reqJson);
  } catch {
    return JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: 'リクエスト形式が不正です' } });
  }
  return JSON.stringify(handleRequest(be(), req, null));
}

export function doPost(e: GoogleAppsScript.Events.DoPost) {
  const b = be();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(e.postData.contents) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: { code: 'INVALID_INPUT', message: 'invalid' } });
  }
  try {
    if (body.kind === 'ping') {
      // 公開情報のみ（初期化状態・バージョン）
      return json({
        ok: true,
        data: {
          app: 'shiftly-core',
          version: APP_VERSION,
          schemaVersion: SCHEMA_VERSION,
          initialized: !!b.p.secrets.get('SHIFTLY_DB_ID'),
          envId: SHIFTLY_BOOTSTRAP.envId,
          adminPaired: b.p.secrets.get('SHIFTLY_ADMIN_PAIRED') === '1',
          setupPaired: b.p.secrets.get('SHIFTLY_SETUP_PAIRED') === '1',
        },
      });
    }
    if (body.kind === 'pair') return json(pair(b, body.role === 'setup' ? 'setup' : 'admin', body.pairingCode));
    if (body.kind === 'owner') {
      // admin（店長画面）/ setup（更新関連のみ）の署名を検証
      const v = verifyEnvelope(b.p, body.envelope);
      return json(handleRequest(b, JSON.parse(v.body), 'owner'));
    }
  } catch {
    return json({ ok: false, error: { code: 'UNAUTHENTICATED', message: '認証に失敗しました' } });
  }
  return json({ ok: false, error: { code: 'UNKNOWN', message: 'unknown' } });
}

/** Admin / Setup との初回ペアリング（使い捨て）。成功時に役割別の HMAC 鍵を返す */
function pair(b: Backend, role: 'admin' | 'setup', code: unknown) {
  const p = b.p;
  const fails = windowCount(p, `pair-fail:${role}`);
  if (fails >= 30) return { ok: false, error: { code: 'RATE_LIMITED', message: 'too many attempts' } };
  const expected = role === 'admin' ? SHIFTLY_BOOTSTRAP.adminPairingHash : SHIFTLY_BOOTSTRAP.setupPairingHash;
  if (typeof code !== 'string' || code.length < 32 || !timingSafeEqualHex(p.sha256Hex(code), expected)) {
    windowBump(p, `pair-fail:${role}`, 3600);
    return { ok: false, error: { code: 'UNAUTHENTICATED', message: 'pairing failed' } };
  }
  const flag = role === 'admin' ? 'SHIFTLY_ADMIN_PAIRED' : 'SHIFTLY_SETUP_PAIRED';
  return p.withLock(10000, () => {
    if (p.secrets.get(flag) === '1') return { ok: false, error: { code: 'CONFLICT', message: 'already paired' } };
    const key = p.randomHex(32);
    p.secrets.set(role === 'admin' ? SECRET_KEYS.adminHmac : SECRET_KEYS.setupHmac, key);
    p.secrets.set(flag, '1');
    return { ok: true, data: { key } };
  });
}

/**
 * 店長がスクリプトエディタで 1 回実行する初期化（権限承認を兼ねる）
 * フォルダ・DB 作成、秘密情報生成、初期データ、日次トリガー登録（すべて冪等）
 */
export function shiftlyAuthorize() {
  // 匿名の Web アプリ訪問者が google.script.run で呼ぶことを拒否（エディタから店長が実行した場合のみ）
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから店長が実行してください');
  const b = be();
  const cfg = SHIFTLY_BOOTSTRAP;
  // ロックは入れ子にしない（handleRequest 内で再度ロックを取得するため）
  const st = b.p.withLock(30000, () => {
    ensureSecrets(b.p);
    const r = provisionStorage(cfg.storeName);
    if (!b.p.secrets.get(SECRET_KEYS.envId)) b.p.secrets.set(SECRET_KEYS.envId, cfg.envId);
    return r;
  });
  const r = handleRequest(b, { op: 'system.initialize', args: { storeName: cfg.storeName, envId: cfg.envId } }, 'system');
  // 日次トリガー（重複登録しない）
  if (!ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'shiftlyDailyJob')) {
    ScriptApp.newTrigger('shiftlyDailyJob').timeBased().everyDays(1).atHour(4).inTimezone('Asia/Tokyo').create();
  }
  writeEnvironmentFile({ envId: cfg.envId, app: 'shiftly', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, scriptId: ScriptApp.getScriptId(), databaseId: st.dbId, updatedAt: new Date().toISOString() });
  return { ok: r.ok, created: st.created };
}

/** エディタ実行（店長本人）か。匿名アクセスの Web アプリ経由では getActiveUser が空になる */
function isOwnerExecution(): boolean {
  try {
    const active = Session.getActiveUser().getEmail();
    const eff = Session.getEffectiveUser().getEmail();
    return !!active && !!eff && active.toLowerCase() === eff.toLowerCase();
  } catch {
    return false;
  }
}

export function shiftlyDailyJob(e?: { triggerUid?: string }) {
  // 時間主導トリガーからの呼び出しのみ受け付ける（google.script.run 経由の匿名呼び出しを拒否）
  const uid = e && typeof e.triggerUid === 'string' ? e.triggerUid : '';
  if (!uid || !ScriptApp.getProjectTriggers().some((t) => t.getUniqueId() === uid && t.getHandlerFunction() === 'shiftlyDailyJob')) {
    console.log(JSON.stringify({ level: 'warn', message: 'dailyJob rejected (not a trigger invocation)' }));
    return;
  }
  const r = handleRequest(be(), { op: 'system.dailyJob' }, 'system');
  if (!r.ok) console.log(JSON.stringify({ level: 'error', message: 'dailyJob failed', code: r.error.code }));
}
