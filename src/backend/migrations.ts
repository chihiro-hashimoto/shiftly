/**
 * DB マイグレーション（F35）
 * - 原則は「列・テーブルの追加のみ」（後方互換）。読み取りはヘッダー不足を既定値で補う。
 * - destructive: true のマイグレーションは管理者の明示承認（approveDestructive）なしに実行しない。
 * - GAS コードのロールバックと DB 構造のロールバックは別。DB は「更新前バックアップからの復元」で戻す。
 */
import type { Ctx } from './context';
import { TABLES } from './schema';

export interface Migration {
  from: number;
  to: number;
  description: string;
  destructive: boolean;
  up: (ctx: Ctx) => void;
}

/** スキーマ v1 が初版。以降の変更はここに追加する */
export const MIGRATIONS: Migration[] = [
  {
    from: 1,
    to: 2,
    description:
      'v1.3: 列の追加（店舗設定 breakMode/payrollTimeBasis、PIN の連続ロック回数、セッションの本人確認、勤怠修正の確認状態）とテーブルの追加（admin_credentials, admin_sessions, break_declarations, overtime_requests, overtime_request_history）。既存の行・列は変更しない',
    destructive: false,
    // 既存シートの列幅（グリッド）とヘッダーを v2 に合わせる（Sheets では列幅を超える範囲を読み書きできないため）。
    // 既存の行の値は変更しない。読み取り時に不足列は既定値で補い、新しいテーブルは最初の書き込み時に作成される
    // （旧版のセッションは「本人確認なし」として扱われ、次回ログインで解消）
    up: (ctx) => {
      const a = ctx.uow.adapter;
      if (!a.ensureSchema) return;
      // v2 で列を追加したテーブルのみ（API 呼び出し回数を抑える）
      for (const def of TABLES.filter((t) => ['store_settings', 'credentials', 'sessions', 'attendance_corrections'].includes(t.name))) {
        if (def.partitionBy) for (const p of a.partitions(def)) a.ensureSchema(def, p);
        else a.ensureSchema(def, null);
      }
    },
  },
];

export function plan(fromVersion: number, toVersion: number): Migration[] {
  const out: Migration[] = [];
  let v = fromVersion;
  while (v < toVersion) {
    const m = MIGRATIONS.find((x) => x.from === v);
    if (!m) throw new Error(`スキーマ ${v} → ${v + 1} のマイグレーションが定義されていません`);
    out.push(m);
    v = m.to;
  }
  return out;
}
