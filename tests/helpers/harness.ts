/** 統合・セキュリティテスト用ハーネス（メモリ上のモック環境で Core API を直接呼ぶ） */
import { handleRequest, type ApiResponse } from '../../src/backend/index';
import { createMockEnv, type MockEnv } from '../../src/backend/mock';
import { localDateTime } from '../../src/shared/time';

export class Harness {
  env: MockEnv;
  device = '';
  session = '';
  private seq = 0;
  constructor(now = localDateTime('2026-11-02', '10:00')) {
    this.env = createMockEnv({ now });
  }
  get be() {
    return { p: this.env.platform, adapter: () => this.env.adapter };
  }
  setNow(d: string, t: string) {
    this.env.clock.now = localDateTime(d, t);
  }
  advance(ms: number) {
    this.env.clock.now += ms;
  }
  rid() {
    return `req_${(++this.seq).toString().padStart(8, '0')}`;
  }
  owner(op: string, args?: unknown): ApiResponse {
    return handleRequest(this.be, { op, args, requestId: this.rid() }, 'owner');
  }
  ownerOk<T = any>(op: string, args?: unknown): T {
    const r = this.owner(op, args);
    if (!r.ok) throw new Error(`${op} failed: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  }
  staff(op: string, args?: unknown, o: { device?: string; session?: string; requestId?: string } = {}): ApiResponse {
    return handleRequest(this.be, { op, args, requestId: o.requestId ?? this.rid(), device: o.device ?? this.device, session: o.session ?? this.session });
  }
  staffOk<T = any>(op: string, args?: unknown, o: { device?: string; session?: string; requestId?: string } = {}): T {
    const r = this.staff(op, args, o);
    if (!r.ok) throw new Error(`${op} failed: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  }
  /**
   * 初期化・店舗設定（給与計算に必要な項目を設定済み）・端末登録
   * timeBasis: v1.2 で作成した給与・勤怠のテストは「打刻（修正後）の実績どおり」を前提とするため既定は 'actual'。
   *            v1.3 のシフト基準のテストは 'shift'（製品の既定値）を指定する
   */
  setupStore(opts: { confirmRules?: boolean; timeBasis?: 'shift' | 'actual'; breakMode?: 'scheduled' | 'punch' } = {}) {
    this.ownerOk('system.initialize', { storeName: 'テスト店舗', envId: 'env_test' });
    this.ownerOk('settings.update', {
      workingTimeSystem: 'standard', weekStartDay: 0, statutoryHolidayWeekday: 0, payrollClosingDay: 0, payMonthOffset: 1, payDay: 10,
      minimumWages: [{ effectiveFrom: '2025-10-01', hourly: 1000, label: 'テスト用（架空）', sourceNote: 'テスト' }], paidLeaveWageMethod: 'normal', agreement36: 'concluded',
      payrollTimeBasis: opts.timeBasis ?? 'actual',
      ...(opts.breakMode ? { breakMode: opts.breakMode } : {}),
    });
    if (opts.confirmRules !== false) this.ownerOk('settings.confirmPayrollRules');
    const en = this.ownerOk<{ code: string }>('devices.createEnrollment', { deviceName: '店舗iPad' });
    const r = this.staffOk<{ deviceToken: string }>('staff.enroll', { code: en.code, userAgent: 'test' }, { device: '' });
    this.device = r.deviceToken;
  }
  addStaff(name: string, pin: string, opts: { payType?: 'hourly' | 'monthly'; rate?: number; perms?: string[]; stepUp?: string } = {}) {
    const e = this.ownerOk<{ id: string }>('employees.create', { displayName: name, kana: name, payType: opts.payType ?? 'hourly', hireDate: '2025-01-01' });
    this.ownerOk('credentials.setPin', { employeeId: e.id, pin });
    if (opts.rate) this.ownerOk('payconf.upsertWageRule', { employeeId: e.id, kind: 'base', hourlyRate: opts.rate, effectiveFrom: '2025-01-01', priority: 0 });
    this.ownerOk('payconf.upsertTransport', { employeeId: e.id, method: 'none', effectiveFrom: '2025-01-01' });
    if (opts.perms) this.ownerOk('permissions.set', { employeeId: e.id, permissions: opts.perms });
    if (opts.stepUp) this.ownerOk('credentials.setStepUp', { employeeId: e.id, passcode: opts.stepUp });
    return e.id;
  }
  login(employeeId: string, pin: string) {
    const r = this.staffOk<{ sessionToken: string; state: string }>('auth.login', { employeeId, pin }, { session: '' });
    this.session = r.sessionToken;
    return r;
  }
  punch(type: string, extra: Record<string, unknown> = {}) {
    return this.staff('attendance.punch', { type, ...extra });
  }
  /** ログイン→打刻→ログアウト（共用 iPad の典型操作） */
  punchAt(employeeId: string, pin: string, d: string, t: string, type: string, extra: Record<string, unknown> = {}) {
    this.setNow(d, t);
    this.login(employeeId, pin);
    const r = this.punch(type, extra);
    if (!r.ok) throw new Error(`punch ${type} ${d} ${t}: ${r.error.message}`);
    this.staff('auth.logout');
    this.session = '';
    return r.data as any;
  }
}
