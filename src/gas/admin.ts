/**
 * Shiftly-Admin（店長用）GAS エントリ
 * - Web アプリ: 実行=デプロイユーザー（店長）、アクセス=自分のみ → Google が店長本人を認証
 * - 業務データには直接アクセスせず、Core へ HMAC 署名付きリクエストを転送（更新経路を Core に一本化）
 * - ブラウザに OAuth トークン・HMAC 鍵を渡さない
 */
import { signOwnerEnvelope } from '../backend/auth';
import { createGasPlatform } from '../backend/gas/platform';
import { fromHex } from '../shared/crypto';

interface AdminBootstrap {
  envId: string;
  coreUrl: string;
  /** Core とのペアリングコード（使い捨て。ペアリング後は無効） */
  pairingCode: string;
}
declare const SHIFTLY_ADMIN_BOOTSTRAP: AdminBootstrap;

const KEY_PROP = 'SHIFTLY_ADMIN_HMAC_KEY';

export function doGet(_e: GoogleAppsScript.Events.DoGet) {
  return HtmlService.createHtmlOutputFromFile('admin')
    .setTitle('Shiftly 管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function postCore(payload: unknown): { ok: boolean; data?: unknown; error?: { code: string; message: string } } {
  const res = UrlFetchApp.fetch(SHIFTLY_ADMIN_BOOTSTRAP.coreUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const text = res.getContentText();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: 'CORE_UNAVAILABLE', message: 'Shiftly 本体（Core）に接続できません。初期設定（承認）が完了しているか確認してください' } };
  }
}

const PENDING_KEY_PROP = 'SHIFTLY_ADMIN_PENDING_KEY';

function ensurePaired(): string {
  const props = PropertiesService.getScriptProperties();
  const k = props.getProperty(KEY_PROP);
  if (k) return k;
  // 鍵は Admin 側で生成し、送信前に保存する（応答が失われても再試行で再開できる）
  let pending = props.getProperty(PENDING_KEY_PROP);
  if (!pending) {
    pending = createGasPlatform().randomHex(32);
    props.setProperty(PENDING_KEY_PROP, pending);
  }
  const r = postCore({ kind: 'pair', role: 'admin', pairingCode: SHIFTLY_ADMIN_BOOTSTRAP.pairingCode, clientKey: pending });
  let key: string | null = null;
  if (r.ok) key = (r.data as { key: string }).key;
  else if (r.error?.code === 'CONFLICT') {
    // 登録済み: 前回の応答が失われた可能性。保存済みの鍵で署名した呼び出しが通れば、その鍵が登録されている
    const env = signOwnerEnvelope(createGasPlatform(), fromHex(pending), JSON.stringify({ op: 'settings.get', requestId: undefined }), 'admin');
    if (postCore({ kind: 'owner', envelope: env }).ok) key = pending;
  }
  if (!key)
    throw new Error(
      r.error?.code === 'CONFLICT'
        ? '管理画面の接続がすでに別の鍵で登録されています。Shiftly-Kiosk のエディタで shiftlyResetAdminPairing を実行してから、もう一度 shiftlyAuthorize を実行してください'
        : `Core とのペアリングに失敗しました（${r.error?.code ?? 'unknown'}）`,
    );
  props.setProperty(KEY_PROP, key);
  props.deleteProperty(PENDING_KEY_PROP);
  return key;
}

/** 店長画面からの API 呼び出し（google.script.run） */
export function adminApi(reqJson: string): string {
  try {
    const parsed = JSON.parse(reqJson) as { op?: unknown; args?: unknown; requestId?: unknown };
    // ブラウザ由来のフィールドは op / args / requestId のみ転送
    const body = JSON.stringify({ op: parsed.op, args: parsed.args, requestId: parsed.requestId });
    const key = fromHex(ensurePaired());
    const env = signOwnerEnvelope(createGasPlatform(), key, body, 'admin');
    return JSON.stringify(postCore({ kind: 'owner', envelope: env }));
  } catch (e) {
    return JSON.stringify({ ok: false, error: { code: 'ADMIN_ERROR', message: e instanceof Error ? e.message.slice(0, 200) : 'エラー' } });
  }
}

/** 店長の Google アカウント（表示・取り違え確認用。他者へは送らない） */
export function adminWhoAmI(): string {
  return JSON.stringify({ email: Session.getEffectiveUser().getEmail(), envId: SHIFTLY_ADMIN_BOOTSTRAP.envId });
}

/** エディタから実行して権限承認とペアリングを行う */
export function shiftlyAuthorize() {
  ensurePaired();
  return { ok: true };
}
