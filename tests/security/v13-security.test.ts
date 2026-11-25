/**
 * v1.3 のセキュリティテスト（全 API 操作を対象に、管理者モード・本人未確認セッションの権限境界を検査）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { handleRequest, listOps } from '../../src/backend/index';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);
const ADMIN_PW = 'Store#Manager2026';

function setup() {
  const h = new Harness();
  h.setupStore();
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  const e = h.ownerOk('employees.create', { displayName: '佐藤', kana: 'さとう', payType: 'hourly', hireDate: '2025-01-01' });
  h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
  return { h, a, noPin: e.id as string };
}

describe('管理者モード（管理者パスワード）の権限境界', () => {
  it('Google 所有者に限定した操作（adminAllowed なしの owner 操作）は、管理者モードでは全件拒否', () => {
    const { h } = setup();
    const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    const ownerOnly = listOps().filter((o) => o.auth === 'owner' && !o.adminAllowed);
    expect(ownerOnly.map((o) => o.name)).toEqual(expect.arrayContaining(['adminAuth.setPassword', 'system.prepareUpdate', 'system.migrate', 'system.finishUpdate', 'system.initialize']));
    for (const op of ownerOnly) expect(code(handleRequest(h.be, { op: op.name, args: {}, requestId: h.rid(), device: h.device, adminSession: t })), op.name).toBe('FORBIDDEN');
  });
  it('スタッフ本人用の操作（session）は管理者モードでは全件拒否', () => {
    const { h } = setup();
    const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    for (const op of listOps().filter((o) => o.auth === 'session')) {
      const r = handleRequest(h.be, { op: op.name, args: {}, requestId: h.rid(), device: h.device, adminSession: t });
      expect(['FORBIDDEN', 'UNAUTHENTICATED'], op.name).toContain(code(r));
    }
  });
  it('管理者セッションなし（端末トークンのみ）では、管理者が実行できる操作を実行できない', () => {
    const { h } = setup();
    for (const op of listOps().filter((o) => o.auth === 'admin' || (o.auth === 'owner' && o.adminAllowed))) {
      const r = handleRequest(h.be, { op: op.name, args: {}, requestId: h.rid(), device: h.device });
      expect(code(r), op.name).not.toBe('OK');
    }
  });
  it('偽の・形式不正な管理者トークンは拒否', () => {
    const { h } = setup();
    for (const t of ['', 'x', '0'.repeat(64), 'f'.repeat(64), { a: 1 }]) {
      const r = handleRequest(h.be, { op: 'settings.get', requestId: h.rid(), device: h.device, adminSession: t as never });
      expect(code(r)).not.toBe('OK');
    }
  });
  it('重要操作は reauth 指定されている（給与確定・訂正・権限変更・復元・PIN 設定/解除・端末登録/失効）', () => {
    const names = new Set(listOps().filter((o) => o.reauth).map((o) => o.name));
    for (const n of ['payroll.confirm', 'payroll.correct', 'permissions.set', 'backup.restore', 'credentials.setPin', 'credentials.clearPin', 'credentials.setStepUp', 'devices.createEnrollment', 'devices.revoke', 'settings.confirmPayrollRules'])
      expect(names.has(n), n).toBe(true);
  });
  it('管理者の総当たり: 端末単位の上限を超えると正しいパスワードでも一時的に拒否', () => {
    const { h } = setup();
    // 個別ロックの影響を避けるため、ロックのたびに Google 所有者が解除する
    for (let i = 0; i < 10; i++) {
      h.staff('adminAuth.login', { password: 'Wrong#Password99' }, { session: '' });
      if (i % 4 === 3) h.ownerOk('adminAuth.unlock');
    }
    h.ownerOk('adminAuth.unlock');
    expect(code(h.staff('adminAuth.login', { password: ADMIN_PW }, { session: '' }))).toBe('RATE_LIMITED');
  });
});

describe('本人未確認（PIN 未設定）セッションの権限境界', () => {
  it('allowUnverified の操作のみ実行でき、それ以外の全操作は拒否', () => {
    const { h, noPin } = setup();
    const s = h.staffOk('auth.login', { employeeId: noPin, pin: null }, { session: '' }).sessionToken;
    const allowed = new Set(listOps().filter((o) => o.allowUnverified).map((o) => o.name));
    expect([...allowed].sort()).toEqual(['attendance.clockOutContext', 'attendance.lookup', 'attendance.punch', 'attendance.selfCorrect', 'auth.logout', 'auth.me', 'breaks.declare', 'overtime.request', 'shifts.published'].sort());
    for (const op of listOps().filter((o) => (o.auth === 'session' || o.auth === 'staff_or_owner') && !o.allowUnverified)) {
      const r = handleRequest(h.be, { op: op.name, args: {}, requestId: h.rid(), device: h.device, session: s });
      expect(['IDENTITY_REQUIRED', 'FORBIDDEN'], op.name).toContain(code(r));
    }
  });
  it('委任権限を持つスタッフでも、PIN 未設定なら管理メニューの操作はできない', () => {
    const { h, noPin } = setup();
    h.ownerOk('permissions.set', { employeeId: noPin, permissions: ['punch_self', 'attendance_view_all', 'attendance_edit', 'payroll_view_all'] });
    const r = h.staffOk('auth.login', { employeeId: noPin, pin: null }, { session: '' });
    expect(r.permissions.sort()).toEqual(['punch_self']);
    expect(code(h.staff('attendance.list', { from: '2026-11-01', to: '2026-11-02' }, { session: r.sessionToken }))).toBe('IDENTITY_REQUIRED');
  });
  it('本人未確認で発行したセッションは、その後 PIN が設定されても本人確認済みにならない', () => {
    const { h, noPin } = setup();
    const s = h.staffOk('auth.login', { employeeId: noPin, pin: null }, { session: '' }).sessionToken;
    h.ownerOk('credentials.setPin', { employeeId: noPin, pin: '0739' });
    // PIN 設定でセッションは失効
    expect(code(h.staff('auth.me', undefined, { session: s }))).toBe('UNAUTHENTICATED');
  });
  it('スタッフは管理者向けの確認・登録 API を自分の勤怠に使えない（委任権限があっても）', () => {
    const { h, a } = setup();
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'attendance_view_self', 'attendance_view_all', 'attendance_edit'] });
    h.ownerOk('credentials.setStepUp', { employeeId: a, passcode: 'Passcode2026x' });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '12:00', 'clock_out');
    h.setNow('2026-11-02', '13:00');
    h.login(a, '482913');
    h.staffOk('auth.stepUp', { passcode: 'Passcode2026x' });
    expect(code(h.staff('offshift.confirm', { comment: '自己承認', items: [{ employeeId: a, start: '2026-11-02T08:00', end: '2026-11-02T09:00', result: 'work', category: 'early' }] }))).toBe('FORBIDDEN');
    const req = h.staffOk('overtime.request', { category: 'early', start: '2026-11-02T08:30', end: '2026-11-02T09:00', reason: '準備' });
    expect(code(h.staff('overtime.review', { requestId: req.id, action: 'approve' }))).toBe('FORBIDDEN');
    expect(code(h.staff('attendance.adminCorrectSession', { employeeId: a, clockIn: '2026-11-02T08:00', clockOut: '2026-11-02T12:00', reason: '自己' }))).toBe('FORBIDDEN');
  });
});
