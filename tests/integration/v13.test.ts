/**
 * v1.3 追加仕様の統合テスト（メモリ上のモック Core。Google 実環境ではない）
 * - 期待値は仕様（Shiftly 追加仕様変更指示 v1.3 §9.2 等）から手計算したもの。実装の出力を写していない
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { handleRequest } from '../../src/backend/index';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);
const ADMIN_PW = 'Store#Manager2026';

/** シフト基準（製品の既定）の店舗 */
function shiftStore() {
  const h = new Harness();
  h.setupStore({ timeBasis: 'shift' });
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  return { h, a };
}

function shift(h: Harness, employeeId: string, date: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  const s = h.ownerOk('shifts.upsert', { employeeId, date, start, end, breakMinutes: 0, ...extra });
  h.ownerOk('shifts.publish', { from: date, to: date });
  return s.id as string;
}

function compute(h: Harness, employeeId: string, periodKey = '2026-11') {
  const p = h.ownerOk('payroll.openPeriod', { periodKey });
  const r = h.ownerOk('payroll.compute', { periodId: p.id });
  return r.employees.find((e: any) => e.employeeId === employeeId) as { totals: { workMinutes: number; nightMinutes: number; basePay: number }; issues: Array<{ code: string; severity: string; date?: string }> };
}

const issueCodes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

/** 管理者パスワードを設定し、店舗端末で管理者モードに入る */
function adminLogin(h: Harness) {
  h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
  const r = h.staffOk<{ adminSessionToken: string }>('adminAuth.login', { password: ADMIN_PW }, { session: '' });
  return r.adminSessionToken;
}

function asAdmin(h: Harness, token: string, op: string, args?: unknown) {
  // 最新の画面として現在の復元世代を付ける（D-026。世代の照合のテストは restore-epoch.test.ts）
  const epoch = h.currentEpoch();
  return handleRequest(h.be, { op, args, requestId: h.rid(), device: h.device, adminSession: token, ...(epoch !== null ? { epoch } : {}) });
}

// ======================================================================== §9.2
describe('シフト基準の給与計算（§9.2: シフト 18:00〜23:00・打刻 17:55〜23:10・休憩なし）', () => {
  function scenario() {
    const { h, a } = shiftStore();
    shift(h, a, '2026-11-03', '18:00', '23:00');
    h.punchAt(a, '482913', '2026-11-03', '17:55', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '23:10', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    return { h, a };
  }
  const confirm = (h: Harness, a: string, items: Array<[string, string, 'work' | 'no_work', string]>) =>
    h.ownerOk('offshift.confirm', { comment: 'テスト確認', items: items.map(([s, e, result, category]) => ({ employeeId: a, start: s, end: e, result, category })) });

  it('仮の給与対象は 5時間00分（早出5分・残業10分は未確認として確定を止める）', () => {
    const { h, a } = scenario();
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(300);
    expect(r.issues.find((i) => i.code === 'OFF_SHIFT_UNCONFIRMED')).toMatchObject({ severity: 'blocking', date: '2026-11-03' });
    // 打刻原本はシフト時間に書き換えない
    const det = h.ownerOk('attendance.staffDetails', { employeeId: a, from: '2026-11-03', to: '2026-11-03' });
    expect(det.sessions[0].original.clockIn.slice(11, 16)).toBe('17:55');
    expect(det.sessions[0].original.clockOut.slice(11, 16)).toBe('23:10');
    expect(det.sessions[0].timeBasis.candidates.map((c: any) => [c.category, c.minutes])).toEqual([['early', 5], ['late', 10]]);
  });
  it('シフト外に実労働がなかったと確認 → 5時間00分', () => {
    const { h, a } = scenario();
    confirm(h, a, [['2026-11-03T17:55', '2026-11-03T18:00', 'no_work', 'early'], ['2026-11-03T23:00', '2026-11-03T23:10', 'no_work', 'late']]);
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(300);
    expect(issueCodes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
  });
  it('早出5分のみ実労働 → 5時間05分', () => {
    const { h, a } = scenario();
    confirm(h, a, [['2026-11-03T17:55', '2026-11-03T18:00', 'work', 'early'], ['2026-11-03T23:00', '2026-11-03T23:10', 'no_work', 'late']]);
    expect(compute(h, a).totals.workMinutes).toBe(305);
  });
  it('残業10分のみ実労働 → 5時間10分', () => {
    const { h, a } = scenario();
    confirm(h, a, [['2026-11-03T17:55', '2026-11-03T18:00', 'no_work', 'early'], ['2026-11-03T23:00', '2026-11-03T23:10', 'work', 'late']]);
    expect(compute(h, a).totals.workMinutes).toBe(310);
  });
  it('早出・残業ともに実労働 → 5時間15分', () => {
    const { h, a } = scenario();
    confirm(h, a, [['2026-11-03T17:55', '2026-11-03T18:00', 'work', 'early'], ['2026-11-03T23:00', '2026-11-03T23:10', 'work', 'late']]);
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(315);
    // 時給1,200円: 315分 = 6,300円（時間外・深夜なし）
    expect(r.totals.basePay).toBe(6300);
  });
  it('スタッフの申請 → 管理者の承認でも同じ（5時間15分）。重ねて確認しても二重に加算しない', () => {
    const { h, a } = scenario();
    h.login(a, '482913');
    const e = h.staffOk('overtime.request', { category: 'early', start: '2026-11-03T17:55', end: '2026-11-03T18:00', reason: '開店準備' });
    const l = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T23:00', end: '2026-11-03T23:10', reason: '閉店作業' });
    expect(e.status).toBe('pending');
    let r = compute(h, a);
    expect(issueCodes(r)).toContain('OVERTIME_REQUEST_PENDING');
    h.ownerOk('overtime.review', { requestId: e.id, action: 'approve' });
    h.ownerOk('overtime.review', { requestId: l.id, action: 'approve' });
    // 同じ時間を管理者が重ねて確認しても加算は 1 回
    confirm(h, a, [['2026-11-03T23:00', '2026-11-03T23:10', 'work', 'late']]);
    r = compute(h, a);
    expect(r.totals.workMinutes).toBe(315);
    expect(issueCodes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
    expect(issueCodes(r)).not.toContain('OVERTIME_REQUEST_PENDING');
  });
  it('一部承認: 残業 23:00〜23:10 のうち 23:00〜23:05 を承認し、残りを実労働なしと確認 → 確定可（5時間05分）', () => {
    const { h, a } = scenario();
    confirm(h, a, [['2026-11-03T17:55', '2026-11-03T18:00', 'no_work', 'early']]);
    h.login(a, '482913');
    const l = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T23:00', end: '2026-11-03T23:10', reason: '閉店作業' });
    h.ownerOk('overtime.review', { requestId: l.id, action: 'partial', approvedStart: '2026-11-03T23:00', approvedEnd: '2026-11-03T23:05', comment: '5分は私的滞在', remainder: 'no_work' });
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(305);
    expect(issueCodes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
  });
  it('却下（実労働は未確認）・差戻しでは無給扱いにせず、未確認として確定を止める', () => {
    const { h, a } = scenario();
    h.login(a, '482913');
    const l = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T23:00', end: '2026-11-03T23:10', reason: '閉店作業' });
    h.ownerOk('overtime.review', { requestId: l.id, action: 'reject', workConfirmation: 'unconfirmed', comment: '時間の記載に誤り' });
    let r = compute(h, a);
    expect(r.issues.find((i) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
    const e = h.staffOk('overtime.request', { category: 'early', start: '2026-11-03T17:55', end: '2026-11-03T18:00', reason: '準備' });
    h.ownerOk('overtime.review', { requestId: e.id, action: 'return', comment: '理由を詳しく' });
    r = compute(h, a);
    expect(r.issues.find((i) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
    // 差戻し → 再申請 → 承認
    h.staffOk('overtime.resubmit', { requestId: e.id, category: 'early', start: '2026-11-03T17:55', end: '2026-11-03T18:00', reason: '開店前の仕込み' });
    h.ownerOk('overtime.review', { requestId: e.id, action: 'approve' });
    // 未申請の残業も管理者が実労働として登録できる
    confirm(h, a, [['2026-11-03T23:00', '2026-11-03T23:10', 'work', 'late']]);
    r = compute(h, a);
    expect(r.totals.workMinutes).toBe(315);
    expect(issueCodes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
  });
  it('申請履歴（申請・承認・取消）が残る', () => {
    const { h, a } = scenario();
    h.login(a, '482913');
    const l = h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T23:00', end: '2026-11-03T23:10', reason: '閉店作業' });
    h.ownerOk('overtime.review', { requestId: l.id, action: 'approve' });
    h.ownerOk('overtime.review', { requestId: l.id, action: 'cancel', comment: '誤って承認したため取消' });
    const list = h.ownerOk('overtime.list', { status: 'all' });
    expect(list[0].history.map((x: any) => x.action)).toEqual(['submit', 'approve', 'cancel']);
  });
  it('同じ時間帯の重複申請は拒否', () => {
    const { h, a } = scenario();
    h.login(a, '482913');
    h.staffOk('overtime.request', { category: 'late', start: '2026-11-03T23:00', end: '2026-11-03T23:10', reason: '閉店作業' });
    expect(code(h.staff('overtime.request', { category: 'late', start: '2026-11-03T23:05', end: '2026-11-03T23:10', reason: '重複' }))).toBe('CONFLICT');
  });
});

describe('シフト基準: 遅刻・早退・シフト未登録・深夜', () => {
  it('遅刻（18:10 出勤）は実際の勤務のみ: 4時間50分', () => {
    const { h, a } = shiftStore();
    shift(h, a, '2026-11-03', '18:00', '23:00');
    h.punchAt(a, '482913', '2026-11-03', '18:10', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '23:00', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(290);
    expect(issueCodes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
  });
  it('シフト未登録の勤務は 0 分にせず未確認として止め、管理者が実労働と確認すると全時間を計上', () => {
    const { h, a } = shiftStore();
    h.punchAt(a, '482913', '2026-11-03', '10:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '14:00', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    let r = compute(h, a);
    expect(r.issues.find((i) => i.code === 'OFF_SHIFT_UNCONFIRMED')?.severity).toBe('blocking');
    h.ownerOk('offshift.confirm', { comment: '急な応援', items: [{ employeeId: a, start: '2026-11-03T10:00', end: '2026-11-03T14:00', result: 'work', category: 'no_shift' }] });
    r = compute(h, a);
    expect(r.totals.workMinutes).toBe(240);
    expect(issueCodes(r)).not.toContain('OFF_SHIFT_UNCONFIRMED');
  });
  it('日付をまたぐ残業（シフト 20:00〜26:00、退勤 26:30 を実労働と確認）: 深夜 22:00〜26:30 = 270分', () => {
    const { h, a } = shiftStore();
    shift(h, a, '2026-11-03', '20:00', '26:00');
    h.punchAt(a, '482913', '2026-11-03', '20:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-04', '02:30', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    h.ownerOk('offshift.confirm', { comment: '閉店作業', items: [{ employeeId: a, start: '2026-11-04T02:00', end: '2026-11-04T02:30', result: 'work', category: 'late' }] });
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(390);
    expect(r.totals.nightMinutes).toBe(270);
  });
  it('既定の時間基準はシフト（新規初期化）', () => {
    const h = new Harness();
    h.ownerOk('system.initialize', { storeName: 'x', envId: 'env_x' });
    const s = h.ownerOk('settings.get');
    expect(s.payrollTimeBasis).toBe('shift');
    expect(s.breakMode).toBe('scheduled');
  });
});

// ======================================================================== §8 休憩
describe('休憩（予定休憩は取得を確認したものだけ控除）', () => {
  function breakStore(mode: 'scheduled' | 'punch' = 'scheduled') {
    const h = new Harness();
    h.setupStore({ timeBasis: 'shift', breakMode: mode });
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    // シフト 9:00〜17:00、予定休憩 12:00〜13:00（60分）
    shift(h, a, '2026-11-03', '09:00', '17:00', { breakMinutes: 60, fixedBreakStart: '12:00' });
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    return { h, a };
  }
  const out = (h: Harness, a: string, decl?: Record<string, unknown>) => h.punchAt(a, '482913', '2026-11-03', '17:00', 'clock_out', decl ? { breakDeclaration: decl } : {});

  it('Codex 監査1 #8: 休憩の取得を確認していない場合は控除しない（実働8時間＝9,600円）', () => {
    const { h, a } = breakStore();
    out(h, a);
    h.setNow('2026-11-04', '10:00');
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(480);
    expect(r.totals.basePay).toBe(9600);
    expect(issueCodes(r)).toContain('PLANNED_BREAK_UNCONFIRMED');
  });
  it('退勤時に「予定どおり取得」→ 60分控除（7時間）', () => {
    const { h, a } = breakStore();
    expect(out(h, a, { kind: 'as_scheduled', expectedPlanned: { start: '2026-11-03T12:00', end: '2026-11-03T13:00', minutes: 60 } }).breakDeclaration).toBe('applied');
    h.setNow('2026-11-04', '10:00');
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(420);
    expect(issueCodes(r)).not.toContain('PLANNED_BREAK_UNCONFIRMED');
  });
  it('休憩を取得できなかった → 控除なし（8時間）', () => {
    const { h, a } = breakStore();
    out(h, a, { kind: 'not_taken', reason: '混雑のため' });
    h.setNow('2026-11-04', '10:00');
    expect(compute(h, a).totals.workMinutes).toBe(480);
  });
  it('短縮（30分）→ 7時間30分 / 延長（90分）→ 6時間30分 / 時間帯違い（14〜15時）→ 7時間 / 追加（12〜13時＋15〜15時15分）→ 6時間45分', () => {
    const cases: Array<[Array<[string, string]>, number]> = [
      [[['12:00', '12:30']], 450],
      [[['12:00', '13:30']], 390],
      [[['14:00', '15:00']], 420],
      [[['12:00', '13:00'], ['15:00', '15:15']], 405],
    ];
    for (const [ivs, expected] of cases) {
      const { h, a } = breakStore();
      out(h, a, { kind: 'custom', reason: '実際の休憩', intervals: ivs.map(([s, e]) => ({ start: `2026-11-03T${s}`, end: `2026-11-03T${e}` })) });
      h.setNow('2026-11-04', '10:00');
      expect(compute(h, a).totals.workMinutes).toBe(expected);
    }
  });
  it('休憩打刻方式: 打刻した休憩と「予定どおり」の申告を二重に控除しない', () => {
    const { h, a } = breakStore('punch');
    h.punchAt(a, '482913', '2026-11-03', '12:00', 'break_start');
    h.punchAt(a, '482913', '2026-11-03', '13:00', 'break_end');
    out(h, a, { kind: 'as_scheduled', expectedPlanned: { start: '2026-11-03T12:00', end: '2026-11-03T13:00', minutes: 60 } });
    h.setNow('2026-11-04', '10:00');
    expect(compute(h, a).totals.workMinutes).toBe(420);
  });
  it('予定休憩がないシフトで休憩を取らない6時間超の勤務: 自動控除せず警告のみ（賃金は全時間）', () => {
    const h = new Harness();
    h.setupStore({ timeBasis: 'shift' });
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    shift(h, a, '2026-11-03', '09:00', '17:00');
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:00', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    const r = compute(h, a);
    expect(r.totals.workMinutes).toBe(480);
    expect(issueCodes(r)).toContain('INSUFFICIENT_BREAK');
  });
  it('本人の休憩申告（PIN 済み）は勤怠確認画面から変更でき、最新の申告を使う', () => {
    const { h, a } = breakStore();
    out(h, a, { kind: 'as_scheduled', expectedPlanned: { start: '2026-11-03T12:00', end: '2026-11-03T13:00', minutes: 60 } });
    h.setNow('2026-11-04', '10:00');
    h.login(a, '482913');
    const det = h.staffOk('attendance.myDetails', { from: '2026-11-03', to: '2026-11-03' });
    h.staffOk('breaks.declare', { workDate: '2026-11-03', sessionKey: det.sessions[0].sessionKey, kind: 'custom', intervals: [{ start: '2026-11-03T12:00', end: '2026-11-03T12:45' }], reason: '45分で戻った' });
    expect(compute(h, a).totals.workMinutes).toBe(435);
  });
});

// ======================================================================== §4 管理者パスワード
describe('管理者パスワード認証（店舗 iPad の管理者モード）', () => {
  function store() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    return { h, a };
  }
  it('未設定では管理者ログインできない（認証を省略しない）', () => {
    const { h } = store();
    expect(code(h.staff('adminAuth.login', { password: ADMIN_PW }, { session: '' }))).toBe('ADMIN_PASSWORD_NOT_SET');
  });
  it('パスワードの強度要件（12文字以上・3種類以上・推測されやすい語の禁止）', () => {
    const { h } = store();
    for (const pw of ['Short#1a', 'alllowercase123', 'Password#2026x', 'Aaaaa#123456']) expect(code(h.owner('adminAuth.setPassword', { password: pw }))).toBe('INVALID_INPUT');
    expect(code(h.owner('adminAuth.setPassword', { password: ADMIN_PW }))).toBe('OK');
  });
  it('正しいパスワードでログイン・誤りは拒否・連続失敗でロック（ロック中は正しいパスワードでも不可）', () => {
    const { h } = store();
    h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
    for (let i = 0; i < 4; i++) expect(code(h.staff('adminAuth.login', { password: 'Wrong#Password99' }, { session: '' }))).toBe('INVALID_INPUT');
    expect(code(h.staff('adminAuth.login', { password: 'Wrong#Password99' }, { session: '' }))).toBe('LOCKED');
    expect(code(h.staff('adminAuth.login', { password: ADMIN_PW }, { session: '' }))).toBe('LOCKED');
    h.advance(16 * 60_000);
    expect(code(h.staff('adminAuth.login', { password: ADMIN_PW }, { session: '' }))).toBe('OK');
  });
  it('未登録端末からは管理者ログインできない', () => {
    const { h } = store();
    h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
    expect(code(h.staff('adminAuth.login', { password: ADMIN_PW }, { device: '' }))).toBe('DEVICE_NOT_REGISTERED');
  });
  it('管理者モードで管理業務ができ、Google 所有者に限定した操作はできない', () => {
    const { h, a } = store();
    const t = adminLogin(h);
    expect(code(asAdmin(h, t, 'employees.list'))).toBe('OK');
    expect(code(asAdmin(h, t, 'settings.get'))).toBe('OK');
    // v1.3 で提供しない操作（更新・移行・メンテナンスの切替）は一覧から除き、下で拒否を確かめる（D-027。入力の変更のみ）
    for (const op of ['adminAuth.setPassword', 'adminAuth.unlock', 'system.initialize', 'system.resetSetupPairing', 'payslips.pdf', 'maintenance.begin', 'maintenance.finish'])
      expect(code(asAdmin(h, t, op, {}))).toBe('FORBIDDEN');
    for (const op of ['system.prepareUpdate', 'system.migrate', 'system.finishUpdate', 'system.setMaintenance', 'backup.restore'])
      expect(code(asAdmin(h, t, op, {})), op).toBe('NOT_IN_THIS_RELEASE');
    // スタッフ本人用の操作は管理者モードでは不可
    expect(code(asAdmin(h, t, 'payroll.mine'))).not.toBe('OK');
    void a;
  });
  it('重要操作（権限変更・給与確定・PIN 設定）は 5 分以内の再認証が必要', () => {
    const { h, a } = store();
    const t = adminLogin(h);
    h.advance(6 * 60_000 - 1000);
    // 無操作 5 分で失効しないよう途中で操作
    h.env.clock.now -= 2 * 60_000;
    expect(code(asAdmin(h, t, 'employees.list'))).toBe('OK');
    h.advance(2 * 60_000);
    expect(code(asAdmin(h, t, 'permissions.set', { employeeId: a, permissions: ['punch_self'] }))).toBe('REAUTH_REQUIRED');
    expect(code(asAdmin(h, t, 'credentials.setPin', { employeeId: a, pin: '0739' }))).toBe('REAUTH_REQUIRED');
    expect(code(asAdmin(h, t, 'adminAuth.reauth', { password: 'Wrong#Password99' }))).toBe('INVALID_INPUT');
    expect(code(asAdmin(h, t, 'adminAuth.reauth', { password: ADMIN_PW }))).toBe('OK');
    expect(code(asAdmin(h, t, 'permissions.set', { employeeId: a, permissions: ['punch_self'] }))).toBe('OK');
  });
  it('無操作 5 分で失効・ログアウト後はサーバー側で失効（API の直接呼び出しも拒否）', () => {
    const { h } = store();
    let t = adminLogin(h);
    h.advance(5 * 60_000 + 30_000);
    expect(code(asAdmin(h, t, 'employees.list'))).toBe('ADMIN_UNAUTHENTICATED');
    t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    expect(code(asAdmin(h, t, 'adminAuth.logout'))).toBe('OK');
    expect(code(asAdmin(h, t, 'employees.list'))).toBe('ADMIN_UNAUTHENTICATED');
  });
  it('スタッフのセッション（委任権限・追加認証済みでも）から管理者権限を得られない', () => {
    const { h, a } = store();
    h.ownerOk('permissions.set', { employeeId: a, permissions: ['punch_self', 'staff_manage', 'payroll_confirm'] });
    h.ownerOk('credentials.setStepUp', { employeeId: a, passcode: 'Passcode2026x' });
    h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
    const s = h.login(a, '482913').sessionToken;
    // スタッフのセッショントークンを管理者トークンとして送っても無効
    expect(code(handleRequest(h.be, { op: 'settings.get', requestId: h.rid(), device: h.device, adminSession: s }))).toBe('ADMIN_UNAUTHENTICATED');
    // 管理者モード専用の操作・Google 所有者専用の操作はスタッフのセッションでは不可
    expect(code(h.staff('adminAuth.me'))).toBe('ADMIN_UNAUTHENTICATED');
    expect(code(h.staff('settings.update', { storeName: 'x' }))).toBe('FORBIDDEN');
  });
  it('別の端末の管理者セッションは使えない・端末の失効で管理者セッションも失効', () => {
    const { h } = store();
    const t = adminLogin(h);
    const en = h.ownerOk('devices.createEnrollment', { deviceName: '別端末' });
    const other = h.staffOk('staff.enroll', { code: en.code }, { device: '' }).deviceToken;
    expect(code(handleRequest(h.be, { op: 'employees.list', requestId: h.rid(), device: other, adminSession: t }))).toBe('ADMIN_UNAUTHENTICATED');
    const devs = h.ownerOk('devices.list');
    h.ownerOk('devices.revoke', { deviceId: devs[0].id });
    expect(code(asAdmin(h, t, 'employees.list'))).not.toBe('OK');
  });
  it('パスワード変更（本人・現在のパスワードが必要）・再設定（Google 所有者）で既存セッションを失効', () => {
    const { h } = store();
    const t = adminLogin(h);
    expect(code(asAdmin(h, t, 'adminAuth.changePassword', { currentPassword: 'Wrong#Password99', newPassword: 'New#Manager2027' }))).toBe('INVALID_INPUT');
    expect(code(asAdmin(h, t, 'adminAuth.changePassword', { currentPassword: ADMIN_PW, newPassword: 'New#Manager2027' }))).toBe('OK');
    expect(code(asAdmin(h, t, 'employees.list'))).toBe('ADMIN_UNAUTHENTICATED');
    const t2 = h.staffOk('adminAuth.login', { password: 'New#Manager2027' }, { session: '' }).adminSessionToken;
    h.ownerOk('adminAuth.setPassword', { password: 'Reset#Manager2028' });
    expect(code(asAdmin(h, t2, 'employees.list'))).toBe('ADMIN_UNAUTHENTICATED');
  });
  it('管理者モードの出力は共用端末にファイル本体を返さない（Drive に保存のみ）', () => {
    const { h } = store();
    const t = adminLogin(h);
    const r: any = asAdmin(h, t, 'export.attendance', { from: '2026-11-01', to: '2026-11-02', format: 'csv' });
    expect(r.ok).toBe(true);
    expect(r.data.base64).toBeUndefined();
  });
  it('管理者パスワード・トークンは平文で DB に保存しない', () => {
    const { h } = store();
    const t = adminLogin(h);
    const dump = JSON.stringify(h.env.adapter.snapshot());
    expect(dump).not.toContain(ADMIN_PW);
    expect(dump).not.toContain(t);
  });
});

// ======================================================================== §5 PIN 任意化
describe('スタッフ PIN の任意化', () => {
  function store() {
    const h = new Harness();
    h.setupStore();
    const withPin = h.addStaff('山田', '482913', { rate: 1200 });
    const e = h.ownerOk('employees.create', { displayName: '佐藤', kana: 'さとう', payType: 'hourly', hireDate: '2025-01-01' });
    return { h, withPin, noPin: e.id as string };
  }
  it('PIN 未設定: 氏名選択のみで出退勤できるが、本人未確認として給与・明細・勤怠詳細・有給は表示しない', () => {
    const { h, noPin } = store();
    const r = h.staffOk('auth.login', { employeeId: noPin, pin: null }, { session: '' });
    h.session = r.sessionToken;
    expect(r.verified).toBe(false);
    expect(r.permissions.sort()).toEqual(['punch_self', 'shift_view_published']);
    expect(code(h.punch('clock_in'))).toBe('OK');
    expect(code(h.staff('shifts.published', { from: '2026-11-01', to: '2026-11-07' }))).toBe('OK');
    for (const op of ['attendance.mine', 'attendance.myDetails', 'payroll.mine', 'payslips.mine', 'leave.mine', 'notifications.list', 'overtime.mine'])
      expect(code(h.staff(op, { from: '2026-11-01', to: '2026-11-02' }))).toBe('IDENTITY_REQUIRED');
    expect(code(h.staff('auth.stepUp', { passcode: 'Passcode2026x' }))).toBe('IDENTITY_REQUIRED');
  });
  it('PIN 設定済みは PIN なし・空欄・誤った PIN で認証できない（本人未確認ログインに切り替わらない）', () => {
    const { h, withPin } = store();
    expect(code(h.staff('auth.login', { employeeId: withPin, pin: null }, { session: '' }))).toBe('PIN_REQUIRED');
    expect(code(h.staff('auth.login', { employeeId: withPin, pin: '' }, { session: '' }))).toBe('PIN_REQUIRED');
    expect(code(h.staff('auth.login', { employeeId: withPin }, { session: '' }))).toBe('PIN_REQUIRED');
    expect(code(h.staff('auth.login', { employeeId: withPin, pin: '111112' }, { session: '' }))).toBe('INVALID_INPUT');
  });
  it('PIN 未設定のスタッフに PIN を送ると拒否（未設定と誤入力を混同しない）', () => {
    const { h, noPin } = store();
    expect(code(h.staff('auth.login', { employeeId: noPin, pin: '1234' }, { session: '' }))).toBe('PIN_NOT_SET');
  });
  it('4桁・先頭0・5桁・6桁以上の PIN を設定でき、正しく認証する', () => {
    const { h, noPin } = store();
    for (const pin of ['0739', '07391', '073915', '07391548']) {
      h.ownerOk('credentials.setPin', { employeeId: noPin, pin });
      const r = h.staffOk('auth.login', { employeeId: noPin, pin }, { session: '' });
      expect(r.verified).toBe(true);
    }
    for (const pin of ['123', '1234567890123', '1111', '1234', '12a4']) expect(code(h.owner('credentials.setPin', { employeeId: noPin, pin }))).toBe('INVALID_INPUT');
  });
  it('本人による PIN 変更（4桁可）と管理者による PIN 解除。解除後は既存セッションを失効し、本人未確認になる', () => {
    const { h, withPin } = store();
    h.login(withPin, '482913');
    expect(code(h.staff('auth.changePin', { currentPin: '482913', newPin: '0739' }))).toBe('OK');
    expect(h.staffOk('auth.login', { employeeId: withPin, pin: '0739' }, { session: '' }).verified).toBe(true);
    const s = h.staffOk('auth.login', { employeeId: withPin, pin: '0739' }, { session: '' }).sessionToken;
    h.ownerOk('credentials.clearPin', { employeeId: withPin });
    expect(code(h.staff('auth.me', undefined, { session: s }))).toBe('UNAUTHENTICATED');
    const r = h.staffOk('auth.login', { employeeId: withPin, pin: null }, { session: '' });
    expect(r.verified).toBe(false);
  });
  it('短い PIN の総当たり対策: ロックのたびにロック時間を延長（15分 → 30分）', () => {
    const { h, withPin } = store();
    h.ownerOk('credentials.setPin', { employeeId: withPin, pin: '0739' });
    const fail = () => code(h.staff('auth.login', { employeeId: withPin, pin: '9999' }, { session: '' }));
    for (let i = 0; i < 4; i++) expect(fail()).toBe('INVALID_INPUT');
    expect(fail()).toBe('LOCKED');
    h.advance(16 * 60_000);
    for (let i = 0; i < 4; i++) expect(fail()).toBe('INVALID_INPUT');
    expect(fail()).toBe('LOCKED');
    h.advance(16 * 60_000);
    // 2回目のロックは30分: 16分後もまだロック中
    expect(code(h.staff('auth.login', { employeeId: withPin, pin: '0739' }, { session: '' }))).toBe('LOCKED');
    h.advance(15 * 60_000);
    expect(code(h.staff('auth.login', { employeeId: withPin, pin: '0739' }, { session: '' }))).toBe('OK');
  });
  it('本人未確認の勤怠修正・早出残業申請・休憩申告は承認待ちとして保存し、応答に勤怠の詳細を含めない', () => {
    const { h, noPin } = store();
    const login = () => {
      h.session = h.staffOk('auth.login', { employeeId: noPin, pin: null }, { session: '' }).sessionToken;
    };
    h.setNow('2026-11-03', '09:00');
    login();
    h.punch('clock_in');
    h.setNow('2026-11-03', '17:00');
    login();
    h.punch('clock_out');
    h.setNow('2026-11-04', '10:00');
    login();
    const c = h.staffOk('attendance.selfCorrect', { clockIn: '2026-11-03T08:50', clockOut: '2026-11-03T17:00', reason: '打刻が遅れた' });
    expect(c).toEqual({ status: 'pending' });
    const o = h.staffOk('overtime.request', { category: 'early', start: '2026-11-03T08:50', end: '2026-11-03T09:00', reason: '準備' });
    expect(o).toEqual({ status: 'pending' });
    const b = h.staffOk('breaks.declare', { workDate: '2026-11-03', kind: 'not_taken', reason: '取れなかった' });
    expect(b).toEqual({ status: 'pending' });
    // 管理者は本人未確認として確認できる
    const list = h.ownerOk('attendance.reviewList');
    expect(list.corrections[0].identityVerified).toBe(false);
    expect(list.corrections[0].reviewStatus).toBe('pending');
    const ot = h.ownerOk('overtime.list', { status: 'pending' });
    expect(ot[0].identityVerified).toBe(false);
  });
});

// ======================================================================== §6 本人の勤怠修正
describe('スタッフ本人の勤怠修正', () => {
  function store() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    const b = h.addStaff('佐藤', '582914', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-03', '09:05', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '17:00', 'clock_out');
    h.punchAt(b, '582914', '2026-11-03', '10:00', 'clock_in');
    h.punchAt(b, '582914', '2026-11-03', '15:00', 'clock_out');
    h.setNow('2026-11-04', '10:00');
    return { h, a, b };
  }
  const myKey = (h: Harness) => h.staffOk('attendance.myDetails', { from: '2026-11-03', to: '2026-11-03' }).sessions[0].sessionKey as string;

  it('本人（PIN）の修正は反映し、管理者は未確認として確認できる。打刻原本は変更しない', () => {
    const { h, a } = store();
    h.login(a, '482913');
    const key = myKey(h);
    const r = h.staffOk('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T17:00', reason: '打刻が遅れた' });
    expect(r.status).toBe('applied');
    const det = h.staffOk('attendance.myDetails', { from: '2026-11-03', to: '2026-11-03' });
    expect(det.sessions[0].start.slice(11, 16)).toBe('09:00');
    expect(det.sessions[0].original.clockIn.slice(11, 16)).toBe('09:05');
    const rl = h.ownerOk('attendance.reviewList');
    expect(rl.corrections[0]).toMatchObject({ reviewStatus: 'unreviewed', identityVerified: true });
    expect(JSON.parse(rl.corrections[0].items[0].before).at.slice(11, 16)).toBe('09:05');
    // 管理者の確認
    h.ownerOk('attendance.review', { kind: 'correction', id: rl.corrections[0].groupId, action: 'approve' });
    expect(h.ownerOk('attendance.reviewList').corrections).toHaveLength(0);
  });
  it('他人の勤務は自己修正できない（他人の勤務キーを指定しても対象にならない）', () => {
    const { h, a, b } = store();
    h.login(b, '582914');
    const bKey = myKey(h);
    h.login(a, '482913');
    expect(code(h.staff('attendance.selfCorrect', { sessionKey: bKey, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T15:00', reason: 'なりすまし' }))).toBe('NOT_FOUND');
    // 管理者向けの修正 API もスタッフは使えない
    expect(code(h.staff('attendance.adminCorrectSession', { employeeId: b, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T15:00', reason: 'x' }))).toBe('FORBIDDEN');
  });
  it('複数回の修正でも初回の原本とすべての修正履歴を追跡できる', () => {
    const { h, a } = store();
    h.login(a, '482913');
    const key = myKey(h);
    h.staffOk('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T17:00', reason: '1回目' });
    h.staffOk('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T08:55', clockOut: '2026-11-03T17:10', reason: '2回目' });
    const det = h.staffOk('attendance.myDetails', { from: '2026-11-03', to: '2026-11-03' });
    expect(det.sessions[0].start.slice(11, 16)).toBe('08:55');
    expect(det.sessions[0].end.slice(11, 16)).toBe('17:10');
    expect(det.sessions[0].original.clockIn.slice(11, 16)).toBe('09:05');
    expect(det.sessions[0].corrections.map((c: any) => c.reason)).toEqual(['1回目', '2回目', '2回目']);
  });
  it('打刻漏れ（出勤・退勤の記録なし）・日付をまたぐ勤務を申告できる', () => {
    const { h, a } = store();
    h.login(a, '482913');
    h.staffOk('attendance.selfCorrect', { clockIn: '2026-11-01T20:00', clockOut: '2026-11-02T02:00', reason: '打刻を忘れた' });
    const det = h.staffOk('attendance.myDetails', { from: '2026-11-01', to: '2026-11-01' });
    expect(det.sessions[0].laborDate).toBe('2026-11-01');
    expect(det.sessions[0].workMinutes).toBe(360);
  });
  it('不正な日時（未来・退勤が出勤より前・他の勤務と重複）は拒否', () => {
    const { h, a } = store();
    h.login(a, '482913');
    const key = myKey(h);
    expect(code(h.staff('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-05T09:00', clockOut: '2026-11-05T17:00', reason: '未来' }))).toBe('INVALID_INPUT');
    expect(code(h.staff('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T17:00', clockOut: '2026-11-03T09:00', reason: '逆転' }))).toBe('INVALID_INPUT');
    // 別の勤務（打刻漏れの申告 18:00〜20:00）と重なる修正
    h.staffOk('attendance.selfCorrect', { clockIn: '2026-11-03T18:00', clockOut: '2026-11-03T20:00', reason: '夜の打刻漏れ' });
    expect(code(h.staff('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T19:00', reason: '重複' }))).toBe('INVALID_INPUT');
    expect(code(h.staff('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T17:00', reason: '' }))).toBe('INVALID_INPUT');
  });
  it('給与確定済みの期間は反映せず訂正の申告（承認待ち）として保存し、確定済み給与は変更しない', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-03', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-03', '13:00', 'clock_out');
    h.setNow('2026-12-02', '10:00');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    const comp = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = comp.employees.flatMap((e: any) => e.issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key));
    h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    h.login(a, '482913');
    const key = h.staffOk('attendance.myDetails', { from: '2026-11-03', to: '2026-11-03' }).sessions[0].sessionKey;
    const r = h.staffOk('attendance.selfCorrect', { sessionKey: key, clockIn: '2026-11-03T09:00', clockOut: '2026-11-03T14:00', reason: '退勤を押し忘れ' });
    expect(r.status).toBe('pending');
    expect(r.warning).toContain('給与確定済み');
    const results = h.ownerOk('payroll.results', { periodId: p.id });
    expect(results.find((x: any) => x.employeeId === a && x.status === 'confirmed').totals.workMinutes).toBe(240);
  });
});

describe('互換・移行', () => {
  it('旧名称の kiosk.bootstrap は互換のため動作し、新名称 staff.bootstrap と同じ内容を返す', () => {
    const h = new Harness();
    h.setupStore();
    h.addStaff('山田', '482913');
    expect(h.staffOk('kiosk.bootstrap').staff).toEqual(h.staffOk('staff.bootstrap').staff);
  });
});
