import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { handleRequest, listOps, signOwnerEnvelope, verifyOwnerEnvelope, SECRET_KEYS } from '../../src/backend/index';
import { fromHex } from '../../src/shared/crypto';

function setup() {
  const h = new Harness();
  h.setupStore();
  const a = h.addStaff('山田', '482913', { rate: 1100 });
  const b = h.addStaff('佐藤', '582914', { rate: 1200 });
  return { h, a, b };
}

const code = (r: any) => (r.ok ? 'OK' : r.error.code);

describe('認証', () => {
  it('未認証・未登録端末からは public 以外の操作ができない', () => {
    const { h } = setup();
    for (const op of listOps()) {
      if (op.auth === 'public') continue;
      const r = handleRequest(h.be, { op: op.name, args: {}, requestId: 'anon_00000001' });
      expect(r.ok, op.name).toBe(false);
      expect(['DEVICE_NOT_REGISTERED', 'FORBIDDEN', 'UNAUTHENTICATED'], op.name).toContain(code(r));
    }
  });
  it('public 操作は限定（status / enroll）で、未登録端末に店舗名を返さない', () => {
    const { h } = setup();
    const pub = listOps().filter((o) => o.auth === 'public').map((o) => o.name).sort();
    expect(pub).toEqual(['kiosk.enroll', 'system.status']);
    const r: any = handleRequest(h.be, { op: 'system.status' });
    expect(r.data.storeName).toBeNull();
  });
  it('店長専用操作は登録端末＋スタッフセッションからは実行できない（全 owner 操作）', () => {
    const { h, a } = setup();
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'staff_manage', 'payroll_view_all', 'payroll_confirm', 'attendance_edit'] });
    h.login(a, '482913');
    for (const op of listOps().filter((o) => o.auth === 'owner')) {
      const r = h.kiosk(op.name, {});
      expect(code(r), op.name).toBe('FORBIDDEN');
    }
  });
  it('ブラウザ入力で owner を名乗っても無視される', () => {
    const { h } = setup();
    const r = handleRequest(h.be, { op: 'settings.get', device: h.device, principal: 'owner', trusted: 'owner' } as any);
    expect(r.ok).toBe(false);
  });
  it('失効した端末・ログアウト済み・期限切れセッションは拒否', () => {
    const { h, a } = setup();
    h.login(a, '482913');
    expect(h.kiosk('auth.me').ok).toBe(true);
    h.advance(10 * 60_000); // 無操作 60 秒（+猶予）を超過
    expect(code(h.kiosk('auth.me'))).toBe('UNAUTHENTICATED');
    h.login(a, '482913');
    h.kioskOk('auth.logout');
    expect(code(h.kiosk('auth.me'))).toBe('UNAUTHENTICATED');
    h.login(a, '482913');
    const dev = h.ownerOk<any[]>('devices.list')[0];
    h.ownerOk('devices.revoke', { deviceId: dev.id });
    expect(code(h.kiosk('auth.me'))).toBe('DEVICE_NOT_REGISTERED');
    expect(code(h.kiosk('kiosk.bootstrap'))).toBe('DEVICE_NOT_REGISTERED');
  });
  it('セッションは発行端末に紐づく（別端末のトークンでは使えない）', () => {
    const { h, a } = setup();
    h.login(a, '482913');
    const sess = h.session;
    const en = h.ownerOk('devices.createEnrollment', { deviceName: '2台目' });
    const d2 = h.kioskOk('kiosk.enroll', { code: en.code }, { device: '' }).deviceToken;
    expect(code(h.kiosk('auth.me', undefined, { device: d2, session: sess }))).toBe('UNAUTHENTICATED');
  });
  it('登録コードは使い捨て・期限付き', () => {
    const { h } = setup();
    const en = h.ownerOk('devices.createEnrollment', { deviceName: 'x' });
    expect(h.kiosk('kiosk.enroll', { code: en.code }, { device: '' }).ok).toBe(true);
    expect(h.kiosk('kiosk.enroll', { code: en.code }, { device: '' }).ok).toBe(false);
    const en2 = h.ownerOk('devices.createEnrollment', { deviceName: 'y' });
    h.advance(16 * 60_000);
    expect(h.kiosk('kiosk.enroll', { code: en2.code }, { device: '' }).ok).toBe(false);
  });
});

describe('PIN 総当たり対策', () => {
  it('連続失敗で一時ロック、ロック中は正しい PIN でも拒否、時間経過で解除', () => {
    const { h, a } = setup();
    for (let i = 0; i < 4; i++) expect(code(h.kiosk('auth.login', { employeeId: a, pin: '000001' }, { session: '' }))).toBe('INVALID_INPUT');
    expect(code(h.kiosk('auth.login', { employeeId: a, pin: '000001' }, { session: '' }))).toBe('LOCKED');
    expect(code(h.kiosk('auth.login', { employeeId: a, pin: '482913' }, { session: '' }))).toBe('LOCKED');
    h.advance(16 * 60_000);
    expect(h.kiosk('auth.login', { employeeId: a, pin: '482913' }, { session: '' }).ok).toBe(true);
  });
  it('端末単位の失敗上限（複数スタッフへの横断的な試行）', () => {
    const { h, a, b } = setup();
    const c = h.addStaff('鈴木', '682915');
    const d = h.addStaff('高橋', '782916');
    const e = h.addStaff('田中', '882917');
    // 各スタッフ 4 回ずつ（個人ロック未満）× 5 名 = 20 回失敗（端末上限 20 回）
    for (const id of [a, b, c, d, e]) for (let i = 0; i < 4; i++) expect(code(h.kiosk('auth.login', { employeeId: id, pin: '000001' }, { session: '' }))).toBe('INVALID_INPUT');
    // 21 回目以降は端末単位で制限（正しい PIN でも拒否）
    expect(code(h.kiosk('auth.login', { employeeId: a, pin: '482913' }, { session: '' }))).toBe('RATE_LIMITED');
  });
  it('PIN は平文保存しない（DB に PIN 文字列が現れない）', () => {
    const { h } = setup();
    const dump = JSON.stringify(h.env.adapter.snapshot());
    expect(dump).not.toContain('482913');
    expect(dump).not.toContain(h.env.secrets.get(SECRET_KEYS.pepper)!);
  });
});

describe('認可・IDOR・なりすまし', () => {
  it('他人の給与明細は個別権限＋追加認証なしに閲覧できない', () => {
    const { h, a, b } = setup();
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    for (const id of [a, b]) h.ownerOk('deductions.upsert', { employeeId: id, periodId: p.id, status: 'explicit_none' });
    h.ownerOk('payroll.confirm', { periodId: p.id });
    h.ownerOk('payslips.issue', { periodId: p.id });
    const slips = h.ownerOk<any[]>('payslips.list', { periodId: p.id });
    const bSlip = slips.find((s) => s.employeeId === b);
    h.login(a, '482913');
    expect(code(h.kiosk('payslips.view', { payslipId: bSlip.id }))).toBe('FORBIDDEN');
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'payslip_view_self', 'payslip_view_others'] });
    expect(code(h.kiosk('payslips.view', { payslipId: bSlip.id }))).toBe('STEP_UP_REQUIRED');
    h.ownerOk('credentials.setStepUp', { employeeId: a, passcode: 'Kanri2026pass' });
    expect(code(h.kiosk('auth.stepUp', { passcode: 'wrongpass99' }))).toBe('INVALID_INPUT');
    h.kioskOk('auth.stepUp', { passcode: 'Kanri2026pass' });
    expect(h.kiosk('payslips.view', { payslipId: bSlip.id }).ok).toBe(true);
    h.advance(50_000);
    h.kioskOk('auth.me');
    h.advance(50_000);
    h.kioskOk('auth.me');
    h.advance(50_000);
    h.kioskOk('auth.me');
    h.advance(50_000);
    h.kioskOk('auth.me');
    h.advance(50_000);
    h.kioskOk('auth.me');
    h.advance(50_000);
    // 追加認証は 5 分で失効
    expect(code(h.kiosk('payslips.view', { payslipId: bSlip.id }))).toBe('STEP_UP_REQUIRED');
  });
  it('payslips.pdf（ダウンロード）は店長専用で共用 iPad からは不可', () => {
    const { h, a } = setup();
    h.login(a, '482913');
    expect(code(h.kiosk('payslips.pdf', { payslipId: 'slp_x' }))).toBe('FORBIDDEN');
  });
  it('権限変更は既存セッションの次の操作から反映', () => {
    const { h, a } = setup();
    h.login(a, '482913');
    expect(h.kiosk('attendance.mine', { from: '2026-11-01', to: '2026-11-30' }).ok).toBe(true);
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self'] });
    expect(code(h.kiosk('attendance.mine', { from: '2026-11-01', to: '2026-11-30' }))).toBe('FORBIDDEN');
  });
  it('スタッフ管理権限でも権限変更・PIN変更・自己の給与条件変更はできない（昇格・なりすまし防止）', () => {
    const { h, a, b } = setup();
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'staff_manage', 'pay_conditions_edit', 'attendance_edit', 'payroll_confirm'] });
    h.ownerOk('credentials.setStepUp', { employeeId: a, passcode: 'Kanri2026pass' });
    h.login(a, '482913');
    h.kioskOk('auth.stepUp', { passcode: 'Kanri2026pass' });
    expect(code(h.kiosk('permissions.set', { employeeId: a, permissions: ['payroll_view_all'] }))).toBe('FORBIDDEN');
    expect(code(h.kiosk('credentials.setPin', { employeeId: b, pin: '123987' }))).toBe('FORBIDDEN');
    expect(code(h.kiosk('payconf.upsertWageRule', { employeeId: a, kind: 'base', hourlyRate: 9999, effectiveFrom: '2026-11-01', priority: 99 }))).toBe('FORBIDDEN');
    expect(code(h.kiosk('attendance.correct', { employeeId: a, action: 'add', type: 'clock_in', at: '2026-11-01T09:00', reason: '自分の修正' }))).toBe('FORBIDDEN');
    expect(code(h.kiosk('payroll.confirm', { periodId: 'x', employeeIds: [a] }))).not.toBe('OK');
    expect(h.kiosk('payconf.upsertWageRule', { employeeId: b, kind: 'base', hourlyRate: 1300, effectiveFrom: '2026-11-01', priority: 1 }).ok).toBe(true);
  });
  it('機密操作はスタッフの場合ステップアップ必須', () => {
    const { h, a, b } = setup();
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'pay_conditions_edit'] });
    h.login(a, '482913');
    expect(code(h.kiosk('payconf.get', { employeeId: b }))).toBe('STEP_UP_REQUIRED');
  });
  it('本人用操作で他人の employeeId を指定しても自分のデータしか返らない', () => {
    const { h, a, b } = setup();
    h.punchAt(b, '582914', '2026-11-02', '09:00', 'clock_in');
    h.login(a, '482913');
    const r = h.kioskOk('attendance.mine', { from: '2026-11-01', to: '2026-11-30', employeeId: b });
    expect(r.sessions).toHaveLength(0);
  });
  it('人件費分析: 給与閲覧権限がなければスタッフ別内訳・1名のみの日を返さない', () => {
    const { h, a, b } = setup();
    h.punchAt(b, '582914', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(b, '582914', '2026-11-02', '13:00', 'clock_out');
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'labor_cost_view'] });
    h.ownerOk('credentials.setStepUp', { employeeId: a, passcode: 'Kanri2026pass' });
    h.login(a, '482913');
    h.kioskOk('auth.stepUp', { passcode: 'Kanri2026pass' });
    const r = h.kioskOk('analytics.laborCost', { month: '2026-11' });
    expect(r.individualVisible).toBe(false);
    expect(r.actual.byEmployee).toEqual([]);
    expect(r.actual.byDate['2026-11-02'].amount).toBeNull();
  });
  it('スタッフ端末からの出力はファイル本体を返さず店長の Drive に保存のみ', () => {
    const { h, a } = setup();
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'export_attendance'] });
    h.ownerOk('credentials.setStepUp', { employeeId: a, passcode: 'Kanri2026pass' });
    h.login(a, '482913');
    h.kioskOk('auth.stepUp', { passcode: 'Kanri2026pass' });
    const r = h.kioskOk('export.attendance', { from: '2026-11-01', to: '2026-11-30', format: 'csv' });
    expect(r.savedToDrive).toBe(true);
    expect(r.base64).toBeUndefined();
  });
  it('任意のファイルID・シート名を指定する汎用操作は存在しない', () => {
    const names = listOps().map((o) => o.name);
    expect(names.some((n) => /sheet|file|drive|raw|query/i.test(n))).toBe(false);
  });
  it('kiosk.bootstrap は氏名以外（給与・勤怠詳細）を返さない', () => {
    const { h } = setup();
    const r = h.kioskOk('kiosk.bootstrap');
    for (const s of r.staff) expect(Object.keys(s).sort()).toEqual(['displayName', 'id', 'kana']);
  });
  it('requestId の他人への流用・別操作での再利用は拒否', () => {
    const { h, a, b } = setup();
    h.login(a, '482913');
    h.kiosk('attendance.punch', { type: 'clock_in' }, { requestId: 'shared_rid_0001' });
    h.login(b, '582914');
    expect(code(h.kiosk('attendance.punch', { type: 'clock_in' }, { requestId: 'shared_rid_0001' }))).toBe('CONFLICT');
  });
});

describe('Admin → Core 署名付きリクエスト', () => {
  it('正しい署名のみ受理。改ざん・期限切れ・リプレイは拒否', () => {
    const { h } = setup();
    const p = h.env.platform;
    p.secrets.set(SECRET_KEYS.adminHmac, p.randomHex(32));
    const key = fromHex(p.secrets.get(SECRET_KEYS.adminHmac)!);
    const body = JSON.stringify({ op: 'settings.get' });
    const env = signOwnerEnvelope(p, key, body);
    expect(verifyOwnerEnvelope(p, env)).toBe(body);
    expect(() => verifyOwnerEnvelope(p, env)).toThrow(); // リプレイ
    const env2 = signOwnerEnvelope(p, key, body);
    expect(() => verifyOwnerEnvelope(p, { ...env2, body: JSON.stringify({ op: 'permissions.set' }) })).toThrow(); // 改ざん
    const env3 = signOwnerEnvelope(p, key, body);
    h.advance(61_000);
    expect(() => verifyOwnerEnvelope(p, env3)).toThrow(); // 期限切れ
    const wrong = signOwnerEnvelope(p, fromHex('00'.repeat(32)), body);
    expect(() => verifyOwnerEnvelope(p, wrong)).toThrow();
  });
});

describe('入力検証・情報漏えい', () => {
  it('内部エラーの詳細を応答に含めない', () => {
    const { h } = setup();
    const r: any = h.owner('attendance.list', { from: '2026-13-01', to: 'x' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/stack|at Object|\.ts:/);
  });
  it('監査ログに PIN・トークンを記録しない', () => {
    const { h, a } = setup();
    h.login(a, '482913');
    const month = '2026-11';
    const logs = h.ownerOk<any[]>('audit.list', { month });
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain('482913');
    expect(dump).not.toContain(h.session);
    expect(dump).not.toContain(h.device);
  });
});

describe('秘密値の非保存（レビュー指摘 #3 の回帰テスト）', () => {
  it('端末トークン・セッショントークンの平文が DB のどのセルにも残らない', () => {
    const { h, a } = setup();
    h.login(a, '482913');
    h.punch('clock_in');
    const dump = JSON.stringify(h.env.adapter.snapshot());
    expect(dump).not.toContain(h.device);
    expect(dump).not.toContain(h.session);
  });
  it('秘密値を返す操作の再送は保存済み応答を返さない', () => {
    const { h, a } = setup();
    const r1 = h.kiosk('auth.login', { employeeId: a, pin: '482913' }, { session: '', requestId: 'login_rid_0001' });
    expect(r1.ok).toBe(true);
    const r2 = h.kiosk('auth.login', { employeeId: a, pin: '482913' }, { session: '', requestId: 'login_rid_0001' });
    expect(r2.ok).toBe(false);
  });
});
