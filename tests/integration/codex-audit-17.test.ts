/**
 * Codex 独立監査 17 回目（docs/reviews/codex-audit-17.md。全体のマージ可否の判定）の指摘に対する回帰テスト
 * （#3 は Setup の初回構築のため tests/integration/installer.test.ts にある）
 * #1・#2・監査18 #1 は、アプリ内の復元を v1.3 では提供しないため（D-027 B案）、「バックアップの内容に戻す」操作を保守作業の中の手作業として
 * 行う形に置き換えた（停止・照合・解除の確認内容は同じ。R2）
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

function monthlyScenario() {
  const h = new Harness();
  h.setupStore();
  const a = h.addStaff('佐藤', '582913', { payType: 'monthly' });
  const rule = { employeeId: a, effectiveFrom: '2025-01-01', monthlyScheduledMinutes: 160 * 60, scheduledWeekdays: [1, 2, 3, 4, 5], scheduledDailyMinutes: 480, confirmed: true };
  const sr = h.ownerOk('payconf.upsertSalaryRule', { ...rule, monthlySalary: 200000 });
  const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
  h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
  h.setNow('2026-12-01', '06:00');
  // 基本給 20 万円の状態でバックアップ → 24 万円に変更して確定
  const atBackup = h.env.adapter.snapshot();
  h.setNow('2026-12-01', '06:10');
  h.ownerOk('payconf.upsertSalaryRule', { ...rule, id: sr.id, monthlySalary: 240000 });
  const c = h.ownerOk('payroll.compute', { periodId: p.id });
  const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
  h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
  h.setNow('2026-12-01', '06:20');
  // 保守作業で、月給設定の表をバックアップの時点（20 万円）に戻す
  h.ownerOk('maintenance.begin', { confirmText: '保守を開始する' });
  h.env.adapter.sheets.set('salary_rules', atBackup['salary_rules']!.map((r) => [...r]));
  h.ownerOk('maintenance.finish', { confirmText: '保守を終了する' });
  h.setNow('2026-12-01', '06:30');
  return { h, a, p, acks, rule };
}

describe('Codex 監査17 #1: 保守作業の後の給与の確認で、月給制のスタッフの月給設定と、確定時との差額を確認しなければ解除しない', () => {
  it('基本給 24 万円で確定 → 保守作業で 20 万円の内容に戻す → 時給ルール・手当・控除の確認だけでは解除できず、比較に 24 万円と 20 万円の差が出る', () => {
    const { h, a, p, acks } = monthlyScenario();
    const confirmedGross = h.ownerOk<any>('payroll.results', { periodId: p.id });
    const rows = (Array.isArray(confirmedGross) ? confirmedGross : confirmedGross.results).filter((r: any) => r.employeeId === a && r.status === 'confirmed');
    expect(rows[0].totals.basePay).toBe(240000);
    const review = h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id });
    expect(review.hasMonthly).toBe(true);
    expect(review.differences).toBe(1);
    const row = review.rows.find((x: any) => x.employeeId === a);
    expect(row.confirmedGross - row.currentGross).toBe(40000);
    const base = { periodId: p.id, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, confirmText: '確認しました' };
    // 月給設定の確認がない → 解除しない
    expect(code(h.owner('payroll.releaseRestoreLock', base))).toBe('INVALID_INPUT');
    // 月給設定を確認しても、差額の確認がない → 解除しない
    expect(code(h.owner('payroll.releaseRestoreLock', { ...base, checkedSalaryRules: true }))).toBe('RESTORE_DIFFERENCES');
    // 停止は続いている（20 万円での訂正はできない）
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks }))).toBe('PAYROLL_BLOCKED');
  });

  it('月給を確定時の 24 万円に戻せば差はなくなり、月給設定を確認して解除できる（監査ログに金額・氏名を残さない）', () => {
    const { h, a, p, rule } = monthlyScenario();
    // 復元後の月給条件（20 万円）を、確定時の 24 万円に戻す
    const s0 = h.ownerOk<any>('payconf.get', { employeeId: a }).salaryRules[0];
    expect(s0.monthlySalary).toBe(200000);
    h.ownerOk('payconf.upsertSalaryRule', { ...rule, id: s0.id, monthlySalary: 240000 });
    const review = h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id });
    expect(review.differences).toBe(0);
    h.ownerOk('payroll.releaseRestoreLock', { periodId: p.id, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, checkedSalaryRules: true, confirmText: '確認しました' });
    const logs = h.ownerOk<any[]>('audit.list', { month: '2026-12' });
    const rel = logs.find((l) => l.action === 'payroll.releaseRestoreLock');
    expect(rel.detail ?? rel.summary ?? JSON.stringify(rel)).toContain('月給設定');
    expect(JSON.stringify(rel)).not.toContain('240000');
    expect(JSON.stringify(rel)).not.toContain('佐藤');
  });
});

describe('Codex 監査17 #2 の保護: 保守作業で、バックアップの履歴の状態を巻き戻さない', () => {
  it('日次バックアップ → それを含む手動バックアップ → 世代管理で日次が削除済み（pruned）→ 保守作業で履歴を手動バックアップの時点に戻すと再開しない', () => {
    const h = new Harness();
    h.setupStore();
    h.ownerOk('settings.update', { dailyBackupGenerations: 7 });
    h.setNow('2026-11-02', '03:00');
    const d1 = h.ownerOk('backup.run', { kind: 'daily' });
    h.setNow('2026-11-02', '10:00');
    h.ownerOk('backup.run', { kind: 'manual' });
    const atManual = h.env.adapter.snapshot();
    // その後 7 日分の日次バックアップで、世代数（7）を超えた d1 が削除済みになる
    for (let d = 3; d <= 9; d++) {
      h.setNow(`2026-11-0${d}`, '03:00');
      h.ownerOk('backup.run', { kind: 'daily' });
    }
    const st = () => h.ownerOk<any[]>('backup.list').find((b: any) => b.id === d1.id)?.status;
    expect(st()).toBe('pruned');
    h.setNow('2026-11-09', '10:00');
    h.ownerOk('maintenance.begin', { confirmText: '保守を開始する' });
    const now = h.env.adapter.snapshot();
    h.env.adapter.sheets.set('backup_history', atManual['backup_history']!.map((r) => [...r]));
    expect(code(h.owner('maintenance.finish', { confirmText: '保守を終了する' }))).toBe('MAINTENANCE_CHECK_FAILED');
    h.env.adapter.restore(now);
    h.ownerOk('maintenance.finish', { confirmText: '保守を終了する' });
    expect(st()).toBe('pruned');
  });
});

describe('Codex 監査18 #1: 保守作業の後の給与の確認の解除は、サーバーがその場で計算し直して差がない場合だけ（確認の値では差を承認できない）', () => {
  it('24 万円で確定 → 保守作業で 20 万円の内容に戻す → 月給設定の確認と差額の承認の値を送っても解除できず、訂正は停止したまま', () => {
    const { h, a, p, acks } = monthlyScenario();
    const all = { periodId: p.id, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, checkedSalaryRules: true, acknowledgedDifferences: true, confirmText: '確認しました' };
    expect(code(h.owner('payroll.releaseRestoreLock', all))).toBe('RESTORE_DIFFERENCES');
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks }))).toBe('PAYROLL_BLOCKED');
  });

  it('比較を見た後に別の画面で給与条件を変えても、解除の時点の再計算で差があれば解除できない', () => {
    const { h, a, p, rule } = monthlyScenario();
    // いったん確定時の 24 万円に戻す → 比較は差なし
    const s0 = h.ownerOk<any>('payconf.get', { employeeId: a }).salaryRules[0];
    h.ownerOk('payconf.upsertSalaryRule', { ...rule, id: s0.id, monthlySalary: 240000 });
    expect(h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id }).differences).toBe(0);
    // 比較を見た後に、別の画面で 20 万円に変更 → 古い比較のまま解除しようとしても拒否
    h.ownerOk('payconf.upsertSalaryRule', { ...rule, id: s0.id, monthlySalary: 200000 });
    const all = { periodId: p.id, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, checkedSalaryRules: true, confirmText: '確認しました' };
    expect(code(h.owner('payroll.releaseRestoreLock', all))).toBe('RESTORE_DIFFERENCES');
    expect(h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock).toBeTruthy();
  });
});
