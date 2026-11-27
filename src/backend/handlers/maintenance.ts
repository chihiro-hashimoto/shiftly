/**
 * Google 所有者の保守作業（D-027 B案。F26 のデータの復元・F37 の環境の復旧を、アプリ内の自動処理ではなく所有者の手作業で行うための枠組み）
 *
 * v1.3 は「正常時は自動・異常時は手動」。アプリ内の自動復元・稼働中の DB の切替は提供せず、データの復元は Google 所有者が
 * 稼働中の DB（同じスプレッドシート）をバックアップの内容を見ながら手で直す。この手作業の前後を、次の 2 つの操作で囲む。
 *
 * - maintenance.begin: 業務の更新を全員（Google 所有者・定期処理を含む）について止め（記録は Script Properties）、
 *   その時点のバックアップと、DB の全行の内容の記録（ハッシュ。Google ドライブの 00_System）を作る。スクリプトロックの中で
 *   実行するため、開始の時点で実行中の更新系の処理はない
 * - maintenance.finish: 手作業の結果を開始時の記録と照合し、安全を確かめてから業務を再開する
 *   1) DB の構造（整合性の確認）
 *   2) 守る表（打刻原本・修正の履歴・申請・確定した給与・明細・スタッフ・認証・端末・監査ログなど）の開始時の行が、
 *      削除・変更されていないこと（追加は可。バックアップの後に記録された打刻・確定給与などを、手作業で消していないことの保護。R1）
 *   3) 内容に変更があれば、確定済みの給与がある期間をすべて停止する（既存の「復元後の給与の確認」で、全体の照合の後に解除。R2）
 *   4) 全スタッフ・管理者のセッションを失効し、画面の世代を新しく発行する（保守の前に開いた画面からの保存をすべて拒否する）
 *   問題があれば業務を再開しない（保守中のまま。所有者が直してから再実行する。自動では直さない）
 *
 * 個人情報を応答・ログに出さない（表の名前・件数・行の ID だけを返す）
 */
import { defineOps } from '../api';
import { audit, issueEpoch, MAINTENANCE_KEY, maintenanceState, metaValue, nowIso, payrollRestoreLocks, setMeta, setPayrollRestoreLocks, type Ctx, type MaintenanceState, type PayrollRestoreLock } from '../context';
import { ApiError, E } from '../errors';
import * as v from '../validate';
import { SCHEMA_VERSION, TABLES, type TableName } from '../schema';
import { revokeAdminSessions, revokeSessionsWhere } from '../auth';
import { integrityCheck } from './system';
import { runBackup } from './ops';
import { utf8, type Bytes } from '../../shared/crypto';
import type { PayrollResult, PaySlip } from '../../shared/types';

/**
 * 保守作業での各表の扱い（全表の指定を型で必須にする。表を追加したときに扱いを決め忘れない）
 * - protected: 開始時の行を削除・変更してはならない（追加は可）。起きた事実・履歴・確定した給与・認証と権限・端末
 * - input: 所有者が手で戻してよい業務の入力・設定（変更があれば確定済みの給与を停止して照合する）
 * - system: 照合しない内部の記録（セッションは終了時にすべて失効。冪等性・処理記録は保守中にも増える）
 * バックアップの履歴は守る（削除済みのバックアップを利用できる状態に戻さない。Codex 監査17 #2 と同じ保護）。保守中はバックアップを作らない
 * （開始時のバックアップは開始の記録の前に作る）
 */
type MaintenanceClass = 'protected' | 'input' | 'system';
export const MAINTENANCE_TABLES: Record<TableName, MaintenanceClass> = {
  store_settings: 'input',
  employees: 'protected',
  employment_history: 'input',
  credentials: 'protected',
  permissions: 'protected',
  devices: 'protected',
  device_enrollments: 'protected',
  sessions: 'system',
  wage_rules: 'input',
  salary_rules: 'input',
  attendance_events: 'protected',
  attendance_corrections: 'protected',
  manual_breaks: 'protected',
  shifts: 'input',
  shift_patterns: 'input',
  shift_history: 'protected',
  leave_grants: 'protected',
  leave_transactions: 'protected',
  transport_rules: 'input',
  allowances: 'input',
  deductions: 'input',
  payroll_adjustments: 'input',
  payroll_periods: 'protected',
  payroll_results: 'protected',
  pay_slips: 'protected',
  budgets: 'input',
  notifications: 'system',
  audit_logs: 'protected',
  backup_history: 'protected',
  system_metadata: 'system',
  request_idempotency: 'system',
  operation_journal: 'system',
  migration_history: 'system',
  exports: 'protected',
  admin_credentials: 'protected',
  admin_sessions: 'system',
  break_declarations: 'protected',
  overtime_requests: 'protected',
  overtime_request_history: 'protected',
};

/**
 * アプリ自身が保守中にも追記する守る表（保守の開始・バックアップ・読み取りの拒否の記録など）。
 * 行の追加は「内容の変更」と数えない（削除・変更は守る表として止める）
 */
const APP_APPENDED: ReadonlySet<TableName> = new Set<TableName>(['audit_logs']);

/** 保守の開始・終了で変えてはならない環境の記録（system_metadata のキー） */
const FIXED_META = ['envId', 'initializedAt'] as const;

interface Snapshot {
  v: 1;
  takenAt: string;
  /** 表 → 行の ID → 行の内容のハッシュ（system の表は含めない） */
  tables: Partial<Record<TableName, Record<string, string>>>;
  meta: { envId: string | null; initializedAt: string | null; payrollRestoreLocks: Record<string, PayrollRestoreLock> };
}

function rowHash(ctx: Ctx, row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  return ctx.p.sha256Hex(JSON.stringify(keys.map((k) => [k, row[k] ?? null]))).slice(0, 32);
}

function tableHashes(ctx: Ctx): Snapshot['tables'] {
  const out: Snapshot['tables'] = {};
  for (const def of TABLES) {
    if (MAINTENANCE_TABLES[def.name] === 'system') continue;
    const m: Record<string, string> = {};
    for (const r of ctx.uow.list<Record<string, unknown>>(def.name)) m[String(r.id)] = rowHash(ctx, r);
    out[def.name] = m;
  }
  return out;
}

function saveState(ctx: Ctx, s: MaintenanceState) {
  ctx.p.secrets.set(MAINTENANCE_KEY, JSON.stringify(s));
  const back = maintenanceState(ctx.p);
  if (!back || back === 'broken' || back.startedAt !== s.startedAt || back.snapshotFileId !== s.snapshotFileId || back.backupId !== s.backupId)
    throw new Error('保守作業の記録を保存できませんでした');
}

export interface MaintenanceDiff {
  /** 守る表で、開始時の行が削除・変更された（業務を再開しない） */
  violations: Array<{ table: TableName; deleted: string[]; modified: string[] }>;
  /** 内容が変わった表（追加・変更・削除。system の表を除く） */
  changedTables: TableName[];
  /** 変えてはならない環境の記録が変わった */
  metaIssues: string[];
}

export function compareWithSnapshot(ctx: Ctx, snap: Snapshot): MaintenanceDiff {
  const now = tableHashes(ctx);
  const violations: MaintenanceDiff['violations'] = [];
  const changedTables: TableName[] = [];
  for (const def of TABLES) {
    const cls = MAINTENANCE_TABLES[def.name];
    if (cls === 'system') continue;
    // 開始時の記録に表がない（記録が欠けている）場合は、照合できないため変更として扱い、守る表なら止める
    const before = snap.tables[def.name];
    const after = now[def.name] ?? {};
    if (!before) {
      changedTables.push(def.name);
      if (cls === 'protected') violations.push({ table: def.name, deleted: ['（開始時の記録がありません）'], modified: [] });
      continue;
    }
    const deleted: string[] = [];
    const modified: string[] = [];
    for (const [id, h] of Object.entries(before)) {
      if (!(id in after)) deleted.push(id);
      else if (after[id] !== h) modified.push(id);
    }
    const added = Object.keys(after).filter((id) => !(id in before));
    if (deleted.length || modified.length || (added.length && !APP_APPENDED.has(def.name))) changedTables.push(def.name);
    if (cls === 'protected' && (deleted.length || modified.length)) violations.push({ table: def.name, deleted, modified });
  }
  const metaIssues: string[] = [];
  for (const k of FIXED_META) if (metaValue(ctx, k) !== snap.meta[k]) metaIssues.push(`環境の記録（${k}）が保守の開始時と異なります`);
  return { violations, changedTables, metaIssues };
}

/** 記録は ASCII だけで書く（ID・ハッシュ・日時）。ASCII 以外を含む場合は壊れているとみなす */
function fromAscii(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) {
    const part = Array.from(b.subarray(i, i + 4096));
    if (part.some((c) => c > 0x7e || (c < 0x20 && c !== 0x0a))) throw new Error('not ascii');
    s += String.fromCharCode(...part);
  }
  return s;
}

function readSnapshot(ctx: Ctx, fileId: string): Snapshot {
  const bytes = ctx.p.files.readFile(fileId);
  if (!bytes) throw new ApiError('MAINTENANCE_CHECK_FAILED', '保守の開始時の記録（Google ドライブの 00_System の「Shiftly_maintenance_snapshot」）を読み込めないため、業務を再開できません（保守中のままです）。時間をおいて再実行してください', 409);
  try {
    const s = JSON.parse(fromAscii(bytes)) as Snapshot;
    if (s.v !== 1 || !s.tables || !s.meta) throw new Error('format');
    return s;
  } catch {
    throw new ApiError('MAINTENANCE_CHECK_FAILED', '保守の開始時の記録の内容を読み取れないため、業務を再開できません（保守中のままです）', 409);
  }
}

defineOps([
  {
    name: 'maintenance.begin',
    kind: 'system',
    // Google 所有者だけ（Shiftly-Staff のエディタの shiftlyMaintenanceBegin・Shiftly-Admin）。店舗 iPad の管理者モードでは実行できない
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      if (v.str(v.obj(raw ?? {}), 'confirmText', { max: 20 }) !== '保守を開始する') throw E.invalid('確認のため「保守を開始する」と入力してください');
      const cur = maintenanceState(ctx.p);
      if (cur && cur !== 'broken' && cur.snapshotFileId && cur.backupId) throw E.conflict(`保守作業はすでに開始しています（開始: ${cur.startedAt}）`);
      // 1) 最初に保守の記録を保存する（以後、全員の更新系が止まる。途中で失敗しても保守中のまま＝安全側）
      const state: MaintenanceState = { startedAt: nowIso(ctx), backupId: null, snapshotFileId: null };
      saveState(ctx, state);
      // 2) 開始時のバックアップ（Google ドライブの 05_Backup）。失敗したら保守中のまま止める（再実行できる）
      const b = runBackup(ctx, 'manual', '保守作業の開始時のバックアップ');
      if (b.status !== 'ok') {
        ctx.uow.flush();
        throw new ApiError('MAINTENANCE_BEGIN_FAILED', '保守作業の開始時のバックアップに失敗しました。業務の更新は止めたままです。Google ドライブの空き容量を確認し、もう一度実行してください', 409);
      }
      ctx.uow.flush();
      // 3) 開始時の DB の全行の内容の記録（終了時の照合に使う）
      const locks = payrollRestoreLocks(ctx);
      const snap: Snapshot = {
        v: 1,
        takenAt: state.startedAt,
        tables: tableHashes(ctx),
        meta: { envId: metaValue(ctx, 'envId'), initializedAt: metaValue(ctx, 'initializedAt'), payrollRestoreLocks: locks },
      };
      const f = ctx.p.files.createFile('00_System', `Shiftly_maintenance_snapshot_${state.startedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`, 'application/json', utf8(JSON.stringify(snap)));
      saveState(ctx, { ...state, backupId: b.id, snapshotFileId: f.fileId });
      audit(ctx, 'maintenance.begin', 'system', null, '保守作業の開始（業務の更新を停止）');
      return {
        startedAt: state.startedAt,
        backupId: b.id,
        note: '業務の更新（打刻・修正・申請・給与・定期処理を含む）を停止しました。店舗に紙のタイムカードへの切替を連絡してください。作業の後に maintenance.finish（shiftlyMaintenanceFinish）を実行するまで再開しません',
      };
    },
  },
  {
    name: 'maintenance.finish',
    kind: 'system',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      if (v.str(v.obj(raw ?? {}), 'confirmText', { max: 20 }) !== '保守を終了する') throw E.invalid('確認のため「保守を終了する」と入力してください');
      const st = maintenanceState(ctx.p);
      if (st === null) throw E.conflict('保守作業は開始されていません');
      if (st === 'broken' || !st.snapshotFileId || !st.backupId)
        throw new ApiError('MAINTENANCE_CHECK_FAILED', '保守作業の開始が完了していないため、業務を再開できません。shiftlyMaintenanceBegin をもう一度実行してから作業してください', 409);
      // 1) DB の構造
      const check = integrityCheck(ctx);
      const sv = Number(metaValue(ctx, 'schemaVersion') ?? '0');
      if (!check.ok || sv !== SCHEMA_VERSION)
        throw new ApiError('MAINTENANCE_CHECK_FAILED', `DB の整合性の確認で問題が見つかったため、業務を再開していません（保守中のままです）: ${check.issues.slice(0, 5).join(' / ')}`, 409);
      // 2) 開始時の記録との照合（守る表の行の削除・変更、環境の記録の変更があれば再開しない）
      const snap = readSnapshot(ctx, st.snapshotFileId);
      const diff = compareWithSnapshot(ctx, snap);
      if (diff.violations.length || diff.metaIssues.length) {
        const detail = [
          ...diff.metaIssues,
          ...diff.violations.map((x) => `${x.table}: 削除 ${x.deleted.length} 件・変更 ${x.modified.length} 件（例: ${[...x.deleted, ...x.modified].slice(0, 3).join(', ')}）`),
        ];
        throw new ApiError(
          'MAINTENANCE_CHECK_FAILED',
          `保守の開始時にあった記録（打刻原本・修正の履歴・申請・確定した給与・明細・スタッフ・認証・端末・監査ログなど）が削除・変更されているため、業務を再開していません（保守中のままです）。開始時のバックアップを見て元に戻してから、もう一度実行してください: ${detail.slice(0, 6).join(' / ')}`,
          409,
        );
      }
      // 3) 内容に変更があれば、確定済みの給与がある期間をすべて停止する（給与条件・勤怠の変更で確定時と結果が変わり得るため。
      //    「復元後の給与の確認」で計算結果の全体を照合し、差がない場合だけ解除できる。R2）。開始時の停止は必ず引き継ぐ
      let locks: Record<string, PayrollRestoreLock> = { ...snap.meta.payrollRestoreLocks };
      try {
        locks = { ...locks, ...payrollRestoreLocks(ctx) };
      } catch {
        /* 現在の記録が壊れている（手で編集された）: 保守の間に停止を追加する経路はないため、開始時の記録と、ここで加える停止を使う */
      }
      let locked = 0;
      if (diff.changedTables.length) {
        const lock: PayrollRestoreLock = { restoredAt: nowIso(ctx), backupId: st.backupId };
        const periods = new Set<string>();
        for (const r of ctx.uow.list<PayrollResult>('payroll_results')) if (r.status === 'confirmed' || r.status === 'issued' || r.status === 'superseded') periods.add(r.periodId);
        for (const sl of ctx.uow.list<PaySlip>('pay_slips')) periods.add(sl.periodId);
        for (const pid of periods) locks[pid] = lock;
        locked = periods.size;
      }
      setPayrollRestoreLocks(ctx, locks);
      // 4) 全セッションの失効（保守の前にログインしていた画面は使えない）。メンテナンスの表示も解除する
      revokeSessionsWhere(ctx, () => true);
      revokeAdminSessions(ctx, () => true, 'maintenance');
      setMeta(ctx, 'maintenance', 'off');
      audit(ctx, 'maintenance.finish', 'system', null, `保守作業の終了 変更のあった表=${diff.changedTables.length} 給与の確認の対象期間=${locked}`);
      ctx.uow.flush();
      // 5) 画面の世代を新しく発行してから、保守の記録を消す（ここで失敗しても保守中のまま。再実行で続きから終了できる）
      issueEpoch(ctx.p);
      ctx.p.secrets.delete(MAINTENANCE_KEY);
      return {
        resumed: true,
        changedTables: diff.changedTables,
        payrollPeriodsToReview: locked,
        note: '業務を再開しました。全スタッフ・管理者のセッションを失効し、保守の前に開いた画面からの保存はできなくなっています。' + (locked ? '確定済みの給与がある期間は「復元後の給与の確認」で照合してから、確定・訂正・明細の発行を再開してください' : ''),
      };
    },
  },
]);
