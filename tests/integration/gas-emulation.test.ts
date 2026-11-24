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
    const auth = core.shiftlyAuthorize();
    expect(auth.ok).toBe(true);
    expect(core.shiftlyAuthorize().created).toBe(false); // 冪等
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
    core.shiftlyDailyJob();
    const backups = owner('backup.list');
    expect(backups[0].status).toBe('ok');
    expect(emu.spreadsheets.has(backups[0].driveFileId)).toBe(true);

    // Setup 役割の鍵: 更新関連のみ
    const skey = post({ kind: 'pair', role: 'setup', pairingCode: setupCode }).data.key as string;
    expect(post(ownerEnvelope(skey, { op: 'system.info' }, 'setup')).ok).toBe(true);
    expect(post(ownerEnvelope(skey, { op: 'employees.list' }, 'setup')).ok).toBe(false);
    // 管理者鍵で setup 役割を名乗っても不可
    expect(post(ownerEnvelope(key, { op: 'system.info' }, 'setup')).ok).toBe(false);
  });

  it('大量行でもシートの行数を自動拡張して書き込める', () => {
    const emu = new GasEmulator();
    const code = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_emu2', storeName: 'x', adminPairingHash: sha(code), setupPairingHash: sha(code + 'x') } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    core.shiftlyAuthorize();
    const key = post({ kind: 'pair', role: 'admin', pairingCode: code }).data.key as string;
    const owner = (op: string, args?: unknown) => post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}` }));
    // 1 操作で登録コード 1 行・ジャーナル 1 行が増える。既定のグリッド（1000 行）を超えるまで実行
    for (let i = 0; i < 1050; i++) expect(owner('devices.createEnrollment', { deviceName: `d${i}` }).ok).toBe(true);
    const dbId = emu.scriptProps.getProperty('SHIFTLY_DB_ID')!;
    const enr = emu.spreadsheets.get(dbId)!.sheets.find((s) => s.title === 'device_enrollments')!;
    expect(enr.rows.length).toBe(1051);
    expect(enr.rowCount).toBeGreaterThan(1000);
  });
});
