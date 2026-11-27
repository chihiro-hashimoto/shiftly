/**
 * Google 所有者の保守作業（D-027 B案）の網羅テスト
 * v1.3 ではアプリ内の自動復元（稼働中の DB の切替）を提供せず、データの復元は Google 所有者が保守作業の中で手で行う。
 * ここでは、手作業の前後を囲む maintenance.begin / maintenance.finish が、次を満たすことを確かめる。
 * - 業務の更新を全員（Google 所有者・管理者モード・スタッフ・定期処理）について止め、終了まで再開しない
 * - R1: 保守の開始時にあった守る記録（打刻原本・修正の履歴・申請・確定した給与・明細・スタッフ・認証・端末・監査ログなど）を、
 *   手作業で削除・変更した場合は業務を再開しない（全表を代表行で確かめる）
 * - R2: 内容に変更があれば確定済みの給与がある期間をすべて停止し、計算結果の全項目の照合で差がない場合だけ解除できる
 * - 終了で全セッションを失効し、画面の世代を新しく発行する（保守作業の前の画面からの保存を拒否する。view-epoch.test.ts）
 * 旧版の restore-policy.test.ts（アプリ内の復元の表ごとの扱い）は、復元を v1.3 で提供しないため、このファイルに置き換えた。
 * 復元に依存しない給与の照合（differingTotals）・停止の記録の破損のテストは、そのまま引き継いだ（docs/review-log.md C-24）
 */
import { describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness';
import { TABLES, type TableName } from '../../src/backend/schema';
import { MAINTENANCE_TABLES } from '../../src/backend/handlers/maintenance';
import { differingTotals } from '../../src/backend/handlers/payroll';
import { handleRequest } from '../../src/backend/index';
import { MAINTENANCE_KEY } from '../../src/backend/context';
import { UnitOfWork } from '../../src/backend/store';
import type { PayrollTotals } from '../../src/shared/types';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);
const uowOf = (h: Harness) => new UnitOfWork(h.env.adapter, { now: () => h.env.clock.now, newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
const ADMIN_PW = 'Kanri#Pass-2026x';
const BEGIN = { confirmText: '保守を開始する' };
const FINISH = { confirmText: '保守を終了する' };
type Row = Record<string, unknown> & { id: string; version: number };
/** 手作業でシートの行を消したことを模す（パーティションのシートを含めて、ID の一致する行を除く） */
function deleteRow(h: Harness, t: TableName, id: string) {
  for (const [name, rows] of h.env.adapter.sheets) {
    if (name !== t && !name.startsWith(`${t}__`)) continue;
    h.env.adapter.sheets.set(name, rows.filter((r) => r[0] !== id));
  }
}

function store() {
  const h = new Harness();
  h.setupStore();
  const a = h.addStaff('山田', '482913', { rate: 1200 });
  h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
  return { h, a };
}

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
const mutableCol = (t: TableName) => {
  const d = TABLES.find((x) => x.name === t)!;
  return d.columns.find(([c, ty]) => ty === 'string' && !['id', 'createdAt', 'updatedAt', 'employeeId', 'periodId', 'key', 'state', 'kind'].includes(c) && c !== d.partitionBy)?.[0];
};

describe('保守作業での表ごとの扱い（MAINTENANCE_TABLES）', () => {
  it('すべての表に扱いが明示されている（表を追加したときに決め忘れない）', () => {
    expect(Object.keys(MAINTENANCE_TABLES).sort()).toEqual(TABLES.map((t) => t.name).sort());
  });
  it('説明に「追記専用」とある表（監査ログ・冪等性キーなど内部の記録を除く）は、すべて守る表', () => {
    for (const t of TABLES.filter((x) => x.description.includes('追記専用'))) {
      if (t.name === 'request_idempotency' || t.name === 'operation_journal') continue; // 内部の処理記録（保守中も増える。照合しない）
      expect(MAINTENANCE_TABLES[t.name], t.name).toBe('protected');
    }
  });
  it('打刻原本・修正の履歴・申請と確認・確定した給与と明細・有給・スタッフ・認証・権限・端末・監査ログ・出力とバックアップの履歴は、守る表', () => {
    const mustProtect = ['employees', 'credentials', 'permissions', 'devices', 'device_enrollments', 'admin_credentials', 'backup_history', 'attendance_events', 'attendance_corrections', 'manual_breaks', 'break_declarations', 'overtime_requests', 'overtime_request_history', 'payroll_periods', 'payroll_results', 'pay_slips', 'audit_logs', 'leave_grants', 'leave_transactions', 'exports', 'shift_history'] as const;
    for (const n of mustProtect) expect(MAINTENANCE_TABLES[n], n).toBe('protected');
  });
});

describe('保守作業の開始・終了', () => {
  it('開始で、Google 所有者・管理者モード・スタッフ・定期処理を含む全員の更新を止める（読み取りは可。バックアップは開始時に作る）', () => {
    const { h, a } = store();
    const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    h.login(a, '482913');
    const r = h.ownerOk('maintenance.begin', BEGIN);
    expect(r.backupId).toBeTruthy();
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t }))).toBe('MAINTENANCE');
    expect(code(h.staff('attendance.punch', { type: 'clock_in' }))).toBe('MAINTENANCE');
    expect(code(h.staff('auth.login', { employeeId: a, pin: '482913' }, { session: '' }))).toBe('MAINTENANCE');
    expect(code(handleRequest(h.be, { op: 'system.dailyJob' }, 'system'))).toBe('MAINTENANCE');
    expect(code(handleRequest(h.be, { op: 'notifications.scan' }, 'system'))).toBe('MAINTENANCE');
    expect(code(h.owner('export.attendance', { from: '2026-11-01', to: '2026-11-30', format: 'csv' }))).toBe('MAINTENANCE');
    // 読み取りはできる。保守中のバックアップの作成は止める（開始時のバックアップを使う。バックアップの履歴も照合の対象）
    expect(code(h.owner('settings.get'))).toBe('OK');
    expect(code(h.owner('backup.run', { kind: 'manual' }))).toBe('MAINTENANCE');
    // 状態の表示（スタッフ画面の保守中の表示・システム情報）
    expect((h.ownerOk<any>('system.status') as any).maintenance).toBe(true);
    expect(h.ownerOk<any>('system.info').maintenanceWork).toMatchObject({ active: true, readable: true });
    // 開始時のバックアップと、内容の記録（Google ドライブの 00_System）
    expect(h.ownerOk<any[]>('backup.list').some((b) => b.id === r.backupId && b.status === 'ok')).toBe(true);
    expect([...h.env.files.files.values()].some((f) => f.folder === '00_System' && f.name.startsWith('Shiftly_maintenance_snapshot_'))).toBe(true);
    // 終了で再開する
    const f = h.ownerOk('maintenance.finish', FINISH);
    expect(f.resumed).toBe(true);
    expect(code(h.owner('settings.update', { storeName: '再開後' }))).toBe('OK');
    expect(h.env.platform.secrets.get(MAINTENANCE_KEY)).toBeNull();
  });

  it('開始・終了は Google 所有者だけ（管理者モード・スタッフ・Setup の鍵では実行できない）。確認の入力が必要', () => {
    const { h, a } = store();
    const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    h.staffOk('adminAuth.reauth', { password: ADMIN_PW }, { session: '', adminSession: t });
    for (const op of ['maintenance.begin', 'maintenance.finish']) {
      expect(code(h.staff(op, op === 'maintenance.begin' ? BEGIN : FINISH, { session: '', adminSession: t })), op).toBe('FORBIDDEN');
    }
    h.login(a, '482913');
    expect(code(h.staff('maintenance.begin', BEGIN))).toBe('FORBIDDEN');
    expect(code(h.owner('maintenance.begin', { confirmText: 'はい' }))).toBe('INVALID_INPUT');
    expect(h.env.platform.secrets.get(MAINTENANCE_KEY)).toBeNull();
    h.ownerOk('maintenance.begin', BEGIN);
    expect(code(h.owner('maintenance.finish', { confirmText: 'はい' }))).toBe('INVALID_INPUT');
  });

  it('開始の二重実行は拒否し、開始していない保守作業は終了できない', () => {
    const { h } = store();
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('CONFLICT');
    h.ownerOk('maintenance.begin', BEGIN);
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('CONFLICT');
  });

  it('終了で全スタッフ・管理者のセッションを失効し、画面の世代を新しく発行する', () => {
    const { h, a } = store();
    const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
    h.login(a, '482913');
    const opened = h.currentEpoch()!;
    h.ownerOk('maintenance.begin', BEGIN);
    h.ownerOk('maintenance.finish', FINISH);
    expect(h.currentEpoch()).not.toBe(opened);
    expect(code(h.staff('attendance.punch', { type: 'clock_in' }))).not.toBe('OK');
    expect(code(h.staff('permissions.set', { employeeId: a, permissions: ['punch_self'] }, { session: '', adminSession: t }))).toBe('ADMIN_UNAUTHENTICATED');
  });

  it('開始時のバックアップに失敗した場合は、業務の更新を止めたまま止める（再実行で開始できる）', () => {
    const { h } = store();
    const files = h.env.files;
    const copy = files.copyDatabase.bind(files);
    files.copyDatabase = () => {
      throw new Error('容量不足（模擬）');
    };
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('MAINTENANCE_BEGIN_FAILED');
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED'); // 開始が完了していない
    files.copyDatabase = copy;
    h.ownerOk('maintenance.begin', BEGIN);
    h.ownerOk('maintenance.finish', FINISH);
    expect(code(h.owner('settings.update', { storeName: '再開後' }))).toBe('OK');
  });

  it('開始時の記録を読み込めない場合は、終了しない（保守中のまま）', () => {
    const { h } = store();
    h.ownerOk('maintenance.begin', BEGIN);
    const files = h.env.files;
    const read = files.readFile.bind(files);
    files.readFile = () => null;
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
    files.readFile = read;
    h.ownerOk('maintenance.finish', FINISH);
  });

  it('終了の途中（世代の発行）で失敗しても保守中のままで、再実行で終了できる', () => {
    const { h } = store();
    h.ownerOk('maintenance.begin', BEGIN);
    const secrets = h.env.platform.secrets;
    const set = secrets.set.bind(secrets);
    secrets.set = (k: string, v: string) => {
      if (k === 'SHIFTLY_RESTORE_EPOCH') throw new Error('保存に失敗しました（模擬）');
      set(k, v);
    };
    expect(h.owner('maintenance.finish', FINISH).ok).toBe(false);
    secrets.set = set;
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
    h.ownerOk('maintenance.finish', FINISH);
    expect(code(h.owner('settings.update', { storeName: '再開後' }))).toBe('OK');
  });

  it('保守の記録を読み取れない（手での編集など）場合も、全員の更新を止め、終了しない。開始は「やり直し」の確認がある場合だけで、終了時は確定済みの給与をすべて照合の対象にする（独立した点検 #3）', () => {
    const { h } = store();
    h.env.platform.secrets.set(MAINTENANCE_KEY, '{壊れた');
    expect(code(h.owner('settings.update', { storeName: 'x' }))).toBe('MAINTENANCE');
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(h.ownerOk<any>('system.info').maintenanceWork).toMatchObject({ active: true, readable: false });
    // 通常の開始では、記録のない手作業を基準に含め得るため作り直さない
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('MAINTENANCE_RESTART_REQUIRED');
    expect(code(h.owner('maintenance.begin', { confirmText: '保守を開始する', restart: true }))).toBe('INVALID_INPUT');
    const r = h.ownerOk('maintenance.begin', { confirmText: '保守を開始し直す', restart: true });
    expect(r.baselineUncertain).toBe(true);
    h.ownerOk('maintenance.finish', FINISH);
    expect(code(h.owner('settings.update', { storeName: '再開後' }))).toBe('OK');
  });
});

describe('R1: 保守作業で守る記録（全表を代表行で確かめる）', () => {
  /** 全表に代表行を入れてから保守作業を開始する */
  function prepared() {
    const { h } = store();
    const emp = h.ownerOk<{ id: string }>('employees.create', { displayName: '代表X', kana: '代表X', payType: 'hourly', hireDate: '2025-01-01' }).id;
    const u = uowOf(h);
    const X = new Map<TableName, string>();
    for (const d of TABLES) {
      if (d.name === 'store_settings') X.set(d.name, u.list<Row>('store_settings')[0]!.id);
      else if (d.name === 'permissions') X.set(d.name, u.list<Row & { employeeId: string }>('permissions').find((p) => p.employeeId === emp)!.id);
      else {
        const row = rowFor(d.name, 'x', emp);
        u.insert(d.name, row as never, 'rep');
        X.set(d.name, row.id as string);
      }
    }
    u.flush();
    h.ownerOk('maintenance.begin', BEGIN);
    return { h, X, emp };
  }
  const protectedTables = TABLES.filter((d) => MAINTENANCE_TABLES[d.name] === 'protected').map((d) => d.name);
  const inputTables = TABLES.filter((d) => MAINTENANCE_TABLES[d.name] === 'input').map((d) => d.name);

  it('守る表は 0 件ではない', () => expect(protectedTables.length).toBeGreaterThan(15));

  for (const t of protectedTables) {
    it(`${t}: 開始時の行を削除・変更した場合は再開しない。元に戻すと再開できる。行の追加は再開を妨げない`, () => {
      const { h, X } = prepared();
      const id = X.get(t)!;
      const orig = uowOf(h).get<Row>(t, id)!;
      expect(orig, '代表行').toBeTruthy();
      // 削除（手作業でシートの行を消した）
      deleteRow(h, t, id);
      expect(uowOf(h).get<Row>(t, id)).toBeNull();
      let r = h.owner('maintenance.finish', FINISH);
      expect(code(r), '削除').toBe('MAINTENANCE_CHECK_FAILED');
      expect((r as any).error.message).toContain(t);
      expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
      // 元に戻してから、内容を変更（手作業でセルを書き換えた）
      let u = uowOf(h);
      u.putForRestore(t, orig as never);
      u.flush();
      const col = mutableCol(t);
      if (col) {
        u = uowOf(h);
        u.putForRestore(t, { ...orig, [col]: `変更_${t}` } as never);
        u.flush();
        r = h.owner('maintenance.finish', FINISH);
        expect(code(r), '変更').toBe('MAINTENANCE_CHECK_FAILED');
        u = uowOf(h);
        u.putForRestore(t, orig as never);
        u.flush();
      }
      // 追加（バックアップから失われた行を戻した）は再開を妨げない
      u = uowOf(h);
      u.insert(t, { ...rowFor(t, 'added', String(orig.employeeId ?? '')), ...(orig.employeeId ? { employeeId: orig.employeeId } : {}) } as never, 'rep');
      u.flush();
      const ok = h.ownerOk('maintenance.finish', FINISH);
      // 監査ログ・バックアップの履歴はアプリ自身が保守中にも追記するため（保守の開始の記録・開始時のバックアップ）、追加は「内容の変更」と数えない（削除・変更は止める）
      if (t === 'audit_logs' || t === 'backup_history') expect(ok.changedTables).not.toContain(t);
      else expect(ok.changedTables).toContain(t);
    });
  }

  for (const t of inputTables) {
    it(`${t}: 業務の入力・設定は手で戻せる（変更しても再開でき、変更として記録する）`, () => {
      const { h, X } = prepared();
      const col = mutableCol(t);
      const u = uowOf(h);
      const cur = u.get<Row>(t, X.get(t)!)!;
      u.putForRestore(t, (col ? { ...cur, [col]: `戻した値_${t}` } : { ...cur }) as never);
      if (!col) u.insert(t, rowFor(t, 'added', String(cur.employeeId ?? '')) as never, 'rep');
      u.flush();
      const r = h.ownerOk('maintenance.finish', FINISH);
      expect(r.changedTables).toContain(t);
    });
  }

  it('バックアップの後に記録された打刻を、手作業で失った場合は再開しない（打刻原本を消さない）', () => {
    const { h, a } = store();
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '18:00', 'clock_out');
    h.ownerOk('maintenance.begin', BEGIN);
    // 打刻のシートを、退勤の前の状態（バックアップの内容）で上書きした
    const out = uowOf(h).list<Row & { type: string }>('attendance_events').find((e) => e.type === 'clock_out')!;
    deleteRow(h, 'attendance_events', out.id);
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
  });

  it('環境の記録（envId・初期化日時）が変わった（別の環境の DB の内容を戻した）場合は再開しない', () => {
    const { h } = store();
    h.ownerOk('maintenance.begin', BEGIN);
    const u = uowOf(h);
    const m = u.list<Row & { key: string; value: string }>('system_metadata').find((x) => x.key === 'envId')!;
    u.putForRestore('system_metadata', { ...m, value: 'env_other' } as never);
    u.flush();
    const r = h.owner('maintenance.finish', FINISH);
    expect(code(r)).toBe('MAINTENANCE_CHECK_FAILED');
    expect((r as any).error.message).toContain('envId');
  });
});

describe('R2: 保守作業の後の給与の停止と照合', () => {
  /** 時給 1,200 円・09:00〜14:00（5 時間）で 2026-11 を確定する */
  function confirmed() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    h.setNow('2026-12-01', '06:00');
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    const r = h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    expect(r.confirmed[0].netPay).toBe(6000);
    return { h, a, p, acks };
  }
  const all = (periodId: string) => ({ periodId, checkedWageRules: true, checkedAllowances: true, checkedDeductions: true, checkedSalaryRules: true, confirmText: '確認しました' });

  it('内容を変えなかった保守作業の後は、給与を停止しない（通常どおり訂正できる）', () => {
    const { h, a, p, acks } = confirmed();
    h.ownerOk('maintenance.begin', BEGIN);
    const f = h.ownerOk('maintenance.finish', FINISH);
    expect(f.payrollPeriodsToReview).toBe(0);
    expect(h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock).toBeNull();
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks }))).not.toBe('PAYROLL_BLOCKED');
  });

  it('時給を手で戻した保守作業の後は、確定済みの期間を停止し、差がある間は解除・訂正・明細の発行をしない。条件を合わせると解除できる', () => {
    const { h, a, p, acks } = confirmed();
    h.ownerOk('maintenance.begin', BEGIN);
    // 保守の作業で、時給ルールをバックアップの値（1,000 円）に戻した
    const u = uowOf(h);
    const w = u.list<Row & { employeeId: string; hourlyRate: number }>('wage_rules').find((x) => x.employeeId === a)!;
    u.putForRestore('wage_rules', { ...w, hourlyRate: 1000 } as never);
    u.flush();
    const f = h.ownerOk('maintenance.finish', FINISH);
    expect(f.payrollPeriodsToReview).toBe(1);
    expect(f.changedTables).toContain('wage_rules');
    const review = h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id });
    expect(review.differences).toBe(1);
    expect(review.rows[0].confirmedGross).toBe(6000);
    expect(review.rows[0].currentGross).toBe(5000);
    expect(code(h.owner('payroll.releaseRestoreLock', all(p.id)))).toBe('RESTORE_DIFFERENCES');
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '訂正', acknowledgements: acks }))).toBe('PAYROLL_BLOCKED');
    expect(code(h.owner('payslips.issue', { periodId: p.id }))).toBe('PAYROLL_BLOCKED');
    // 条件を確定時に合わせる（画面から時給を 1,200 円に）と、差がなくなり解除できる
    h.ownerOk('payconf.upsertWageRule', { employeeId: a, kind: 'base', effectiveFrom: w.effectiveFrom, hourlyRate: 1200, priority: 0, id: w.id, version: uowOf(h).get<Row>('wage_rules', w.id)!.version });
    expect(h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id }).differences).toBe(0);
    expect(code(h.owner('payroll.releaseRestoreLock', all(p.id)))).toBe('OK');
  });

  it('Codex 監査19 #1 と同じ形: 控除なしで差引 24 万円に確定 → 保守作業で控除 4 万円の入力を戻す → 総支給額が同じでも差として検出し、解除・訂正を止める', () => {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('佐藤', '582913', { payType: 'monthly' });
    h.ownerOk('payconf.upsertSalaryRule', { employeeId: a, effectiveFrom: '2025-01-01', monthlyScheduledMinutes: 160 * 60, scheduledWeekdays: [1, 2, 3, 4, 5], scheduledDailyMinutes: 480, confirmed: true, monthlySalary: 240000 });
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'entered', incomeTax: 40000, residentTax: 0, healthInsurance: 0, pension: 0, employmentInsurance: 0, nursingInsurance: 0 });
    h.setNow('2026-12-01', '06:00');
    const withDeduction = uowOf(h).list<Row & { employeeId: string }>('deductions').find((d) => d.employeeId === a)!;
    h.setNow('2026-12-01', '06:10');
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    const r = h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    expect(r.confirmed[0].netPay).toBe(240000);
    h.setNow('2026-12-01', '06:20');
    h.ownerOk('maintenance.begin', BEGIN);
    // 保守の作業で、控除の行をバックアップの内容（控除 4 万円）に戻した
    const u = uowOf(h);
    const cur = u.list<Row & { employeeId: string }>('deductions').find((d) => d.employeeId === a)!;
    u.putForRestore('deductions', { ...withDeduction, id: cur.id, version: cur.version } as never);
    u.flush();
    h.ownerOk('maintenance.finish', FINISH);
    h.setNow('2026-12-01', '06:30');
    const review = h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id });
    expect(review.differences).toBe(1);
    const row = review.rows[0];
    expect(row.confirmedGross).toBe(row.currentGross); // 総支給額は同じ
    expect(row.confirmedNet - row.currentNet).toBe(40000);
    expect(row.differingItems).toEqual(expect.arrayContaining(['控除の内訳', '控除合計', '差引支給額']));
    expect(code(h.owner('payroll.releaseRestoreLock', all(p.id)))).toBe('RESTORE_DIFFERENCES');
    expect(code(h.owner('payroll.correct', { periodId: p.id, employeeId: a, reason: '確認のための訂正', acknowledgements: acks }))).toBe('PAYROLL_BLOCKED');
  });

  it('保守の開始時にあった給与の停止は、作業で停止の記録を消しても引き継ぐ（停止を外さない）', () => {
    const { h, a, p } = confirmed();
    // 1 回目の保守作業: 時給を変えて停止させる
    h.ownerOk('maintenance.begin', BEGIN);
    let u = uowOf(h);
    const w = u.list<Row & { employeeId: string; hourlyRate: number }>('wage_rules').find((x) => x.employeeId === a)!;
    u.putForRestore('wage_rules', { ...w, hourlyRate: 1000 } as never);
    u.flush();
    h.ownerOk('maintenance.finish', FINISH);
    // 2 回目の保守作業: 停止の記録（system_metadata の payrollRestoreLocks）を、停止のない古い値に戻してしまった
    h.ownerOk('maintenance.begin', BEGIN);
    u = uowOf(h);
    const m = u.list<Row & { key: string }>('system_metadata').find((x) => x.key === 'payrollRestoreLocks')!;
    u.putForRestore('system_metadata', { ...m, value: '{}' } as never);
    u.flush();
    h.ownerOk('maintenance.finish', FINISH);
    expect(h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock).not.toBeNull();
  });
});

describe('給与の照合: 計算結果の全項目を比べる（differingTotals。旧 restore-policy.test.ts から引き継ぎ）', () => {
  function sampleTotals(): Record<string, unknown> {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    return h.ownerOk('payroll.compute', { periodId: p.id }).employees[0].totals;
  }
  it('計算結果のどの 1 項目が違っても差として検出し、違う項目の名前を返す（項目を個別に選ばない）', () => {
    const base = sampleTotals();
    const ALL: Record<keyof PayrollTotals, true> = {
      workDays: true, workMinutes: true, overtimeMinutes: true, over60Minutes: true, nightMinutes: true, holidayMinutes: true, basePay: true, extraHoursBasePay: true,
      overtimePremium: true, over60Premium: true, nightPremium: true, holidayPremium: true, fixedOvertimePay: true, fixedOvertimeExcess: true, paidLeavePay: true,
      paidLeaveDays: true, allowances: true, transport: true, absenceDeduction: true, grossPay: true, deductions: true, deductionTotal: true, netPay: true,
    };
    const keys = Object.keys(ALL);
    expect(Object.keys(base).sort()).toEqual([...keys].sort());
    expect(differingTotals(base as never, JSON.parse(JSON.stringify(base)))).toEqual([]);
    for (const k of keys) {
      const changed = JSON.parse(JSON.stringify(base));
      changed[k] = Array.isArray(base[k]) ? [...(base[k] as unknown[]), { name: '追加', amount: 1 }] : typeof base[k] === 'number' ? (base[k] as number) + 1 : 'changed';
      expect(differingTotals(base as never, changed), k).toHaveLength(1);
      const missing = JSON.parse(JSON.stringify(base));
      delete missing[k];
      expect(differingTotals(base as never, missing), `${k}（片方にない）`).toHaveLength(1);
      expect(differingTotals(missing, base as never), `${k}（片方にない・逆）`).toHaveLength(1);
    }
  });
});

describe('給与の停止の記録が壊れている場合（独立した点検 補足2。旧 restore-policy.test.ts から引き継ぎ）', () => {
  const BROKEN = ['', ' ', '\n', '{壊れた', '[]', 'null', '0', 'true', '"text"', '"{}"', '{"pd_x":1}', '{"pd_x":null}', '{"pd_x":{"restoredAt":1}}', '{"pd_x":{"restoredAt":"2026-11-01"}}', '{"pd_x":{"backupId":"b"}}'];
  for (const raw of [...BROKEN, '{}', null]) {
    const ok = raw === '{}' || raw === null;
    it(`記録が ${raw === null ? '（行なし）' : JSON.stringify(raw)} のとき、給与の確定を${ok ? '止めない' : '止める'}`, () => {
      const h = new Harness();
      h.setupStore();
      const a = h.addStaff('佐藤', '582913', { payType: 'monthly' });
      h.ownerOk('payconf.upsertSalaryRule', { employeeId: a, effectiveFrom: '2025-01-01', monthlyScheduledMinutes: 160 * 60, scheduledWeekdays: [1, 2, 3, 4, 5], scheduledDailyMinutes: 480, confirmed: true, monthlySalary: 240000 });
      const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
      h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
      h.setNow('2026-12-01', '06:00');
      const c = h.ownerOk('payroll.compute', { periodId: p.id });
      const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
      const u = uowOf(h);
      expect(u.list<any>('system_metadata').find((m) => m.key === 'payrollRestoreLocks')).toBeUndefined();
      if (raw !== null) {
        u.insert('system_metadata', { key: 'payrollRestoreLocks', value: raw } as never, 'met');
        u.flush();
        expect(uowOf(h).list<any>('system_metadata').find((m) => m.key === 'payrollRestoreLocks')?.value).toBe(raw);
      }
      expect(code(h.owner('payroll.confirm', { periodId: p.id, acknowledgements: acks }))).toBe(ok ? 'OK' : 'PAYROLL_BLOCKED');
    });
  }
});

describe('独立した点検（D-027 の 1 回目）の反例: 照合の迂回をしない', () => {
  function confirmedStore() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    h.setNow('2026-12-01', '06:00');
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    return { h, a, p };
  }
  const lockOf = (h: Harness, p: { id: string }) => h.ownerOk<any>('payroll.periods').periods.find((x: any) => x.id === p.id).restoreLock;

  it('#1: 同じ ID の行を重ねて挿入した（控除を 4 万円にした行を元の行の前に置いた）場合は再開しない', () => {
    const { h, a, p } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const sheet = h.env.adapter.sheets.get('deductions')!;
    const i = sheet.findIndex((r) => r[0] !== 'id' && String(r[0]).startsWith('ded'));
    expect(i).toBeGreaterThanOrEqual(0);
    const dup = [...sheet[i]!];
    sheet.splice(i, 0, dup); // 同じ ID の行（内容は後で変える）を前に置く
    const r = h.owner('maintenance.finish', FINISH);
    expect(code(r)).toBe('MAINTENANCE_CHECK_FAILED');
    expect((r as any).error.message).toContain('同じ ID の行');
    sheet.splice(i, 1);
    h.ownerOk('maintenance.finish', FINISH);
    expect(lockOf(h, p)).toBeNull();
    void a;
  });

  it('#1: 守る表（端末）の行を重複させた場合も再開しない', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const sheet = h.env.adapter.sheets.get('devices')!;
    const row = sheet.find((r) => String(r[0]).startsWith('dev'))!;
    sheet.push([...row]);
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
  });

  it('#2: 打刻の行を別の月のシートへ移した場合は再開しない（給与の計算から外れる）', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const nov = h.env.adapter.sheets.get('attendance_events__2026_11')!;
    const out = nov.findIndex((r) => r.includes('clock_out'));
    const [row] = nov.splice(out, 1);
    h.env.adapter.sheets.set('attendance_events__2026_08', [row!]);
    const r = h.owner('maintenance.finish', FINISH);
    expect(code(r)).toBe('MAINTENANCE_CHECK_FAILED');
  });

  it('#2: 月のシートの名前を変えた（年月の形式でない）場合は再開しない', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const rows = h.env.adapter.sheets.get('attendance_events__2026_11')!;
    h.env.adapter.sheets.delete('attendance_events__2026_11');
    h.env.adapter.sheets.set('attendance_events__2026_11_old', rows);
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
  });

  it('#3: 開始が途中で止まった（開始時の記録を作れなかった）後は、通常の開始で基準を作り直さない。やり直しは確認が必要で、終了時は確定済みの給与を停止する', () => {
    const { h, p } = confirmedStore();
    const files = h.env.files;
    const create = files.createFile.bind(files);
    files.createFile = () => {
      throw new Error('Drive の一時的な失敗（模擬）');
    };
    expect(h.owner('maintenance.begin', BEGIN).ok).toBe(false);
    files.createFile = create;
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
    // 開始の後の手作業（打刻を 1 行消した）を、やり直しの基準に含めない
    const nov = h.env.adapter.sheets.get('attendance_events__2026_11')!;
    nov.splice(nov.findIndex((r) => r.includes('clock_out')), 1);
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('MAINTENANCE_RESTART_REQUIRED');
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    // 所有者が「手作業をしていない」と確認してやり直した場合は、基準が不確かなため、内容の変更の有無にかかわらず確定済みの給与を停止して照合する
    h.ownerOk('maintenance.begin', { confirmText: '保守を開始し直す', restart: true });
    const f = h.ownerOk('maintenance.finish', FINISH);
    expect(f.payrollPeriodsToReview).toBe(1);
    expect(lockOf(h, p)).not.toBeNull();
    // 照合で差が分かる（打刻を消したため総支給額が 6,000 円から下がる）。差がある間は解除できない
    expect(h.ownerOk<any>('payroll.restoreLockReview', { periodId: p.id }).differences).toBe(1);
  });

  it('#3: 開始時のバックアップだけが失敗した場合は、再実行でバックアップだけをやり直し、開始時の記録（基準）はそのまま使う', () => {
    const { h } = confirmedStore();
    const files = h.env.files;
    const copy = files.copyDatabase.bind(files);
    files.copyDatabase = () => {
      throw new Error('容量不足（模擬）');
    };
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('MAINTENANCE_BEGIN_FAILED');
    files.copyDatabase = copy;
    // 失敗の後の手作業（打刻の削除）は、基準（失敗の前に作った記録）との照合で検出される
    // （独立した点検 2 回目 #5: バックアップのやり直しの前にも照合し、変更があればバックアップを作り直さない）
    const nov = h.env.adapter.sheets.get('attendance_events__2026_11')!;
    const [removed] = nov.splice(nov.findIndex((r) => r.includes('clock_out')), 1);
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    nov.push(removed!);
    h.ownerOk('maintenance.begin', BEGIN);
    h.ownerOk('maintenance.finish', FINISH);
  });

  it('#5: 開始時の記録のファイルを失った場合も、やり直し（確認あり）で抜け出せ、確定済みの給与は停止して照合する', () => {
    const { h, p } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    for (const f of h.env.files.files.values()) if (f.name.startsWith('Shiftly_maintenance_snapshot_')) f.data = null;
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(code(h.owner('maintenance.begin', BEGIN))).toBe('CONFLICT');
    h.ownerOk('maintenance.begin', { confirmText: '保守を開始し直す', restart: true });
    h.ownerOk('maintenance.finish', FINISH);
    expect(lockOf(h, p)).not.toBeNull();
  });

  it('#6: 保守中は、途中で止まった書き込みの再適用（ジャーナル）を、業務の要求・定期処理をきっかけに行わない', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const proto = UnitOfWork.prototype as unknown as { recoverJournal: (...a: unknown[]) => unknown };
    const orig = proto.recoverJournal;
    let calls = 0;
    proto.recoverJournal = function (this: unknown, ...a: unknown[]) {
      calls++;
      return orig.apply(this, a);
    };
    try {
      expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
      expect(code(handleRequest(h.be, { op: 'system.dailyJob' }, 'system'))).toBe('MAINTENANCE');
      expect(code(h.owner('payroll.confirm', { periodId: 'x' }))).toBe('MAINTENANCE');
      expect(calls).toBe(0);
      h.ownerOk('maintenance.finish', FINISH); // 保守の終了は再適用してから照合する
      expect(calls).toBe(1);
    } finally {
      proto.recoverJournal = orig;
    }
  });

  it('#7: 既存の環境で店舗設定・初期化の記録の行を手で消し、世代の記録も失った場合も、初期化は世代を作り直さない', () => {
    const { h } = confirmedStore();
    h.env.adapter.sheets.set('store_settings', []);
    h.env.adapter.sheets.set('system_metadata', h.env.adapter.sheets.get('system_metadata')!.filter((r) => !r.includes('initializedAt')));
    h.env.platform.secrets.delete('SHIFTLY_RESTORE_EPOCH');
    h.owner('system.initialize', { storeName: 'テスト店舗', envId: 'env_test' });
    expect(h.currentEpoch()).toBeNull();
    expect(code(h.owner('settings.update', { storeName: 'x' }, { epoch: null }))).not.toBe('OK');
  });
});

describe('独立した点検（D-027 の 2 回目）の反例', () => {
  function confirmedStore() {
    const h = new Harness();
    h.setupStore();
    const a = h.addStaff('山田', '482913', { rate: 1200 });
    h.punchAt(a, '482913', '2026-11-02', '09:00', 'clock_in');
    h.punchAt(a, '482913', '2026-11-02', '14:00', 'clock_out');
    const p = h.ownerOk('payroll.openPeriod', { periodKey: '2026-11' });
    h.ownerOk('deductions.upsert', { employeeId: a, periodId: p.id, status: 'explicit_none' });
    h.setNow('2026-12-01', '06:00');
    const c = h.ownerOk('payroll.compute', { periodId: p.id });
    const acks = c.employees[0].issues.filter((i: any) => i.severity === 'confirm').map((i: any) => i.key);
    h.ownerOk('payroll.confirm', { periodId: p.id, acknowledgements: acks });
    return { h, a, p };
  }

  it('#1: 開始時の記録を読み込める間は「開始のやり直し」を受け付けない（手で消した守る記録を基準に取り込んで再開しない）', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const nov = h.env.adapter.sheets.get('attendance_events__2026_11')!;
    nov.splice(nov.findIndex((r) => r.includes('clock_out')), 1);
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(code(h.owner('maintenance.begin', { confirmText: '保守を開始し直す', restart: true }))).toBe('CONFLICT');
    expect(code(h.owner('maintenance.finish', FINISH))).toBe('MAINTENANCE_CHECK_FAILED');
    expect(code(h.owner('settings.update', { storeName: '保守中' }))).toBe('MAINTENANCE');
  });

  it('#2: 先の月のジャーナルのシートに未完了の書き込みの記録を置いた場合は再開しない（再開の後に照合していない書き込みをさせない）', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const u = uowOf(h);
    u.insert('operation_journal', { op: 'payroll.correct', state: 'started', detail: '[]' } as never, 'jnl');
    u.flush();
    // 保存した行を 2027-01 のシートへ移す（直近 2 か月の再適用の範囲の外）
    const rows: unknown[][] = [];
    for (const [name, sheet] of h.env.adapter.sheets) {
      if (!name.startsWith('operation_journal__')) continue;
      const i = sheet.findIndex((r) => r.includes('started'));
      if (i >= 0) rows.push(...sheet.splice(i, 1));
    }
    expect(rows.length).toBe(1);
    h.env.adapter.sheets.set('operation_journal__2027_01', rows as never);
    const r = h.owner('maintenance.finish', FINISH);
    expect(code(r)).toBe('MAINTENANCE_CHECK_FAILED');
    expect((r as any).error.message).toContain('operation_journal');
  });

  it('#3: 数値の列を、空欄から数値でない値に変えた場合も変更として検出し、再開しない', () => {
    const { h } = confirmedStore();
    h.ownerOk('maintenance.begin', BEGIN);
    const st = h.env.adapter.sheets.get('store_settings')!;
    const col = TABLES.find((t) => t.name === 'store_settings')!.columns.findIndex(([c]) => c === 'employerCostRatePercent');
    expect(col).toBeGreaterThanOrEqual(0);
    st[0]![col] = 'abc';
    const r = h.owner('maintenance.finish', FINISH);
    expect(code(r)).toBe('MAINTENANCE_CHECK_FAILED');
    expect((r as any).error.message).toContain('数値ではありません');
  });
});
