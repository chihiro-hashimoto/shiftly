/**
 * API ルーター
 *
 * - すべての公開操作は明示的に登録された op のみ（汎用のファイルID/シート名指定APIは提供しない）
 * - 認証種別: public / device / session / owner / staff_or_owner / admin
 *   v1.3: 管理者パスワードで認証した管理者（principal=admin）は staff_or_owner と、adminAllowed を指定した owner の操作を実行できる。
 *   Google 所有者に限定する操作（構築・更新・管理者パスワードの初期設定/再設定等）は adminAllowed を付けない。
 *   PIN 未設定（本人未確認）のスタッフは allowUnverified を指定した操作のみ実行できる。
 * - 権限はサーバー側で毎回検証。機密操作はスタッフの場合ステップアップ必須
 * - 更新系はスクリプトロック内で実行し、requestId による冪等性を保証
 */
import type { Platform } from './platform';
import { UnitOfWork, ConflictError, type TableAdapter } from './store';
import { ApiError, E } from './errors';
import { audit, currentEpoch, type Ctx, type Principal } from './context';
import { EPOCH_EXEMPT } from './epoch-exemptions';
import { authenticateAdminSession, authenticateDevice, authenticateSession, touchDevice } from './auth';
import type { PermissionKey, RequestIdempotency } from '../shared/types';
import { prevMonthKey, toLocalDate } from '../shared/time';

export type AuthKind = 'public' | 'device' | 'session' | 'owner' | 'staff_or_owner' | 'admin';

/**
 * 操作の分類（D-026。必須。新しい操作は分類を決めないと型検査で失敗する）
 * - read: 読み取り（データを変えない）
 * - edit: 画面上のデータに基づく業務更新。共通の入口で、画面がデータを取得した時点の復元世代（epoch）を照合する。
 *         世代が古い・ない場合は拒否する（復元前に開いた画面からの保存を通さない。R1）
 * - punch: サーバー時刻に基づく打刻（画面のデータで既存のデータを書き換えない）
 * - auth: 認証・端末登録・セッション・資格情報の管理（新しい値を設定する操作で、画面の古いデータを書き戻さない）
 * - system: 復元・バックアップ・初期化・更新・メンテナンス（Google 所有者・Setup の操作。それぞれの処理で状態を確認する）
 * - output: 出力（現在のデータを読み出してファイルを作る。出力の履歴だけを追記する）
 * - internal: 定期実行・内部処理（現在のデータから通知などを作る）
 */
export type OpKind = 'read' | 'edit' | 'punch' | 'auth' | 'system' | 'output' | 'internal';

export interface OpDef {
  name: string;
  /** 操作の分類（D-026） */
  kind: OpKind;
  /**
   * edit 以外の更新系の操作のうち、引数によっては画面上のデータに基づく更新を含む場合に true を返す。true の要求は edit と同じく
   * 世代を照合する（例: 退勤の打刻に付けた休憩の申告。D-026 の独立した点検 #7）
   */
  editWhen?: (args: unknown) => boolean;
  auth: AuthKind;
  /** staff_or_owner / session で要求する権限（いずれか） */
  perms?: PermissionKey[];
  mutating: boolean;
  /** スタッフが実行する場合に追加認証を要求（perms に機密権限があれば自動で true） */
  sensitive?: boolean;
  /** メンテナンス中も許可 */
  allowInMaintenance?: boolean;
  /** 応答に秘密値（端末トークン・セッショントークン）を含む: 冪等性テーブル・ジャーナルに応答を保存しない */
  secretResponse?: boolean;
  /** auth='owner' の操作を、管理者パスワードで認証した管理者にも許可する（既定は Google 所有者のみ） */
  adminAllowed?: boolean;
  /** 管理者パスワードの管理者が実行する場合、直近 5 分以内の再認証を要求する（重要操作） */
  reauth?: boolean;
  /** PIN 未設定（本人未確認）のスタッフにも許可する（既定は不可） */
  allowUnverified?: boolean;
  handler: (ctx: Ctx, args: unknown) => unknown;
}

export interface ApiRequest {
  op: string;
  args?: unknown;
  requestId?: string;
  device?: string;
  session?: string;
  /** 管理者セッション（v1.3。スタッフのセッションとは別のトークン） */
  adminSession?: string;
  /** 画面がデータを取得した時点の復元世代（D-026。kind: 'edit' の操作で必須） */
  epoch?: number;
}

/** epoch: 現在の復元世代（記録がない場合は null）。画面はアプリの読み込み後に最初に受け取った世代を固定して、以後の要求に付ける */
export type ApiResponse = { ok: true; data: unknown; epoch?: number | null } | { ok: false; error: { code: string; message: string }; epoch?: number | null };

const registry = new Map<string, OpDef>();

export function defineOps(defs: OpDef[]) {
  for (const d of defs) {
    if (registry.has(d.name)) throw new Error(`op 重複: ${d.name}`);
    // 分類と更新の有無の整合（読み取りはデータを変えない／読み取り以外は更新系としてロック内で実行する）
    if ((d.kind === 'read') === d.mutating) throw new Error(`op の分類と mutating が一致しません: ${d.name}`);
    // 世代の照合を適用しない更新系の操作は、理由の登録を必須にする（D-026。登録漏れ・理由のない除外を防ぐ）
    if (d.mutating && d.kind !== 'edit' && !EPOCH_EXEMPT[d.name]) throw new Error(`世代の照合を適用しない理由が登録されていません: ${d.name}`);
    if (d.kind === 'edit' && EPOCH_EXEMPT[d.name]) throw new Error(`画面からの業務更新は世代の照合から除外できません: ${d.name}`);
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
      // 認証・認可・設定で毎回使うテーブルを一括先読み（Sheets API の呼び出し回数を削減）
      uow.prefetch([
        { table: 'system_metadata' },
        { table: 'store_settings' },
        ...(r.device ? [{ table: 'devices' as const }, { table: 'employees' as const }, { table: 'permissions' as const }, { table: 'credentials' as const }, { table: 'sessions' as const, partitions: uow.recentPartitions() }] : []),
        ...(r.adminSession ? [{ table: 'admin_credentials' as const }, { table: 'admin_sessions' as const, partitions: uow.recentPartitions() }] : []),
        ...(def.mutating ? [{ table: 'operation_journal' as const, partitions: uow.recentPartitions() }, { table: 'request_idempotency' as const, partitions: uow.recentPartitions() }] : []),
        ...(r.op.startsWith('attendance.') || r.op.startsWith('auth.') ? [{ table: 'attendance_events' as const, partitions: uow.recentPartitions() }, { table: 'attendance_corrections' as const }, { table: 'manual_breaks' as const }, { table: 'shifts' as const }] : []),
      ]);
      if (def.mutating) {
        const rec = uow.recoverJournal();
        if (rec.replayed || rec.unrecoverable) p.log('warn', 'journal recovered', { replayed: rec.replayed, unrecoverable: rec.unrecoverable });
      }
      const ctx: Ctx = { p, uow, principal: { kind: 'anonymous' }, now, requestId: r.requestId ?? null, op: r.op };
      ctx.principal = resolvePrincipal(ctx, def, r, trusted);
      authorize(ctx, def);
      if (!def.allowInMaintenance && isMaintenance(ctx) && ctx.principal.kind !== 'owner' && ctx.principal.kind !== 'system') throw E.maintenance();
      // 画面からの業務更新は、画面がデータを取得した時点の復元世代を照合する（D-026。ロックの内側で照合し、復元と競合しない）。
      // 世代がない・古い要求は拒否する。世代の記録がない・壊れている場合も、古い要求を受け入れないよう更新を止める
      if (def.kind === 'edit' || (def.editWhen && def.editWhen(r.args))) {
        const cur = currentEpoch(p);
        if (cur === null) throw new ApiError('EPOCH_UNAVAILABLE', 'データの世代情報を確認できないため、更新を停止しています。Google 所有者が Shiftly-Staff のエディタで shiftlyAuthorize を実行してください', 409);
        if (typeof r.epoch !== 'number' || r.epoch !== cur)
          throw new ApiError('STALE_VIEW', '画面の情報が、データの復元より前に読み込んだものです。画面を読み込み直し、最新の内容を確認してから、もう一度操作してください', 409);
      }
      // 管理者モードでの更新操作は監査ログに記録（内容は記録しない。各操作の個別の監査ログに加えて記録）
      if (ctx.principal.kind === 'admin' && def.mutating) audit(ctx, 'admin.op', 'op', def.name, '管理者モードでの操作');

      // 冪等性: 同一 principal・同一 requestId の再送は保存済みの応答を返す
      const pkey = principalKey(ctx.principal);
      const month = toLocalDate(now).slice(0, 7);
      if (def.mutating && r.requestId) {
        const prev = uow
          .list<RequestIdempotency>('request_idempotency', { partitions: [prevMonthKey(month), month] })
          .find((x) => x.requestId === r.requestId);
        if (prev) {
          if (prev.principalKey !== pkey || prev.op !== r.op) throw E.conflict('requestId が別の操作で使用されています');
          if (def.secretResponse) throw E.conflict('この操作はすでに処理されています。最初からやり直してください');
          return { ...(JSON.parse(prev.responseJson) as object), replayed: true };
        }
      }
      const data = def.handler(ctx, r.args);
      if (def.mutating) {
        if (r.requestId) {
          const json = JSON.stringify(data ?? null);
          uow.insert<RequestIdempotency>('request_idempotency', { requestId: r.requestId, op: r.op, principalKey: pkey, responseJson: def.secretResponse ? '{"redacted":true}' : json.length < 30000 ? json : '{"stored":false}' }, 'idm');
        }
        uow.flush();
      } else if (uow.hasPending()) {
        if (!uow.onlyInserts()) throw new Error('参照系の操作で既存行の更新が行われました');
        // 参照系でも最終利用日時等の軽微な更新がある場合（書き込みは必ずロック内）
        p.withLock(5000, () => uow.flush());
      }
      return data;
    };

    // 更新系で端末認証が必要な操作は、ロック取得前に読み取りのみで認証する（未認証リクエストでロックを占有させない）
    if (def.mutating && !trusted && def.auth !== 'public') preAuthenticate(be, def, r);
    // 応答に付ける世代は、処理の前と後に読み、途中で変わった（処理の間に復元が切り替わった）場合は前の世代を返す。
    // 読み取りはロックの外で行うため、新しく開いた画面が「世代を進めた後・DB の切替の前」に旧 DB を読み、新しい世代を固定することを防ぐ
    // （前の世代を固定した画面は、次の応答で古い画面として検知される。D-026 の独立した点検 #2）
    const before = safeEpoch(p);
    const data = def.mutating ? p.withLock(15000, run) : run();
    const after = safeEpoch(p);
    return { ok: true, data, epoch: before === after ? after : before };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: { code: e.code, message: e.message }, epoch: safeEpoch(p) };
    if (e instanceof ConflictError) return { ok: false, error: { code: 'CONFLICT', message: e.message }, epoch: safeEpoch(p) };
    // 内部エラーの詳細（スタック・個人情報）は応答に含めない
    p.log('error', 'unhandled', { op: opName, err: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    return { ok: false, error: { code: 'INTERNAL', message: '処理中にエラーが発生しました。時間をおいて再度お試しください' } };
  }
}

/** 応答に付ける現在の復元世代（読み取れない場合は null） */
function safeEpoch(p: Platform): number | null {
  try {
    return currentEpoch(p);
  } catch {
    return null;
  }
}

function preAuthenticate(be: Backend, def: OpDef, r: ApiRequest) {
  const now = be.p.now();
  const uow = new UnitOfWork(be.adapter(), { now: () => now, newId: (prefix) => `${prefix}_${be.p.randomHex(10)}` });
  uow.prefetch([
    { table: 'system_metadata' },
    { table: 'store_settings' },
    { table: 'devices' },
    { table: 'employees' },
    { table: 'credentials' },
    { table: 'sessions', partitions: uow.recentPartitions() },
    ...(r.adminSession ? [{ table: 'admin_credentials' as const }, { table: 'admin_sessions' as const, partitions: uow.recentPartitions() }] : []),
  ]);
  const ctx: Ctx = { p: be.p, uow, principal: { kind: 'anonymous' }, now, requestId: null, op: def.name };
  if (def.auth === 'owner' && !def.adminAllowed) throw E.forbidden();
  const dev = authenticateDevice(ctx, r.device);
  if (adminApplies(def, r)) {
    authenticateAdminSession(ctx, dev, r.adminSession);
    return;
  }
  if (def.auth === 'owner' || def.auth === 'admin') throw E.forbidden();
  if (def.auth === 'session' || def.auth === 'staff_or_owner') authenticateSession(ctx, dev, r.session);
}

/** このリクエストを管理者セッションとして扱うか（管理者が実行できる操作に管理者トークンが付いている場合） */
function adminApplies(def: OpDef, r: ApiRequest): boolean {
  if (!r.adminSession) return def.auth === 'admin';
  return def.auth === 'admin' || def.auth === 'staff_or_owner' || (def.auth === 'owner' && !!def.adminAllowed);
}

function principalKey(pr: Principal): string {
  switch (pr.kind) {
    case 'staff':
      return `staff:${pr.employeeId}:${pr.deviceId}`;
    case 'device':
      return `device:${pr.deviceId}`;
    case 'admin':
      return `admin:${pr.sessionId}`;
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
  // Google 所有者に限定した操作は、管理者パスワードの管理者・スタッフからは実行できない
  if (def.auth === 'owner' && !def.adminAllowed) throw E.forbidden();
  const dev = authenticateDevice(ctx, r.device);
  if (def.mutating) touchDevice(ctx, dev); // 既存行の更新は更新系（ロック内）でのみ行う
  if (def.auth === 'device') {
    return { kind: 'device', deviceId: dev.id };
  }
  if (adminApplies(def, r)) {
    // ブラウザ側の「管理者モード」という申告は信用せず、サーバーで管理者セッションを毎回検証する
    const a = authenticateAdminSession(ctx, dev, r.adminSession);
    return { kind: 'admin', sessionId: a.session.id, deviceId: dev.id, reauth: a.reauth };
  }
  if (def.auth === 'owner' || def.auth === 'admin') throw E.forbidden();
  const s = authenticateSession(ctx, dev, r.session);
  return { kind: 'staff', employeeId: s.employee.id, sessionId: s.session.id, deviceId: dev.id, permissions: s.permissions, stepUp: s.stepUp, verified: s.verified };
}

function authorize(ctx: Ctx, def: OpDef) {
  const pr = ctx.principal;
  if (def.auth === 'public') return;
  if (pr.kind === 'owner' || pr.kind === 'system') {
    if (def.auth === 'session') throw E.forbidden('スタッフ専用の操作'); // 本人用操作は管理者に提供しない
    if (def.auth === 'admin') throw E.forbidden('管理者モード専用の操作');
    return;
  }
  if (pr.kind === 'admin') {
    if (def.auth === 'session') throw E.forbidden('スタッフ専用の操作');
    if (def.auth === 'owner' && !def.adminAllowed) throw E.forbidden('Google 所有者専用の操作');
    if (def.reauth && !pr.reauth) throw E.reauthRequired();
    return;
  }
  if (def.auth === 'owner' || def.auth === 'admin') throw E.forbidden();
  if (def.auth === 'device') return;
  if (pr.kind !== 'staff') throw E.unauthenticated();
  // 本人未確認（PIN 未設定）のセッションは、明示的に許可した操作のみ
  if (!pr.verified && !def.allowUnverified) throw E.identityRequired();
  if (def.perms && def.perms.length > 0 && !def.perms.some((x) => pr.permissions.includes(x))) {
    audit(ctx, 'authz.denied', 'op', def.name, '権限不足による拒否');
    ctx.p.withLock(5000, () => ctx.uow.flush());
    throw E.forbidden();
  }
  if (def.sensitive && !pr.stepUp) throw E.stepUpRequired();
}
