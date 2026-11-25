import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';

describe('初期化・端末登録・打刻（F01/F02/F03/F06/F07）', () => {
  it('初期化は冪等', () => {
    const h = new Harness();
    h.ownerOk('system.initialize', { storeName: 'A', envId: 'env1' });
    const r = h.ownerOk('system.initialize', { storeName: 'B', envId: 'env2' });
    expect(r.envId).toBe('env1');
    expect(h.ownerOk('settings.get').storeName).toBe('A');
  });

  it('出勤→休憩→休憩終了→退勤→再出勤→日付をまたいで退勤', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1100 });
    expect(h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in').state).toBe('working');
    expect(h.punchAt(a, '482913', '2026-11-02', '12:00', 'break_start').state).toBe('on_break');
    expect(h.punchAt(a, '482913', '2026-11-02', '12:45', 'break_end').state).toBe('working');
    expect(h.punchAt(a, '482913', '2026-11-02', '15:00', 'clock_out').state).toBe('clocked_out');
    h.punchAt(a, '482913', '2026-11-02', '20:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '01:30', 'clock_out');
    const list = h.ownerOk<any[]>('attendance.list', { from: '2026-11-02', to: '2026-11-03' });
    const ss = list[0].sessions;
    expect(ss).toHaveLength(2);
    expect(ss[0].workMinutes).toBe(360 - 45);
    expect(ss[1].laborDate).toBe('2026-11-02');
    expect(ss[1].workMinutes).toBe(330);
  });

  it('二重打刻・不正な遷移は拒否し、成功と表示しない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.setNow('2026-11-02', '09:00');
    h.login(a, '482913');
    expect(h.punch('clock_in').ok).toBe(true);
    const dup = h.punch('clock_in');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('INVALID_TRANSITION');
    expect(h.punch('break_end').ok).toBe(false);
  });

  it('同じ requestId の再送は重複登録せず、保存済み結果を返す（冪等性・保存結果不明時の確認）', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.login(a, '482913');
    const r1 = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'punch_retry_0001' });
    const r2 = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'punch_retry_0001' });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect((r2.data as any).eventId).toBe((r1.data as any).eventId);
    expect((h.staffOk('attendance.lookup', { requestId: 'punch_retry_0001' }) as any).saved).toBe(true);
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(det.originals).toHaveLength(1);
  });

  it('休憩中の退勤は確認が必要。確認後は休憩終了＋退勤を記録', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '12:00', 'break_start');
    h.setNow('2026-11-02', '13:00');
    h.login(a, '482913');
    const r = h.punch('clock_out');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('BREAK_END_CONFIRM_REQUIRED');
    expect(h.punch('clock_out', { endBreakConfirmed: true }).ok).toBe(true);
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(det.originals.map((x: any) => x.type)).toEqual(['clock_in', 'break_start', 'break_end', 'clock_out']);
  });

  it('前日の退勤打刻漏れがあっても翌日出勤でき、前日は打刻漏れとして残る', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '18:00', 'clock_in');
    h.setNow('2026-11-03', '18:00');
    const me = h.login(a, '482913');
    expect(me.state).toBe('off');
    expect(h.punch('clock_in').ok).toBe(true);
    const ss = h.ownerOk<any[]>('attendance.list', { from: '2026-11-02', to: '2026-11-03' })[0].sessions;
    expect(ss[0].anomalies).toContain('missing_clock_out');
    expect(ss[1].open).toBe(true);
  });
});

describe('勤怠修正（F09）', () => {
  it('原本を変更せず修正履歴を保存し、修正後の勤務を再構築', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '09:07', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '18:00', 'clock_out');
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    const inEv = det.originals[0];
    h.ownerOk('attendance.correct', { employeeId: a, action: 'replace', targetEventId: inEv.id, type: 'clock_in', at: '2026-11-02T09:00', reason: '打刻忘れ（本人申告・管理者確認）' });
    h.ownerOk('attendance.correct', { employeeId: a, action: 'add', type: 'break_start', at: '2026-11-02T12:00', reason: '休憩打刻漏れ' });
    h.ownerOk('attendance.correct', { employeeId: a, action: 'add', type: 'break_end', at: '2026-11-02T13:00', reason: '休憩打刻漏れ' });
    const det2 = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(det2.originals[0].at).toBe(inEv.at);
    expect(det2.corrections).toHaveLength(3);
    expect(det2.corrections.every((c: any) => c.reason && c.actorId === 'owner')).toBe(true);
    expect(det2.sessions[0].workMinutes).toBe(480);
  });

  it('紙タイムカードからの復旧登録（理由付き）', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.ownerOk('attendance.correct', { employeeId: a, action: 'add', type: 'clock_in', at: '2026-11-01T17:00', reason: '通信障害', source: 'paper_recovery' });
    h.ownerOk('attendance.correct', { employeeId: a, action: 'add', type: 'clock_out', at: '2026-11-01T23:00', reason: '通信障害', source: 'paper_recovery' });
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-01', to: '2026-11-01' });
    expect(det.sessions[0].workMinutes).toBe(360);
    expect(det.corrections[0].reason).toContain('紙タイムカード');
  });
});

describe('シフト（F10/F11）', () => {
  it('作成→複製→公開、スタッフは公開分のみ閲覧、実績比較で遅刻を検出', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-02', start: '18:00', end: '26:00', breakMinutes: 60, applyFixedBreak: false });
    h.login(a, '482913');
    expect(h.staffOk<any[]>('shifts.published', { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(0);
    expect(h.ownerOk('shifts.copyWeek', { fromWeekStart: '2026-11-01', toWeekStart: '2026-11-08' }).created).toBe(1);
    expect(h.ownerOk('shifts.publish', { from: '2026-11-01', to: '2026-11-14' }).published).toBe(2);
    expect(h.staffOk<any[]>('shifts.published', { from: '2026-11-01', to: '2026-11-30' })).toHaveLength(2);
    h.staff('auth.logout');
    h.punchAt(a, '482913', '2026-11-02', '18:20', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '02:00', 'clock_out');
    const cmp = h.ownerOk('attendance.compareShifts', { from: '2026-11-02', to: '2026-11-02' });
    expect(cmp.rows[0].flags).toContain('late');
  });
  it('同一スタッフの重複シフトは拒否', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-02', start: '18:00', end: '26:00', breakMinutes: 0 });
    expect(h.owner('shifts.upsert', { employeeId: a, date: '2026-11-03', start: '01:00', end: '05:00', breakMinutes: 0 }).ok).toBe(false);
  });
});

describe('有給（F20）', () => {
  it('付与提案→付与（出勤率確認必須）→取得→残日数', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.ownerOk('employment.upsert', { employeeId: a, effectiveFrom: '2025-01-01', payType: 'hourly', weeklyScheduledDays: 5, weeklyScheduledMinutes: 2400, dailyScheduledMinutes: 480 });
    const det = h.ownerOk('leave.detail', { employeeId: a });
    expect(det.proposals[0]).toMatchObject({ grantDate: '2025-07-01', days: 10 });
    expect(h.owner('leave.grant', { employeeId: a, grantDate: '2025-07-01', days: 10, kind: 'statutory', attendanceRateConfirmed: false }).ok).toBe(false);
    h.ownerOk('leave.grant', { employeeId: a, grantDate: '2025-07-01', days: 10, kind: 'statutory', attendanceRateConfirmed: true });
    h.ownerOk('leave.take', { employeeId: a, date: '2026-11-05', days: 1, scheduledMinutes: 480 });
    expect(h.owner('leave.take', { employeeId: a, date: '2026-11-06', days: 0.5 }).ok).toBe(false); // 半日は未許可
    h.login(a, '482913');
    expect(h.staffOk('leave.mine').balance).toBe(9);
  });
  it('既存残日数は根拠なしでは登録できない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    expect(h.owner('leave.grant', { employeeId: a, grantDate: '2026-11-01', days: 5, kind: 'initial_balance', attendanceRateConfirmed: false }).ok).toBe(false);
    expect(h.owner('leave.grant', { employeeId: a, grantDate: '2026-11-01', days: 5, kind: 'initial_balance', attendanceRateConfirmed: false, note: '紙台帳 2026/10 時点' }).ok).toBe(true);
  });
});

describe('給与（F14/F18/F19）', () => {
  function setupPayroll() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1100 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '18:00', 'clock_out');
    // 休憩未取得（9h）→ 休憩不足の確認が必要
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    // 給与期間（11月）の終了後に計算・確定する（締め日前の確定は不可: Codex 監査1 #3）
    h.setNow('2026-12-01', '06:00');
    return { h, a, p };
  }
  it('控除未入力では確定できない → 控除なし明示 → 確認項目の承認で確定', () => {
    const { h, a, p } = setupPayroll();
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const emp = c.employees[0];
    expect(emp.totals.basePay).toBe(9900);
    expect(emp.totals.overtimePremium).toBe(275);
    expect(emp.canConfirm).toBe(false);
    expect(emp.issues.map((i: any) => i.code)).toContain('DEDUCTION_UNENTERED');
    const r1 = h.owner('payroll.confirm', { periodId: p.id });
    expect(r1.ok).toBe(false);
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    const r2 = h.owner('payroll.confirm', { periodId: p.id });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('ACK_REQUIRED');
    const c2 = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c2.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    const r3 = h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    expect(r3.confirmed[0].netPay).toBe(10175);
    // 確定後に時給を変更しても過去の確定結果は変わらない
    h.ownerOk('payconf.upsertWageRule', { employeeId: a, kind: 'base', hourlyRate: 2000, effectiveFrom: '2026-11-01', priority: 5 });
    const res = h.ownerOk<any[]>('payroll.results', { periodId: p.id });
    expect(res.find((x) => x.status === 'confirmed').totals.basePay).toBe(9900);
    // 二重確定は不可、訂正は理由必須で新リビジョン
    expect(h.owner('payroll.confirm', { periodId: p.id, acknowledgements: acks }).ok).toBe(false);
    expect(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '', acknowledgements: acks }).ok).toBe(false);
    const cor = h.ownerOk('payroll.correct', { periodId: p.id, employeeId: a, reason: '時給改定の遡及適用', acknowledgements: acks });
    expect(cor.revision).toBe(2);
    const res2 = h.ownerOk<any[]>('payroll.results', { periodId: p.id });
    expect(res2.filter((x) => x.status === 'superseded').length).toBeGreaterThanOrEqual(1);
    expect(res2.find((x) => x.status === 'confirmed').totals.basePay).toBe(18000);
    // 明細発行・本人閲覧
    expect(h.ownerOk('payslips.issue', { periodId: p.id }).issued).toBe(1);
    h.login(a, '482913');
    const mine = h.staffOk<any[]>('payslips.mine');
    expect(mine).toHaveLength(1);
    const view = h.staffOk('payslips.view', { payslipId: mine[0].id });
    expect(view.net).toBe(res2.find((x) => x.status === 'issued' || x.status === 'confirmed')?.totals.netPay ?? view.net);
    expect(view.employeeName).toBe('山田');
  });
  it('未確認の店舗給与規定では確定禁止（設定変更で確認がリセットされる）', () => {
    const { h, a, p } = setupPayroll();
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    const r = h.ownerOk('settings.update', { weekStartDay: 1 });
    expect(r.payrollRulesReset).toBe(true);
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    expect(c.employees[0].issues.map((i: any) => i.code)).toContain('PAYROLL_RULES_UNCONFIRMED');
  });
});

describe('出力・分析・通知（F21/F22/F23/F24）', () => {
  it('CSV・Excel を出力し Drive に保存', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('=HYPERLINK("x")', '482913', { rate: 1100 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '17:00', 'clock_out');
    const csv = h.ownerOk('export.attendance', { from: '2026-11-01', to: '2026-11-30', format: 'csv' });
    const text = Buffer.from(csv.base64, 'base64').toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""x"")"`);
    const x = h.ownerOk('export.attendance', { from: '2026-11-01', to: '2026-11-30', format: 'xlsx' });
    expect(Buffer.from(x.base64, 'base64').subarray(0, 2).toString()).toBe('PK');
    expect(h.env.files.listFiles('03_Exports')).toHaveLength(2);
  });
  it('人件費・予算・着地予測（実績と予定を区別）', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1000 });
    const b = h.addStaff('佐藤', '582913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '10:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    h.punchAt(b, '582913', '2026-11-02', '10:00', 'clock_in');
    h.punchAt(b, '582913', '2026-11-02', '12:00', 'clock_out');
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-20', start: '10:00', end: '15:00', breakMinutes: 0 });
    h.ownerOk('shifts.publish', { from: '2026-11-01', to: '2026-11-30' });
    h.ownerOk('budgets.upsert', { month: '2026-11', monthlyAmount: 8000, laborCostAllocation: 'by_worked_minutes' });
    h.setNow('2026-11-03', '10:00');
    const r = h.ownerOk('analytics.laborCost', { month: '2026-11' });
    expect(r.actual.total).toBe(4000 + 2400);
    expect(r.forecast.total).toBe(6400 + 5000);
    expect(r.budget.over).toBe(true);
    expect(r.actual.byDate['2026-11-02'].amount).toBe(6400);
  });
  it('通知スキャン（重複生成しない）', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1000 });
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-02', start: '10:00', end: '15:00', breakMinutes: 0 });
    h.ownerOk('shifts.publish', { from: '2026-11-01', to: '2026-11-30' });
    h.setNow('2026-11-02', '16:00');
    const n1 = h.ownerOk('notifications.scan').created;
    const n2 = h.ownerOk('notifications.scan').created;
    expect(n1).toBeGreaterThan(0);
    expect(n2).toBe(0);
    const list = h.ownerOk<any[]>('notifications.list');
    expect(list.some((x) => x.kind === 'absence')).toBe(true);
  });
});

describe('バックアップ・復元・更新（F26/F35/F36/F37）', () => {
  it('復元後もバックアップ後の打刻は失われず、失効端末は失効のまま、セッションは失効', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.setNow('2026-11-02', '10:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.punchAt(a, '482913', '2026-11-02', '18:00', 'clock_out');
    h.setNow('2026-11-02', '18:05');
    h.login(a, '482913');
    const sessionBefore = h.session;
    h.setNow('2026-11-02', '18:10');
    const r = h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    expect(r.preservedRowsReinserted).toBeGreaterThan(0);
    expect(r.integrity.ok).toBe(true);
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(det.originals.map((x: any) => x.type)).toEqual(['clock_in', 'clock_out']);
    expect(h.staff('auth.me', undefined, { session: sessionBefore }).ok).toBe(false);
  });
  it('復元には確認文字列が必要', () => {
    const h = new Harness();
    h.setupStore();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    expect(h.owner('backup.restore', { backupId: bk.id, confirmText: 'yes' }).ok).toBe(false);
  });
  it('更新: 準備（メンテナンス＋更新前バックアップ）中はスタッフの打刻を拒否し、完了で解除', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.login(a, '482913');
    const prep = h.ownerOk('system.prepareUpdate', { targetVersion: '0.2.0' });
    expect(prep.maintenance).toBe(true);
    const r = h.punch('clock_in');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MAINTENANCE');
    expect(h.ownerOk('system.migrate', {}).requiresApproval).toEqual([]);
    expect(h.ownerOk('system.finishUpdate').integrity.ok).toBe(true);
    expect(h.punch('clock_in').ok).toBe(true);
    expect(h.ownerOk<any[]>('backup.list').some((b) => b.kind === 'pre_update')).toBe(true);
  });
  it('日次ジョブ: バックアップ世代管理', () => {
    const h = new Harness();
    h.setupStore();
    for (let i = 0; i < 33; i++) {
      h.advance(86400000);
      h.ownerOk('system.dailyJob');
    }
    const daily = h.ownerOk<any[]>('backup.list').filter((b) => b.kind === 'daily' && b.status === 'ok');
    expect(daily).toHaveLength(30);
  });
});

describe('書き込み途中失敗からの復旧（ジャーナル）', () => {
  it('業務データ書き込みで失敗→次の更新処理で再適用', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.login(a, '482913');
    // flush 内の 2 回目の write（業務データ本体）で失敗させる
    h.env.adapter.failOnWrite = (h.env.adapter as any).writes + 2;
    const r = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'jnl_test_0001' });
    expect(r.ok).toBe(false);
    h.env.adapter.failOnWrite = null;
    // 次の更新系処理の開始時にジャーナルから再適用され、同じ requestId の再送は保存済み結果を返す
    const r2 = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'jnl_test_0001' });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect((r2.data as any).replayed).toBe(true);
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(det.originals).toHaveLength(1);
    expect(h.ownerOk('system.integrityCheck').ok).toBe(true);
  });
});

describe('大きな書き込み（給与確定・訂正）の途中失敗からの復旧（レビュー指摘 #5）', () => {
  it('訂正の業務データ書き込みが失敗しても、次の処理でジャーナルから再適用され確定版が失われない', () => {
    const h = new Harness();
    h.setupStore();
    const ids = [h.addStaff('A', '482913', { rate: 1100 }), h.addStaff('B', '582914', { rate: 1200 }), h.addStaff('C', '682915', { rate: 1300 })];
    h.setNow('2026-12-05', '10:00');
    for (const id of ids) {
      for (let d = 2; d <= 20; d++) {
        const day = `2026-11-${String(d).padStart(2, '0')}`;
        h.ownerOk('attendance.correct', { employeeId: id, action: 'add', type: 'clock_in', at: `${day}T10:00`, reason: 'テストデータ' });
        h.ownerOk('attendance.correct', { employeeId: id, action: 'add', type: 'clock_out', at: `${day}T15:00`, reason: 'テストデータ' });
      }
    }
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    for (const id of ids) h.ownerOk('deductions.upsert', { employeeId: id, periodId: p.id, status: 'explicit_none' });
    h.ownerOk('payroll.confirm', { periodId: p.id });
    // 訂正の業務データ書き込み（flush 内 2 回目の write）で失敗させる
    h.env.adapter.failOnWrite = (h.env.adapter as any).writes + 2;
    expect(h.owner('payroll.correct', { periodId: p.id, employeeId: ids[0], reason: '再計算' }).ok).toBe(false);
    h.env.adapter.failOnWrite = null;
    h.ownerOk('system.setMaintenance', { on: false }); // 任意の更新系処理でジャーナル再適用
    const res = h.ownerOk<any[]>('payroll.results', { periodId: p.id }).filter((r) => r.employeeId === ids[0]);
    expect(res.find((r) => r.status === 'confirmed')?.revision).toBe(2);
    expect(res.find((r) => r.status === 'superseded')?.revision).toBe(1);
    expect(h.ownerOk('system.integrityCheck').ok).toBe(true);
  });
});
