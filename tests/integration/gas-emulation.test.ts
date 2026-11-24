/**
 * ビルド済み GAS バンドル（dist/gas）をエミュレータ上で実行する統合テスト
 * 前提: npm run build && npm run build:gas（未ビルドの場合はスキップ）
 * ※ Google の実環境での検証ではない（docs/technical-verification.md 参照）
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { GasEmulator } from '../helpers/gas-emulator';

const built = existsSync('dist/gas/core/Code.js');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function ownerEnvelope(keyHex: string, body: unknown, role: 'admin' | 'setup' = 'admin') {
  const ts = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const b = JSON.stringify(body);
  const sig = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`1.${role}.${ts}.${nonce}.${b}`).digest('hex');
  return { kind: 'owner', envelope: { v: 1, role, ts, nonce, body: b, sig } };
}

describe.skipIf(!built)('GAS バンドルのエミュレーション実行', () => {
  it('初期化 → Admin ペアリング → 店長操作 → 端末登録 → PIN ログイン → 打刻 → 日次ジョブ', () => {
    const emu = new GasEmulator();
    const adminCode = randomBytes(32).toString('hex');
    const setupCode = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_emu', storeName: 'エミュ店', adminPairingHash: sha(adminCode), setupPairingHash: sha(setupCode) } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);

    expect(post({ kind: 'ping' }).data.initialized).toBe(false);
    // 匿名の訪問者（getActiveUser が空）は初期化関数を呼べない
    emu.activeUser = '';
    expect(() => core.shiftlyAuthorize()).toThrow();
    emu.activeUser = 'owner@example.invalid';
    const auth = core.shiftlyAuthorize();
    expect(auth.ok).toBe(true);
    expect(core.shiftlyAuthorize().created).toBe(false); // 冪等
    expect([...emu.files.values()].filter((f) => f.appProperties?.shiftly === 'database')).toHaveLength(1);
    expect(emu.triggers).toEqual(['shiftlyDailyJob']);
    const dbId = emu.scriptProps.getProperty('SHIFTLY_DB_ID')!;
    expect(emu.spreadsheets.get(dbId)!.props.timeZone).toBe('Asia/Tokyo');
    expect(post({ kind: 'ping' }).data.initialized).toBe(true);
    // Admin ペアリング（誤ったコードは拒否、使い捨て）
    expect(post({ kind: 'pair', role: 'admin', pairingCode: 'x'.repeat(64) }).ok).toBe(false);
    const key = post({ kind: 'pair', role: 'admin', pairingCode: adminCode }).data.key as string;
    expect(post({ kind: 'pair', role: 'admin', pairingCode: adminCode }).ok).toBe(false);

    const owner = (op: string, args?: unknown) => {
      const r = post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}` }));
      if (!r.ok) throw new Error(`${op}: ${r.error.message}`);
      return r.data;
    };
    owner('settings.update', { workingTimeSystem: 'standard', weekStartDay: 0, statutoryHolidayWeekday: 0, payrollClosingDay: 0, payMonthOffset: 1, payDay: 10 });
    const e = owner('employees.create', { displayName: '=SUM(1)', kana: 'てすと', payType: 'hourly', hireDate: '2025-01-01' });
    owner('credentials.setPin', { employeeId: e.id, pin: '482913' });
    const en = owner('devices.createEnrollment', { deviceName: 'iPad' });

    const kiosk = (req: unknown) => JSON.parse(core.kioskApi(JSON.stringify(req)));
    const dev = kiosk({ op: 'kiosk.enroll', args: { code: en.code }, requestId: 'emu_enroll_1' });
    expect(dev.ok).toBe(true);
    const device = dev.data.deviceToken;
    const login = kiosk({ op: 'auth.login', args: { employeeId: e.id, pin: '482913' }, device, requestId: 'emu_login_01' });
    expect(login.ok).toBe(true);
    const punch = kiosk({ op: 'attendance.punch', args: { type: 'clock_in' }, device, session: login.data.sessionToken, requestId: 'emu_punch_01' });
    expect(punch.ok).toBe(true);
    // 冪等: 同じ requestId の再送
    const again = kiosk({ op: 'attendance.punch', args: { type: 'clock_in' }, device, session: login.data.sessionToken, requestId: 'emu_punch_01' });
    expect(again.data.eventId).toBe(punch.data.eventId);

    // Sheets 上のデータ: 月別パーティション、RAW 書き込み（数式として評価されない文字列のまま）
    const ss = emu.spreadsheets.get(dbId)!;
    const month = punch.data.at.slice(0, 7).replace('-', '_');
    const evSheet = ss.sheets.find((s) => s.title === `attendance_events__${month}`)!;
    expect(evSheet.rows[0]![0]).toBe('id');
    expect(evSheet.rows).toHaveLength(2);
    const emp = ss.sheets.find((s) => s.title === 'employees')!;
    expect(emp.rows[1]).toContain('=SUM(1)');
    const jnl = ss.sheets.find((s) => s.title.startsWith('operation_journal__'))!;
    expect(jnl.rows.slice(1).every((r) => r[5] === 'committed')).toBe(true);
    // PIN・pepper は DB に保存されない
    const dump = JSON.stringify(ss.sheets.map((s) => s.rows));
    expect(dump).not.toContain('482913');
    expect(dump).not.toContain(emu.scriptProps.getProperty('SHIFTLY_PIN_PEPPER')!);

    // 日次ジョブ（バックアップ: DB の複製を 05_Backup に作成）
    // google.script.run 経由（トリガーではない）の呼び出しは無視される
    core.shiftlyDailyJob();
    core.shiftlyDailyJob({ triggerUid: 'forged' });
    expect(owner('backup.list')).toHaveLength(0);
    core.shiftlyDailyJob({ triggerUid: 'trg0' });
    core.shiftlyDailyJob({ triggerUid: 'trg0' }); // 同日 2 回目は作らない
    const backups = owner('backup.list');
    expect(backups.filter((b: { kind: string }) => b.kind === 'daily')).toHaveLength(1);
    expect(backups[0].status).toBe('ok');
    expect(emu.spreadsheets.has(backups[0].driveFileId)).toBe(true);

    // Setup 役割の鍵: 更新関連のみ
    const skey = post({ kind: 'pair', role: 'setup', pairingCode: setupCode }).data.key as string;
    expect(post(ownerEnvelope(skey, { op: 'system.info' }, 'setup')).ok).toBe(true);
    expect(post(ownerEnvelope(skey, { op: 'employees.list' }, 'setup')).ok).toBe(false);
    // 管理者鍵で setup 役割を名乗っても不可
    expect(post(ownerEnvelope(key, { op: 'system.info' }, 'setup')).ok).toBe(false);
    // Codex 監査1 #15: 共用 iPad の 1 人分（ログイン→打刻→ログアウト）の Sheets 書き込み回数
    // （シート作成済みの状態で計測。1 回の保存＝ジャーナル開始・業務データ・ジャーナル完了の 3 回 × 3 操作）
    const e2 = owner('employees.create', { displayName: '計測', kana: 'けいそく', payType: 'hourly', hireDate: '2025-01-01' });
    owner('credentials.setPin', { employeeId: e2.id, pin: '582914' });
    const w0 = emu.writeCalls;
    const login2 = kiosk({ op: 'auth.login', args: { employeeId: e2.id, pin: '582914' }, device, requestId: 'emu_login_02' });
    expect(kiosk({ op: 'attendance.punch', args: { type: 'clock_in' }, device, session: login2.data.sessionToken, requestId: 'emu_punch_02' }).ok).toBe(true);
    expect(kiosk({ op: 'auth.logout', device, session: login2.data.sessionToken, requestId: 'emu_logout_02' }).ok).toBe(true);
    expect(emu.writeCalls - w0).toBeLessThanOrEqual(9);
  });

  it('Codex 監査1 #12: 呼び出し側が生成した鍵でペアリングし、応答喪失後も鍵を再送せずに登録済みを確認できる', () => {
    const emu = new GasEmulator();
    const code = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_emu3', storeName: 'x', adminPairingHash: sha(code), setupPairingHash: sha(code + 'x') } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    core.shiftlyAuthorize();
    const clientKey = randomBytes(32).toString('hex');
    expect(post({ kind: 'pair', role: 'admin', pairingCode: code, clientKey }).data.key).toBe(clientKey);
    // 応答が失われたとして再試行: 2 回目は拒否され、鍵は返さない
    const again = post({ kind: 'pair', role: 'admin', pairingCode: code, clientKey: randomBytes(32).toString('hex') });
    expect(again.ok).toBe(false);
    expect(JSON.stringify(again)).not.toContain(clientKey);
    // 保存済みの鍵で署名した呼び出しは通る（登録済みの確認）
    expect(post(ownerEnvelope(clientKey, { op: 'settings.get' })).ok).toBe(true);
    // 店長のエディタ実行でのみリセットできる
    emu.activeUser = '';
    expect(() => core.shiftlyResetAdminPairing()).toThrow();
    emu.activeUser = 'owner@example.invalid';
    core.shiftlyResetAdminPairing();
    expect(post(ownerEnvelope(clientKey, { op: 'settings.get' })).ok).toBe(false);
    expect(post({ kind: 'pair', role: 'admin', pairingCode: code }).ok).toBe(true);
  });

  it('大量行でもシートの行数を自動拡張して書き込める', () => {
    const emu = new GasEmulator();
    emu.defaultRows = 100; // 既定 1000 行の代わりに 100 行のグリッドで拡張処理を検証（実行時間短縮）
    const code = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_emu2', storeName: 'x', adminPairingHash: sha(code), setupPairingHash: sha(code + 'x') } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    core.shiftlyAuthorize();
    const key = post({ kind: 'pair', role: 'admin', pairingCode: code }).data.key as string;
    const owner = (op: string, args?: unknown) => post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}` }));
    // 1 操作で登録コード 1 行・ジャーナル 1 行が増える。グリッド（100 行）を超えるまで実行
    for (let i = 0; i < 150; i++) expect(owner('devices.createEnrollment', { deviceName: `d${i}` }).ok).toBe(true);
    const dbId = emu.scriptProps.getProperty('SHIFTLY_DB_ID')!;
    const enr = emu.spreadsheets.get(dbId)!.sheets.find((s) => s.title === 'device_enrollments')!;
    expect(enr.rows.length).toBe(151);
    expect(enr.rowCount).toBeGreaterThan(100);
  });
});
