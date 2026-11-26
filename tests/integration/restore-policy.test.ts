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
import type { PayrollTotals } from '../../src/shared/types';

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
    const req = { op: 'shifts.upsert', args: { employeeId: a, date: '2026-11-11', start: '09:00', end: '17:00', breakMinutes: 60 }, requestId: 'req_fixed_after_backup_01', epoch: h.currentEpoch()! };
    expect(handleRequest(h.be, req, 'owner').ok).toBe(true);
    restore(h, bk.id);
    const shiftsAfterRestore = uowOf(h).list<{ date: string }>('shifts').filter((x) => x.date === '2026-11-11').length;
    expect(shiftsAfterRestore).toBe(0); // シフト（入力）はバックアップの時点に戻る
    // 再送（冪等性キーの確認のため、復元後の世代を付ける。復元前の世代のままの再送は世代の照合で拒否される。D-026）
    handleRequest(h.be, { ...req, epoch: h.currentEpoch()! }, 'owner');
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
    // 型（PayrollTotals）の全項目を列挙する（Record<keyof PayrollTotals, true> なので、項目を追加すると型検査で決め忘れが分かる）。
    // 計算結果に全項目が出ていることも確かめ、計算結果に現れた項目だけを回すことにならないようにする（Codex 監査22 のテストの指摘）
    const ALL: Record<keyof PayrollTotals, true> = {
      workDays: true, workMinutes: true, overtimeMinutes: true, over60Minutes: true, nightMinutes: true, holidayMinutes: true, basePay: true, extraHoursBasePay: true,
      overtimePremium: true, over60Premium: true, nightPremium: true, holidayPremium: true, fixedOvertimePay: true, fixedOvertimeExcess: true, paidLeavePay: true,
      paidLeaveDays: true, allowances: true, transport: true, absenceDeduction: true, grossPay: true, deductions: true, deductionTotal: true, netPay: true,
    };
    const keys = Object.keys(ALL);
    expect(Object.keys(base).sort()).toEqual([...keys].sort());
    expect(differingTotals(base as never, JSON.parse(JSON.stringify(base)))).toEqual([]);
    for (const k of keys) {
      const changed = JSON.parse(JSON.stringify(base));
      changed[k] = Array.isArray(base[k]) ? [...(base[k] as unknown[]), { name: '追加', amount: 1 }] : typeof base[k] === 'number' ? (base[k] as number) + 1 : 'changed';
      const d = differingTotals(base as never, changed);
      expect(d, k).toHaveLength(1);
      // 片方にだけない項目（以前の版で確定した結果など）も差として検出する
      const missing = JSON.parse(JSON.stringify(base));
      delete missing[k];
      expect(differingTotals(base as never, missing), `${k}（片方にない）`).toHaveLength(1);
      expect(differingTotals(missing, base as never), `${k}（片方にない・逆）`).toHaveLength(1);
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

/**
 * 復元と楽観的排他（版）: 復元で行の版を小さくしない（D-025 R1。独立した点検 R1-1）。
 * 版が小さくなると、復元前に開いていた画面（Google 所有者の管理画面はセッションの失効の対象外）からの古い内容の上書きが、
 * 版の照合を通ってしまう。全表で「復元前からある行の版は小さくならず、内容が変わった行・引き継いだ行の版は大きくなる」ことを確かめる
 */
describe('復元と楽観的排他（版）', () => {
  type Row = Record<string, unknown> & { id: string; version: number };
  const snapshot = (h: Harness) => {
    const u = uowOf(h);
    const out = new Map<string, Map<string, Row>>();
    for (const def of TABLES) out.set(def.name, new Map(u.list<Row>(def.name).map((r) => [r.id, r])));
    return out;
  };
  const content = (r: Row) => JSON.stringify(Object.keys(r).filter((k) => k !== 'version' && k !== 'updatedAt').sort().map((k) => [k, r[k] ?? null]));

  /** バックアップの後に、restore・carry の両方の表で行を作成・更新した状態から復元する */
  function scenario() {
    const h = new Harness();
    h.setupStore();
    h.setNow('2026-11-02', '09:00');
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    const emp = h.ownerOk<any>('employees.list', {}).find((e: any) => e.id === a);
    const wr = h.ownerOk<any>('payconf.get', { employeeId: a }).wageRules[0];
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '10:00');
    // carry の表: スタッフの更新 2 回・権限・PIN・バックアップの後に作ったスタッフ
    const e1 = h.ownerOk<any>('employees.update', { employeeId: a, displayName: '山田2', version: emp.version });
    const e2 = h.ownerOk<any>('employees.update', { employeeId: a, electronicPayslipConsent: false, version: e1.version });
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['shift_edit'] });
    h.ownerOk('credentials.setPin', { employeeId: a, pin: '582914' });
    const b = h.ownerOk<{ id: string }>('employees.create', { displayName: '後から', kana: 'あとから', payType: 'hourly', hireDate: '2025-01-01' });
    const bList = h.ownerOk<any>('employees.list', {}).find((e: any) => e.id === b.id);
    const b2 = h.ownerOk<any>('employees.update', { employeeId: b.id, note: '更新', version: bList.version });
    // restore の表: 時給ルールの更新 2 回・店舗設定・シフト
    const w1 = h.ownerOk<any>('payconf.upsertWageRule', { id: wr.id, version: wr.version, employeeId: a, kind: 'base', hourlyRate: 1300, effectiveFrom: '2025-01-01', priority: 0 }).rule;
    const w2 = h.ownerOk<any>('payconf.upsertWageRule', { id: wr.id, version: w1.version, employeeId: a, kind: 'base', hourlyRate: 1400, effectiveFrom: '2025-01-01', priority: 0 }).rule;
    h.ownerOk('settings.update', { storeName: '復元前の店名' });
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-10', start: '09:00', end: '17:00', breakMinutes: 60 });
    const before = snapshot(h);
    h.setNow('2026-11-02', '12:00');
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    const after = snapshot(h);
    return { h, a, b: b.id, e1, e2, b1Version: bList.version, b2, w1, w2, before, after };
  }

  it('全表: 復元前からある行の版は小さくならず、内容が変わった行・引き継いだ行（carry）の版は大きくなる', () => {
    const { before, after } = scenario();
    let changedRestoreRows = 0;
    let carriedRows = 0;
    for (const def of TABLES) {
      const pol = RESTORE_POLICY[def.name].policy;
      if (pol === 'revoke' || pol === 'skip') continue; // セッションはすべて失効・処理記録は候補のまま（画面から版で更新しない）
      for (const [id, b] of before.get(def.name)!) {
        const a = after.get(def.name)!.get(id);
        if (!a) continue; // restore の表で、バックアップの後に作られた行（復元で消える。古い画面の更新は「見つからない」で拒否される）
        expect(a.version, `${def.name} ${id}`).toBeGreaterThanOrEqual(b.version);
        if (pol === 'carry') {
          expect(a.version, `${def.name} ${id}（carry）`).toBeGreaterThan(b.version);
          carriedRows++;
        } else if (content(a) !== content(b)) {
          expect(a.version, `${def.name} ${id}（内容が変わった行）`).toBeGreaterThan(b.version);
          changedRestoreRows++;
        }
      }
    }
    // 検証が空にならないこと（restore の表で内容が戻った行・carry の行の両方を確かめている）
    expect(changedRestoreRows).toBeGreaterThan(0);
    expect(carriedRows).toBeGreaterThan(0);
  });

  it('独立した点検 R1-1: 復元前に開いていたスタッフの編集画面（版 2）からの保存は、復元後に衝突として拒否する（同意の撤回を古い値に戻さない）', () => {
    const { h, a, e1 } = scenario();
    const r = h.owner('employees.update', { employeeId: a, electronicPayslipConsent: true, version: e1.version });
    expect(code(r)).toBe('CONFLICT');
    const now = h.ownerOk<any>('employees.list', {}).find((e: any) => e.id === a);
    expect(now.electronicPayslipConsent).toBe(false);
    // 開き直した画面（最新の版）からは保存できる
    expect(code(h.owner('employees.update', { employeeId: a, note: '開き直して保存', version: now.version }))).toBe('OK');
  });

  it('独立した点検 R1-1: バックアップの後に作ったスタッフも、復元前の古い版（版 1）からの保存を拒否する', () => {
    const { h, b, b1Version } = scenario();
    expect(code(h.owner('employees.update', { employeeId: b, note: '古い画面', version: b1Version }))).toBe('CONFLICT');
  });

  it('restore の表: 復元後に時給ルールを保存して版が進んでも、復元前に開いていた画面（復元前の版）からの保存は拒否する', () => {
    const { h, a, w1, w2 } = scenario();
    const restored = h.ownerOk<any>('payconf.get', { employeeId: a }).wageRules.find((x: any) => x.id === w1.id);
    expect(restored.hourlyRate).toBe(1200); // 内容はバックアップの時点
    // 復元後に開き直して保存（版が 1 つ進む）。版を小さくしていると、ここで復元前の画面の版と重なる
    let cur = h.ownerOk<any>('payconf.upsertWageRule', { id: w1.id, version: restored.version, employeeId: a, kind: 'base', hourlyRate: 1250, effectiveFrom: '2025-01-01', priority: 0 }).rule;
    for (let i = 0; i < 2; i++) {
      for (const v of [w1.version, w2.version]) {
        const r = h.owner('payconf.upsertWageRule', { id: w1.id, version: v, employeeId: a, kind: 'base', hourlyRate: 1500, effectiveFrom: '2025-01-01', priority: 0 });
        expect(code(r), `復元前の版 ${v}（復元後の保存 ${i + 1} 回目の後）`).toBe('CONFLICT');
      }
      cur = h.ownerOk<any>('payconf.upsertWageRule', { id: w1.id, version: cur.version, employeeId: a, kind: 'base', hourlyRate: 1260 + i, effectiveFrom: '2025-01-01', priority: 0 }).rule;
    }
    expect(h.ownerOk<any>('payconf.get', { employeeId: a }).wageRules.find((x: any) => x.id === w1.id).hourlyRate).toBe(1261);
  });
});

describe('復元後の給与の停止の記録が壊れている場合（独立した点検 補足2）', () => {
  // 記録を読み取れない場合は「停止なし」と見なさず、確定を止める（迷ったら止める）。壊れ方の種類を列挙して確かめる
  // 有効な値は「停止なし（{}）」と「期間 ID → { restoredAt, backupId }」だけ。それ以外（空欄・空白を含む）はすべて止める（Codex 監査22 #1）
  const BROKEN = ['', ' ', '\n', '{壊れた', '[]', 'null', '0', 'true', '"text"', '"{}"', '{"pd_x":1}', '{"pd_x":null}', '{"pd_x":{"restoredAt":1}}', '{"pd_x":{"restoredAt":"2026-11-01"}}', '{"pd_x":{"backupId":"b"}}'];
  for (const raw of [...BROKEN, '{}', null]) {
    const ok = raw === '{}' || raw === null; // 停止なし（{}）・記録の行がない場合だけ確定できる
    it(`記録が ${raw === null ? '（行なし）' : JSON.stringify(raw)} のとき、給与の確定を${ok ? '止めない' : '止める'}`, () => {
      const h = new Harness();
      h.setupStore();
      const a = h.addStaff('佐藤', '582913', { payType: 'monthly' });
      h.ownerOk('payconf.upsertSalaryRule', { employeeId: a, effectiveFrom: '2025-01-01', monthlyScheduledMinutes: 160 * 60, scheduledWeekdays: [1, 2, 3, 4, 5], scheduledDailyMinutes: 480, confirmed: true, monthlySalary: 240000 });
      const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
      h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
      h.setNow('2026-12-01', '06:00');
      const c = h.ownerOk('payroll.compute', { periodId: p.id });
      const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
      // DB の記録を直接壊す（手での編集を模す）
      const u = uowOf(h);
      const meta = u.list<any>('system_metadata');
      const row = meta.find((m) => m.key === 'payrollRestoreLocks');
      expect(row).toBeUndefined(); // 復元していないので行はない
      if (raw !== null) {
        u.insert('system_metadata', { key: 'payrollRestoreLocks', value: raw } as never, 'met');
        u.flush();
        expect(uowOf(h).list<any>('system_metadata').find((m) => m.key === 'payrollRestoreLocks')?.value).toBe(raw); // 保存と読み込みで値が変わらない
      }
      expect(code(h.owner('payroll.confirm', { periodId: p.id, acknowledgements: acks }))).toBe(ok ? 'OK' : 'PAYROLL_BLOCKED');
    });
  }
});

/**
 * 復元を続けて行う場合の版（Codex 監査22 #2）。復元の順番の組み合わせを回し、各復元の後に、戻した表・引き継いだ表の全行の版が、
 * それまでに見えたどの版（どの DB の、どの時点の行の版）よりも大きいことを確かめる。あわせて、いったん消えて復活した時給ルールを、
 * 過去に見えたどの版で保存しても衝突として拒否することを確かめる
 */
describe('復元を続けて行う場合の版（復元の順番の組み合わせ）', () => {
  type Row = { id: string; version: number };
  const SEQUENCES = [['A', 'B'], ['B', 'A', 'B'], ['A', 'B', 'A', 'B'], ['B', 'B'], ['A', 'A', 'B']];
  for (const seq of SEQUENCES) {
    it(`復元の順番 ${seq.join('→')}`, () => {
      const h = new Harness();
      h.setupStore();
      h.setNow('2026-11-02', '09:00');
      const a = h.addStaff('山田', '482913'); // 時給ルールなし
      const bkA = h.ownerOk('backup.run', { kind: 'manual' });
      h.setNow('2026-11-02', '09:10');
      const w1 = h.ownerOk<any>('payconf.upsertWageRule', { employeeId: a, kind: 'base', hourlyRate: 1400, effectiveFrom: '2025-01-01', priority: 0 }).rule;
      const bkB = h.ownerOk('backup.run', { kind: 'manual' });
      h.setNow('2026-11-02', '09:20');
      h.ownerOk('payconf.upsertWageRule', { id: w1.id, version: w1.version, employeeId: a, kind: 'base', hourlyRate: 1500, effectiveFrom: '2025-01-01', priority: 0 });
      const ids = { A: bkA.id, B: bkB.id } as Record<string, string>;
      const seen = new Map<string, number>(); // `${表}|${ID}` → これまでに見えた最大の版
      const observe = () => {
        const u = uowOf(h);
        for (const def of TABLES) {
          const pol = RESTORE_POLICY[def.name].policy;
          if (pol !== 'restore' && pol !== 'carry') continue;
          for (const r of u.list<Row>(def.name)) {
            const k = `${def.name}|${r.id}`;
            seen.set(k, Math.max(seen.get(k) ?? 0, r.version));
          }
        }
      };
      const wageVersions = new Set<number>([w1.version, w1.version + 1]);
      let minute = 30;
      for (const step of seq) {
        observe();
        const before = new Map(seen);
        h.setNow('2026-11-02', `09:${minute++}`);
        h.ownerOk('backup.restore', { backupId: ids[step], confirmText: '復元する' });
        const u = uowOf(h);
        let checked = 0;
        for (const def of TABLES) {
          const pol = RESTORE_POLICY[def.name].policy;
          if (pol !== 'restore' && pol !== 'carry') continue;
          for (const r of u.list<Row>(def.name)) {
            const prev = before.get(`${def.name}|${r.id}`);
            if (prev !== undefined) {
              expect(r.version, `${step} の復元後 ${def.name} ${r.id}`).toBeGreaterThan(prev);
              checked++;
            }
          }
        }
        expect(checked).toBeGreaterThan(0);
        // 復元後の時給ルール（あれば）を、これまでに見えたどの版で保存しても拒否する
        const rule = h.ownerOk<any>('payconf.get', { employeeId: a }).wageRules.find((x: any) => x.id === w1.id);
        if (rule) {
          for (const v of wageVersions) {
            const r = h.owner('payconf.upsertWageRule', { id: w1.id, version: v, employeeId: a, kind: 'base', hourlyRate: 1000, effectiveFrom: '2025-01-01', priority: 0 });
            expect(code(r), `${step} の復元後、過去の版 ${v}`).toBe('CONFLICT');
          }
          expect(h.ownerOk<any>('payconf.get', { employeeId: a }).wageRules.find((x: any) => x.id === w1.id).hourlyRate).toBe(1400); // B の時点
          wageVersions.add(rule.version);
        }
      }
    });
  }
});
