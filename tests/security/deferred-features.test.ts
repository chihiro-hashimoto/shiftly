/**
 * v1.3 で提供しない機能（D-027 B案）の実行禁止の網羅テスト
 * アプリ内の自動復元・稼働中の DB の自動切替・アプリの自動更新・更新に伴う DB の自動移行・自動ロールバックを、
 * 旧画面・直接の API 呼び出し・Google 所有者・管理者モード・スタッフ・Setup・定期処理のどの経路からも実行できないことを、
 * サーバー側で確かめる（画面の表示の切り替え・隠し設定に頼らない）。あわせて、配布物（GAS のバンドル・画面）に処理が含まれないことを確かめる
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Harness } from '../helpers/harness';
import { GasEmulator } from '../helpers/gas-emulator';
import { defineOps, DEFERRED_OPS, listOps } from '../../src/backend/api';
import { handleRequest } from '../../src/backend/index';
import { SETUP_ALLOWED_OPS } from '../../src/backend/auth';
import { TABLES } from '../../src/backend/schema';
import { UnitOfWork } from '../../src/backend/store';
import { Installer } from '../../src/setup/installer';

const code = (r: any) => (r.ok ? 'OK' : r.error.code);
const ADMIN_PW = 'Kanri#Pass-2026x';
const uowOf = (h: Harness) => new UnitOfWork(h.env.adapter, { now: () => h.env.clock.now, newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
const fingerprint = (h: Harness) => JSON.stringify(TABLES.map((d) => [d.name, uowOf(h).list(d.name)]));
/** 旧画面・旧版の Setup が送っていた引数（確認の文字列・承認を含む） */
const ARGS: Record<string, unknown> = {
  'backup.restore': { confirmText: '復元する' },
  'system.prepareUpdate': { targetVersion: '9.9.9' },
  'system.migrate': { approveDestructive: true },
  'system.finishUpdate': { acceptIntegrityIssues: true },
  'system.setMaintenance': { on: false },
};

describe('v1.3 で提供しない操作（D-027）: サーバー側の拒否', () => {
  const deferred = Object.keys(DEFERRED_OPS);

  it('対象は、アプリ内の復元・自動更新（準備・移行・完了）・メンテナンスの切替のすべて', () => {
    expect(deferred.sort()).toEqual(['backup.restore', 'system.finishUpdate', 'system.migrate', 'system.prepareUpdate', 'system.setMaintenance']);
  });

  it('処理を登録していない（操作の一覧にない）。登録しようとすると読み込み時にエラーになる（戻し忘れの防止）', () => {
    const names = new Set(listOps().map((o) => o.name));
    for (const op of deferred) expect(names.has(op), op).toBe(false);
    for (const op of deferred) expect(() => defineOps([{ name: op, kind: 'system', auth: 'owner', mutating: true, handler: () => null }]), op).toThrow(/提供しない/);
  });

  it('Setup の鍵で実行できる操作に、更新・移行・メンテナンスの切替・復元を含めない（読み取りだけ）', () => {
    expect([...SETUP_ALLOWED_OPS].sort()).toEqual(['backup.list', 'system.info', 'system.integrityCheck', 'system.storageCheck']);
  });

  for (const op of Object.keys(DEFERRED_OPS)) {
    it(`${op}: Google 所有者・定期処理・管理者モード（再認証の直後）・スタッフ・匿名のどの経路でも拒否し、データを変えない`, () => {
      const h = new Harness();
      h.setupStore();
      const a = h.addStaff('山田', '482913', { perms: ['punch_self'] });
      h.ownerOk('adminAuth.setPassword', { password: ADMIN_PW });
      const bk = h.ownerOk('backup.run', { kind: 'manual' });
      const args = { ...(ARGS[op] as object), backupId: bk.id };
      const t = h.staffOk('adminAuth.login', { password: ADMIN_PW }, { session: '' }).adminSessionToken;
      h.staffOk('adminAuth.reauth', { password: ADMIN_PW }, { session: '', adminSession: t });
      h.login(a, '482913');
      const epoch = h.currentEpoch();
      const before = fingerprint(h);
      const files = h.env.files.files.size;
      const calls: Array<[string, () => any]> = [
        ['Google 所有者', () => handleRequest(h.be, { op, args, requestId: h.rid(), epoch: epoch ?? undefined }, 'owner')],
        ['定期処理', () => handleRequest(h.be, { op, args }, 'system')],
        ['管理者モード', () => h.staff(op, args, { session: '', adminSession: t })],
        ['スタッフ', () => h.staff(op, args)],
        ['匿名（旧画面からの直接の呼び出し）', () => handleRequest(h.be, { op, args, requestId: h.rid() })],
      ];
      for (const [who, call] of calls) {
        const r = call();
        expect(code(r), who).toBe('NOT_IN_THIS_RELEASE');
        expect(r.error.message, who).toContain('Google 所有者による保守作業');
      }
      expect(fingerprint(h)).toBe(before);
      expect(h.env.files.files.size).toBe(files);
      expect(h.currentEpoch()).toBe(epoch);
      expect(h.env.platform.secrets.get('SHIFTLY_MAINTENANCE')).toBeNull();
    });
  }

  it('稼働中の DB を切り替える仕組み（復元の候補の作成・切替・破棄）は、プラットフォームにもない', () => {
    const h = new Harness();
    const db = h.env.platform.database as unknown as Record<string, unknown>;
    for (const m of ['prepareRestoreCopy', 'activate', 'discard']) expect(db[m], m).toBeUndefined();
    expect(typeof h.env.platform.database.currentId).toBe('function');
  });

  it('Setup のインストーラーに、既存環境の更新・ロールバックの処理がない', () => {
    const proto = Installer.prototype as unknown as Record<string, unknown>;
    for (const m of ['checkUpdate', 'applyUpdate', 'rollbackCode']) expect(proto[m], m).toBeUndefined();
  });
});

const built = existsSync('dist/gas/core/Code.js') && existsSync('dist/gas/admin/Code.js') && existsSync('dist/gas/setup/Code.js');

describe.skipIf(!built)('v1.3 で提供しない機能（D-027）: 配布物に含まれない・GAS の経路でも拒否する', () => {
  /** 延期した処理にだけ現れる名前（処理の本体・画面の操作の文言） */
  const MARKERS = ['prepareRestoreCopy', 'applyUpdateInner', 'rollbackCodeInner', 'acceptIntegrityIssues', 'approveDestructive', 'RESTORE_POLICY', 'pendingRollback', 'restore_candidate', 'このバックアップから復元', '復元を実行', 'DB 更新を再実行', '直前のバージョンに戻す', 'メンテナンスを解除'];
  const FILES = ['dist/gas/core/Code.js', 'dist/gas/core/staff.html', 'dist/gas/admin/Code.js', 'dist/gas/admin/admin.html', 'dist/gas/setup/Code.js', 'dist/gas/setup/setup.html'];
  for (const f of FILES) {
    it(`${f} に延期した処理が含まれない`, () => {
      const text = readFileSync(f, 'utf8');
      for (const m of MARKERS) expect(text.includes(m), `${f}: ${m}`).toBe(false);
    });
  }

  it('Setup（GAS）の更新・ロールバックの操作は拒否し、記録・ファイルを変えない', () => {
    const emu = new GasEmulator();
    const setup = emu.load('setup', { SHIFTLY_RELEASE: { version: '9.9.9', core: [], admin: [], hashes: {} } });
    const before = JSON.stringify([[...emu.files.keys()], emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY')]);
    for (const action of ['checkUpdate', 'applyUpdate', 'rollback']) {
      const r = JSON.parse(setup.setupApi(JSON.stringify({ action, args: { approveDestructive: true } })));
      expect(r.ok, action).toBe(false);
      expect(r.error.code, action).toBe('NOT_IN_THIS_RELEASE');
    }
    expect(JSON.stringify([[...emu.files.keys()], emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY')])).toBe(before);
  });

  it('Core（GAS）: Setup の鍵・Admin（Google 所有者）の署名付きの要求でも、延期した操作は拒否する', () => {
    const emu = new GasEmulator();
    const sha = (x: string) => createHash('sha256').update(x).digest('hex');
    const adminCode = randomBytes(32).toString('hex');
    const setupCode = randomBytes(32).toString('hex');
    const core = emu.load('core', { SHIFTLY_BOOTSTRAP: { envId: 'env_def', storeName: '店', adminPairingHash: sha(adminCode), setupPairingHash: sha(setupCode) } });
    expect(core.shiftlyAuthorize().ok).toBe(true);
    const post = (body: unknown) => JSON.parse(core.doPost({ postData: { contents: JSON.stringify(body) } }).content);
    const keys = { admin: post({ kind: 'pair', role: 'admin', pairingCode: adminCode }).data.key as string, setup: post({ kind: 'pair', role: 'setup', pairingCode: setupCode }).data.key as string };
    const envelope = (role: 'admin' | 'setup', req: unknown) => {
      const body = JSON.stringify(req);
      const ts = Date.now();
      const nonce = randomBytes(16).toString('hex');
      const sig = createHmac('sha256', Buffer.from(keys[role], 'hex')).update(`1.${role}.${ts}.${nonce}.${body}`).digest('hex');
      return { kind: 'owner', envelope: { v: 1, role, ts, nonce, body, sig } };
    };
    const dbBefore = emu.scriptProps.getProperty('SHIFTLY_DB_ID');
    for (const op of Object.keys(DEFERRED_OPS)) {
      for (const role of ['admin', 'setup'] as const) {
        const r = post(envelope(role, { op, args: ARGS[op], requestId: `def_${randomBytes(6).toString('hex')}` }));
        expect(r.ok, `${role} ${op}`).toBe(false);
      }
      expect(post(envelope('admin', { op, args: ARGS[op], requestId: `def_${randomBytes(6).toString('hex')}` })).error.code, op).toBe('NOT_IN_THIS_RELEASE');
    }
    expect(emu.scriptProps.getProperty('SHIFTLY_DB_ID')).toBe(dbBefore);
    expect(emu.scriptProps.getProperty('SHIFTLY_MAINTENANCE')).toBeNull();
  });
});
