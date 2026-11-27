/**
 * 画面の世代（D-026。D-027 B案で発行の契機を変更）の網羅テスト
 * - 全操作の分類と、世代の照合を適用しない操作の理由の登録
 * - 画面からの業務更新（kind: 'edit'）すべてで: 現在の世代は通る／保守作業の前の世代・世代なしは拒否し、データを変えない
 *   （Google 所有者・店舗 iPad の管理者モード・スタッフ本人の 3 つの経路）
 * - 保守作業の場面: 店舗設定（Codex 監査23 #1 と同じ形）、再認証、連続した保守作業、終了の失敗、世代の記録の欠落・破損、ロックの内側での照合
 * - Codex 監査24 A1: 世代は時刻に依存しない乱数。既存の環境で記録が失われた・壊れた場合は、初期化では作り直さない（保守作業の終了で再発行）
 * v1.3 ではアプリ内の復元（DB の切替）を提供しないため（D-027）、世代が変わるのは初めての構築と保守作業の終了だけ。
 * 旧版の「復元」で世代を進めていたテストは、保守作業の終了で世代を変える形に置き換えた（期待値は仕様から定めたもの）。
 * 世代は乱数のため、旧版の「前より大きい」の確認は「過去のどの世代とも異なる」に置き換えた（仕様変更。docs/review-log.md C-24）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { listOps } from '../../src/backend/api';
import { EPOCH_EXEMPT } from '../../src/backend/epoch-exemptions';
import { EPOCH_KEY } from '../../src/backend/context';
import { TABLES } from '../../src/backend/schema';
import { UnitOfWork } from '../../src/backend/store';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);
const uowOf = (h: Harness) => new UnitOfWork(h.env.adapter, { now: () => h.env.clock.now, newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
/** DB の全表の内容（変わっていないことの確認に使う） */
const fingerprint = (h: Harness) => JSON.stringify(TABLES.map((d) => [d.name, uowOf(h).list(d.name)]));
const ADMIN_PW = 'Kanri#Pass-2026x';

function store() {
  const h = new Harness();
  h.setupStore();
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
  return { h, a };
}
/** Google 所有者の保守作業（開始 → 終了）。終了で全セッションを失効し、画面の世代を新しく発行する（D-027） */
const maint = (h: Harness) => {
  h.ownerOk('maintenance.begin', { confirmText: '保守を開始する' });
  return h.ownerOk('maintenance.finish', { confirmText: '保守を終了する' });
};

describe('操作の分類（D-026）', () => {
  const ops = listOps();
  it('全操作に分類があり、読み取りだけがデータを変えない', () => {
    for (const o of ops) {
      expect(['read', 'edit', 'punch', 'auth', 'system', 'output', 'internal'], o.name).toContain(o.kind);
      expect(o.kind === 'read', o.name).toBe(!o.mutating);
    }
  });
  it('世代の照合を適用しない更新系の操作は、この一覧（見直し済み）と一致する（追加・変更にはテストの更新＝見直しが必要）', () => {
    const EXPECTED = [
      'attendance.punch',
      'auth.login', 'auth.logout', 'auth.changePin', 'auth.stepUp',
      'adminAuth.login', 'adminAuth.logout', 'adminAuth.reauth', 'adminAuth.changePassword', 'adminAuth.setPassword', 'adminAuth.unlock', 'adminAuth.revokeSessions',
      'credentials.setPin', 'credentials.clearPin', 'credentials.unlock', 'credentials.setStepUp',
      'staff.enroll', 'devices.createEnrollment', 'devices.revoke',
      'backup.run', 'system.initialize', 'system.resetSetupPairing', 'maintenance.begin', 'maintenance.finish',
      'export.attendance', 'export.payroll', 'export.shifts', 'export.wageLedger',
      'system.dailyJob', 'notifications.scan',
    ];
    expect(Object.keys(EPOCH_EXEMPT).sort()).toEqual([...EXPECTED].sort());
  });
  it('世代の照合を適用しない更新系の操作は、すべて理由が登録されている（登録の過不足がない）', () => {
    const exempt = ops.filter((o) => o.mutating && o.kind !== 'edit').map((o) => o.name).sort();
    expect(Object.keys(EPOCH_EXEMPT).sort()).toEqual(exempt);
    for (const [k, why] of Object.entries(EPOCH_EXEMPT)) expect(why.length, k).toBeGreaterThan(5);
    for (const o of ops.filter((x) => x.kind === 'edit')) expect(EPOCH_EXEMPT[o.name], o.name).toBeUndefined();
  });
});

describe('画面からの業務更新（kind: edit）の全操作で、世代を照合する', () => {
  const edits = listOps().filter((o) => o.kind === 'edit');
  it('対象は 0 件ではない', () => expect(edits.length).toBeGreaterThan(40));

  // 経路: Google 所有者（Shiftly-Admin）／店舗 iPad の管理者モード／スタッフ本人
  for (const op of edits) {
    it(`${op.name}: 保守作業の前の世代・世代なしは拒否してデータを変えず、現在の世代は世代の照合を通る`, () => {
      const { h } = store();
      const old = h.currentEpoch()!;
      maint(h);
      const cur = h.currentEpoch()!;
      expect(cur).not.toBe(old);
      // 経路ごとの呼び出し
      const viaOwner = op.auth === 'owner' || op.auth === 'staff_or_owner';
      const viaAdmin = op.auth === 'staff_or_owner' || (op.auth === 'owner' && !!op.adminAllowed);
      const viaStaff = op.auth === 'session' || op.auth === 'staff_or_owner';
      const calls: Array<[string, (epoch: number | null) => any]> = [];
      if (viaOwner) calls.push(['Google 所有者', (epoch) => h.owner(op.name, {}, { epoch })]);
      if (viaAdmin) {
        const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
        calls.push(['管理者モード', (epoch) => h.staff(op.name, {}, { session: '', adminSession: t, epoch })]);
      }
      if (viaStaff) {
        // 権限を持つスタッフ（追加認証済み）
        const cat = h.ownerOk<any>('permissions.catalog').permissions as Array<{ key: string } | string> | Record<string, unknown>;
        const allPerms = Array.isArray(cat) ? cat.map((x) => (typeof x === 'string' ? x : x.key)) : Object.keys(cat);
        const s = h.addStaff(`本人${Math.random().toString(16).slice(2, 6)}`, '573024', { perms: allPerms, stepUp: 'Kanri-Code-9137' });
        h.login(s, '573024');
        h.staff('auth.stepUp', { passcode: 'Kanri-Code-9137' });
        calls.push(['スタッフ本人', (epoch) => h.staff(op.name, {}, { epoch })]);
      }
      expect(calls.length, '少なくとも 1 つの経路で確かめる').toBeGreaterThan(0);
      for (const [who, call] of calls) {
        for (const epoch of [old, null, cur + 1]) {
          const before = fingerprint(h);
          const r = call(epoch);
          expect(code(r), `${who} 世代 ${epoch}`).toBe('STALE_VIEW');
          expect(fingerprint(h), `${who} 世代 ${epoch}: データを変えない`).toBe(before);
        }
        expect(code(call(cur)), `${who} 現在の世代`).not.toBe('STALE_VIEW');
      }
    });
  }
});

describe('保守作業の場面', () => {
  it('保守作業の前に開いた店舗設定画面から、給与計算の時間基準を変更できない（最新の画面からは変更できる。Codex 監査23 #1 と同じ形）', () => {
    const { h } = store();
    h.ownerOk('settings.update', { payrollTimeBasis: 'shift' });
    const opened = h.currentEpoch()!; // 別のタブで店舗設定を開いた時点
    maint(h);
    expect(code(h.owner('settings.update', { payrollTimeBasis: 'actual' }, { epoch: opened }))).toBe('STALE_VIEW');
    expect(h.ownerOk('settings.get').payrollTimeBasis).toBe('shift');
    expect(code(h.owner('settings.update', { payrollTimeBasis: 'actual' }))).toBe('OK'); // 読み込み直した画面
    expect(h.ownerOk('settings.get').payrollTimeBasis).toBe('actual');
  });

  it('再認証: 保守作業の終了で管理者モードのセッションが失効し、ログインし直しても、保守作業の前に読み込んだ画面（世代）からは保存できない', () => {
    const { h, a } = store();
    const t1 = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    const opened = h.currentEpoch()!;
    maint(h);
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t1, epoch: opened }))).toBe('ADMIN_UNAUTHENTICATED');
    const t2 = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t2, epoch: opened }))).toBe('STALE_VIEW');
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t2 }))).toBe('OK');
  });

  it('連続した保守作業: 世代は毎回、過去のどの世代とも異なる値になり、過去のどの世代でも保存できない（世代は業務 DB の外に置く）', () => {
    const { h, a } = store();
    const seen: number[] = [h.currentEpoch()!];
    for (let i = 0; i < 5; i++) {
      h.advance(60_000);
      maint(h);
      const cur = h.currentEpoch()!;
      expect(seen).not.toContain(cur);
      for (const e of seen) expect(code(h.owner('employees.update', { employeeId: a, note: '古い画面', version: 1 }, { epoch: e })), `世代 ${e}`).toBe('STALE_VIEW');
      seen.push(cur);
    }
    for (const d of TABLES) expect(JSON.stringify(uowOf(h).list(d.name)), d.name).not.toContain(String(h.currentEpoch()));
  });

  it('Codex 監査24 A1: 世代は時刻に依存しない（時計が戻っても、同じ時刻でも、過去の世代と重ならない）', () => {
    const { h } = store();
    const seen = new Set<number>([h.currentEpoch()!]);
    const t0 = h.env.clock.now;
    for (let i = 0; i < 6; i++) {
      h.env.clock.now = t0 - i * 3_600_000; // 時計の巻き戻り
      maint(h);
      const cur = h.currentEpoch()!;
      expect(seen.has(cur)).toBe(false);
      expect(cur).not.toBe(h.env.clock.now);
      seen.add(cur);
    }
    // 同じ時刻の 2 つの環境でも、世代は一致しない
    const x = store().h;
    const y = store().h;
    expect(x.currentEpoch()).not.toBe(y.currentEpoch());
  });

  it('保守作業の終了が失敗した場合（守る記録の削除）は、世代を変えず、業務の更新は止めたまま、データも変えない', () => {
    const { h, a } = store();
    const opened = h.currentEpoch()!;
    h.ownerOk('maintenance.begin', { confirmText: '保守を開始する' });
    // 保守の作業で、守る記録（スタッフ）を誤って変更した状態
    const u = uowOf(h);
    const e = u.get<any>('employees', a);
    u.update('employees', { ...e, displayName: '誤って変更' });
    u.flush();
    const before = fingerprint(h);
    expect(code(h.owner('maintenance.finish', { confirmText: '保守を終了する' }))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(h.currentEpoch()).toBe(opened);
    expect(fingerprint(h)).toBe(before);
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
  });

  for (const broken of [null, '', 'abc', '0', '-5', '1.5', '99999999999999999999']) {
    it(`世代の記録が ${broken === null ? '（ない）' : JSON.stringify(broken)} の場合、画面からの業務更新を止め、初期化では作り直さない（保守作業の終了で再発行する。Codex 監査24 A1）`, () => {
      const { h } = store();
      const opened = h.currentEpoch()!;
      if (broken === null) h.env.platform.secrets.delete(EPOCH_KEY);
      else h.env.platform.secrets.set(EPOCH_KEY, broken);
      for (const epoch of [opened, null, 1]) expect(code(h.owner('settings.update', { storeName: 'x' }, { epoch }))).toBe('EPOCH_UNAVAILABLE');
      // 既存の環境の初期化（shiftlyAuthorize の再実行）では作り直さない（時刻・推測で再発行しない）
      h.advance(1000);
      h.ownerOk('system.initialize', { storeName: 'テスト店舗', envId: 'env_test' });
      expect(h.env.platform.secrets.get(EPOCH_KEY)).toBe(broken);
      expect(code(h.owner('settings.update', { storeName: 'x' }))).toBe('EPOCH_UNAVAILABLE');
      // Google 所有者の保守作業の終了で再発行する（全セッションを失効し、古い画面からの保存を拒否する）
      maint(h);
      expect(h.currentEpoch()).not.toBeNull();
      expect(h.currentEpoch()).not.toBe(opened);
      expect(code(h.owner('settings.update', { storeName: 'x' }, { epoch: opened }))).toBe('STALE_VIEW');
      expect(code(h.owner('settings.update', { storeName: 'x' }))).toBe('OK');
    });
  }

  it('初めての構築では、初期化で世代を発行する（DB に初期化の記録がない場合だけ）', () => {
    const h = new Harness();
    expect(h.currentEpoch()).toBeNull();
    h.ownerOk('system.initialize', { storeName: 'テスト店舗', envId: 'env_test' });
    const first = h.currentEpoch();
    expect(first).not.toBeNull();
    h.ownerOk('system.initialize', { storeName: 'テスト店舗', envId: 'env_test' });
    expect(h.currentEpoch()).toBe(first); // 再実行しても変えない
  });

  it('保守作業の終了と通常の更新の競合: 世代はロックの内側で照合する（ロックを待つ間に保守作業が終わった要求は拒否する）', () => {
    const { h } = store();
    const opened = h.currentEpoch()!;
    h.ownerOk('maintenance.begin', { confirmText: '保守を開始する' });
    const p = h.env.platform;
    const withLock = p.withLock.bind(p);
    let once = true;
    // 更新の要求がロックを取得する直前に、別の実行の保守作業の終了が完了した状態を模す
    p.withLock = ((ms: number, fn: () => unknown) => {
      if (once) {
        once = false;
        p.withLock = withLock;
        h.ownerOk('maintenance.finish', { confirmText: '保守を終了する' });
      }
      return withLock(ms, fn);
    }) as typeof p.withLock;
    expect(code(h.owner('settings.update', { storeName: '競合' }, { epoch: opened }))).toBe('STALE_VIEW');
  });

  it('応答に現在の世代が付く（画面が固定する世代）。読み取りも同じ', () => {
    const { h } = store();
    const r: any = h.owner('settings.get');
    expect(r.epoch).toBe(h.currentEpoch());
    const e: any = h.owner('settings.update', { storeName: 'x' }, { epoch: 1 });
    expect(e.epoch).toBe(h.currentEpoch());
  });
});

describe('応答に付ける世代（D-026 の独立した点検 #2）', () => {
  it('読み取りの処理の間に世代が進んだ場合は、処理の前の世代を返す（新しい画面が旧 DB のデータを新しい世代として固定しない）', () => {
    const h = new Harness();
    h.setupStore();
    const before = h.currentEpoch()!;
    const p = h.env.platform;
    // 読み取りの処理の途中で、別の実行の復元が世代を進めた状態を模す（DB の切替はまだ）
    const ad = h.env.adapter as unknown as { read: (...a: unknown[]) => unknown; readMany?: (...a: unknown[]) => unknown };
    let once = true;
    const advance = () => {
      if (once) {
        once = false;
        p.secrets.set('SHIFTLY_RESTORE_EPOCH', String(before + 1000));
      }
    };
    const read = ad.read.bind(ad);
    ad.read = (...a: unknown[]) => (advance(), read(...a));
    if (ad.readMany) {
      const readMany = ad.readMany.bind(ad);
      ad.readMany = (...a: unknown[]) => (advance(), readMany(...a));
    }
    const r: any = h.owner('settings.get');
    expect(r.ok).toBe(true);
    expect(r.epoch).toBe(before); // 前の世代 → 画面は前の世代を固定し、次の応答（新しい世代）で古い画面として検知する
    expect((h.owner('settings.get') as any).epoch).toBe(before + 1000);
  });
});

describe('退勤の打刻に付けた休憩の申告（D-026 の独立した点検 #7）', () => {
  it('申告の付いた退勤は、保守作業の前に読み込んだ画面（世代）からは拒否する。申告のない打刻は世代を照合しない', () => {
    const h = new Harness();
    h.setupStore({ breakMode: 'scheduled', timeBasis: 'shift' });
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.ownerOk('shifts.upsert', { employeeId: a, date: '2026-11-03', start: '09:00', end: '17:00', breakMinutes: 60, fixedBreakStart: '12:00' });
    h.ownerOk('shifts.publish', { from: '2026-11-03', to: '2026-11-03' });
    h.setNow('2026-11-03', '09:00');
    h.login(a, '482913');
    expect(code(h.staff('attendance.punch', { type: 'clock_in' }, { epoch: null }))).toBe('OK'); // 申告なし: 照合しない
    const opened = h.currentEpoch()!;
    maint(h);
    h.setNow('2026-11-03', '17:00');
    h.login(a, '482913'); // 保守作業の終了でセッションは失効。ログインし直す（画面は保守作業の前に読み込んだまま）
    const decl = { kind: 'as_scheduled', expectedPlanned: { start: '2026-11-03T12:00', end: '2026-11-03T13:00', minutes: 60 } };
    expect(code(h.staff('attendance.punch', { type: 'clock_out', breakDeclaration: decl }, { epoch: opened }))).toBe('STALE_VIEW');
    expect(code(h.staff('attendance.punch', { type: 'clock_out', breakDeclaration: decl }, { epoch: null }))).toBe('STALE_VIEW');
    // 読み込み直した画面（現在の世代）からは申告付きで退勤できる
    expect(code(h.staff('attendance.punch', { type: 'clock_out', breakDeclaration: decl }))).toBe('OK');
  });
});
