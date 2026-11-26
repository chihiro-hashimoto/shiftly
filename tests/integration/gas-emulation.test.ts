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
  it('Codex 監査2 #1: v1.2 の DB（store_settings が 32 列のシート）を v1.3 の Core で読み込み、移行で列とヘッダーを拡張する', () => {
    const emu = new GasEmulator();
    const adminCode = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_emu2', storeName: 'エミュ店', adminPairingHash: sha(adminCode), setupPairingHash: sha(randomBytes(32).toString('hex')) } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    emu.activeUser = 'owner@example.invalid';
    core.shiftlyAuthorize();
    const key = post({ kind: 'pair', role: 'admin', pairingCode: adminCode }).data.key as string;
    const owner = (op: string, args?: unknown) => post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}` }));
    expect(owner('settings.update', { storeName: '旧店舗' }).ok).toBe(true);
    // v1.2 の状態を再現: store_settings のグリッド・ヘッダー・行を 32 列に、スキーマ版を 1 に
    const ss = emu.spreadsheets.get(emu.scriptProps.getProperty('SHIFTLY_DB_ID')!)!;
    const st = ss.sheets.find((x) => x.title === 'store_settings')!;
    st.colCount = 32;
    st.rows = st.rows.map((r) => r.slice(0, 32));
    const meta = ss.sheets.find((x) => x.title === 'system_metadata')!;
    for (const r of meta.rows) if (r[4] === 'schemaVersion') r[5] = '1';
    // 列が少ないシートでも読み込める（範囲外を読まない）。v1 の行は既定値（シフト基準・予定休憩）で補う
    const g = owner('settings.get');
    expect(g.ok).toBe(true);
    expect(g.data.storeName).toBe('旧店舗');
    expect(g.data.payrollTimeBasis).toBe('shift');
    // 移行で列幅とヘッダーを拡張
    expect(owner('system.migrate', {}).ok).toBe(true);
    expect(st.colCount).toBeGreaterThanOrEqual(34);
    expect(st.rows[0]!.slice(32, 34)).toEqual(['breakMode', 'payrollTimeBasis']);
    expect(owner('settings.update', { breakMode: 'punch' }).ok).toBe(true);
    expect(owner('settings.get').data.breakMode).toBe('punch');
    expect(owner('system.info').data.schemaVersion).toBe(2);
  });

  it('初期化 → Admin ペアリング → 管理者操作 → 端末登録 → PIN ログイン → 打刻 → 日次ジョブ', () => {
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

    const staffApi = (req: unknown) => JSON.parse(core.staffApi(JSON.stringify(req)));
    const dev = staffApi({ op: 'staff.enroll', args: { code: en.code }, requestId: 'emu_enroll_1' });
    expect(dev.ok).toBe(true);
    const device = dev.data.deviceToken;
    const login = staffApi({ op: 'auth.login', args: { employeeId: e.id, pin: '482913' }, device, requestId: 'emu_login_01' });
    expect(login.ok).toBe(true);
    const punch = staffApi({ op: 'attendance.punch', args: { type: 'clock_in' }, device, session: login.data.sessionToken, requestId: 'emu_punch_01' });
    expect(punch.ok).toBe(true);
    // 冪等: 同じ requestId の再送
    const again = staffApi({ op: 'attendance.punch', args: { type: 'clock_in' }, device, session: login.data.sessionToken, requestId: 'emu_punch_01' });
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
    const login2 = staffApi({ op: 'auth.login', args: { employeeId: e2.id, pin: '582914' }, device, requestId: 'emu_login_02' });
    expect(staffApi({ op: 'attendance.punch', args: { type: 'clock_in' }, device, session: login2.data.sessionToken, requestId: 'emu_punch_02' }).ok).toBe(true);
    expect(staffApi({ op: 'auth.logout', device, session: login2.data.sessionToken, requestId: 'emu_logout_02' }).ok).toBe(true);
    // 互換: v1.2 までの関数名 kioskApi も同じ処理（更新前から開いていた画面向け）
    expect(JSON.parse(core.kioskApi(JSON.stringify({ op: 'staff.bootstrap', device, requestId: 'emu_boot_compat' }))).ok).toBe(true);
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
    // 管理者のエディタ実行でのみリセットできる
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

/**
 * 外部の作成の一回性（不変条件 S1、D-025）: Drive の検索・内容の取得に失敗したときに「存在しない」と見なして作り直さない。
 * 失敗の種類（作成の応答の喪失・検索の失敗・内容の取得の失敗）を列挙し、どの組み合わせでも作成物が 1 つだけであることを確かめる
 */
describe.skipIf(!built || !existsSync('dist/gas/setup/Code.js'))('S1: Drive の作成の一回性（GAS エミュレーション）', () => {
  const count = (emu: GasEmulator, key: string, value: string) => [...emu.files.values()].filter((f) => !f.trashed && f.appProperties?.[key] === value).length;

  // Core の初期化（shiftlyAuthorize）で作るもの。どれか 1 つの作成の応答を失い、再実行の最初の検索も失敗する
  for (const target of ['root', '00_System', '01_Database', 'database'] as const) {
    it(`Core の初期化: 「${target}」の作成の応答を失い、再実行の検索も失敗しても、二重に作らない`, () => {
      const emu = new GasEmulator();
      const code = randomBytes(32).toString('hex');
      const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_s1', storeName: 'S1店', adminPairingHash: sha(code), setupPairingHash: sha(code + 's') } });
      let lose = 1;
      emu.driveFaults.loseCreate = (_n, ap) => ap?.shiftly === target && lose-- > 0;
      expect(() => core.shiftlyAuthorize()).toThrow();
      expect(count(emu, 'shiftly', target)).toBe(1); // 作成は完了している（応答だけを失った）
      // 再実行: その作成物を探す検索が 1 回失敗する → 作らずに止める
      let fail = 1;
      emu.driveFaults.loseCreate = undefined;
      emu.driveFaults.listFail = (q) => q.includes(`value='${target}'`) && fail-- > 0;
      expect(() => core.shiftlyAuthorize()).toThrow();
      expect(count(emu, 'shiftly', target)).toBe(1);
      // 次の再実行で既存を見つけて使う
      emu.driveFaults.listFail = undefined;
      expect(core.shiftlyAuthorize().ok).toBe(true);
      for (const k of ['root', '00_System', '01_Database', 'database']) expect(count(emu, 'shiftly', k)).toBe(1);
    });
  }

  const release = { version: '1.3.0', core: [], admin: [], hashes: {} };
  const registry = (steps: Record<string, unknown> = {}) => ({
    schema: 1,
    envId: 'env_reg',
    ownerEmail: 'owner@example.invalid',
    storeName: '記録店',
    appVersion: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    steps,
    core: { title: 'Shiftly-Staff (env_reg)', scriptId: 'scr_core' },
    admin: { title: 'Shiftly-Admin (env_reg)' },
    adminPairingHash: sha('a'),
    setupPairingHash: sha('s'),
    update: null,
  });
  const putRegistryFile = (emu: GasEmulator, reg: unknown) => {
    emu.files.set('regfile', { name: 'Shiftly Setup Registry.json', mimeType: 'application/json', parents: [], data: Buffer.from(JSON.stringify(reg)), appProperties: { shiftlySetup: 'registry', envId: 'env_reg' } });
  };
  const api = (setup: ReturnType<GasEmulator['load']>, action: string, args?: unknown) => JSON.parse(setup.setupApi(JSON.stringify({ action, args })));

  for (const fault of ['検索の失敗', '内容の取得の失敗'] as const) {
    it(`Setup の読み込み: 記録ファイルの${fault}を、新しい環境と取り違えない`, () => {
      const emu = new GasEmulator();
      putRegistryFile(emu, registry());
      const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
      if (fault === '検索の失敗') emu.driveFaults.listFail = (q) => q.includes('shiftlySetup');
      else emu.driveFaults.mediaStatus = 500;
      const res = api(setup, 'state');
      expect(res.ok).toBe(false); // 新しい環境（envId なし）として返さない
      emu.driveFaults = {};
      const again = api(setup, 'state');
      expect(again.ok).toBe(true);
      expect(again.data.envId).toBe('env_reg');
    });
  }

  it('独立した点検 S1-3: 作成した記録ファイルが検索に反映されていなくても、同じ実行の中の保存で二重に作らない', () => {
    const emu = new GasEmulator();
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    emu.driveFaults.listHide = (q) => q.includes('shiftlySetup'); // 作成直後で検索にまだ出ない
    // 初回の実行（アカウントの確認・店舗名の保存・作成の失敗の記録など、1 回の実行の中で何度も保存する）
    api(setup, 'run', { storeName: '反映待ち店' });
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
    // 別の実行（再読み込み）でも、保存済みの ID で更新する
    api(setup, 'run', { storeName: '反映待ち店' });
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
  });

  it('独立した点検 S1-3: 同じ環境の記録ファイルが複数ある場合は、最後に保存した記録（updatedAt が最新）で再開する', () => {
    const emu = new GasEmulator();
    const old = registry();
    const latest = { ...registry(), updatedAt: '2026-11-02T00:00:00.000Z', core: { title: 'Shiftly-Staff (env_reg)', scriptId: 'scr_latest' } };
    // 古い記録（scriptId なし）を先に、新しい記録を後に置く（検索の結果の先頭は古いほう）
    emu.files.set('regA', { name: 'Shiftly Setup Registry.json', mimeType: 'application/json', parents: [], data: Buffer.from(JSON.stringify({ ...old, core: { title: 'Shiftly-Staff (env_reg)' } })), appProperties: { shiftlySetup: 'registry', envId: 'env_reg' } });
    emu.files.set('regB', { name: 'Shiftly Setup Registry.json', mimeType: 'application/json', parents: [], data: Buffer.from(JSON.stringify(latest)), appProperties: { shiftlySetup: 'registry', envId: 'env_reg' } });
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    const st = api(setup, 'state');
    expect(st.ok).toBe(true);
    expect(st.data.coreEditorUrl).toContain('scr_latest');
  });

  it('独立した点検 S1-3: 別々の環境を指す記録ファイルが複数ある場合は、どちらでも再開せずに止める', () => {
    const emu = new GasEmulator();
    putRegistryFile(emu, registry());
    emu.files.set('regOther', { name: 'Shiftly Setup Registry.json', mimeType: 'application/json', parents: [], data: Buffer.from(JSON.stringify({ ...registry(), envId: 'env_other' })), appProperties: { shiftlySetup: 'registry', envId: 'env_other' } });
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    const st = api(setup, 'state');
    expect(st.ok).toBe(false);
    expect(st.error.message).toContain('複数');
  });

  it('Setup の保存: 記録ファイルの検索に失敗しても、記録ファイルを二重に作らない', () => {
    const emu = new GasEmulator();
    const reg = registry({ 'admin.create': { status: 'error', at: '2026-11-01T00:00:00.000Z' } });
    putRegistryFile(emu, reg);
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY', JSON.stringify(reg));
    emu.userProps.setProperty('SHIFTLY_SETUP_SECRETS', JSON.stringify({ adminPairingCode: 'a', setupPairingCode: 's', setupKey: null }));
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    emu.driveFaults.listFail = (q) => q.includes('shiftlySetup');
    const res = api(setup, 'retry', { step: 'admin.create' });
    expect(res.ok).toBe(false);
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
  });
});
