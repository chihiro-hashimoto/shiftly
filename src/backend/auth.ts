/**
 * 認証
 *
 * - 管理者: Shiftly-Admin（アクセス=自分のみ の Web アプリ）を Google が認証し、Admin GAS が
 *   HMAC 署名付きリクエストで Core に転送する。Core は署名・時刻・ノンスを検証して owner として扱う。
 *   （ブラウザに管理者用の秘密情報・OAuth トークンは渡さない）
 * - 店舗端末: 管理者が発行した短時間・使い捨ての登録コードで登録し、ランダムな端末トークン（256bit）を発行。
 *   DB にはトークンの SHA-256 のみ保存。失効可能。
 * - スタッフ: 端末トークン ＋ 氏名選択 ＋ 個別 PIN（pepper 付き PBKDF2）。試行回数制限・一時ロック・端末単位の制限。
 * - 機密操作: 別の管理用パスコード（10文字以上）による追加認証（5分間有効）。
 * - v1.3 PIN 任意化: PIN 未設定のスタッフは氏名選択のみでログインできるが「本人未確認」セッションとなり、
 *   打刻・公開シフト閲覧・本人未確認の申告（勤怠修正・休憩・早出残業）以外の権限は付与しない（サーバー側で権限を削る）。
 *   PIN の有無はサーバーの DB で判定し、クライアントの申告は使わない（PIN 設定済みのスタッフは空欄では認証できない）。
 * - v1.3 管理者パスワード: 店舗 iPad の「管理者ページ」から管理者パスワード（12文字以上）で認証し、
 *   管理者セッション（256bit トークン・ハッシュのみ保存・無操作5分・絶対期限）を発行する。スタッフのセッションとは完全に別。
 *   Google 所有者に限定した操作（構築・更新・管理者パスワードの初期設定/再設定等）は管理者セッションでは実行できない。
 */
import type { Ctx } from './context';
import { audit, nowIso, settings } from './context';
import { ApiError, E } from './errors';
import type { Platform } from './platform';
import type { AdminCredential, AdminSessionRow, Credential, Device, DeviceEnrollment, Employee, PermissionKey, PermissionRow, SessionRow } from '../shared/types';
import { PIN_ALGO, fromHex, hashSecret, timingSafeEqualHex, utf8, toHex } from '../shared/crypto';
import { parseIso, toIsoJst } from '../shared/time';
import { DEFAULT_STAFF_PERMISSIONS, sanitizePermissions } from '../shared/permissions';

export const SECRET_KEYS = {
  pepper: 'SHIFTLY_PIN_PEPPER',
  adminHmac: 'SHIFTLY_ADMIN_HMAC_KEY',
  /** Shiftly Setup 用（更新関連の操作のみ許可） */
  setupHmac: 'SHIFTLY_SETUP_HMAC_KEY',
  envId: 'SHIFTLY_ENV_ID',
} as const;

/** PBKDF2 反復回数（GAS 上の実測で調整予定: docs/technical-verification.md） */
export const PIN_ITERATIONS = 1000;
export const STEPUP_ITERATIONS = 1000;
export const SESSION_ABSOLUTE_MINUTES = 30;
export const STEPUP_MINUTES = 5;
export const ENROLLMENT_MINUTES = 15;
export const DEVICE_FAIL_LIMIT = 20;
export const DEVICE_FAIL_WINDOW_SEC = 15 * 60;
export const OWNER_SIG_WINDOW_MS = 60_000;
/** 管理者パスワード（v1.3） */
export const ADMIN_ITERATIONS = 2000;
export const ADMIN_IDLE_SEC = 300;
export const ADMIN_ABSOLUTE_MINUTES = 240;
export const ADMIN_REAUTH_MINUTES = 5;
export const ADMIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOCK_MINUTES = 15;
export const ADMIN_DEVICE_FAIL_LIMIT = 10;
export const ADMIN_GLOBAL_FAIL_LIMIT = 30;
/** 段階的ロック延長の上限（分） */
export const MAX_LOCK_MINUTES = 24 * 60;
/** 本人未確認（PIN 未設定）のセッションに残す権限 */
export const UNVERIFIED_PERMISSIONS: PermissionKey[] = ['punch_self', 'shift_view_published'];

/** 連続ロック回数に応じたロック時間（基本時間 × 2^回数、上限 24 時間） */
export function lockMinutesFor(base: number, lockCount: number): number {
  return Math.min(MAX_LOCK_MINUTES, base * 2 ** Math.min(lockCount, 10));
}

/** 固定ウィンドウの失敗回数（失敗のたびに期限を延長しない） */
export function windowCount(p: Platform, key: string): number {
  const v = p.cache.get(key);
  if (!v) return 0;
  try {
    const o = JSON.parse(v) as { n: number; until: number };
    return o.until > p.now() ? o.n : 0;
  } catch {
    return 0;
  }
}

export function windowBump(p: Platform, key: string, windowSec: number) {
  const v = p.cache.get(key);
  let o = { n: 0, until: p.now() + windowSec * 1000 };
  try {
    if (v) {
      const prev = JSON.parse(v) as { n: number; until: number };
      if (prev.until > p.now()) o = prev;
    }
  } catch {
    /* 破損時は新しいウィンドウ */
  }
  o.n += 1;
  p.cache.put(key, JSON.stringify(o), Math.max(1, Math.ceil((o.until - p.now()) / 1000)));
}

export function ensureSecrets(p: Platform) {
  if (!p.secrets.get(SECRET_KEYS.pepper)) p.secrets.set(SECRET_KEYS.pepper, p.randomHex(32));
}

function pepper(p: Platform): Uint8Array {
  const v = p.secrets.get(SECRET_KEYS.pepper);
  if (!v) throw E.notInitialized();
  return fromHex(v);
}

export function tokenHash(p: Platform, raw: string): string {
  return p.sha256Hex(`shiftly-token-v1:${raw}`);
}

export function newToken(p: Platform): string {
  return p.randomHex(32);
}

// ------------------------------------------------------------------ credentials
export function setCredential(ctx: Ctx, employeeId: string, kind: 'pin' | 'stepup', secret: string, mustChange: boolean) {
  const salt = ctx.p.randomHex(16);
  const iterations = kind === 'pin' ? PIN_ITERATIONS : STEPUP_ITERATIONS;
  const hash = hashSecret(ctx.p.hmacSha256, pepper(ctx.p), secret, salt, iterations);
  const existing = ctx.uow.list<Credential>('credentials').find((c) => c.employeeId === employeeId && c.kind === kind);
  if (existing) {
    ctx.uow.update('credentials', { ...existing, hash, salt, iterations, algo: PIN_ALGO, failedCount: 0, lockedUntil: null, mustChange });
  } else {
    ctx.uow.insert<Credential>('credentials', { employeeId, kind, hash, salt, iterations, algo: PIN_ALGO, failedCount: 0, lockedUntil: null, mustChange, lockCount: 0 }, 'crd');
  }
}

/** PIN の解除（v1.3: PIN 任意化）。資格情報の行を無効化する（行は残さず削除扱い: ハッシュを空にする） */
export function hasPin(ctx: Ctx, employeeId: string): boolean {
  return ctx.uow.list<Credential>('credentials').some((c) => c.employeeId === employeeId && c.kind === 'pin' && c.hash !== '');
}

export function clearPin(ctx: Ctx, employeeId: string): boolean {
  const cred = ctx.uow.list<Credential>('credentials').find((c) => c.employeeId === employeeId && c.kind === 'pin' && c.hash !== '');
  if (!cred) return false;
  // Sheets の行削除は行わず、ハッシュ・ソルトを空にして「未設定」とする（ロック状態もリセット）
  ctx.uow.update('credentials', { ...cred, hash: '', salt: '', failedCount: 0, lockedUntil: null, lockCount: 0, mustChange: false });
  return true;
}

/** 検証（失敗回数・ロックを更新）。ロック中は検証自体を行わない */
export function verifyCredential(ctx: Ctx, employeeId: string, kind: 'pin' | 'stepup', secret: string): Credential {
  const s = settings(ctx);
  const cred = ctx.uow.list<Credential>('credentials').find((c) => c.employeeId === employeeId && c.kind === kind && c.hash !== '');
  if (!cred) throw E.invalid(kind === 'pin' ? 'PINが設定されていません' : '管理用パスコードが設定されていません');
  if (cred.lockedUntil && parseIso(cred.lockedUntil) > ctx.now) {
    throw E.locked('入力の失敗が続いたため一時的にロックされています。しばらくしてから再度お試しください');
  }
  const h = hashSecret(ctx.p.hmacSha256, pepper(ctx.p), secret, cred.salt, cred.iterations);
  if (!timingSafeEqualHex(h, cred.hash)) {
    const failed = cred.failedCount + 1;
    const lock = failed >= s.pinMaxAttempts;
    const lockCount = cred.lockCount || 0;
    // ロックのたびにロック時間を延長（短い PIN の総当たり対策。成功で回数をリセット）
    const minutes = lockMinutesFor(s.pinLockMinutes, lockCount);
    ctx.uow.update('credentials', {
      ...cred,
      failedCount: lock ? 0 : failed,
      lockedUntil: lock ? toIsoJst(ctx.now + minutes * 60_000) : cred.lockedUntil,
      lockCount: lock ? lockCount + 1 : lockCount,
    });
    audit(ctx, lock ? 'auth.lock' : 'auth.fail', 'employee', employeeId, lock ? `${kind} 連続失敗によりロック（${minutes}分、${lockCount + 1}回目）` : `${kind} 認証失敗`);
    ctx.uow.flush(); // 失敗回数は例外でロールバックさせない
    throw lock
      ? E.locked('入力の失敗が続いたため一時的にロックされました')
      : E.invalid(kind === 'pin' ? 'PINが正しくありません' : '管理用パスコードが正しくありません');
  }
  if (cred.failedCount > 0 || cred.lockedUntil || cred.lockCount) ctx.uow.update('credentials', { ...cred, failedCount: 0, lockedUntil: null, lockCount: 0 });
  return cred;
}

// ------------------------------------------------------------------ device
export function createEnrollment(ctx: Ctx, deviceName: string): { code: string; expiresAt: string } {
  // 10桁の英数字（紛らわしい文字を除外）。短時間・使い捨て
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = ctx.p.randomHex(20);
  let code = '';
  for (let i = 0; i < 10; i++) code += alphabet[parseInt(hex.slice(i * 4, i * 4 + 4), 16) % alphabet.length];
  const expiresAt = toIsoJst(ctx.now + ENROLLMENT_MINUTES * 60_000);
  ctx.uow.insert<DeviceEnrollment>('device_enrollments', { codeHash: tokenHash(ctx.p, code), deviceName, expiresAt, usedAt: null }, 'enr');
  audit(ctx, 'device.enrollment_create', 'device', null, '端末登録コードを発行');
  return { code, expiresAt };
}

export function enrollDevice(ctx: Ctx, code: string, userAgentHint: string): { deviceToken: string; deviceId: string; name: string } {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const h = tokenHash(ctx.p, normalized);
  // 端末未登録状態での総当たり対策: キャッシュで全体の失敗回数を制限
  // 登録コードは 32 文字種×10 桁（約 10^15 通り）のため、全体での上限は妨害耐性を優先して緩めに設定
  const failKey = 'enroll-fail';
  const fails = windowCount(ctx.p, failKey);
  if (fails >= 100) throw E.rateLimited('登録コードの入力失敗が多すぎます。時間をおいてから再度お試しください');
  const en = ctx.uow.list<DeviceEnrollment>('device_enrollments').find((e) => timingSafeEqualHex(e.codeHash, h));
  if (!en || en.usedAt || parseIso(en.expiresAt) < ctx.now) {
    windowBump(ctx.p, failKey, 900);
    throw E.invalid('登録コードが無効か、有効期限が切れています');
  }
  const raw = newToken(ctx.p);
  ctx.uow.update('device_enrollments', { ...en, usedAt: nowIso(ctx) });
  const dev = ctx.uow.insert<Device>(
    'devices',
    { name: en.deviceName, tokenHash: tokenHash(ctx.p, raw), status: 'active', registeredAt: nowIso(ctx), lastUsedAt: nowIso(ctx), revokedAt: null, userAgentHint: userAgentHint.slice(0, 120) },
    'dev',
  );
  audit(ctx, 'device.enroll', 'device', dev.id, '店舗端末を登録');
  return { deviceToken: raw, deviceId: dev.id, name: dev.name };
}

export function authenticateDevice(ctx: Ctx, rawToken: unknown): Device {
  if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/.test(rawToken)) throw E.deviceNotRegistered();
  const h = tokenHash(ctx.p, rawToken);
  const dev = ctx.uow.list<Device>('devices').find((d) => timingSafeEqualHex(d.tokenHash, h));
  if (!dev || dev.status !== 'active') throw E.deviceNotRegistered();
  return dev;
}

/** 最終利用日時（書き込み削減のため10分間隔で更新） */
export function touchDevice(ctx: Ctx, dev: Device) {
  if (!dev.lastUsedAt || ctx.now - parseIso(dev.lastUsedAt) > 10 * 60_000) ctx.uow.update('devices', { ...dev, lastUsedAt: nowIso(ctx) });
}

// ------------------------------------------------------------------ staff session
export function permissionsOf(ctx: Ctx, employeeId: string): PermissionKey[] {
  const row = ctx.uow.list<PermissionRow>('permissions').find((p) => p.employeeId === employeeId);
  return row ? sanitizePermissions(row.permissions) : [...DEFAULT_STAFF_PERMISSIONS];
}

/**
 * スタッフのログイン（v1.3: PIN 任意）
 * - PIN 設定済み: PIN 必須。空欄・未入力は認証失敗（本人未確認のログインへ切り替えない）
 * - PIN 未設定: 氏名選択のみでログインできるが「本人未確認」セッション（権限は打刻・公開シフト・本人未確認の申告のみ）
 *   PIN が送られた場合は取り違えを防ぐため拒否する（PIN 未設定と誤った PIN を混同しない）
 */
export function login(ctx: Ctx, dev: Device, employeeId: string, pin: string | null): { sessionToken: string; employee: Employee; permissions: PermissionKey[]; verified: boolean } {
  const devFailKey = `pin-fail:${dev.id}`;
  const devFails = windowCount(ctx.p, devFailKey);
  if (devFails >= DEVICE_FAIL_LIMIT) throw E.rateLimited('この端末でのPIN入力失敗が多すぎます。しばらくしてから再度お試しください');
  const emp = ctx.uow.get<Employee>('employees', employeeId);
  if (!emp || emp.status !== 'active') {
    windowBump(ctx.p, devFailKey, DEVICE_FAIL_WINDOW_SEC);
    throw E.invalid('スタッフが見つかりません');
  }
  const pinSet = hasPin(ctx, employeeId);
  if (pinSet) {
    if (pin === null || pin === '') {
      // PIN なし・空欄では認証しない（本人未確認のログインに切り替えない）。
      // 画面は氏名の選択時に PIN なしで試し、この応答で PIN 入力に進む。PIN を照合していないため失敗回数には数えない
      throw new ApiError('PIN_REQUIRED', 'PINを入力してください', 401);
    }
    try {
      verifyCredential(ctx, employeeId, 'pin', pin);
    } catch (e) {
      windowBump(ctx.p, devFailKey, DEVICE_FAIL_WINDOW_SEC);
      throw e;
    }
  } else if (pin !== null && pin !== '') {
    throw new ApiError('PIN_NOT_SET', 'このスタッフはPINが設定されていません。名前を選んでそのままログインしてください', 409);
  }
  const verified = pinSet;
  const raw = newToken(ctx.p);
  const s = settings(ctx);
  const sess = ctx.uow.insert<SessionRow>(
    'sessions',
    { tokenHash: tokenHash(ctx.p, raw), deviceId: dev.id, employeeId, expiresAt: toIsoJst(ctx.now + SESSION_ABSOLUTE_MINUTES * 60_000), lastActivityAt: nowIso(ctx), stepUpUntil: null, revokedAt: null, verified },
    'ses',
  );
  ctx.p.cache.put(`sess-act:${sess.id}`, String(ctx.now), s.idleTimeoutSec + 30);
  touchDevice(ctx, dev);
  audit(ctx, 'auth.login', 'employee', employeeId, verified ? 'スタッフログイン（PIN）' : 'スタッフログイン（PIN未設定・本人未確認）');
  return { sessionToken: raw, employee: emp, permissions: effectivePermissions(ctx, employeeId, verified), verified };
}

/** セッションで有効な権限（本人未確認のセッションは打刻・公開シフトのみ） */
export function effectivePermissions(ctx: Ctx, employeeId: string, verified: boolean): PermissionKey[] {
  const all = permissionsOf(ctx, employeeId);
  return verified ? all : all.filter((p) => UNVERIFIED_PERMISSIONS.includes(p));
}

/** セッション検証。権限は毎回 DB から読み直す（権限変更は次の操作から反映） */
export function authenticateSession(ctx: Ctx, dev: Device, rawToken: unknown): { session: SessionRow; employee: Employee; permissions: PermissionKey[]; stepUp: boolean; verified: boolean } {
  if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/.test(rawToken)) throw E.unauthenticated();
  const h = tokenHash(ctx.p, rawToken);
  const sess = ctx.uow.list<SessionRow>('sessions', { partitions: ctx.uow.recentPartitions() }).find((x) => timingSafeEqualHex(x.tokenHash, h));
  if (!sess || sess.revokedAt || sess.deviceId !== dev.id || parseIso(sess.expiresAt) < ctx.now) throw E.unauthenticated();
  const s = settings(ctx);
  const last = ctx.p.cache.get(`sess-act:${sess.id}`);
  // キャッシュ消失時は安全側（失効）に倒す
  if (!last || ctx.now - Number(last) > (s.idleTimeoutSec + 30) * 1000) throw E.unauthenticated();
  const emp = ctx.uow.get<Employee>('employees', sess.employeeId);
  if (!emp || emp.status !== 'active') throw E.unauthenticated();
  ctx.p.cache.put(`sess-act:${sess.id}`, String(ctx.now), s.idleTimeoutSec + 30);
  // 本人確認の有無はセッション発行時の記録。発行後に PIN が解除されても権限は広がらない。
  // 発行後に PIN が設定された場合も、本人未確認のセッションは本人未確認のまま（再ログインが必要）
  const verified = sess.verified === true && hasPin(ctx, emp.id);
  const stepUp = verified && !!sess.stepUpUntil && parseIso(sess.stepUpUntil) > ctx.now;
  return { session: sess, employee: emp, permissions: effectivePermissions(ctx, emp.id, verified), stepUp, verified };
}

export function logout(ctx: Ctx, sessionId: string) {
  const sess = ctx.uow.get<SessionRow>('sessions', sessionId, { partitions: ctx.uow.recentPartitions() });
  if (sess && !sess.revokedAt) ctx.uow.update('sessions', { ...sess, revokedAt: nowIso(ctx) });
  ctx.p.cache.remove(`sess-act:${sessionId}`);
}

export function revokeSessionsWhere(ctx: Ctx, pred: (s: SessionRow) => boolean) {
  for (const s of ctx.uow.list<SessionRow>('sessions', { partitions: ctx.uow.recentPartitions() })) {
    if (!s.revokedAt && parseIso(s.expiresAt) > ctx.now && pred(s)) {
      ctx.uow.update('sessions', { ...s, revokedAt: nowIso(ctx) });
      ctx.p.cache.remove(`sess-act:${s.id}`);
    }
  }
}

export function stepUp(ctx: Ctx, sessionId: string, employeeId: string, secret: string) {
  verifyCredential(ctx, employeeId, 'stepup', secret);
  const sess = ctx.uow.get<SessionRow>('sessions', sessionId, { partitions: ctx.uow.recentPartitions() });
  if (!sess) throw E.unauthenticated();
  ctx.uow.update('sessions', { ...sess, stepUpUntil: toIsoJst(ctx.now + STEPUP_MINUTES * 60_000) });
  audit(ctx, 'auth.stepup', 'employee', employeeId, '追加認証');
}

// ------------------------------------------------------------------ 管理者パスワード（v1.3）
export function adminCredential(ctx: Ctx): AdminCredential | null {
  return ctx.uow.list<AdminCredential>('admin_credentials').find((c) => c.hash !== '') ?? null;
}

/** 管理者パスワードの設定・変更（呼び出し側で経路の認可を行うこと）。全管理者セッションを失効 */
export function setAdminPassword(ctx: Ctx, password: string, setBy: 'owner' | 'admin') {
  const salt = ctx.p.randomHex(16);
  const hash = hashSecret(ctx.p.hmacSha256, pepper(ctx.p), password, salt, ADMIN_ITERATIONS);
  const rows = ctx.uow.list<AdminCredential>('admin_credentials');
  const data = { hash, salt, iterations: ADMIN_ITERATIONS, algo: PIN_ALGO, failedCount: 0, lockedUntil: null, lockCount: 0, setBy, passwordChangedAt: nowIso(ctx) };
  if (rows[0]) ctx.uow.update('admin_credentials', { ...rows[0], ...data });
  else ctx.uow.insert<AdminCredential>('admin_credentials', data, 'adc');
  // 余分な行があれば無効化（1 店舗 1 件）
  for (const r of rows.slice(1)) if (r.hash !== '') ctx.uow.update('admin_credentials', { ...r, hash: '', salt: '' });
  revokeAdminSessions(ctx, () => true, 'password_changed');
}

/** 管理者パスワードの検証（失敗回数・段階的ロック・端末/全体の試行制限） */
export function verifyAdminPassword(ctx: Ctx, password: string, deviceId: string | null): AdminCredential {
  const devKey = deviceId ? `admin-fail:${deviceId}` : null;
  const globalKey = 'admin-fail:all';
  if ((devKey && windowCount(ctx.p, devKey) >= ADMIN_DEVICE_FAIL_LIMIT) || windowCount(ctx.p, globalKey) >= ADMIN_GLOBAL_FAIL_LIMIT)
    throw E.rateLimited('管理者パスワードの入力失敗が多すぎます。しばらくしてから再度お試しください');
  const cred = adminCredential(ctx);
  // 未設定時は認証を省略しない（常に失敗）
  if (!cred) throw new ApiError('ADMIN_PASSWORD_NOT_SET', '管理者パスワードが設定されていません。Google 所有者の管理画面（Shiftly-Admin）で設定してください', 409);
  if (cred.lockedUntil && parseIso(cred.lockedUntil) > ctx.now) throw E.locked('管理者パスワードの入力失敗が続いたため一時的にロックされています。しばらくしてから再度お試しください');
  const h = hashSecret(ctx.p.hmacSha256, pepper(ctx.p), password, cred.salt, cred.iterations);
  if (!timingSafeEqualHex(h, cred.hash)) {
    const failed = cred.failedCount + 1;
    const lock = failed >= ADMIN_MAX_ATTEMPTS;
    const minutes = lockMinutesFor(ADMIN_LOCK_MINUTES, cred.lockCount || 0);
    ctx.uow.update('admin_credentials', { ...cred, failedCount: lock ? 0 : failed, lockedUntil: lock ? toIsoJst(ctx.now + minutes * 60_000) : cred.lockedUntil, lockCount: lock ? (cred.lockCount || 0) + 1 : cred.lockCount || 0 });
    audit(ctx, lock ? 'admin_auth.lock' : 'admin_auth.fail', 'admin', null, lock ? `管理者パスワード連続失敗によりロック（${minutes}分）` : '管理者パスワード認証失敗');
    if (devKey) windowBump(ctx.p, devKey, 900);
    windowBump(ctx.p, globalKey, 3600);
    ctx.uow.flush(); // 失敗回数は例外でロールバックさせない
    throw lock ? E.locked('入力の失敗が続いたため一時的にロックされました') : E.invalid('管理者パスワードが正しくありません');
  }
  if (cred.failedCount > 0 || cred.lockedUntil || cred.lockCount) ctx.uow.update('admin_credentials', { ...cred, failedCount: 0, lockedUntil: null, lockCount: 0 });
  return cred;
}

export function adminLogin(ctx: Ctx, dev: Device, password: string): { adminSessionToken: string; expiresAt: string; idleTimeoutSec: number } {
  verifyAdminPassword(ctx, password, dev.id);
  const raw = newToken(ctx.p);
  const expiresAt = toIsoJst(ctx.now + ADMIN_ABSOLUTE_MINUTES * 60_000);
  const sess = ctx.uow.insert<AdminSessionRow>(
    'admin_sessions',
    // ログイン直後は再認証済み扱い（パスワードを入力した直後のため）
    { tokenHash: tokenHash(ctx.p, `admin:${raw}`), deviceId: dev.id, expiresAt, lastActivityAt: nowIso(ctx), reauthUntil: toIsoJst(ctx.now + ADMIN_REAUTH_MINUTES * 60_000), revokedAt: null, revokeReason: '' },
    'ads',
  );
  ctx.p.cache.put(`admin-act:${sess.id}`, String(ctx.now), ADMIN_IDLE_SEC + 15);
  touchDevice(ctx, dev);
  audit(ctx, 'admin_auth.login', 'admin', sess.id, '管理者ログイン（店舗端末）');
  return { adminSessionToken: raw, expiresAt, idleTimeoutSec: ADMIN_IDLE_SEC };
}

/** 管理者セッションの検証。端末の一致・失効・絶対期限・無操作 5 分を確認 */
export function authenticateAdminSession(ctx: Ctx, dev: Device, rawToken: unknown): { session: AdminSessionRow; reauth: boolean } {
  if (typeof rawToken !== 'string' || !/^[0-9a-f]{64}$/.test(rawToken)) throw new ApiError('ADMIN_UNAUTHENTICATED', '管理者モードが終了しました。もう一度パスワードを入力してください', 401);
  const h = tokenHash(ctx.p, `admin:${rawToken}`);
  const sess = ctx.uow.list<AdminSessionRow>('admin_sessions', { partitions: ctx.uow.recentPartitions() }).find((x) => timingSafeEqualHex(x.tokenHash, h));
  const fail = () => new ApiError('ADMIN_UNAUTHENTICATED', '管理者モードが終了しました。もう一度パスワードを入力してください', 401);
  if (!sess || sess.revokedAt || sess.deviceId !== dev.id || parseIso(sess.expiresAt) < ctx.now) throw fail();
  // パスワード変更・未設定化の後は既存セッションを使わせない
  const cred = adminCredential(ctx);
  if (!cred || parseIso(cred.passwordChangedAt) > parseIso(sess.createdAt)) throw fail();
  const last = ctx.p.cache.get(`admin-act:${sess.id}`);
  // キャッシュ消失時は安全側（失効）に倒す
  if (!last || ctx.now - Number(last) > ADMIN_IDLE_SEC * 1000) throw fail();
  ctx.p.cache.put(`admin-act:${sess.id}`, String(ctx.now), ADMIN_IDLE_SEC + 15);
  const reauth = !!sess.reauthUntil && parseIso(sess.reauthUntil) > ctx.now;
  return { session: sess, reauth };
}

export function adminReauth(ctx: Ctx, sessionId: string, password: string, deviceId: string) {
  verifyAdminPassword(ctx, password, deviceId);
  const sess = ctx.uow.get<AdminSessionRow>('admin_sessions', sessionId, { partitions: ctx.uow.recentPartitions() });
  if (!sess) throw E.unauthenticated();
  ctx.uow.update('admin_sessions', { ...sess, reauthUntil: toIsoJst(ctx.now + ADMIN_REAUTH_MINUTES * 60_000) });
  audit(ctx, 'admin_auth.reauth', 'admin', sessionId, '管理者の再認証');
}

export function revokeAdminSessions(ctx: Ctx, pred: (s: AdminSessionRow) => boolean, reason: string) {
  for (const s of ctx.uow.list<AdminSessionRow>('admin_sessions', { partitions: ctx.uow.recentPartitions() })) {
    if (!s.revokedAt && parseIso(s.expiresAt) > ctx.now && pred(s)) {
      ctx.uow.update('admin_sessions', { ...s, revokedAt: nowIso(ctx), revokeReason: reason });
      ctx.p.cache.remove(`admin-act:${s.id}`);
    }
  }
}

// ------------------------------------------------------------------ owner (Admin → Core) 署名
export type EnvelopeRole = 'admin' | 'setup';

export interface OwnerEnvelope {
  v: 1;
  role: EnvelopeRole;
  ts: number;
  nonce: string;
  body: string; // JSON 文字列（ApiRequest）
  sig: string; // hex HMAC-SHA256(key(role), `${v}.${role}.${ts}.${nonce}.${body}`)
}

/**
 * Setup 用の鍵で実行できる操作（最小権限。構築の完了前の確認に使う読み取りだけ）。
 * v1.3 では Setup による既存環境の更新・ロールバックを提供しないため、更新の操作は含めない（D-027）
 */
export const SETUP_ALLOWED_OPS = new Set(['system.info', 'system.integrityCheck', 'backup.list', 'system.storageCheck']);

export function signOwnerEnvelope(p: Pick<Platform, 'now' | 'randomHex' | 'hmacSha256'>, key: Uint8Array, body: string, role: EnvelopeRole = 'admin'): OwnerEnvelope {
  const ts = p.now();
  const nonce = p.randomHex(16);
  const sig = toHex(p.hmacSha256(key, utf8(`1.${role}.${ts}.${nonce}.${body}`)));
  return { v: 1, role, ts, nonce, body, sig };
}

/** 署名・有効期限・リプレイを検証し、body と role を返す */
export function verifyOwnerEnvelope(p: Platform, env: unknown): string {
  return verifyEnvelope(p, env).body;
}

export function verifyEnvelope(p: Platform, env: unknown): { body: string; role: EnvelopeRole } {
  const e = env as Partial<OwnerEnvelope>;
  if (!e || e.v !== 1 || (e.role !== 'admin' && e.role !== 'setup')) throw E.unauthenticated();
  const keyHex = p.secrets.get(e.role === 'admin' ? SECRET_KEYS.adminHmac : SECRET_KEYS.setupHmac);
  if (!keyHex) throw E.unauthenticated();
  if (typeof e.ts !== 'number' || typeof e.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(e.nonce) || typeof e.body !== 'string' || typeof e.sig !== 'string') throw E.unauthenticated();
  if (Math.abs(p.now() - e.ts) > OWNER_SIG_WINDOW_MS) throw E.unauthenticated();
  const expect = toHex(p.hmacSha256(fromHex(keyHex), utf8(`1.${e.role}.${e.ts}.${e.nonce}.${e.body}`)));
  if (!timingSafeEqualHex(expect, e.sig)) throw E.unauthenticated();
  const nk = `nonce:${e.nonce}`;
  if (p.cache.get(nk)) throw E.unauthenticated();
  p.cache.put(nk, '1', Math.ceil((OWNER_SIG_WINDOW_MS * 2) / 1000));
  if (e.role === 'setup') {
    let op: string;
    try {
      op = String((JSON.parse(e.body) as { op?: unknown }).op ?? '');
    } catch {
      throw E.unauthenticated();
    }
    if (!SETUP_ALLOWED_OPS.has(op)) throw E.forbidden();
  }
  return { body: e.body, role: e.role };
}
