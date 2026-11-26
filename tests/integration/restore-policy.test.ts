/**
 * 復元の表ごとの扱い（RESTORE_POLICY。D-025）と、復元後の給与の照合（計算結果の全項目）の網羅テスト。
 * Codex 監査19 の分析: 復元・照合の指摘が繰り返されたのは、表・項目を個別に足していたため。ここでは対象の全体（全表・全項目）を検証する。
 * 期待値は仕様（表の扱いの方針・計算結果の比較）から定めたもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { handleRequest } from '../../src/backend/index';
import { TABLES } from '../../src/backend/schema';
import { RESTORE_POLICY } from '../../src/backend/handlers/ops';
import { differingTotals } from '../../src/backend/handlers/payroll';
import { UnitOfWork } from '../../src/backend/store';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);
const uowOf = (h: Harness) => new UnitOfWork(h.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });

describe('復元の表ごとの扱い（RESTORE_POLICY）', () => {
  it('すべての表に扱いが明示されている（表を追加したときに決め忘れない）', () => {
    const names = TABLES.map((t) => t.name).sort();
    expect(Object.keys(RESTORE_POLICY).sort()).toEqual(names);
    for (const n of names) expect(RESTORE_POLICY[n as keyof typeof RESTORE_POLICY].why.length, n).toBeGreaterThan(0);
  });

  it('説明に「追記専用」とある表は、すべて append（巻き戻さずに再投入）', () => {
    for (const t of TABLES.filter((x) => x.description.includes('追記専用'))) expect(RESTORE_POLICY[t.name].policy, t.name).toBe('append');
  });

  it('認証・セッション・端末・給与の確定データ・申請と確認・バックアップの履歴は、巻き戻さない（carry / append / revoke）', () => {
    const mustNotRestore = ['employees', 'credentials', 'permissions', 'devices', 'device_enrollments', 'sessions', 'admin_credentials', 'admin_sessions', 'attendance_events', 'attendance_corrections', 'manual_breaks', 'break_declarations', 'overtime_requests', 'overtime_request_history', 'payroll_periods', 'payroll_results', 'pay_slips', 'audit_logs', 'backup_history', 'leave_grants', 'leave_transactions', 'request_idempotency', 'exports', 'shift_history'] as const;
    for (const n of mustNotRestore) expect(['carry', 'append', 'revoke'], n).toContain(RESTORE_POLICY[n].policy);
  });

  function setup() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.setNow('2026-11-02', '10:00');
    return { h, a };
  }
  const restore = (h: Harness, backupId: string) => {
    h.setNow('2026-11-02', '12:00');
    h.ownerOk('backup.restore', { backupId, confirmText: '復元する' });
  };

  it('端末登録コード: バックアップの前に発行し、後で使ったコードは、復元しても使用済みのまま（再び使えない）', () => {
    const { h } = setup();
    const en = h.ownerOk<{ code: string }>('devices.createEnrollment', { deviceName: '予備iPad' });
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '10:01');
    expect(code(h.staff('staff.enroll', { code: en.code, userAgent: 'test' }, { device: '' }))).toBe('OK');
    // 有効期限（15 分）の内に復元し、同じコードを使う（期限切れで拒否されるのではなく、使用済みとして拒否されることを確かめる）
    h.setNow('2026-11-02', '10:02');
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    h.setNow('2026-11-02', '10:03');
    expect(code(h.staff('staff.enroll', { code: en.code, userAgent: 'test' }, { device: '' }))).not.toBe('OK');
  });

  it('有給: バックアップの後に付与・取得した記録は、復元しても残る（取得した事実を消さない）', () => {
    const { h, a } = setup();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '11:00');
    h.ownerOk('leave.grant', { employeeId: a, kind: 'extra', grantDate: '2026-11-01', days: 5, attendanceRateConfirmed: true, note: '試験' });
    h.ownerOk('leave.take', { employeeId: a, date: '2026-11-05', days: 1, scheduledMinutes: 480 });
    restore(h, bk.id);
    const d = h.ownerOk<any>('leave.detail', { employeeId: a });
    expect(d.grants.map((g: any) => g.days)).toContain(5);
    expect(d.transactions.filter((t: any) => t.kind === 'take' && t.date === '2026-11-05')).toHaveLength(1);
  });

  it('シフトの変更履歴・出力の履歴: バックアップの後の記録は、復元しても残る（シフト自体はバックアップの時点に戻る）', () => {
    const { h, a } = setup();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '11:00');
    const sh = h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-10', start: '09:00', end: '17:00', breakMinutes: 60 });
    h.ownerOk('export.attendance', { from: '2026-11-01', to: '2026-11-30', format: 'csv' });
    const histBefore = uowOf(h).list<{ shiftId: string }>('shift_history').filter((x) => x.shiftId === sh.id).length;
    const expBefore = uowOf(h).list('exports').length;
    expect(histBefore).toBeGreaterThan(0);
    expect(expBefore).toBeGreaterThan(0);
    restore(h, bk.id);
    expect(uowOf(h).list<{ id: string }>('shifts').some((x) => x.id === sh.id)).toBe(false);
    expect(uowOf(h).list<{ shiftId: string }>('shift_history').filter((x) => x.shiftId === sh.id)).toHaveLength(histBefore);
    expect(uowOf(h).list('exports').length).toBeGreaterThanOrEqual(expBefore);
  });

  it('冪等性キー: バックアップの後に処理した要求を、復元の後に同じ要求 ID で再送しても、再実行しない', () => {
    const { h, a } = setup();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '11:00');
    const req = { op: 'shifts.upsert', args: { employeeId: a, date: '2026-11-11', start: '09:00', end: '17:00', breakMinutes: 60 }, requestId: 'req_fixed_after_backup_01' };
    expect(handleRequest(h.be, req, 'owner').ok).toBe(true);
    restore(h, bk.id);
    const shiftsAfterRestore = uowOf(h).list<{ date: string }>('shifts').filter((x) => x.date === '2026-11-11').length;
    expect(shiftsAfterRestore).toBe(0); // シフト（入力）はバックアップの時点に戻る
    handleRequest(h.be, req, 'owner'); // 再送
    expect(uowOf(h).list<{ date: string }>('shifts').filter((x) => x.date === '2026-11-11')).toHaveLength(0);
  });
});

describe('復元後の給与の照合: 計算結果の全項目を比べる（differingTotals）', () => {
  function sampleTotals(): Record<string, unknown> {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    return h.ownerOk('payroll.compute', { periodId: p.id }).employees[0].totals;
  }
  it('計算結果のどの 1 項目が違っても差として検出し、違う項目の名前を返す（項目を個別に選ばない）', () => {
    const base = sampleTotals();
    const keys = Object.keys(base);
    expect(keys.length).toBeGreaterThan(15);
    expect(differingTotals(base as never, JSON.parse(JSON.stringify(base)))).toEqual([]);
    for (const k of keys) {
      const changed = JSON.parse(JSON.stringify(base));
      changed[k] = Array.isArray(base[k]) ? [...(base[k] as unknown[]), { name: '追加', amount: 1 }] : typeof base[k] === 'number' ? (base[k] as number) + 1 : 'changed';
      const d = differingTotals(base as never, changed);
      expect(d, k).toHaveLength(1);
    }
  });

  it('Codex 監査19 #1: 控除 4 万円の状態のバックアップを、控除なしで差引 24 万円に確定した後に復元 → 総支給額が同じでも差として検出し、解除・訂正を止める', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('佐藤', '582913', { payType: 'monthly' });
    h.ownerOk('payconf.upsertSalaryRule', { employeeId: a, effectiveFrom: '2025-01-01', monthlyScheduledMinutes: 160 * 60, scheduledWeekdays: [1, 2, 3, 4, 5], scheduledDailyMinutes: 480, confirmed: true, monthlySalary: 240000 });
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    const ded = { employeeId: a, periodId: p.id, status: 'entered', incomeTax: 40000, residentTax: 0, healthInsurance: 0, pension: 0, employmentInsurance: 0, nursingInsurance: 0 };
    h.ownerOk('deductions.upsert', ded);
    h.setNow('2026-12-01', '06:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-12-01', '06:10');
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    const r = h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    expect(r.confirmed[0].netPay).toBe(240000);
    h.setNow('2026-12-01', '06:20');
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    h.setNow('2026-12-01', '06:30');
    const review = h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id });
    expect(review.differences).toBe(1);
    const row = review.rows[0];
    expect(row.confirmedGross).toBe(row.currentGross); // 総支給額は同じ
    expect(row.confirmedNet - row.currentNet).toBe(40000);
    expect(row.differingItems).toEqual(expect.arrayContaining(['控除の内訳', '控除合計', '差引支給額']));
    const all = { periodId: p.id, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, checkedSalaryRules: true, confirmText: '確認しました' };
    expect(code(h.owner('payroll.releaseRestoreLock', all))).toBe('RESTORE_DIFFERENCES');
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks }))).toBe('PAYROLL_BLOCKED');
  });
});
