/**
 * API ルーター
 *
 * - すべての公開操作は明示的に登録された op のみ（汎用のファイルID/シート名指定APIは提供しない）
 * - 認証種別: public / device / session / owner / staff_or_owner
 * - 権限はサーバー側で毎回検証。機密操作はスタッフの場合ステップアップ必須
 * - 更新系はスクリプトロック内で実行し、requestId による冪等性を保証
 */
import type { Platform } from './platform';
import { UnitOfWork, ConflictError, type TableAdapter } from './store';
import { ApiError, E } from './errors';
import { audit, type Ctx, type Principal } from './context';
import { authenticateDevice, authenticateSession, touchDevice } from './auth';
import type { PermissionKey, RequestIdempotency } from '../shared/types';
import { toLocalDate } from '../shared/time';

export type AuthKind = 'public' | 'device' | 'session' | 'owner' | 'staff_or_owner';

export interface OpDef {
  name: string;
  auth: AuthKind;
  /** staff_or_owner / session で要求する権限（いずれか） */
  perms?: PermissionKey[];
  mutating: boolean;
  /** スタッフが実行する場合に追加認証を要求（perms に機密権限があれば自動で true） */
  sensitive?: boolean;
  /** メンテナンス中も許可 */
  allowInMaintenance?: boolean;
  handler: (ctx: Ctx, args: unknown) => unknown;
}

export interface ApiRequest {
  op: string;
  args?: unknown;
  requestId?: string;
  device?: string;
  session?: string;
}

export type ApiResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

const registry = new Map<string, OpDef>();

export function defineOps(defs: OpDef[]) {
  for (const d of defs) {
    if (registry.has(d.name)) throw new Error(`op 重複: ${d.name}`);
    registry.set(d.name, d);
  }
}

export function listOps(): OpDef[] {
  return [...registry.values()];
}

export interface Backend {
  p: Platform;
  adapter: () => TableAdapter;
}

/**
 * リクエスト処理
 * @param trusted Admin 署名検証済み（owner）や時間主導トリガー（system）の場合に指定。
 *                ブラウザからの入力で owner を指定することはできない。
 */
export function handleRequest(be: Backend, req: unknown, trusted: 'owner' | 'system' | null = null): ApiResponse {
  const p = be.p;
  let opName = 'unknown';
  try {
    if (!req || typeof req !== 'object') throw E.invalid('リクエスト形式が不正です');
    const r = req as ApiRequest;
    if (typeof r.op !== 'string' || r.op.length > 64) throw E.invalid('操作が不正です');
    opName = r.op;
    const def = registry.get(r.op);
    if (!def) throw new ApiError('UNKNOWN_OP', '不明な操作です', 404);
    if (r.requestId !== undefined && (typeof r.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(r.requestId))) throw E.invalid('requestId が不正です');

    const run = (): unknown => {
      const now = p.now();
      const uow = new UnitOfWork(be.adapter(), { now: () => now, newId: (prefix) => `${prefix}_${p.randomHex(10)}` });
      if (def.mutating) {
        const rec = uow.recoverJournal();
        if (rec.replayed || rec.unrecoverable) p.log('warn', 'journal recovered', { replayed: rec.replayed, unrecoverable: rec.unrecoverable });
      }
      const ctx: Ctx = { p, uow, principal: { kind: 'anonymous' }, now, requestId: r.requestId ?? null, op: r.op };
      ctx.principal = resolvePrincipal(ctx, def, r, trusted);
      authorize(ctx, def);
      if (!def.allowInMaintenance && isMaintenance(ctx) && ctx.principal.kind !== 'owner' && ctx.principal.kind !== 'system') throw E.maintenance();

      // 冪等性: 同一 principal・同一 requestId の再送は保存済みの応答を返す
      const pkey = principalKey(ctx.principal);
      const month = toLocalDate(now).slice(0, 7);
      const prevMonth = toLocalDate(now - 32 * 86400000).slice(0, 7);
      if (def.mutating && r.requestId) {
        const prev = uow
          .list<RequestIdempotency>('request_idempotency', { partitions: [prevMonth, month] })
          .find((x) => x.requestId === r.requestId);
        if (prev) {
          if (prev.principalKey !== pkey || prev.op !== r.op) throw E.conflict('requestId が別の操作で使用されています');
          return { ...(JSON.parse(prev.responseJson) as object), replayed: true };
        }
      }
      const data = def.handler(ctx, r.args);
      if (def.mutating) {
        if (r.requestId) {
          const json = JSON.stringify(data ?? null);
          uow.insert<RequestIdempotency>('request_idempotency', { requestId: r.requestId, op: r.op, principalKey: pkey, responseJson: json.length < 40000 ? json : '{"stored":false}' }, 'idm');
        }
        uow.flush();
      } else if (uow.hasPending()) {
        if (!uow.onlyInserts()) throw new Error('参照系の操作で既存行の更新が行われました');
        // 参照系でも最終利用日時等の軽微な更新がある場合（書き込みは必ずロック内）
        p.withLock(5000, () => uow.flush());
      }
      return data;
    };

    const data = def.mutating ? p.withLock(15000, run) : run();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message } };
    if (e instanceof ConflictError) return { ok: false, error: { code: 'CONFLICT', message: e.message } };
    // 内部エラーの詳細（スタック・個人情報）は応答に含めない
    p.log('error', 'unhandled', { op: opName, err: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    return { ok: false, error: { code: 'INTERNAL', message: '処理中にエラーが発生しました。時間をおいて再度お試しください' } };
  }
}

function principalKey(pr: Principal): string {
  switch (pr.kind) {
    case 'staff':
      return `staff:${pr.employeeId}:${pr.deviceId}`;
    case 'device':
      return `device:${pr.deviceId}`;
    default:
      return pr.kind;
  }
}

function isMaintenance(ctx: Ctx): boolean {
  try {
    return ctx.uow.list<{ key: string; value: string }>('system_metadata').some((m) => m.key === 'maintenance' && m.value === 'on');
  } catch {
    return false;
  }
}

function resolvePrincipal(ctx: Ctx, def: OpDef, r: ApiRequest, trusted: 'owner' | 'system' | null): Principal {
  if (trusted) return { kind: trusted };
  if (def.auth === 'public') {
    if (r.device) {
      try {
        const dev = authenticateDevice(ctx, r.device);
        return { kind: 'device', deviceId: dev.id };
      } catch {
        return { kind: 'anonymous' };
      }
    }
    return { kind: 'anonymous' };
  }
  if (def.auth === 'owner') throw E.forbidden();
  const dev = authenticateDevice(ctx, r.device);
  if (def.mutating) touchDevice(ctx, dev); // 既存行の更新は更新系（ロック内）でのみ行う
  if (def.auth === 'device') {
    return { kind: 'device', deviceId: dev.id };
  }
  const s = authenticateSession(ctx, dev, r.session);
  return { kind: 'staff', employeeId: s.employee.id, sessionId: s.session.id, deviceId: dev.id, permissions: s.permissions, stepUp: s.stepUp };
}

function authorize(ctx: Ctx, def: OpDef) {
  const pr = ctx.principal;
  if (def.auth === 'public') return;
  if (pr.kind === 'owner' || pr.kind === 'system') {
    if (def.auth === 'session') throw E.forbidden('スタッフ専用の操作'); // 本人用操作は店長に提供しない
    return;
  }
  if (def.auth === 'owner') throw E.forbidden();
  if (def.auth === 'device') return;
  if (pr.kind !== 'staff') throw E.unauthenticated();
  if (def.perms && def.perms.length > 0 && !def.perms.some((x) => pr.permissions.includes(x))) {
    audit(ctx, 'authz.denied', 'op', def.name, '権限不足による拒否');
    ctx.p.withLock(5000, () => ctx.uow.flush());
    throw E.forbidden();
  }
  if (def.sensitive && !pr.stepUp) throw E.stepUpRequired();
}
