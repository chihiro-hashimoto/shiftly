/**
 * Codex 独立監査 9 回目（docs/reviews/codex-audit-9.md）の指摘に対する回帰テスト
 * （#3 は Setup の更新処理のため tests/integration/installer.test.ts にある。#2 は旧版 v1.2 の運用のため手順書で対応）
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

function scenario() {
  const h = new Harness();
  h.setupStore();
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
  h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
  const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
  h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
  h.setNow('2026-12-01', '06:00');
  // バックアップ時点の時給は 1,200 円
  const bk = h.ownerOk('backup.run', { kind: 'manual' });
  // バックアップの後に、対象日に適用される時給を 1,400 円に変更して確定（5 時間 × 1,400 円 = 7,000 円）
  h.setNow('2026-12-01', '06:10');
  h.ownerOk('payconf.upsertWageRule', { employeeId: a, kind: 'base', hourlyRate: 1400, effectiveFrom: '2026-11-01', priority: 1 });
  const c = h.ownerOk('payroll.compute', { periodId: p.id });
  const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
  const r1 = h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
  expect(r1.confirmed[0].netPay).toBe(7000);
  h.setNow('2026-12-01', '06:20');
  h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
  h.setNow('2026-12-01', '06:30');
  return { h, a, p, acks };
}

describe('Codex 監査9 #1: 復元で引き継いだ確定済みの給与は、給与条件の確認まで訂正・明細の発行をしない', () => {
  it('バックアップ後に 1,400 円で確定（7,000 円）→ 時給 1,200 円のバックアップを復元 → 訂正・明細の発行は停止し、確定結果は 7,000 円のまま', () => {
    const { h, a, p, acks } = scenario();
    const per = h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id);
    expect(per.restoreLock).toBeTruthy();
    // 訂正（復元後の 1,200 円で再計算すると 6,000 円になる）は停止
    const cr = h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks });
    expect(code(cr)).toBe('PAYROLL_BLOCKED');
    expect(code(h.owner('payslips.issue', { periodId: p.id }))).toBe('PAYROLL_BLOCKED');
    const res = h.ownerOk<any>('payroll.results', { periodId: p.id });
    const rows = (Array.isArray(res) ? res : res.results).filter((r: any) => r.employeeId === a && (r.status === 'confirmed' || r.status === 'issued'));
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(1);
    expect(rows[0].totals.netPay).toBe(7000);
  });

  it('管理者が確認内容を記録して「復元後の確認を完了」すると、停止を解除する（確認の文言・内容がなければ解除しない）', () => {
    const { h, p } = scenario();
    // 入力は C-10 で自由記述（note）から定型の確認項目に変更（監査ログに個人情報を残さないため）。アサーションは変更していない
    const checked = { checkedWageRules: true, checkedAllowances: true, checkedDeductions: true };
    expect(code(h.owner('payroll.releaseRestoreLock', { periodId: p.id, ...checked, confirmText: 'はい' }))).toBe('INVALID_INPUT');
    expect(code(h.owner('payroll.releaseRestoreLock', { periodId: p.id, ...checked, checkedDeductions: false, confirmText: '確認しました' }))).toBe('INVALID_INPUT');
    // C-17 で、確定時と現在の条件で総支給額が異なる場合（この例は 7,000 円と 6,000 円）は差額の確認も必須になったため、入力に追加（アサーションは変更していない）
    h.ownerOk('payroll.releaseRestoreLock', { periodId: p.id, ...checked, acknowledgedDifferences: true, confirmText: '確認しました' });
    expect(h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock).toBeNull();
    expect(code(h.owner('payslips.issue', { periodId: p.id }))).toBe('OK');
  });

  it('バックアップの後に確定・訂正・発行していない期間は、復元しても停止しない', () => {
    const h = new Harness();
    h.setupStore();
    h.addStaff('山田', '482913', { rate: 1200 });
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.setNow('2026-12-01', '06:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    expect(h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock).toBeNull();
  });
});
