/**
 * 復元世代（D-026。R1 の構造的な修正）の網羅テスト
 * - 全操作の分類と、世代の照合を適用しない操作の理由の登録
 * - 画面からの業務更新（kind: 'edit'）すべてで: 現在の世代は通る／復元前の世代・世代なしは拒否し、データを変えない
 *   （Google 所有者・店舗 iPad の管理者モード・スタッフ本人の 3 つの経路）
 * - 復元の場面: Codex 監査23 #1（店舗設定）、再認証、連続復元、復元の途中の失敗、世代の記録の欠落・破損、ロックの内側での照合
 * - RESTORE_POLICY の全表について、代表行で実際の復元の結果を確かめる
 * 期待値は仕様（D-025・D-026）から定めたもの（実装の出力を写したものではない）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { listOps } from '../../src/backend/api';
import { EPOCH_EXEMPT } from '../../src/backend/epoch-exemptions';
import { EPOCH_KEY } from '../../src/backend/context';
import { TABLES, type TableName } from '../../src/backend/schema';
import { RESTORE_POLICY } from '../../src/backend/handlers/ops';
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
const restore = (h: Harness, backupId: string) => h.ownerOk('backup.restore', { backupId, confirmText: '復元する' });

describe('操作の分類（D-026）', () => {
  const ops = listOps();
  it('全操作に分類があり、読み取りだけがデータを変えない', () => {
    for (const o of ops) {
      expect(['read', 'edit', 'punch', 'auth', 'system', 'output', 'internal'], o.name).toContain(o.kind);
      expect(o.kind === 'read', o.name).toBe(!o.mutating);
    }
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
    it(`${op.name}: 復元前の世代・世代なしは拒否してデータを変えず、現在の世代は世代の照合を通る`, () => {
      const { h } = store();
      const old = h.currentEpoch()!;
      const bk = h.ownerOk('backup.run', { kind: 'manual' });
      restore(h, bk.id);
      const cur = h.currentEpoch()!;
      expect(cur).toBeGreaterThan(old);
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

describe('復元の場面', () => {
  it('Codex 監査23 #1: 復元前に開いた店舗設定画面から、給与計算の時間基準を変更できない（最新の画面からは変更できる）', () => {
    const { h } = store();
    h.ownerOk('settings.update', { payrollTimeBasis: 'shift' });
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    const opened = h.currentEpoch()!; // 別のタブで店舗設定を開いた時点
    restore(h, bk.id);
    expect(code(h.owner('settings.update', { payrollTimeBasis: 'actual' }, { epoch: opened }))).toBe('STALE_VIEW');
    expect(h.ownerOk('settings.get').payrollTimeBasis).toBe('shift');
    expect(code(h.owner('settings.update', { payrollTimeBasis: 'actual' }))).toBe('OK'); // 読み込み直した画面
    expect(h.ownerOk('settings.get').payrollTimeBasis).toBe('actual');
  });

  it('再認証: 復元で管理者モードのセッションが失効し、ログインし直しても、復元前に読み込んだ画面（世代）からは保存できない', () => {
    const { h, a } = store();
    const t1 = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    const opened = h.currentEpoch()!;
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    restore(h, bk.id);
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t1, epoch: opened }))).toBe('ADMIN_UNAUTHENTICATED');
    const t2 = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t2, epoch: opened }))).toBe('STALE_VIEW');
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t2 }))).toBe('OK');
  });

  it('連続復元: 世代は復元のたびに大きくなり、過去のどの世代でも保存できない（バックアップから世代を戻さない）', () => {
    const { h, a } = store();
    const seen: number[] = [h.currentEpoch()!];
    const bkA = h.ownerOk('backup.run', { kind: 'manual' });
    h.advance(60_000);
    const bkB = h.ownerOk('backup.run', { kind: 'manual' });
    for (const b of [bkA, bkB, bkA, bkA, bkB]) {
      h.advance(60_000);
      restore(h, b.id);
      const cur = h.currentEpoch()!;
      expect(cur).toBeGreaterThan(Math.max(...seen));
      for (const e of seen) expect(code(h.owner('employees.update', { employeeId: a, note: '古い画面', version: 1 }, { epoch: e })), `世代 ${e}`).toBe('STALE_VIEW');
      seen.push(cur);
    }
    // 世代は業務 DB・バックアップの外（Script Properties 相当）に保存する
    for (const d of TABLES) expect(JSON.stringify(uowOf(h).list(d.name)), d.name).not.toContain(String(h.currentEpoch()));
  });

  it('復元の途中の失敗: 候補の整合性確認で中止した場合は世代を進めず、稼働中のデータも変えない', () => {
    const { h, a } = store();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    const before = h.currentEpoch()!;
    // 候補（バックアップの複製）の整合性を壊す: 存在しないスタッフを参照するシフトを追加したバックアップを作る
    const u = uowOf(h);
    u.insert('shifts', { employeeId: 'emp_missing', date: '2026-11-20', start: '09:00', end: '17:00', breakMinutes: 0, status: 'draft', note: '' } as never, 'shf');
    u.flush();
    const broken = h.ownerOk('backup.run', { kind: 'manual' });
    const r = h.owner('backup.restore', { backupId: broken.id, confirmText: '復元する' });
    expect(code(r)).toBe('RESTORE_INTEGRITY_FAILED');
    expect(h.currentEpoch()).toBe(before);
    expect(code(h.owner('employees.update', { employeeId: a, note: '通常の操作', version: h.ownerOk<any>('employees.list', {}).find((e: any) => e.id === a).version }))).toBe('OK');
    void bk;
  });

  it('復元の途中の失敗: 世代を進めた後に DB の切替が失敗しても、復元前の世代の要求は拒否する（安全側）', () => {
    const { h } = store();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    const opened = h.currentEpoch()!;
    const db = h.env.platform.database;
    const activate = db.activate.bind(db);
    db.activate = () => {
      throw new Error('切替の失敗（模擬）');
    };
    expect(code(h.owner('backup.restore', { backupId: bk.id, confirmText: '復元する' }))).toBe('INTERNAL');
    db.activate = activate;
    expect(h.currentEpoch()).toBeGreaterThan(opened);
    expect(code(h.owner('settings.update', { storeName: '古い画面' }, { epoch: opened }))).toBe('STALE_VIEW');
    expect(code(h.owner('settings.update', { storeName: '読み込み直した画面' }))).toBe('OK'); // 切替は行われていない（稼働中の DB のまま）
  });

  for (const broken of [null, '', 'abc', '0', '-5', '1.5', '99999999999999999999']) {
    it(`世代の記録が ${broken === null ? '（ない）' : JSON.stringify(broken)} の場合、画面からの業務更新を止める（古い要求を受け入れない）`, () => {
      const { h } = store();
      const opened = h.currentEpoch()!;
      if (broken === null) h.env.platform.secrets.delete(EPOCH_KEY);
      else h.env.platform.secrets.set(EPOCH_KEY, broken);
      for (const epoch of [opened, null, 1]) expect(code(h.owner('settings.update', { storeName: 'x' }, { epoch }))).toBe('EPOCH_UNAVAILABLE');
      // 初期化（shiftlyAuthorize）で作り直す。作り直した世代は過去の世代と重ならない
      h.advance(1000);
      h.ownerOk('system.initialize', { storeName: 'テスト店舗', envId: 'env_test' });
      expect(h.currentEpoch()!).toBeGreaterThan(opened);
      expect(code(h.owner('settings.update', { storeName: 'x' }, { epoch: opened }))).toBe('STALE_VIEW');
      expect(code(h.owner('settings.update', { storeName: 'x' }))).toBe('OK');
    });
  }

  it('復元と通常の更新の競合: 世代はロックの内側で照合する（ロックを待つ間に復元が終わった要求は拒否する）', () => {
    const { h } = store();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    const opened = h.currentEpoch()!;
    const p = h.env.platform;
    const withLock = p.withLock.bind(p);
    let once = true;
    // 更新の要求がロックを取得する直前に、別の実行の復元が完了した状態を模す
    p.withLock = ((ms: number, fn: () => unknown) => {
      if (once) {
        once = false;
        p.withLock = withLock;
        restore(h, bk.id);
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

describe('RESTORE_POLICY の全表: 代表行で実際の復元の結果を確かめる', () => {
  type Row = Record<string, unknown> & { id: string; version: number };
  /** 列の型から代表行を作る（スタッフの参照は実在するスタッフ） */
  function rowFor(t: TableName, tag: string, employeeId: string): Record<string, unknown> {
    const def = TABLES.find((d) => d.name === t)!;
    const r: Record<string, unknown> = { id: `rep_${t}_${tag}` };
    for (const [c, ty] of def.columns) {
      if (['id', 'createdAt', 'updatedAt', 'version'].includes(c)) continue;
      if (c === 'employeeId') r[c] = employeeId;
      else if (c === def.partitionBy) r[c] = c.endsWith('At') ? '2026-11-02T10:00:00.000+09:00' : '2026-11-02';
      else if (c === 'state') r[c] = 'done';
      else if (c === 'key') r[c] = `rep_${tag}`;
      else if (ty === 'string' && /At$/.test(c)) r[c] = '2026-11-02T10:00:00.000+09:00';
      else if (ty === 'string' && /(date|Date|From|To|On|Since|Day)$/.test(c)) r[c] = '2026-11-02';
      else if (ty === 'string' && /^(start|end|time|timeFrom|timeTo|open|close)$/.test(c)) r[c] = '09:00';
      else r[c] = ty === 'string' ? `値_${tag}` : ty === 'number' ? 1 : ty === 'boolean' ? false : ty === 'json' ? {} : null;
    }
    return r;
  }
  /** 変更できる列（参照・分割・キーを除く文字列の列） */
  const mutableCol = (t: TableName) => TABLES.find((d) => d.name === t)!.columns.find(([c, ty]) => ty === 'string' && !['id', 'createdAt', 'updatedAt', 'employeeId', 'periodId', 'key', 'state', 'kind'].includes(c) && c !== TABLES.find((d) => d.name === t)!.partitionBy)?.[0];

  it('全表: restore は戻す／append は再投入／carry は現行を引き継ぐ／revoke は失効／skip は候補のまま', () => {
    const { h } = store();
    // 代表行の参照先（PIN・権限の行を持たないスタッフを、表ごとに分ける）
    const emp = (n: string) => h.ownerOk<{ id: string }>('employees.create', { displayName: n, kana: n, payType: 'hourly', hireDate: '2025-01-01' }).id;
    const exX = emp('代表X');
    const exY = emp('代表Y');
    const skipInsert = new Set<TableName>(['store_settings', 'permissions']); // 1 行だけの表・スタッフごとに 1 行の表（作成時に行がある）
    const u0 = uowOf(h);
    const X = new Map<TableName, string>();
    for (const d of TABLES) {
      if (d.name === 'store_settings') {
        X.set(d.name, u0.list<Row>('store_settings')[0]!.id);
        continue;
      }
      if (d.name === 'permissions') {
        X.set(d.name, u0.list<Row & { employeeId: string }>('permissions').find((p) => p.employeeId === exX)!.id);
        continue;
      }
      const row = rowFor(d.name, 'x', exX);
      u0.insert(d.name, row as never, 'rep');
      X.set(d.name, row.id as string);
    }
    u0.flush();
    const bk = h.ownerOk('backup.run', { kind: 'manual' });
    h.advance(60_000);
    // バックアップの後: 既存の代表行（X）を変更し、新しい代表行（Y）を追加する
    const u1 = uowOf(h);
    const changed = new Map<TableName, string>();
    for (const d of TABLES) {
      const pol = RESTORE_POLICY[d.name].policy;
      const col = mutableCol(d.name);
      if (pol !== 'append' && col) {
        const cur = u1.get<Row>(d.name, X.get(d.name)!)!;
        u1.update(d.name, { ...cur, [col]: `変更後_${d.name}` } as never);
        changed.set(d.name, col);
      }
      if (!skipInsert.has(d.name)) u1.insert(d.name, rowFor(d.name, 'y', exY) as never, 'rep');
    }
    u1.flush();
    restore(h, bk.id);
    const u2 = uowOf(h);
    let checked = 0;
    for (const d of TABLES) {
      const pol = RESTORE_POLICY[d.name].policy;
      const x = u2.get<Row>(d.name, X.get(d.name)!);
      const y = skipInsert.has(d.name) ? undefined : u2.get<Row>(d.name, `rep_${d.name}_y`);
      const col = changed.get(d.name);
      const label = `${d.name}（${pol}）`;
      switch (pol) {
        case 'restore':
          expect(x, label).toBeTruthy();
          if (col) expect(x![col], label).not.toBe(`変更後_${d.name}`);
          if (!skipInsert.has(d.name)) expect(y, `${label} バックアップの後の行は戻る`).toBeNull();
          break;
        case 'append':
          expect(x, label).toBeTruthy();
          expect(y, `${label} バックアップの後の行を再投入`).toBeTruthy();
          break;
        case 'carry':
          expect(x, label).toBeTruthy();
          if (col) expect(x![col], `${label} 現行の内容を引き継ぐ`).toBe(`変更後_${d.name}`);
          if (!skipInsert.has(d.name)) expect(y, `${label} バックアップの後の行も引き継ぐ`).toBeTruthy();
          break;
        case 'revoke':
          // セッションはすべて失効（バックアップの後に作った行は候補にない）
          expect(y, label).toBeNull();
          break;
        case 'skip':
          expect(y, `${label} 候補の内容のまま`).toBeNull();
          break;
      }
      checked++;
    }
    expect(checked).toBe(TABLES.length);
  });
});
