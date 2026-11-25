/**
 * Codex 独立監査 1 回目（docs/reviews/codex-audit-1.md）の指摘に対する回帰テスト
 * 期待値は指摘の再現条件から手計算したもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { UnitOfWork } from '../../src/backend/store';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

describe('Codex 監査1 #10: 月初に直前月のセッション・冪等性キーを参照する', () => {
  it('11/30 23:59:55 にログインしたセッションが 12/1 00:00:02 にも有効', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.setNow('2026-11-30', '23:59');
    h.advance(55_000);
    h.login(a, '482913');
    h.setNow('2026-12-01', '00:00');
    h.advance(2_000);
    expect(code(h.staff('auth.me'))).toBe('OK');
  });

  it('11/30 に保存した打刻を 12/1 に同じ requestId で再送しても二重登録しない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.setNow('2026-11-30', '23:59');
    h.login(a, '482913');
    const r1 = h.staffOk('attendance.punch', { type: 'clock_in' }, { requestId: 'req_month_end_01' });
    h.setNow('2026-12-01', '00:00');
    h.advance(10_000);
    const r2 = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'req_month_end_01' }) as any;
    expect(r2.ok).toBe(true);
    expect(r2.data.eventId).toBe(r1.eventId);
    expect(r2.data.replayed).toBe(true);
  });
});

describe('Codex 監査1 #14: 同じ秒内の打刻', () => {
  it('同じ秒の「退勤→再出勤」は後の打刻を受け付けず、成功と表示しない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.setNow('2026-11-02', '18:00');
    h.login(a, '482913');
    expect(code(h.punch('clock_out'))).toBe('OK');
    h.advance(400);
    expect(code(h.punch('clock_in'))).toBe('TOO_SOON');
    h.advance(1000);
    expect(code(h.punch('clock_in'))).toBe('OK');
    const ss = h.ownerOk<any[]>('attendance.list', { from: '2026-11-02', to: '2026-11-02' })[0].sessions;
    expect(ss).toHaveLength(2);
  });

  it('勤怠修正で同時刻に「退勤」「出勤」を登録しても再出勤が消えない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.setNow('2026-11-03', '10:00');
    for (const [type, t] of [['clock_out', '18:00'], ['clock_in', '18:00'], ['clock_out', '20:00']] as const) {
      h.ownerOk('attendance.correct', { employeeId: a, action: 'add', type, at: `2026-11-02T${t}`, reason: '紙の記録から登録' });
    }
    const ss = h.ownerOk<any[]>('attendance.list', { from: '2026-11-02', to: '2026-11-02' })[0].sessions;
    expect(ss.map((s: any) => s.workMinutes)).toEqual([540, 120]);
  });
});

describe('Codex 監査1 #3: 締め日前の正式確定', () => {
  it('期間（12/1〜12/31）の終了前は確定できず、翌日の営業日切替時刻（05:00）以降は確定できる', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('試験', '482913', { rate: 1200 });
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-12' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    expect(code(h.owner('payroll.confirm', { periodId: p.id }))).toBe('PAYROLL_BLOCKED');
    h.setNow('2027-01-01', '04:59');
    expect(code(h.owner('payroll.confirm', { periodId: p.id }))).toBe('PAYROLL_BLOCKED');
    h.setNow('2027-01-01', '05:00');
    expect(code(h.owner('payroll.confirm', { periodId: p.id }))).toBe('OK');
  });
});

describe('Codex 監査1 #4: 締め日変更時の給与期間', () => {
  it('末締めで 12 月分を作成後に 20 日締めへ変更すると、1 月分は 2027-01-01 開始（重複しない）', () => {
    const h = new Harness();
    h.setupStore();
    const dec = h.ownerOk('payroll.openPeriod', { periodKey: '2026-12' });
    expect([dec.from, dec.to]).toEqual(['2026-12-01', '2026-12-31']);
    h.ownerOk('settings.update', { payrollClosingDay: 20, payMonthOffset: 1, payDay: 10 });
    const jan = h.ownerOk('payroll.openPeriod', { periodKey: '2027-01' });
    expect([jan.from, jan.to]).toEqual(['2027-01-01', '2027-01-20']);
    const feb = h.ownerOk('payroll.openPeriod', { periodKey: '2027-02' });
    expect([feb.from, feb.to]).toEqual(['2027-01-21', '2027-02-20']);
  });

  it('既存の期間と重なる期間は作成できない（前月が未作成で後の月が作成済みの場合）', () => {
    const h = new Harness();
    h.setupStore();
    h.ownerOk('settings.update', { payrollClosingDay: 20, payMonthOffset: 1, payDay: 10 });
    h.ownerOk('payroll.openPeriod', { periodKey: '2027-01' }); // 2026-12-21〜2027-01-20
    h.ownerOk('settings.update', { payrollClosingDay: 0, payMonthOffset: 1, payDay: 10 });
    expect(code(h.owner('payroll.openPeriod', { periodKey: '2026-12' }))).toBe('INVALID_INPUT'); // 2026-12-01〜12-31 は重なる
  });
});

describe('Codex 監査1 #5: 月60時間の起算週の遡り', () => {
  it('起算日（毎月1日）が週の途中でも、その週の前月分を含めて週次時間外を数える', () => {
    // 週: 月曜起算・40時間、法定休日: 日曜、60時間起算日: 毎月1日、給与期間: 2026-12-21〜2027-01-20、時給1,200円
    const h = new Harness();
    h.setupStore();
    h.ownerOk('settings.update', { weekStartDay: 1, statutoryHolidayWeekday: 0, overtime60StartDay: 1, payrollClosingDay: 20, payMonthOffset: 1, payDay: 10 });
    h.ownerOk('settings.confirmPayrollRules');
    const a = h.addStaff('試験', '482913', { rate: 1200 });
    const day = (d: string, from: string, to: string) => {
      h.punchAt(a, '482913', d, from, 'clock_in');
      h.punchAt(a, '482913', d, to, 'clock_out');
    };
    // 11/30(月)〜12/5(土) 各8時間 → 週48時間。12/5 の8時間は週の時間外（12月の60時間に算入）
    for (const d of ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05']) day(d, '09:00', '17:00');
    // 12/7〜10・12/14〜17 各14時間 → 1日6時間 × 8日 = 48時間の時間外。12/20 時点の累計 56時間
    for (const d of ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17']) day(d, '08:00', '22:00');
    // 12/21(月) 9:00〜24:00、休憩 12:00〜13:00 → 実働14時間、時間外 18:00〜24:00（累計56→62時間）
    h.punchAt(a, '482913', '2026-12-21', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-12-21', '12:00', 'break_start');
    h.punchAt(a, '482913', '2026-12-21', '13:00', 'break_end');
    h.punchAt(a, '482913', '2026-12-22', '00:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2027-01' });
    expect([p.from, p.to]).toEqual(['2026-12-21', '2027-01-20']);
    const emp = h.ownerOk('payroll.compute', { periodId: p.id }).employees.find((x: any) => x.employeeId === a);
    // 基本 14h×1,200=16,800 ＋ 時間外25%（18〜22時 4h）1,200 ＋ 60時間超50%（22〜24時 2h）1,200 ＋ 深夜25%（2h）600 = 19,800
    expect(emp.totals.grossPay).toBe(19800);
  });
});

describe('Codex 監査1 #6・#7: 手当を含む割増算定基礎', () => {
  const grossFor = (h: Harness, a: string) => {
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.setNow('2026-12-01', '06:00');
    return h.ownerOk('payroll.compute', { periodId: p.id }).employees.find((x: any) => x.employeeId === a).totals.grossPay;
  };

  it('#6 深夜割増込み時給（1,500円、算定基礎1,200円）＋算入手当（時間給200円）: 22〜23時の1時間は 1,750円', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('試験', '482913', { rate: 1200 });
    h.ownerOk('payconf.upsertWageRule', { employeeId: a, kind: 'timeband', hourlyRate: 1500, timeFrom: '22:00', timeTo: '29:00', effectiveFrom: '2025-01-01', priority: 10, includesNightPremium: true, premiumBaseRate: 1200 });
    h.ownerOk('payconf.upsertAllowance', { employeeId: a, name: '資格手当', kind: 'per_hour', amount: 200, effectiveFrom: '2025-01-01', premiumBaseCategory: 'include', includeInMinimumWage: false });
    h.punchAt(a, '482913', '2026-11-02', '22:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '23:00', 'clock_out');
    // 1,500（深夜込み時給）＋200（手当）＋差額 (1,200＋200)×25% − 300 = 50 → 1,750
    expect(grossFor(h, a)).toBe(1750);
  });

  it('#7 11/15 から有効な算入手当（時間給200円）を 11/2 の時間外割増に使わない: 9時間勤務は 11,100円', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('試験', '482913', { rate: 1200 });
    h.ownerOk('payconf.upsertAllowance', { employeeId: a, name: '資格手当', kind: 'per_hour', amount: 200, effectiveFrom: '2026-11-15', premiumBaseCategory: 'include', includeInMinimumWage: false });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '18:00', 'clock_out');
    // 9h×1,200=10,800 ＋ 時間外1h×1,200×25%=300（手当は適用前のため算入しない・支給もしない）
    expect(grossFor(h, a)).toBe(11100);
  });
});

describe('Codex 監査1 #1・#2: 復元', () => {
  it('#1 バックアップと同じ秒に保存した退勤、バックアップ後に追加したスタッフの打刻も復元後に残る', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.setNow('2026-11-02', '18:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.advance(400); // 同じ秒（18:00:00.400）
    h.login(a, '482913');
    expect(h.punch('clock_out').ok).toBe(true);
    h.staff('auth.logout');
    h.session = '';
    h.setNow('2026-11-02', '18:30');
    const b = h.addStaff('佐藤', '582914');
    h.punchAt(b, '582914', '2026-11-02', '19:00', 'clock_in');
    h.setNow('2026-11-02', '19:10');
    const r = h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    expect(r.integrity.ok).toBe(true);
    const detA = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(detA.originals.map((x: any) => x.type)).toEqual(['clock_in', 'clock_out']);
    const detB = h.ownerOk('attendance.detail', { employeeId: b, from: '2026-11-02', to: '2026-11-02' });
    expect(detB.originals.map((x: any) => x.type)).toEqual(['clock_in']);
  });

  it('#2 復元しても変更後の PIN・取り消した権限・退職状態はバックアップ時点に戻らない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { perms: ['punch_self', 'payslip_view_self', 'payslip_view_others'] });
    const c = h.addStaff('鈴木', '682915');
    h.setNow('2026-11-02', '10:00');
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.setNow('2026-11-02', '11:00');
    h.ownerOk('credentials.setPin', { employeeId: a, pin: '739154' });
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'payslip_view_self'] });
    h.ownerOk('employees.retire', { employeeId: c, retireDate: '2026-11-02', reason: '退職' });
    h.setNow('2026-11-02', '12:00');
    h.ownerOk('backup.restore', { backupId: bk.id, confirmText: '復元する' });
    expect(code(h.staff('auth.login', { employeeId: a, pin: '482913' }, { session: '' }))).not.toBe('OK');
    h.setNow('2026-11-02', '12:01');
    h.login(a, '739154');
    const perms = h.ownerOk<any[]>('employees.list').find((e: any) => e.id === a);
    expect(JSON.stringify(perms)).not.toContain('payslip_view_others');
    expect(h.ownerOk<any[]>('employees.list', { includeRetired: true }).find((e: any) => e.id === c).status).toBe('retired');
  });
});

describe('Codex 監査1 #13: 整合性 NG での更新完了', () => {
  it('整合性チェックが不合格ならメンテナンスを継続し、管理者の明示的な承認があれば完了する', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    // 存在しないスタッフを参照する行（不整合）を直接書き込む
    const raw = new UnitOfWork(h.env.adapter, { now: () => h.env.clock.now, newId: (p) => `${p}_orphan01` });
    raw.insert('permissions', { employeeId: 'emp_missing0001', permissions: [] } as never);
    raw.flush();
    h.login(a, '482913');
    h.ownerOk('system.prepareUpdate', { targetVersion: '0.2.0' });
    h.ownerOk('system.migrate', {});
    expect(code(h.owner('system.finishUpdate'))).toBe('UPDATE_INTEGRITY_FAILED');
    expect(code(h.punch('clock_in'))).toBe('MAINTENANCE');
    const r = h.ownerOk('system.finishUpdate', { acceptIntegrityIssues: true });
    expect(r.integrity.ok).toBe(false);
    expect(code(h.punch('clock_in'))).toBe('OK');
  });
});

describe('Codex 監査1 #11: 保存結果が不明な打刻の再送', () => {
  it('業務データの書き込み途中で失敗しても、同じ requestId で再送すれば打刻は1件だけ（二重登録しない）', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913');
    h.setNow('2026-11-02', '09:00');
    h.login(a, '482913');
    const ad = h.env.adapter as any;
    ad.failOnWrite = ad.writes + 2; // ジャーナル（started）の次＝業務データの書き込みで失敗
    const r1 = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'req_unknown_0001' });
    expect(code(r1)).toBe('INTERNAL');
    ad.failOnWrite = null;
    h.advance(5_000);
    const r2 = h.staff('attendance.punch', { type: 'clock_in' }, { requestId: 'req_unknown_0001' }) as any;
    expect(r2.ok).toBe(true);
    const det = h.ownerOk('attendance.detail', { employeeId: a, from: '2026-11-02', to: '2026-11-02' });
    expect(det.originals.filter((x: any) => x.type === 'clock_in')).toHaveLength(1);
  });
});
