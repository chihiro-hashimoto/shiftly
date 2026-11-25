/**
 * DB マイグレーション（F35）
 * - 原則は「列・テーブルの追加のみ」（後方互換）。読み取りはヘッダー不足を既定値で補う。
 * - destructive: true のマイグレーションは管理者の明示承認（approveDestructive）なしに実行しない。
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
export const MIGRATIONS: Migration[] = [
  {
    from: 1,
    to: 2,
    description:
      'v1.3: 列の追加（店舗設定 breakMode/payrollTimeBasis、PIN の連続ロック回数、セッションの本人確認、勤怠修正の確認状態）とテーブルの追加（admin_credentials, admin_sessions, break_declarations, overtime_requests, overtime_request_history）。既存の行・列は変更しない',
    destructive: false,
    // 列は末尾に追加され、読み取り時に不足分は既定値で補う。テーブルは最初の書き込み時に作成される。
    // 既存の行の値は変更しない（旧版のセッションは「本人確認なし」として扱われ、次回ログインで解消）
    up: () => {},
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
