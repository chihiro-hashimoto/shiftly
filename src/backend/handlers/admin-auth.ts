/**
 * 管理者パスワード認証（v1.3）
 * F03 認証（拡張）/ F38 店舗 iPad の管理者モード
 *
 * - 1 台の店舗 iPad で「管理者ページ」から管理者パスワードで管理者モードに入る
 * - 管理者パスワードの初期設定・再設定は Google 所有者のみ（Shiftly-Admin 経由の署名付き要求）
 * - 管理者本人は現在のパスワードを入力して変更できる
 * - 管理者セッションはスタッフのセッションと完全に別（別テーブル・別トークン）。
 *   スタッフのセッションから管理者権限を得る経路はない
 */
import { defineOps } from '../api';
import { audit, nowIso, type Ctx } from '../context';
import { E } from '../errors';
import * as v from '../validate';
import type { AdminSessionRow, Device } from '../../shared/types';
import {
  ADMIN_ABSOLUTE_MINUTES,
  ADMIN_IDLE_SEC,
  adminCredential,
  adminLogin,
  adminReauth,
  revokeAdminSessions,
  setAdminPassword,
  verifyAdminPassword,
} from '../auth';
import { validateAdminPassword } from '../../shared/crypto';
import { parseIso } from '../../shared/time';

function adminPrincipal(ctx: Ctx) {
  if (ctx.principal.kind !== 'admin') throw E.unauthenticated();
  return ctx.principal;
}

defineOps([
  {
    // 店舗端末から管理者パスワードで管理者モードに入る（登録済み端末のみ）
    name: 'adminAuth.login',
    kind: 'auth',
    auth: 'device',
    mutating: true,
    secretResponse: true,
    handler: (ctx, raw) => {
      if (ctx.principal.kind !== 'device') throw E.deviceNotRegistered();
      const dev = ctx.uow.get<Device>('devices', ctx.principal.deviceId);
      if (!dev) throw E.deviceNotRegistered();
      const password = v.str(v.obj(raw), 'password', { max: 128, label: '管理者パスワード' });
      if (password === '') throw E.invalid('管理者パスワードを入力してください');
      return adminLogin(ctx, dev, password);
    },
  },
  {
    name: 'adminAuth.me',
    kind: 'read',
    auth: 'admin',
    mutating: false,
    handler: (ctx) => {
      const a = adminPrincipal(ctx);
      const sess = ctx.uow.get<AdminSessionRow>('admin_sessions', a.sessionId, { partitions: ctx.uow.recentPartitions() });
      return { mode: 'admin', reauth: a.reauth, expiresAt: sess?.expiresAt ?? null, idleTimeoutSec: ADMIN_IDLE_SEC };
    },
  },
  {
    // 管理者モードの終了（サーバー側でセッションを失効）
    name: 'adminAuth.logout',
    kind: 'auth',
    auth: 'admin',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx) => {
      const a = adminPrincipal(ctx);
      revokeAdminSessions(ctx, (s) => s.id === a.sessionId, 'logout');
      audit(ctx, 'admin_auth.logout', 'admin', a.sessionId, '管理者モード終了');
      return { ok: true };
    },
  },
  {
    // 重要操作（給与確定・権限変更・バックアップ復元等）の前の再認証（5分間有効）
    name: 'adminAuth.reauth',
    kind: 'auth',
    auth: 'admin',
    mutating: true,
    handler: (ctx, raw) => {
      const a = adminPrincipal(ctx);
      adminReauth(ctx, a.sessionId, v.str(v.obj(raw), 'password', { max: 128, label: '管理者パスワード' }), a.deviceId);
      return { ok: true, minutes: 5 };
    },
  },
  {
    // 管理者本人による変更（現在のパスワードが必要）。変更後は全管理者セッションを失効
    name: 'adminAuth.changePassword',
    kind: 'auth',
    auth: 'admin',
    mutating: true,
    handler: (ctx, raw) => {
      const a = adminPrincipal(ctx);
      const o = v.obj(raw);
      const current = v.str(o, 'currentPassword', { max: 128, label: '現在のパスワード' });
      const next = v.str(o, 'newPassword', { max: 128, label: '新しいパスワード' });
      const err = validateAdminPassword(next);
      if (err) throw E.invalid(err);
      if (current === next) throw E.invalid('新しいパスワードは現在のパスワードと異なるものにしてください');
      verifyAdminPassword(ctx, current, a.deviceId);
      setAdminPassword(ctx, next, 'admin');
      audit(ctx, 'admin_auth.change_password', 'admin', null, '管理者パスワード変更（管理者本人）');
      return { ok: true, loggedOut: true };
    },
  },
  // ------------------------------------------------------------ Google 所有者のみ
  {
    name: 'adminAuth.status',
    kind: 'read',
    auth: 'owner',
    adminAllowed: true,
    mutating: false,
    handler: (ctx) => {
      const c = adminCredential(ctx);
      const active = ctx.uow
        .list<AdminSessionRow>('admin_sessions', { partitions: ctx.uow.recentPartitions() })
        .filter((s) => !s.revokedAt && parseIso(s.expiresAt) > ctx.now).length;
      return {
        configured: !!c,
        setBy: c?.setBy ?? null,
        passwordChangedAt: c?.passwordChangedAt ?? null,
        locked: !!c?.lockedUntil && parseIso(c.lockedUntil) > ctx.now,
        lockedUntil: c?.lockedUntil ?? null,
        activeSessions: active,
        idleTimeoutSec: ADMIN_IDLE_SEC,
        absoluteMinutes: ADMIN_ABSOLUTE_MINUTES,
      };
    },
  },
  {
    // 初期設定・再設定（忘れた場合）。Google 所有者本人のみ（管理者パスワードの管理者からは不可）
    name: 'adminAuth.setPassword',
    kind: 'auth',
    auth: 'owner',
    mutating: true,
    handler: (ctx, raw) => {
      const pw = v.str(v.obj(raw), 'password', { max: 128, label: '管理者パスワード' });
      const err = validateAdminPassword(pw);
      if (err) throw E.invalid(err);
      const existed = !!adminCredential(ctx);
      setAdminPassword(ctx, pw, 'owner');
      audit(ctx, existed ? 'admin_auth.reset_password' : 'admin_auth.set_password', 'admin', null, existed ? '管理者パスワード再設定（Google 所有者）' : '管理者パスワード初期設定（Google 所有者）');
      return { ok: true, at: nowIso(ctx) };
    },
  },
  {
    name: 'adminAuth.unlock',
    kind: 'auth',
    auth: 'owner',
    mutating: true,
    handler: (ctx) => {
      const c = adminCredential(ctx);
      if (c) ctx.uow.update('admin_credentials', { ...c, failedCount: 0, lockedUntil: null, lockCount: 0 });
      audit(ctx, 'admin_auth.unlock', 'admin', null, '管理者パスワードのロック解除（Google 所有者）');
      return { ok: true };
    },
  },
  {
    // 全管理者セッションの強制終了（端末紛失・交代時など）
    name: 'adminAuth.revokeSessions',
    kind: 'auth',
    auth: 'owner',
    adminAllowed: true,
    mutating: true,
    handler: (ctx) => {
      revokeAdminSessions(ctx, () => true, 'revoked_by_owner');
      audit(ctx, 'admin_auth.revoke_sessions', 'admin', null, '全管理者セッションを失効');
      return { ok: true };
    },
  },
]);
