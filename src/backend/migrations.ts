/**
 * DB マイグレーション（F35）
 * - 原則は「列・テーブルの追加のみ」（後方互換）。読み取りはヘッダー不足を既定値で補う。
 * - destructive: true のマイグレーションは店長の明示承認（approveDestructive）なしに実行しない。
 * - GAS コードのロールバックと DB 構造のロールバックは別。DB は「更新前バックアップからの復元」で戻す。
 */
import type { Ctx } from './context';

export interface Migration {
  from: number;
  to: number;
  description: string;
  destructive: boolean;
  up: (ctx: Ctx) => void;
}

/** スキーマ v1 が初版。以降の変更はここに追加する */
export const MIGRATIONS: Migration[] = [];

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
