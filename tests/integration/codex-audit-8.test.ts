/**
 * Codex 独立監査 8 回目（docs/reviews/codex-audit-8.md）の指摘に対する回帰テスト
 * （#3 は Setup の更新処理のため tests/integration/installer.test.ts にある。#2 は旧版 v1.2 の動作のため手順書で対応）
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

describe('Codex 監査8 #1: バックアップの復元で、確定済みの給与を消さない（同じ期間を再確定できない）', () => {
  it('時給 1,200 円・09:00〜14:00（5 時間）。確定直前のバックアップを、6,000 円で確定した後に復元 → 確定結果（リビジョン 1・6,000 円）が残り、再確定は拒否', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    h.setNow('2026-12-01', '06:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-12-01', '06:10');
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    const r1 = h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    expect(r1.confirmed).toHaveLength(1);
    expect(r1.confirmed[0].revision).toBe(1);
    expect(r1.confirmed[0].netPay).toBe(6000);
    h.setNow('2026-12-01', '06:20');
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    // 確定結果は残る
    const res = h.ownerOk<any>('payroll.results', { periodId: p.id });
    const rows = (Array.isArray(res) ? res : res.results).filter((r: any) => r.employeeId === a && (r.status === 'confirmed' || r.status === 'issued'));
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(1);
    expect(rows[0].totals.netPay).toBe(6000);
    // 同じ期間の再確定はできない（訂正の手続きが必要）
    h.setNow('2026-12-01', '06:30');
    expect(code(h.owner('payroll.confirm', { periodId: p.id, acknowledgements: acks }))).toBe('CONFLICT');
  });
});
