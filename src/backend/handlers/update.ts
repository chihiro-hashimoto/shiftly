/**
 * Setup との接続のリセット・定期処理
 * v1.3 では、アプリの自動更新（F36）・更新に伴う DB の自動移行（F35 の更新部分）・自動ロールバック（F37）を提供しない（D-027 B案）。
 * それらの操作（system.prepareUpdate・system.migrate・system.finishUpdate・system.setMaintenance）は登録せず、api.ts の DEFERRED_OPS で拒否する。
 * 旧版の実装は git の履歴（コミット b8ab444 まで）に開発資産として残している
 */
import { defineOps } from '../api';
import { audit, today, type Ctx } from '../context';
import { runBackup, scanNotifications } from './ops';

defineOps([
  {
    name: 'system.resetSetupPairing',
    kind: 'system',
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
    kind: 'internal',
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
