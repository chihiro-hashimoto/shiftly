/**
 * Shiftly-Staff（Core）GAS エントリ（v1.2 までの名称は Shiftly-Kiosk）
 * - Web アプリ: 実行=デプロイユーザー（Google 所有者）、アクセス=全員（匿名）
 * - 店舗 iPad の画面（スタッフ画面・管理者モード）と業務データへの唯一の更新経路（Core API）を持つ
 * - doPost: Google 所有者用 Admin からの署名付きリクエスト／Admin との初回ペアリング／死活確認
 * - 公開関数: doGet, doPost, staffApi（互換: kioskApi）, shiftlyAuthorize, shiftlyDailyJob（ビルド時にトップレベル関数として生成）
 */
import { handleRequest, verifyEnvelope, SECRET_KEYS, APP_VERSION, type Backend } from '../backend/index';
import { clearStorageCreatingMarkers, createGasPlatform, provisionStorage, writeEnvironmentFile } from '../backend/gas/platform';
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
  return HtmlService.createHtmlOutputFromFile('staff')
    .setTitle('Shiftly')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** 店舗 iPad の画面からの API 呼び出し（google.script.run） */
export function staffApi(reqJson: string): string {
  let req: unknown;
  try {
    req = JSON.parse(reqJson);
  } catch {
    return JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message: 'リクエスト形式が不正です' } });
  }
  return JSON.stringify(handleRequest(be(), req, null));
}

/**
 * 互換: v1.2 までの関数名。更新の前から開いていた店舗端末の画面（旧 HTML）が更新後も動作するように残す
 * （同じ処理。認証・認可は staffApi と同一。docs/decisions.md D-014）
 */
export function kioskApi(reqJson: string): string {
  return staffApi(reqJson);
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
    if (body.kind === 'pair') return json(pair(b, body.role === 'setup' ? 'setup' : 'admin', body.pairingCode, body.clientKey));
    if (body.kind === 'owner') {
      // admin（Google 所有者の管理画面）/ setup（更新関連のみ）の署名を検証
      const v = verifyEnvelope(b.p, body.envelope);
      return json(handleRequest(b, JSON.parse(v.body), 'owner'));
    }
  } catch {
    return json({ ok: false, error: { code: 'UNAUTHENTICATED', message: '認証に失敗しました' } });
  }
  return json({ ok: false, error: { code: 'UNKNOWN', message: 'unknown' } });
}

/**
 * Admin / Setup との初回ペアリング（使い捨て）。成功時に役割別の HMAC 鍵を返す
 * clientKey: 呼び出し側が事前に生成・保存した鍵（64桁の16進）。指定時はそれを登録する。
 *   応答が失われても呼び出し側は鍵を保持しているため、署名付きの呼び出しで登録済みかを確かめて再開できる（Core は鍵を再送しない）
 */
function pair(b: Backend, role: 'admin' | 'setup', code: unknown, clientKey?: unknown) {
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
    const key = typeof clientKey === 'string' && /^[0-9a-f]{64}$/.test(clientKey) ? clientKey : p.randomHex(32);
    p.secrets.set(role === 'admin' ? SECRET_KEYS.adminHmac : SECRET_KEYS.setupHmac, key);
    p.secrets.set(flag, '1');
    return { ok: true, data: { key } };
  });
}

/**
 * Google 所有者がスクリプトエディタで 1 回実行する初期化（権限承認を兼ねる）
 * フォルダ・DB 作成、秘密情報生成、初期データ、日次トリガー登録（すべて冪等）
 */
export function shiftlyAuthorize() {
  // 匿名の Web アプリ訪問者が google.script.run で呼ぶことを拒否（エディタから Google 所有者が実行した場合のみ）
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
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
  // 環境情報ファイルも一度だけ作る構成物のため、作成中の目印の読み書きを含めてスクリプトロックの中で行う（handleRequest とは入れ子にしない。D-026 S1）
  b.p.withLock(30000, () =>
    writeEnvironmentFile({ envId: cfg.envId, app: 'shiftly', schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION, scriptId: ScriptApp.getScriptId(), databaseId: st.dbId, updatedAt: new Date().toISOString() }),
  );
  return { ok: r.ok, created: st.created };
}

/**
 * Google 所有者がスクリプトエディタで実行: 初期化の作成中の目印を外す（D-025 S1）。
 * shiftlyAuthorize が「前回の作成の結果を確認できません」で止まり、Google ドライブで該当のフォルダ・ファイルが作られていないこと
 * （またはゴミ箱に移動したこと）を確認した後にだけ実行する。実行後に shiftlyAuthorize を再実行すると作成する
 */
export function shiftlyConfirmStorageNotCreated() {
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
  // shiftlyAuthorize と同じロックの中で、目印のある構成物ごとに検索し直す。見つかったものは関連付け、見つからないものの目印だけを外す
  const r = be().p.withLock(30000, () => clearStorageCreatingMarkers());
  return {
    ok: true,
    cleared: r.cleared,
    adopted: r.adopted,
    message:
      r.cleared.length || r.adopted.length
        ? `作成中の目印を処理しました（作成し直す: ${r.cleared.length} 件、見つかったものを使う: ${r.adopted.length} 件）。shiftlyAuthorize を再実行してください`
        : '作成中の目印はありません',
  };
}

/**
 * Google 所有者がスクリプトエディタで実行: 管理画面（Shiftly-Admin）との接続をリセットする（接続鍵を失った場合の復旧用）。
 * 実行後、Shiftly-Admin のエディタで shiftlyAuthorize を実行すると再接続される
 */
export function shiftlyResetAdminPairing() {
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
  const p = be().p;
  p.withLock(10000, () => {
    p.secrets.delete(SECRET_KEYS.adminHmac);
    p.secrets.delete('SHIFTLY_ADMIN_PAIRED');
  });
  return { ok: true, message: '管理画面との接続をリセットしました。Shiftly-Admin のエディタで shiftlyAuthorize を実行してください' };
}

/**
 * Google 所有者がスクリプトエディタで実行: Shiftly Setup との接続をリセットする（Setup の接続鍵を失った場合の復旧用。
 * 構築の途中で「別の鍵で登録済み」と案内された場合に実行し、Setup で接続設定の工程を再実行する）
 */
export function shiftlyResetSetupPairing() {
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
  return report('Setup との接続のリセット', handleRequest(be(), { op: 'system.resetSetupPairing' }, 'owner'));
}

/**
 * Google 所有者の保守作業（D-027 B案。docs/operations-guide.md「データの復元（Google 所有者の保守作業）」）。
 * v1.3 ではアプリ内の自動復元・自動更新を提供しない。データを手で直す前に shiftlyMaintenanceBegin を実行して業務の更新を止め、
 * 作業の後に shiftlyMaintenanceFinish で開始時の記録と照合してから再開する（問題があれば再開しない）。
 * 開始時の記録を失った場合に今の DB を新しい基準にして開始し直す関数は提供しない（D-027 追補。紙のタイムカードでの運用と開発者への個別の復旧の依頼）
 */
export function shiftlyMaintenanceBegin() {
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
  return report('保守作業の開始', handleRequest(be(), { op: 'maintenance.begin', args: { confirmText: '保守を開始する' } }, 'owner'));
}
export function shiftlyMaintenanceFinish() {
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
  return report('保守作業の終了', handleRequest(be(), { op: 'maintenance.finish', args: { confirmText: '保守を終了する' } }, 'owner'));
}
export function shiftlyMaintenanceStatus() {
  if (!isOwnerExecution()) throw new Error('この関数はスクリプトエディタから Google 所有者が実行してください');
  return report('保守作業の状態', handleRequest(be(), { op: 'system.info' }, 'owner'));
}
/** 実行ログに結果を出す（応答は表の名前・件数・ID だけで、個人情報を含まない） */
function report(title: string, r: ReturnType<typeof handleRequest>) {
  console.log(JSON.stringify({ title, ok: r.ok, ...(r.ok ? { data: r.data } : { error: r.error }) }));
  return r;
}

/** エディタ実行（Google 所有者本人）か。匿名アクセスの Web アプリ経由では getActiveUser が空になる */
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
