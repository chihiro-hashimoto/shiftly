/**
 * アップデート・ロールバック（Core 側）・定期処理
 * F35 DB構造の自動更新 / F36 アプリアップデート / F37 ロールバック・環境復旧
 * GAS コードの差し替え・デプロイ更新は Shiftly Setup（Apps Script API）が行い、
 * Core はメンテナンス状態・更新前バックアップ・マイグレーション・整合性確認を担う。
 */
import { defineOps } from '../api';
import { audit, metaValue, setMeta, today, type Ctx } from '../context';
import { ApiError, E } from '../errors';
import * as v from '../validate';
import { SCHEMA_VERSION } from '../schema';
import { plan } from '../migrations';
import { runBackup, scanNotifications } from './ops';
import { integrityCheck } from './system';
import { APP_VERSION } from '../version';

defineOps([
  {
    name: 'system.prepareUpdate',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      const target = v.str(v.obj(raw), 'targetVersion', { max: 20, pattern: /^\d+\.\d+\.\d+$/, label: '更新先バージョン' });
      // 1) メンテナンス状態（スタッフの書き込みを停止）2) 更新前バックアップ
      setMeta(ctx, 'maintenance', 'on');
      // 複製の前に確定する（更新前バックアップに「メンテナンス中」を含める。旧版へ戻してから復元しても確認前に打刻が再開しない。Codex 監査7 #2）
      ctx.uow.flush();
      const b = runBackup(ctx, 'pre_update', `更新前 ${metaValue(ctx, 'appVersion') ?? '?'} → ${target}`);
      if (b.status !== 'ok') {
        setMeta(ctx, 'maintenance', 'off');
        throw E.conflict('更新前バックアップに失敗したため更新を中止しました');
      }
      setMeta(ctx, 'pendingUpdate', JSON.stringify({ target, backupId: b.id, at: ctx.uow.nowIso() }));
      audit(ctx, 'update.prepare', 'system', null, `更新準備 → ${target}`);
      return { backupId: b.id, maintenance: true };
    },
  },
  {
    name: 'system.migrate',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      const approveDestructive = v.bool(v.obj(raw), 'approveDestructive');
      const cur = Number(metaValue(ctx, 'schemaVersion') ?? '0');
      if (cur > SCHEMA_VERSION) throw E.conflict(`DB のスキーマ（${cur}）がアプリ（${SCHEMA_VERSION}）より新しいため実行できません`);
      const steps = plan(cur, SCHEMA_VERSION);
      const destructive = steps.filter((s) => s.destructive);
      if (destructive.length && !approveDestructive)
        return { applied: [], requiresApproval: destructive.map((s) => s.description) };
      for (const s of steps) {
        s.up(ctx);
        ctx.uow.insert('migration_history', { fromVersion: s.from, toVersion: s.to, status: 'ok', note: s.description } as never, 'mig');
        setMeta(ctx, 'schemaVersion', String(s.to));
      }
      audit(ctx, 'update.migrate', 'system', null, `スキーマ ${cur} → ${SCHEMA_VERSION}`);
      return { applied: steps.map((s) => s.description), requiresApproval: [] };
    },
  },
  {
    name: 'system.finishUpdate',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx, raw) => {
      const accept = v.bool(v.obj(raw ?? {}), 'acceptIntegrityIssues');
      // DB のスキーマとアプリの版が一致しない場合は、承認があっても完了しない（互換性のない組み合わせで打刻を再開しない）
      const sv = Number(metaValue(ctx, 'schemaVersion') ?? '0');
      if (sv !== SCHEMA_VERSION)
        throw new ApiError('UPDATE_INTEGRITY_FAILED', `DB のスキーマ（${sv}）とアプリ（${SCHEMA_VERSION}）が一致しないため、更新を完了できません（メンテナンスを継続します）`, 409);
      const check = integrityCheck(ctx);
      // 整合性に問題がある場合はメンテナンスを継続し、管理者が内容を確認して明示的に承認した場合のみ完了する
      if (!check.ok && !accept)
        throw new ApiError('UPDATE_INTEGRITY_FAILED', `整合性チェックで問題が見つかったため、更新を完了していません（メンテナンスを継続します）: ${check.issues.slice(0, 5).join(' / ')}`, 409);
      setMeta(ctx, 'appVersion', APP_VERSION);
      setMeta(ctx, 'pendingUpdate', '');
      setMeta(ctx, 'maintenance', 'off');
      audit(ctx, 'update.finish', 'system', null, `更新完了 ${APP_VERSION} 整合性=${check.ok}${!check.ok ? '（管理者が問題を確認して完了）' : ''}`);
      return { appVersion: APP_VERSION, integrity: check };
    },
  },
  {
    name: 'system.resetSetupPairing',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: true,
    handler: (ctx) => {
      // Shiftly Setup の更新用接続（鍵）を無効化し、再ペアリングを可能にする（管理者専用）
      ctx.p.secrets.delete('SHIFTLY_SETUP_HMAC_KEY');
      ctx.p.secrets.delete('SHIFTLY_SETUP_PAIRED');
      audit(ctx, 'update.reset_setup_pairing', 'system', null, '更新用接続のリセット');
      return { ok: true };
    },
  },
  {
    name: 'system.dailyJob',
    auth: 'owner',
    mutating: true,
    allowInMaintenance: false,
    handler: (ctx) => dailyJob(ctx),
  },
]);

/** 日次の定期処理（時間主導トリガーから system 権限で実行） */
export function dailyJob(ctx: Ctx) {
  const d = today(ctx);
  // 同日の日次・月次バックアップがあれば作らない（多重実行による容量消費の防止）
  const existing = ctx.uow.list<{ kind: string; status: string; createdAt: string }>('backup_history').filter((b) => b.status === 'ok' && b.createdAt.slice(0, 10) === d);
  const daily = existing.some((b) => b.kind === 'daily') ? { status: 'skipped' } : runBackup(ctx, 'daily');
  const monthly = d.endsWith('-01') && !existing.some((b) => b.kind === 'monthly') ? runBackup(ctx, 'monthly') : null;
  const created = scanNotifications(ctx);
  return { backup: daily.status, monthlyBackup: monthly?.status ?? null, notificationsCreated: created };
}
