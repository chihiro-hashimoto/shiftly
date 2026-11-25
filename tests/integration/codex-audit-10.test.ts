/**
 * Codex 独立監査 10 回目（docs/reviews/codex-audit-10.md。C-9 の対応の確認）の指摘に対する回帰テスト
 * （回帰 1 は Setup の更新処理のため tests/integration/installer.test.ts にある。C-9 #2 の残りは手順書で対応）
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

describe('Codex 監査10（C-9 #1 の残り）: 確定結果がバックアップと同じで、給与条件だけが異なる場合も、復元後の訂正を止める', () => {
  it('1,400 円で確定（7,000 円）→ 1,200 円が適用される状態でバックアップ → 1,400 円に戻す → 復元 → 訂正は停止（6,000 円のリビジョン 2 を作らない）', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    h.setNow('2026-12-01', '06:00');
    const rule = { employeeId: a, kind: 'base', effectiveFrom: '2026-11-01', priority: 1 };
    const w = h.ownerOk('payconf.upsertWageRule', { ...rule, hourlyRate: 1400 }).rule;
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    expect(h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks }).confirmed[0].netPay).toBe(7000);
    // 確定の後に時給を 1,200 円に変更してバックアップ（確定結果はバックアップにも含まれる）→ 1,400 円に戻す
    h.setNow('2026-12-01', '06:10');
    h.ownerOk('payconf.upsertWageRule', { ...rule, id: w.id, hourlyRate: 1200 });
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-12-01', '06:20');
    h.ownerOk('payconf.upsertWageRule', { ...rule, id: w.id, hourlyRate: 1400 });
    h.setNow('2026-12-01', '06:30');
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    h.setNow('2026-12-01', '06:40');
    expect(h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock).toBeTruthy();
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks }))).toBe('PAYROLL_BLOCKED');
    const res = h.ownerOk<any>('payroll.results', { periodId: p.id });
    const rows = (Array.isArray(res) ? res : res.results).filter((r: any) => r.employeeId === a && (r.status === 'confirmed' || r.status === 'issued'));
    expect(rows.map((r: any) => [r.revision, r.totals.netPay])).toEqual([[1, 7000]]);
  });
});

describe('Codex 監査10 回帰2: 復元後の確認の完了で、自由記述を監査ログに残さない', () => {
  it('確認内容に氏名・時給を書いて送っても、監査ログには定型の確認項目だけが記録される', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    h.setNow('2026-12-01', '06:00');
    // バックアップの後に確定（どちらの方式でも復元後に停止される条件）
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    const secret = '山田太郎さんの時給1,400円を確認';
    h.owner('payroll.releaseRestoreLock', { periodId: p.id, note: secret, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, confirmText: '確認しました' });
    const logs = h.ownerOk<any[]>('audit.list', { month: '2026-12' });
    expect(logs.some((l) => l.action === 'payroll.releaseRestoreLock')).toBe(true);
    expect(JSON.stringify(logs)).not.toContain('時給1,400円');
  });
});
