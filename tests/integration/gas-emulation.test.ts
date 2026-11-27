/**
 * ビルド済み GAS バンドル（dist/gas）をエミュレータ上で実行する統合テスト
 * 前提: npm run build && npm run build:gas（未ビルドの場合はスキップ）
 * ※ Google の実環境での検証ではない（docs/technical-verification.md 参照）
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { GasEmulator } from '../helpers/gas-emulator';
import { registryReport } from '../../src/gas/setup';

const built = existsSync('dist/gas/core/Code.js');
/** 最新の画面として現在の復元世代を付ける（D-026。Script Properties に保存された世代） */
const epochOf = (emu: GasEmulator) => {
  const v = emu.scriptProps.getProperty('SHIFTLY_RESTORE_EPOCH');
  return v === null ? {} : { epoch: Number(v) };
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function ownerEnvelope(keyHex: string, body: unknown, role: 'admin' | 'setup' = 'admin') {
  const ts = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const b = JSON.stringify(body);
  const sig = createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`1.${role}.${ts}.${nonce}.${b}`).digest('hex');
  return { kind: 'owner', envelope: { v: 1, role, ts, nonce, body: b, sig } };
}

describe.skipIf(!built)('GAS バンドルのエミュレーション実行', () => {
  // Codex 監査2 #1（v1.2 の DB の移行）は、更新に伴う DB の自動移行を v1.3 では提供しないため（D-027 B案。v1.2 で運用中の店舗もない）、
  // 移行の操作を拒否し DB を変えないことを確かめる形に置き換えた
  it('D-027: 更新に伴う DB の自動移行（system.migrate）は、Google 所有者の署名付きの要求でも拒否し、DB を変えない', () => {
    const emu = new GasEmulator();
    const adminCode = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_emu2', storeName: 'エミュ店', adminPairingHash: sha(adminCode), setupPairingHash: sha(randomBytes(32).toString('hex')) } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    emu.activeUser = 'owner@example.invalid';
    core.shiftlyAuthorize();
    const key = post({ kind: 'pair', role: 'admin', pairingCode: adminCode }).data.key as string;
    const owner = (op: string, args?: unknown) => post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}`, ...epochOf(emu) }));
    const ss = emu.spreadsheets.get(emu.scriptProps.getProperty('SHIFTLY_DB_ID')!)!;
    const before = JSON.stringify(ss.sheets);
    for (const op of ['system.migrate', 'system.prepareUpdate', 'system.finishUpdate', 'system.setMaintenance']) {
      const r = owner(op, { approveDestructive: true, targetVersion: '0.2.0', on: false });
      expect(r.ok, op).toBe(false);
      expect(r.error.code, op).toBe('NOT_IN_THIS_RELEASE');
    }
    expect(JSON.stringify(ss.sheets)).toBe(before);
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
      const r = post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}`, ...epochOf(emu) }));
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
    const owner = (op: string, args?: unknown) => post(ownerEnvelope(key, { op, args, requestId: `emu_${randomBytes(6).toString('hex')}`, ...epochOf(emu) }));
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

  // Codex 監査22 #3: 作成の結果が分からないとき、検索が「正常に 0 件」を返す（反映の遅れ）場合も、作り直さない。
  // 作成物 × 失敗の種類（作成済みで応答を喪失・作成されていない）を回す
  for (const target of ['root', '00_System', '01_Database', 'database', 'environment'] as const) {
    for (const kind of ['作成済みで応答を喪失し、検索に反映されていない', '作成されていない'] as const) {
      it(`Core の初期化: 「${target}」が${kind}場合、確認なしに作り直さない`, () => {
        const emu = new GasEmulator();
        const code = randomBytes(32).toString('hex');
        const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_s1b', storeName: 'S1店', adminPairingHash: sha(code), setupPairingHash: sha(code + 's') } });
        let once = 1;
        if (kind === '作成されていない') emu.driveFaults.failCreate = (_n, ap) => ap?.shiftly === target && once-- > 0;
        else emu.driveFaults.loseCreate = (_n, ap) => ap?.shiftly === target && once-- > 0;
        expect(() => core.shiftlyAuthorize()).toThrow();
        const expected = kind === '作成されていない' ? 0 : 1;
        expect(count(emu, 'shiftly', target)).toBe(expected);
        // 再実行: 検索が正常に 0 件を返す（反映の遅れ。作成されていない場合も検索は 0 件）→ 作らずに止める
        emu.driveFaults = { listHide: (q) => q.includes(`value='${target}'`) };
        expect(() => core.shiftlyAuthorize()).toThrow(/shiftlyConfirmStorageNotCreated/);
        expect(count(emu, 'shiftly', target)).toBe(expected);
        emu.driveFaults = {};
        if (kind === '作成されていない') {
          // 検索に反映されても見つからない → 止まったまま。所有者が確認して目印を外した後にだけ作る
          expect(() => core.shiftlyAuthorize()).toThrow(/shiftlyConfirmStorageNotCreated/);
          expect(count(emu, 'shiftly', target)).toBe(0);
          emu.activeUser = '';
          expect(() => core.shiftlyConfirmStorageNotCreated()).toThrow(); // 匿名の訪問者は実行できない
          emu.activeUser = 'owner@example.invalid';
          expect(core.shiftlyConfirmStorageNotCreated().cleared).toContain(target === 'root' || target === 'database' || target === 'environment' ? target : `folder:${target}`);
        }
        // 検索に反映された（または確認の後）: 既存を使う／1 つだけ作る
        expect(core.shiftlyAuthorize().ok).toBe(true);
        for (const k of ['root', '00_System', '01_Database', 'database', 'environment']) expect(count(emu, 'shiftly', k), k).toBe(1);
      });
    }
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
    api(setup, 'retry', { step: 'account', confirmedNoDuplicate: true, storeName: '反映待ち店' }); // 記録がない: 初めての構築の確認を明示して開始（D-026 #9）
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
    // 別の実行（再読み込み）でも、保存済みの ID で更新する
    api(setup, 'run', { storeName: '反映待ち店' });
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
  });

  for (const kind of ['作成済みで応答を喪失した', '作成されていない'] as const) {
    it(`Codex 監査22 #3: Setup の記録ファイルが${kind}場合も、検索に反映されていない間に二重に作らない`, () => {
      const emu = new GasEmulator();
      const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
      let once = 1;
      if (kind === '作成されていない') emu.driveFaults.failCreate = (_n, ap) => ap?.shiftlySetup === 'registry' && once-- > 0;
      else emu.driveFaults.loseCreate = (_n, ap) => ap?.shiftlySetup === 'registry' && once-- > 0;
      emu.driveFaults.listHide = (q) => q.includes('shiftlySetup'); // 検索には反映されていない
      // 1 回の実行の中で何度も保存する（最初の保存の作成で失敗し、同じ実行のエラーの記録の保存などが続く）
      api(setup, 'retry', { step: 'account', confirmedNoDuplicate: true, storeName: '反映待ち店' }); // 記録がない: 初めての構築の確認を明示して開始（D-026 #9）
      api(setup, 'run', { storeName: '反映待ち店' });
      expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
      emu.driveFaults = {};
      api(setup, 'run', { storeName: '反映待ち店' });
      expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
    });
  }

  it('独立した点検 #9（D-026）: Setup の記録が見つからない場合は、初めての構築の確認を明示するまで新しい環境を作らない', () => {
    const emu = new GasEmulator();
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    emu.driveFaults.listHide = (q) => q.includes('shiftlySetup'); // 以前の記録が検索に見えていない状態
    for (const req of [{ action: 'run', args: { storeName: '店' } }, { action: 'retry', args: { step: 'account', storeName: '店' } }, { action: 'retry', args: { step: 'core.create', confirmedNoDuplicate: true } }]) {
      const r = JSON.parse(setup.setupApi(JSON.stringify(req)));
      expect(r.ok).toBe(true);
      expect(r.data.error.step).toBe('account');
      expect(r.data.error.confirm).toContain('初めて');
      expect(emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY')).toBeNull(); // 新しい環境を作っていない
    }
    const ok = JSON.parse(setup.setupApi(JSON.stringify({ action: 'retry', args: { step: 'account', confirmedNoDuplicate: true, storeName: '店' } })));
    expect(ok.ok).toBe(true);
    expect(emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY')).not.toBeNull();
    // 記録ができた後の「続きから実行」は確認を求めない
    expect(JSON.parse(setup.setupApi(JSON.stringify({ action: 'run', args: {} }))).data.error?.step).not.toBe('account');
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

/**
 * D-026 S1: Core の Google ドライブの構成物と Setup の記録ファイルを、構成物 × 失敗の地点 × 再実行 で確かめる（GAS エミュレーション）。
 * 判定はエミュレータ上の実体（ファイル・フォルダの件数）で行う
 */
describe.skipIf(!built || !existsSync('dist/gas/setup/Code.js'))('S1: Core の保管先・Setup の記録ファイルの状態管理（D-026）', () => {
  const count = (emu: GasEmulator, key: string, value: string) => [...emu.files.values()].filter((f) => !f.trashed && f.appProperties?.[key] === value).length;
  // Core の構成物の全体（ルート・全サブフォルダ FOLDER_KEYS・DB・環境情報ファイル）
  const ITEMS = ['root', '00_System', '01_Database', '02_Payslips', '03_Exports', '04_Audit', '05_Backup', 'database', 'environment'] as const;
  const PROP_OF: Record<string, string> = { root: 'SHIFTLY_ROOT_FOLDER', database: 'SHIFTLY_DB_ID', environment: 'SHIFTLY_ENV_FILE_ID' };
  const load = () => {
    const emu = new GasEmulator();
    const code = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_s1c', storeName: 'S1店', adminPairingHash: sha(code), setupPairingHash: sha(code + 's') } });
    return { emu, core };
  };
  const all = (emu: GasEmulator) => ITEMS.map((k) => count(emu, 'shiftly', k));

  for (const target of ITEMS) {
    it(`「${target}」: 作成の目印の保存に失敗 → 作成を要求しない`, () => {
      const { emu, core } = load();
      const marker = ['root', 'database', 'environment'].includes(target) ? target : `folder:${target}`;
      let once = 1;
      emu.scriptProps.failSet = (k, v) => k === 'SHIFTLY_STORAGE_CREATING' && v.includes(`"${marker}"`) && once-- > 0;
      expect(() => core.shiftlyAuthorize()).toThrow();
      expect(count(emu, 'shiftly', target)).toBe(0);
      emu.scriptProps.failSet = undefined;
      expect(core.shiftlyAuthorize().ok).toBe(true);
      expect(all(emu)).toEqual(ITEMS.map(() => 1));
    });

    for (const fails of ['作成後の ID の保存に失敗', '作成後の ID の保存に失敗し、検索も 0 件（反映の遅れ）'] as const) {
      it(`「${target}」: ${fails} → 目印を残し、二重に作らない（Codex 監査23 #2）`, () => {
        const { emu, core } = load();
        // 作成の後の ID の保存だけを 1 回失敗させる
        let once = 1;
        const created = () => count(emu, 'shiftly', target) === 1;
        emu.scriptProps.failSet = (k) => (k === (PROP_OF[target] ?? 'SHIFTLY_FOLDERS')) && created() && once-- > 0;
        expect(() => core.shiftlyAuthorize()).toThrow();
        emu.scriptProps.failSet = undefined;
        expect(count(emu, 'shiftly', target)).toBe(1);
        expect(emu.scriptProps.getProperty('SHIFTLY_STORAGE_CREATING')).toContain(target === 'root' || target === 'database' || target === 'environment' ? target : `folder:${target}`);
        if (fails.includes('反映の遅れ')) {
          emu.driveFaults.listHide = (q) => q.includes(`value='${target}'`);
          expect(() => core.shiftlyAuthorize()).toThrow(/shiftlyConfirmStorageNotCreated/);
          expect(count(emu, 'shiftly', target)).toBe(1);
          // 所有者の確認の操作: 検索し直して見つからないものだけ目印を外す。反映された後は見つかって関連付ける
          emu.driveFaults = {};
        }
        expect(core.shiftlyAuthorize().ok).toBe(true);
        expect(all(emu)).toEqual(ITEMS.map(() => 1));
        expect(emu.scriptProps.getProperty('SHIFTLY_STORAGE_CREATING')).toBeNull();
      });
    }
  }

  it('独立した点検 #5: Core の構成物（環境情報ファイルを含む）は、すべてスクリプトロックの中で作る（目印の読み書きを含む）', () => {
    const { emu, core } = load();
    expect(core.shiftlyAuthorize().ok).toBe(true);
    const storage = emu.createLog.filter((c) => c.appProperties?.shiftly);
    expect(storage.map((c) => c.appProperties!.shiftly).sort()).toEqual([...ITEMS].sort());
    for (const c of storage) expect(c.underLock, c.appProperties!.shiftly).toBe(true);
    expect(emu.scriptLockHeld).toBe(0);
  });

  it('確認の操作（shiftlyConfirmStorageNotCreated）: 見つかる構成物は関連付け、見つからない構成物の目印だけを外す', () => {
    const { emu, core } = load();
    let once = 1;
    emu.driveFaults.loseCreate = (_n, ap) => ap?.shiftly === 'database' && once-- > 0; // DB は作成済み（応答を喪失）
    expect(() => core.shiftlyAuthorize()).toThrow();
    // 環境情報ファイルは作成されていない状態の目印を加える（作成前に止まった）
    const m = JSON.parse(emu.scriptProps.getProperty('SHIFTLY_STORAGE_CREATING') ?? '{}');
    emu.scriptProps.setProperty('SHIFTLY_STORAGE_CREATING', JSON.stringify({ ...m, environment: new Date().toISOString() }));
    emu.driveFaults = {};
    const r = core.shiftlyConfirmStorageNotCreated();
    expect(r.adopted).toContain('database');
    expect(r.cleared).toContain('environment');
    expect(core.shiftlyAuthorize().ok).toBe(true);
    expect(all(emu)).toEqual(ITEMS.map(() => 1));
  });

  it('検索で同じ構成物が 2 つ見つかった場合は、どちらも使わずに止める（自動では選ばない・削除しない）', () => {
    const { emu, core } = load();
    expect(core.shiftlyAuthorize().ok).toBe(true);
    const dbFolder = JSON.parse(emu.scriptProps.getProperty('SHIFTLY_FOLDERS')!)['01_Database'];
    emu.scriptProps.deleteProperty('SHIFTLY_DB_ID'); // 記録の ID を失った状態
    emu.files.set('dup_db', { name: 'Shiftly Database - 重複', mimeType: 'application/vnd.google-apps.spreadsheet', parents: [dbFolder], data: null, appProperties: { shiftly: 'database' } });
    expect(() => core.shiftlyAuthorize()).toThrow(/2 つあります/);
    expect(count(emu, 'shiftly', 'database')).toBe(2);
  });

  it('完了前の点検（system.storageCheck）: 問題がなければ ok、重複・残った目印・記録の喪失を問題として返す', () => {
    const emu = new GasEmulator();
    const code = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_s1d', storeName: 'S1店', adminPairingHash: sha(code), setupPairingHash: sha(code + 's') } });
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    expect(core.shiftlyAuthorize().ok).toBe(true);
    const key = post({ kind: 'pair', role: 'admin', pairingCode: code }).data.key as string;
    const check = () => post(ownerEnvelope(key, { op: 'system.storageCheck', requestId: `emu_${randomBytes(6).toString('hex')}` })).data as { ok: boolean; issues: string[] };
    expect(check().ok).toBe(true);
    const root = emu.scriptProps.getProperty('SHIFTLY_ROOT_FOLDER')!;
    emu.files.set('dup_exports', { name: '03_Exports', mimeType: 'application/vnd.google-apps.folder', parents: [root], data: null, appProperties: { shiftly: '03_Exports' } });
    emu.scriptProps.setProperty('SHIFTLY_STORAGE_CREATING', JSON.stringify({ environment: new Date().toISOString() }));
    emu.scriptProps.deleteProperty('SHIFTLY_ENV_FILE_ID');
    const r = check();
    expect(r.ok).toBe(false);
    expect(r.issues.join()).toContain('03_Exports');
    expect(r.issues.join()).toContain('目印');
    expect(r.issues.join()).toContain('ID が保存されていません');
  });

  // Setup の記録ファイル: 作成の応答の喪失 → 直後の更新の一時的な失敗 → 同じ ID での作成は競合（作成済み）→ 予約 ID を消さずに止め、次の保存で 1 つのまま
  it('Codex 監査23 #3: 記録ファイルの更新と同じ ID での作成が続けて失敗しても、予約 ID を消さず、二重に作らない', () => {
    const emu = new GasEmulator();
    const setup = emu.load('setup', { SHIFTLY_RELEASE: { version: '1.3.0', core: [], admin: [], hashes: {} } });
    let lose = 1;
    emu.driveFaults.loseCreate = (_n, ap) => ap?.shiftlySetup === 'registry' && lose-- > 0;
    let upd = 1;
    emu.driveFaults.updateFail = () => upd-- > 0;
    emu.driveFaults.listHide = (q) => q.includes('shiftlySetup');
    JSON.parse(setup.setupApi(JSON.stringify({ action: 'retry', args: { step: 'account', confirmedNoDuplicate: true, storeName: '店' } })));
    const reserved = emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID');
    expect(reserved).toBeTruthy();
    JSON.parse(setup.setupApi(JSON.stringify({ action: 'run', args: { storeName: '店' } })));
    expect(emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID')).toBe(reserved);
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
    emu.driveFaults = {};
    JSON.parse(setup.setupApi(JSON.stringify({ action: 'run', args: { storeName: '店' } })));
    expect(count(emu, 'shiftlySetup', 'registry')).toBe(1);
  });
});

/**
 * D-026 R1 を GAS のアダプタ（Sheets・Drive・Script Properties）の経路で確かめる（独立した点検 #4）:
 * Shiftly-Admin（adminApi。epoch の転送）→ Core（doPost）→ 復元（Drive の複製・DB の切替）→ 古い世代の拒否・世代の保持・保管先の点検
 */
describe.skipIf(!built || !existsSync('dist/gas/admin/Code.js'))('R1: GAS のアダプタでの画面の世代・保守作業（D-026・D-027）', () => {
  function stack() {
    const coreEmu = new GasEmulator();
    const adminEmu = new GasEmulator();
    const code = randomBytes(32).toString('hex');
    const core = coreEmu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_r1', storeName: 'R1店', adminPairingHash: sha(code), setupPairingHash: sha(code + 's') } });
    expect(core.shiftlyAuthorize().ok).toBe(true);
    // Admin の UrlFetchApp を Core の doPost につなぐ（実環境では Web アプリの URL への POST）
    const admin = adminEmu.load('admin', {
      SHIFTLY_ADMIN_BOOTSTRAP: { envId: 'env_r1', coreUrl: 'https://script.google.com/macros/s/core/exec', pairingCode: code },
      UrlFetchApp: { fetch: (_url: string, opts: { payload: string }) => ({ getResponseCode: () => 200, getContentText: () => core.doPost({ postData: { contents: opts.payload } }).content }) },
    });
    const api = (req: Record<string, unknown>) => JSON.parse(admin.adminApi(JSON.stringify({ requestId: `emu_${randomBytes(6).toString('hex')}`, ...req })));
    const epoch = () => Number(coreEmu.scriptProps.getProperty('SHIFTLY_RESTORE_EPOCH'));
    return { coreEmu, core, api, epoch };
  }

  it('保守作業の終了で世代は Script Properties で新しくなり、保守の前の世代の保存は拒否される（Admin は数値の世代だけを転送する）。DB は切り替えない', () => {
    const { coreEmu, core, api, epoch } = stack();
    const e0 = epoch();
    expect(e0).toBeGreaterThan(0);
    const got = api({ op: 'settings.get' });
    expect(got.ok).toBe(true);
    expect(got.epoch).toBe(e0);
    expect(api({ op: 'settings.update', args: { storeName: '保守の前' }, epoch: e0 }).ok).toBe(true);
    const dbBefore = coreEmu.scriptProps.getProperty('SHIFTLY_DB_ID');
    // Google 所有者がエディタで保守作業を開始 → 業務の更新は止まる
    expect(core.shiftlyMaintenanceBegin().ok).toBe(true);
    expect(api({ op: 'settings.update', args: { storeName: '保守中' }, epoch: e0 }).error?.code).toBe('MAINTENANCE');
    expect(core.shiftlyMaintenanceStatus().data.maintenanceWork.active).toBe(true);
    // 終了 → 世代が変わる（DB は同じ）
    expect(core.shiftlyMaintenanceFinish().ok).toBe(true);
    expect(coreEmu.scriptProps.getProperty('SHIFTLY_DB_ID')).toBe(dbBefore);
    expect(coreEmu.scriptProps.getProperty('SHIFTLY_MAINTENANCE')).toBeNull();
    const e1 = epoch();
    expect(e1).not.toBe(e0);
    for (const ep of [e0, undefined, String(e1)]) expect(api({ op: 'settings.update', args: { storeName: '古い画面' }, ...(ep !== undefined ? { epoch: ep } : {}) }).error?.code).toBe('STALE_VIEW');
    expect(api({ op: 'settings.update', args: { storeName: '読み込み直した画面' }, epoch: e1 }).ok).toBe(true);
    // 保管先の点検: 保守の記録（00_System のファイル）・バックアップの複製を DB と数えない
    const sc = api({ op: 'system.storageCheck' });
    expect(sc.ok).toBe(true);
    expect(sc.data.issues).toEqual([]);
  });

  it('保守作業中は、日次の定期処理（時間主導トリガー）も業務の更新をしない', () => {
    const { coreEmu, core } = stack();
    expect(core.shiftlyMaintenanceBegin().ok).toBe(true);
    const backups = [...coreEmu.files.values()].filter((f) => f.appProperties?.shiftly === 'backup').length;
    core.shiftlyDailyJob({ triggerUid: 'trg0' });
    expect([...coreEmu.files.values()].filter((f) => f.appProperties?.shiftly === 'backup').length).toBe(backups);
    expect(core.shiftlyMaintenanceFinish().ok).toBe(true);
    core.shiftlyDailyJob({ triggerUid: 'trg0' });
    expect([...coreEmu.files.values()].filter((f) => f.appProperties?.shiftly === 'backup').length).toBe(backups + 1);
  });

  it('D-027: アプリ内の復元（稼働中の DB の切替）は、Admin（Google 所有者）からも拒否し、DB・ファイルを変えない', () => {
    const { coreEmu, api, epoch } = stack();
    const bk = api({ op: 'backup.run', args: { kind: 'manual' }, epoch: epoch() });
    expect(bk.ok).toBe(true);
    const dbBefore = coreEmu.scriptProps.getProperty('SHIFTLY_DB_ID');
    const filesBefore = JSON.stringify([...coreEmu.files.entries()].map(([id, f]) => [id, f.name, f.appProperties, !!f.trashed]));
    const e0 = epoch();
    const r = api({ op: 'backup.restore', args: { backupId: bk.data.id, confirmText: '復元する' } });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('NOT_IN_THIS_RELEASE');
    expect(coreEmu.scriptProps.getProperty('SHIFTLY_DB_ID')).toBe(dbBefore);
    expect(JSON.stringify([...coreEmu.files.entries()].map(([id, f]) => [id, f.name, f.appProperties, !!f.trashed]))).toBe(filesBefore);
    expect(epoch()).toBe(e0);
  });
});

/**
 * Codex 監査24 A3・A4（D-027）: Setup の記録ファイルを、保存している ID で直接照会する／Drive の一覧は全ページを取得する。
 * 判定はエミュレータ上の実体（記録ファイルの件数・内容）で行う
 */
describe.skipIf(!built || !existsSync('dist/gas/setup/Code.js'))('Codex 監査24 A3・A4: Setup の記録ファイルの直接照会・全ページの取得', () => {
  const sha = (x: string) => createHash('sha256').update(x).digest('hex');
  const release = { version: '1.3.0', core: [], admin: [], hashes: {} };
  const registry = (envId = 'env_reg') => ({
    schema: 1, envId, ownerEmail: 'owner@example.invalid', storeName: '記録店', appVersion: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    steps: {}, core: { title: `Shiftly-Staff (${envId})`, scriptId: 'scr_core' }, admin: { title: `Shiftly-Admin (${envId})` }, adminPairingHash: sha('a'), setupPairingHash: sha('s'),
  });
  const putFile = (emu: GasEmulator, id: string, reg: { envId: string }) =>
    emu.files.set(id, { name: 'Shiftly Setup Registry.json', mimeType: 'application/json', parents: [], data: Buffer.from(JSON.stringify(reg)), appProperties: { shiftlySetup: 'registry', envId: reg.envId } });
  const api = (setup: ReturnType<GasEmulator['load']>, action: string, args?: unknown) => JSON.parse(setup.setupApi(JSON.stringify({ action, args })));
  const regFiles = (emu: GasEmulator) => [...emu.files.entries()].filter(([, f]) => !f.trashed && f.appProperties?.shiftlySetup === 'registry');

  it('A3: 保存している ID の記録ファイルが見つからず（404）、Setup の中の記録もない場合は、新しい環境とは推測せずに止める（検索で別の記録を探さない）', () => {
    const emu = new GasEmulator();
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_lost');
    putFile(emu, 'reg_other', registry('env_reg')); // 検索では見つかる記録（同じ環境でも、ID の照会の代わりに使わない）
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    for (const action of ['state', 'run']) {
      const r = api(setup, action, { storeName: '店' });
      expect(r.ok, action).toBe(false);
      expect(r.error.message).toContain('reg_lost');
    }
    expect(emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY')).toBeNull();
    expect(regFiles(emu)).toHaveLength(1);
  });

  it('A3: 保存している ID の照会が一時的に失敗した（500）場合は止め、回復すると同じ記録で再開する', () => {
    const emu = new GasEmulator();
    putFile(emu, 'reg_main', registry());
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_main');
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    emu.driveFaults.metaStatus = 500;
    expect(api(setup, 'state').ok).toBe(false);
    emu.driveFaults = {};
    const st = api(setup, 'state');
    expect(st.ok).toBe(true);
    expect(st.data.envId).toBe('env_reg');
  });

  it('A3: 記録ファイルがゴミ箱にある場合は、新しい環境として扱わずに止める', () => {
    const emu = new GasEmulator();
    putFile(emu, 'reg_main', registry());
    emu.files.get('reg_main')!.trashed = true;
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_main');
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    const r = api(setup, 'state');
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('ゴミ箱');
  });

  it('A3: 保存している ID のファイルが別の環境の記録の場合は、上書きせずに止める（その記録ファイルは変わらない）', () => {
    const emu = new GasEmulator();
    putFile(emu, 'reg_other', registry('env_other'));
    const before = emu.files.get('reg_other')!.data!.toString('utf8');
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_other');
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY', JSON.stringify(registry('env_reg')));
    emu.userProps.setProperty('SHIFTLY_SETUP_SECRETS', JSON.stringify({ adminPairingCode: 'a', setupPairingCode: 's', setupKey: null }));
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    for (const [action, args] of [['state', undefined], ['run', { storeName: '別の店' }], ['retry', { step: 'store', storeName: '別の店' }]] as const) {
      const r = api(setup, action, args);
      expect(r.ok, action).toBe(false);
      expect(r.error.message).toContain('一致しません');
    }
    expect(emu.files.get('reg_other')!.data!.toString('utf8')).toBe(before);
    expect(regFiles(emu)).toHaveLength(1);
  });

  it('A3: 予約した ID でまだ作られていない（Setup の中の記録はある）場合は、同じ ID で作成して続ける', () => {
    const emu = new GasEmulator();
    const ids = (emu as unknown as { reservedIds: Set<string> }).reservedIds;
    ids.add('rsv_pending');
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'rsv_pending');
    emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY', JSON.stringify(registry()));
    emu.userProps.setProperty('SHIFTLY_SETUP_SECRETS', JSON.stringify({ adminPairingCode: 'a', setupPairingCode: 's', setupKey: null }));
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    expect(api(setup, 'state').ok).toBe(true);
    api(setup, 'retry', { step: 'store', storeName: '記録店' });
    const files = regFiles(emu);
    expect(files).toHaveLength(1);
    expect(files[0]![0]).toBe('rsv_pending');
  });

  it('A4: 検索の 2 ページ目にある別の環境の記録ファイルも検出して止める（1 ページ目だけで判断しない）', () => {
    const emu = new GasEmulator();
    emu.maxPageSize = 1;
    putFile(emu, 'reg_a', registry('env_reg'));
    putFile(emu, 'reg_b', registry('env_other'));
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    const r = api(setup, 'state');
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('別々の環境');
  });

  it('A4: 検索の途中のページで失敗した場合は、一部の結果で判断せずに止める', () => {
    const emu = new GasEmulator();
    emu.maxPageSize = 1;
    putFile(emu, 'reg_a', registry('env_reg'));
    putFile(emu, 'reg_b', registry('env_reg'));
    emu.driveFaults.listFailPage = (q, page) => q.includes('shiftlySetup') && page === 1;
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    expect(api(setup, 'state').ok).toBe(false);
    expect(emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID')).toBeNull();
  });

  it('A4: 構築の完了前の点検（registryReport）は、全ページで記録ファイルの重複・別の環境・ID の不一致を検出し、途中のページの失敗は例外にする', () => {
    const emu = new GasEmulator();
    const g = emu.globals({}) as Record<string, unknown>;
    const keys = ['PropertiesService', 'Drive', 'UrlFetchApp', 'ScriptApp'] as const;
    const saved = keys.map((k) => (globalThis as Record<string, unknown>)[k]);
    try {
      for (const k of keys) (globalThis as Record<string, unknown>)[k] = g[k];
      emu.maxPageSize = 1;
      putFile(emu, 'reg_a', registry('env_reg'));
      emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_a');
      expect(registryReport('env_reg')).toEqual({ ok: true, issues: [] });
      // 同じ環境の 2 つ目（2 ページ目）
      putFile(emu, 'reg_dup', registry('env_reg'));
      let r = registryReport('env_reg');
      expect(r.ok).toBe(false);
      expect(r.issues.join()).toContain('2 つあります');
      emu.files.delete('reg_dup');
      // 別の環境の記録（2 ページ目）
      putFile(emu, 'reg_other', registry('env_other'));
      r = registryReport('env_reg');
      expect(r.ok).toBe(false);
      expect(r.issues.join()).toContain('別の環境');
      emu.files.delete('reg_other');
      // 保存している ID と一致しない
      emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_x');
      expect(registryReport('env_reg').issues.join()).toContain('一致しません');
      emu.userProps.setProperty('SHIFTLY_SETUP_REGISTRY_FILE_ID', 'reg_a');
      // 途中のページの失敗
      putFile(emu, 'reg_dup', registry('env_reg'));
      emu.driveFaults.listFailPage = (_q, page) => page === 1;
      expect(() => registryReport('env_reg')).toThrow();
    } finally {
      keys.forEach((k, i) => ((globalThis as Record<string, unknown>)[k] = saved[i]));
    }
  });

  it('A4: Core の保管先の検索も全ページを取得する（2 ページ目にある重複を検出し、作成も関連付けもしない）', () => {
    const emu = new GasEmulator();
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_pg', storeName: '頁店', adminPairingHash: sha('a'), setupPairingHash: sha('s') } });
    expect(core.shiftlyAuthorize().ok).toBe(true);
    // ルートの記録を失い、同じ目印のルートが 2 つある（2 ページ目に 2 つ目）
    const rootId = emu.scriptProps.getProperty('SHIFTLY_ROOT_FOLDER')!;
    const root = emu.files.get(rootId)!;
    emu.files.set('dup_root', { ...root });
    emu.scriptProps.deleteProperty('SHIFTLY_ROOT_FOLDER');
    emu.maxPageSize = 1;
    const filesBefore = emu.files.size;
    expect(() => core.shiftlyAuthorize()).toThrow(/2 つあります/);
    expect(emu.files.size).toBe(filesBefore);
    expect(emu.scriptProps.getProperty('SHIFTLY_ROOT_FOLDER')).toBeNull();
  });
});
