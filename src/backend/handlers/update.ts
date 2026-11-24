/**
 * アップデート・ロールバック（Core 側）・定期処理
 * F35 DB構造の自動更新 / F36 アプリアップデート / F37 ロールバック・環境復旧
 * GAS コードの差し替え・デプロイ更新は Shiftly Setup（Apps Script API）が行い、
 * Core はメンテナンス状態・更新前バックアップ・マイグレーション・整合性確認を担う。
 */
import { defineOps } from '../api';
import { audit, metaValue, setMeta, today, type Ctx } from '../context';
import { E } from '../errors';
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
    handler: (ctx) => {
      const check = integrityCheck(ctx);
      setMeta(ctx, 'appVersion', APP_VERSION);
      setMeta(ctx, 'pendingUpdate', '');
      setMeta(ctx, 'maintenance', 'off');
      audit(ctx, 'update.finish', 'system', null, `更新完了 ${APP_VERSION} 整合性=${check.ok}`);
      return { appVersion: APP_VERSION, integrity: check };
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
  const daily = runBackup(ctx, 'daily');
  const monthly = d.endsWith('-01') ? runBackup(ctx, 'monthly') : null;
  const created = scanNotifications(ctx);
  return { backup: daily.status, monthlyBackup: monthly?.status ?? null, notificationsCreated: created };
}
