/**
 * Shiftly Setup インストーラーの統合テスト
 * Apps Script API はフェイク、Core はメモリ上のモック（doPost 相当の振る舞いを再現）
 */
import { describe, expect, it } from 'vitest';
import { AppsScriptApi, type Http, type ScriptFile } from '../../src/setup/apps-script-api';
import { Installer, type InstallerDeps, type Registry, type SecretRegistry, type ReleaseBundle } from '../../src/setup/installer';
import { createMockEnv } from '../../src/backend/mock';
import { handleRequest, signOwnerEnvelope, verifyEnvelope, SECRET_KEYS } from '../../src/backend/index';
import { UnitOfWork } from '../../src/backend/store';
import { fromHex, toHex, utf8 } from '../../src/shared/crypto';
import { sha256 } from '../../src/shared/sha256';
import { createHash, randomBytes } from 'node:crypto';

const sha = (s: string) => toHex(sha256(utf8(s)));

function fakeScriptApi(opts: { apiDisabled?: boolean; failCreateOnce?: boolean; loseCreateResponseOnce?: boolean } = {}) {
  let loseOnce = opts.loseCreateResponseOnce ?? false;
  const projects = new Map<string, { title: string; files: ScriptFile[]; versions: number; deployments: Map<string, number> }>();
  let n = 0;
  let failOnce = opts.failCreateOnce ?? false;
  const calls: string[] = [];
  const http: Http = (method, url, body) => {
    calls.push(`${method} ${url.replace('https://script.googleapis.com/v1', '')}`);
    if (opts.apiDisabled) return { status: 403, body: JSON.stringify({ error: { message: 'User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings' } }) };
    const m = url.match(/\/projects(?:\/([^/?]+))?(?:\/(content|versions|deployments)(?:\/([^/?]+))?)?/)!;
    const [, id, sub, depId] = m;
    if (method === 'POST' && !id) {
      if (failOnce) {
        failOnce = false;
        return { status: 500, body: '{"error":{"message":"backend error"}}' };
      }
      const sid = `script_${++n}`;
      projects.set(sid, { title: (body as { title: string }).title, files: [], versions: 0, deployments: new Map() });
      if (loseOnce) {
        // 作成は成功したが応答が失われた（タイムアウト等）
        loseOnce = false;
        return { status: 504, body: '{"error":{"message":"gateway timeout"}}' };
      }
      return { status: 200, body: JSON.stringify({ scriptId: sid }) };
    }
    const p = id ? projects.get(decodeURIComponent(id)) : undefined;
    if (!p) return { status: 404, body: '{"error":{"message":"not found"}}' };
    if (method === 'GET' && !sub) return { status: 200, body: JSON.stringify({ scriptId: id, title: p.title }) };
    if (method === 'PUT' && sub === 'content') {
      p.files = (body as { files: ScriptFile[] }).files;
      return { status: 200, body: '{}' };
    }
    if (method === 'POST' && sub === 'versions') return { status: 200, body: JSON.stringify({ versionNumber: ++p.versions }) };
    const dep = (did: string, v: number) => ({ deploymentId: did, deploymentConfig: { versionNumber: v }, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: `https://script.google.com/macros/s/${did}/exec` } }] });
    if (method === 'POST' && sub === 'deployments') {
      const did = `dep_${id}_${p.deployments.size + 1}`;
      p.deployments.set(did, (body as { versionNumber: number }).versionNumber);
      return { status: 200, body: JSON.stringify(dep(did, (body as { versionNumber: number }).versionNumber)) };
    }
    if (method === 'GET' && sub === 'deployments' && depId) {
      const v = p.deployments.get(depId);
      return v ? { status: 200, body: JSON.stringify(dep(depId, v)) } : { status: 404, body: '{}' };
    }
    if (method === 'PUT' && sub === 'deployments' && depId) {
      const v = (body as { deploymentConfig: { versionNumber: number } }).deploymentConfig.versionNumber;
      p.deployments.set(depId, v);
      return { status: 200, body: JSON.stringify(dep(depId, v)) };
    }
    return { status: 400, body: '{"error":{"message":"bad"}}' };
  };
  return { http, projects, calls };
}

/** Core の doPost 相当（ping / pair / owner envelope） */
function fakeCore(installed: { bootstrap?: Record<string, string> }) {
  const env = createMockEnv({ now: Date.now() });
  const be = { p: env.platform, adapter: () => env.adapter };
  const state = { initialized: false, version: '0.1.0' };
  const authorize = () => {
    const b = installed.bootstrap!;
    env.secrets.set('SHIFTLY_DB_ID', 'db');
    handleRequest(be, { op: 'system.initialize', args: { storeName: b.storeName, envId: b.envId } }, 'system');
    state.initialized = true;
  };
  const post = (body: Record<string, unknown>) => {
    const b = installed.bootstrap;
    if (!b) return { ok: false, error: { code: 'NOT_DEPLOYED', message: '' } };
    if (body.kind === 'ping') return { ok: true, data: { app: 'shiftly-core', version: state.version, schemaVersion: 1, initialized: state.initialized, envId: b.envId, adminPaired: env.secrets.get('SHIFTLY_ADMIN_PAIRED') === '1', setupPaired: env.secrets.get('SHIFTLY_SETUP_PAIRED') === '1' } };
    if (body.kind === 'pair') {
      const role = body.role === 'setup' ? 'setup' : 'admin';
      if (sha(String(body.pairingCode)) !== b[role === 'admin' ? 'adminPairingHash' : 'setupPairingHash']) return { ok: false, error: { code: 'UNAUTHENTICATED', message: '' } };
      const flag = role === 'admin' ? 'SHIFTLY_ADMIN_PAIRED' : 'SHIFTLY_SETUP_PAIRED';
      if (env.secrets.get(flag)) return { ok: false, error: { code: 'CONFLICT', message: '' } };
      // 実 Core（src/gas/core.ts pair）と同じく、呼び出し側が生成した鍵（clientKey）があればそれを登録
      const key = typeof body.clientKey === 'string' && /^[0-9a-f]{64}$/.test(body.clientKey) ? body.clientKey : env.platform.randomHex(32);
      env.secrets.set(role === 'admin' ? SECRET_KEYS.adminHmac : SECRET_KEYS.setupHmac, key);
      env.secrets.set(flag, '1');
      return { ok: true, data: { key } };
    }
    if (body.kind === 'owner') {
      try {
        const v = verifyEnvelope(env.platform, body.envelope);
        return handleRequest(be, JSON.parse(v.body), 'owner');
      } catch (e) {
        return { ok: false, error: { code: 'UNAUTHENTICATED', message: String(e) } };
      }
    }
    return { ok: false, error: { code: 'UNKNOWN', message: '' } };
  };
  return { env, post, authorize, state, be };
}

function release(version = '0.1.0'): ReleaseBundle {
  const core: ScriptFile[] = [{ name: 'appsscript', type: 'JSON', source: '{"webapp":{}}' }, { name: 'Code', type: 'SERVER_JS', source: 'function doGet(){}' }, { name: 'staff', type: 'HTML', source: '<html></html>' }];
  const admin: ScriptFile[] = [{ name: 'appsscript', type: 'JSON', source: '{"webapp":{}}' }, { name: 'Code', type: 'SERVER_JS', source: 'function adminApi(){}' }];
  const hashes: Record<string, string> = {};
  for (const f of core) hashes[`core/${f.name}`] = sha(f.source);
  for (const f of admin) hashes[`admin/${f.name}`] = sha(f.source);
  return { version, core, admin, hashes };
}

function setup(o: { apiDisabled?: boolean; failCreateOnce?: boolean; loseCreateResponseOnce?: boolean; email?: string; dropSetupPairResponseOnce?: boolean; store?: { reg: Registry | null; secrets: SecretRegistry | null } } = {}) {
  let dropPair = !!o.dropSetupPairResponseOnce;
  const api = fakeScriptApi(o);
  const store = o.store ?? { reg: null as Registry | null, secrets: null as SecretRegistry | null };
  const installed: { bootstrap?: Record<string, string> } = {};
  const core = fakeCore(installed);
  const deps: InstallerDeps = {
    api: new AppsScriptApi(api.http),
    release: release(),
    load: () => ({ reg: store.reg ? structuredClone(store.reg) : null, secrets: store.secrets ? { ...store.secrets } : null }),
    save: (r, s) => {
      store.reg = structuredClone(r);
      store.secrets = { ...s };
    },
    userEmail: () => o.email ?? 'owner@example.invalid',
    randomHex: (n) => randomBytes(n).toString('hex'),
    sha256Hex: (s) => createHash('sha256').update(s, 'utf8').digest('hex'),
    now: () => new Date().toISOString(),
    postCore: (_url, body) => {
      // デプロイ済みの core の bootstrap を取り出す
      const p = [...api.projects.values()].find((x) => x.title.startsWith('Shiftly-Staff'));
      const bs = p?.files.find((f) => f.name === 'bootstrap');
      if (bs) installed.bootstrap = JSON.parse(bs.source.replace(/^var SHIFTLY_BOOTSTRAP = /, '').replace(/;\n$/, ''));
      const res = core.post(body as Record<string, unknown>);
      const b = body as Record<string, unknown>;
      // 応答の喪失を模擬（Core 側では登録済み）
      if (dropPair && b.kind === 'pair' && b.role === 'setup' && res.ok) {
        dropPair = false;
        return { ok: false, error: { code: 'NETWORK', message: '応答なし' } } as never;
      }
      return res as never;
    },
    callCoreAsSetup: (url, keyHex, req) => {
      const envlp = signOwnerEnvelope(core.env.platform, fromHex(keyHex), JSON.stringify(req), 'setup');
      const res = deps.postCore(url, { kind: 'owner', envelope: envlp }) as never;
      // 処理は Core で完了したが応答が失われた状態を模擬（操作名で指定）
      const op = (req as { op?: string }).op ?? '';
      if (dropOps.has(op)) {
        dropOps.delete(op);
        return { ok: false, error: { code: 'NETWORK', message: '応答なし' } } as never;
      }
      return res;
    },
  };
  const dropOps = new Set<string>();
  return { api, store, core, deps, dropOps, make: () => new Installer(deps) };
}

describe('Shiftly Setup（自動インストーラー）', () => {
  it('初回セットアップ: 自動工程 → 権限承認（手動）で停止 → 承認後に完了', () => {
    const s = setup();
    let r = s.make().runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('store'); // 店舗名未入力
    const inst = s.make();
    inst.retry('store');
    r = inst.runUntilBlocked({ storeName: 'テスト店' }, 20);
    expect(r.waitingFor?.step).toBe('core.authorize');
    expect(r.waitingFor?.openUrl).toContain('script.google.com/home/projects/script_1');
    // 管理者が shiftlyAuthorize を実行
    s.core.authorize();
    r = s.make().runUntilBlocked({}, 20);
    expect(r.waitingFor?.step).toBe('admin.authorize');
    // Admin の shiftlyAuthorize（ペアリング）
    const adminBs = [...s.api.projects.values()].find((p) => p.title.startsWith('Shiftly-Admin'))!.files.find((f) => f.name === 'bootstrap')!;
    const code = JSON.parse(adminBs.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    expect(s.core.post({ kind: 'pair', role: 'admin', pairingCode: code }).ok).toBe(true);
    r = s.make().runUntilBlocked({}, 20);
    expect(r.error).toBeNull();
    expect(r.state.complete).toBe(true);
    expect(r.state.staffUrl).toMatch(/\/exec$/);
    expect(r.state.adminUrl).toMatch(/\/exec$/);
    expect(s.api.projects.size).toBe(2);
    // レジストリには秘密情報（pairing code / setup key）を含めない
    expect(JSON.stringify(s.store.reg)).not.toContain(code);
    expect(JSON.stringify(s.store.reg)).not.toContain(s.store.secrets!.setupKey!);
  });

  it('Codex 監査1 #12: Setup のペアリング応答が失われても、再実行で再開できる', () => {
    const s = setup({ dropSetupPairResponseOnce: true });
    s.make().runUntilBlocked({ storeName: 'テスト店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const adminBs = [...s.api.projects.values()].find((p) => p.title.startsWith('Shiftly-Admin'))!.files.find((f) => f.name === 'bootstrap')!;
    const code = JSON.parse(adminBs.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    let r = s.make().runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('setup.pair'); // 1 回目: 応答喪失
    const inst = s.make();
    inst.retry('setup.pair');
    r = inst.runUntilBlocked({}, 20);
    expect(r.error).toBeNull();
    expect(r.state.complete).toBe(true);
    expect(s.store.secrets!.setupKey).toMatch(/^[0-9a-f]{64}$/);
    expect(s.store.secrets!.pendingSetupKey).toBeUndefined();
  });

  it('再実行・中断再開で重複生成しない（既存環境の再検出）', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    const before = s.api.projects.size;
    for (let i = 0; i < 3; i++) s.make().runUntilBlocked({}, 20);
    expect(s.api.projects.size).toBe(before);
    expect(s.make().state().envId).toMatch(/^env_/);
  });

  it('作成 API の一時エラー後の再実行で 1 つだけ作成', () => {
    const s = setup({ failCreateOnce: true });
    const r1 = s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(r1.error?.step).toBe('core.create');
    const inst = s.make();
    inst.retry('core.create');
    inst.runUntilBlocked({}, 20);
    expect([...s.api.projects.values()].filter((p) => p.title.startsWith('Shiftly-Staff'))).toHaveLength(1);
  });

  it('Codex 監査1 #12: 作成成功の応答が失われた場合は自動で作り直さず、確認後の再実行で 1 つだけになる', () => {
    const s = setup({ loseCreateResponseOnce: true });
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    const r = s.make().runUntilBlocked({}, 20); // 再実行しても自動では作らない
    expect(r.error?.step).toBe('core.create');
    expect(r.error?.fix).toContain('script.google.com/home');
    const staffProjects = () => [...s.api.projects.entries()].filter(([, p]) => p.title.startsWith('Shiftly-Staff'));
    expect(staffProjects()).toHaveLength(1);
    // 管理者が一覧で確認し、応答の失われたプロジェクトをゴミ箱へ移動してから再実行
    s.api.projects.delete(staffProjects()[0]![0]);
    const inst = s.make();
    inst.retry('core.create');
    inst.runUntilBlocked({}, 20);
    expect(staffProjects()).toHaveLength(1);
  });

  it('Apps Script API 無効時は設定ページへの案内', () => {
    const s = setup({ apiDisabled: true });
    const r = s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(r.error?.step).toBe('api');
    expect(r.error?.fix).toContain('script.google.com/home/usersettings');
  });

  it('別アカウントでの再開は停止（取り違え防止）', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    const other = setup({ email: 'someone-else@example.invalid', store: s.store });
    const r = other.make().runNext();
    expect(r.error?.step).toBe('account');
  });

  it('配布物の改ざん・破損を検知して配置しない', () => {
    const s = setup();
    s.deps.release.core[1]!.source = 'function doGet(){ /* tampered */ }';
    const r = s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(r.error?.step).toBe('core.upload');
    expect([...s.api.projects.values()][0]!.files).toHaveLength(0);
  });

  it('更新: 更新前バックアップ → コード更新 → 既存デプロイ更新（URL維持）→ 完了。Setup 鍵は更新関連以外を実行できない', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    const done = s.make().runUntilBlocked({}, 20);
    expect(done.state.complete).toBe(true);
    const urlBefore = done.state.staffUrl;
    s.deps.release = release('0.2.0');
    const inst = s.make();
    expect(inst.checkUpdate().needsUpdate).toBe(true);
    const u = inst.applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(true);
    expect(inst.state().staffUrl).toBe(urlBefore);
    expect(inst.state().installedVersion).toBe('0.2.0');
    const backups = handleRequest(s.core.be, { op: 'backup.list' }, 'owner');
    expect(backups.ok && (backups.data as Array<{ kind: string }>).some((b) => b.kind === 'pre_update')).toBe(true);
    // Setup の鍵で権限外操作は不可
    const forbidden = s.deps.callCoreAsSetup('x', s.store.secrets!.setupKey!, { op: 'permissions.set', args: {} });
    expect(forbidden.ok).toBe(false);
  });

  it('更新失敗時はコードのデプロイを以前のバージョンへ戻し、メンテナンスを解除', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    s.deps.release = release('0.2.0');
    // 配布物を壊して更新途中で失敗させる
    s.deps.release.admin[1]!.source = 'broken';
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('戻しました');
    const proj = s.api.projects.get(coreRef.scriptId!)!;
    expect(proj.deployments.get(coreRef.deploymentId!)).toBe(prevVersion);
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    expect(info.ok && (info.data as { maintenance: boolean }).maintenance).toBe(false);
  });

  it('Codex 監査2 #3: DB の構造が戻したプログラムと一致しない場合は、ロールバック後もメンテナンスを継続する', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    // DB がプログラムより新しい構造になっている状態（移行後の失敗で旧プログラムに戻した場合と同じ不一致）を作る
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    const row = uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === 'schemaVersion')!;
    uow.update('system_metadata', { ...row, value: '99' });
    uow.flush();
    s.deps.release = release('0.3.0');
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('メンテナンスを継続');
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    expect(info.ok && (info.data as { maintenance: boolean }).maintenance).toBe(true);
    // Core 側でも、構造が一致しない間はメンテナンスを解除できない
    expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: false }, requestId: 'req_maint_off_01' }, 'owner').ok).toBe(false);
  });

  it('Codex 監査3 #1: DB の移行後に完了処理が失敗した場合は、旧プログラムへ戻さずメンテナンスを継続する', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    // 整合性の確認で不合格になる状態（存在しないスタッフを参照する打刻）を作る → 移行は成功し、完了処理で失敗する
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    uow.insert('attendance_events', { employeeId: 'emp_ghost', type: 'clock_in', at: new Date().toISOString().slice(0, 19) + '+09:00', deviceId: null, source: 'admin_manual', requestId: 'req_ghost_0001', actorId: null, note: '' } as never, 'evt');
    uow.flush();
    s.deps.release = release('0.3.0');
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('メンテナンスを継続');
    // コードは戻していない（新しい版のまま）
    const proj = s.api.projects.get(coreRef.scriptId!)!;
    expect(proj.deployments.get(coreRef.deploymentId!)).not.toBe(prevVersion);
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    expect(info.ok && (info.data as { maintenance: boolean }).maintenance).toBe(true);
  });

  it('Codex 監査4: 正常に更新した後の手動ロールバックは、先にメンテナンスを開始し、DB の構造が一致しなければ継続する', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
    // 旧版のプログラムが期待する構造と DB が一致しない状態（新しい構造に移行済み）を模す
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    const row = uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === 'schemaVersion')!;
    uow.update('system_metadata', { ...row, value: '99' });
    uow.flush();
    const msg = s.make().rollbackCode();
    expect(msg).toContain('メンテナンスを開始しました');
    expect(msg).toContain('メンテナンスを継続');
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    expect(info.ok && (info.data as { maintenance: boolean }).maintenance).toBe(true);
  });

  it('Codex 監査4: 移行後に失敗した更新は、Setup を開き直しても再開でき、完了処理から行う', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    const ghost = uow.insert('attendance_events', { employeeId: 'emp_ghost', type: 'clock_in', at: new Date().toISOString().slice(0, 19) + '+09:00', deviceId: null, source: 'admin_manual', requestId: 'req_ghost_0002', actorId: null, note: '' } as never, 'evt') as { id: string };
    uow.flush();
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    // 版は配備済み（ping は新しい版を返す）でも、未完了の更新として再開を表示
    s.core.state.version = '0.3.0';
    const chk = s.make().checkUpdate();
    expect(chk.needsUpdate).toBe(true);
    expect(chk.pending).toBeTruthy();
    // 再開: バックアップ・コード配置・配備（versions.create）をやり直さず、DB 更新・完了処理から行う。旧版へは戻さない
    const coreRef = s.store.reg!.core;
    const deployed = s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!);
    const before = s.api.calls.length;
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false); // 不整合（存在しないスタッフの打刻）が残るため完了しない
    expect(r.message).toContain('メンテナンスを継続');
    expect(s.api.calls.slice(before).some((c) => c.includes('/versions') || c.includes('/content'))).toBe(false);
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(deployed);
    void ghost;
  });

  it('Codex 監査4: DB の移行の応答が失われた場合は、DB の実状態で移行済みと判断し、旧版へ戻さない', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    // 更新開始時の DB を旧構造（v1）にし、移行（v1→v2）は Core で完了するが応答が失われる
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    const row = uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === 'schemaVersion')!;
    uow.update('system_metadata', { ...row, value: '1' });
    uow.flush();
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    s.dropOps.add('system.migrate');
    s.deps.release = release('0.3.0');
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('メンテナンスを継続');
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).not.toBe(prevVersion);
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    expect(info.ok && (info.data as { schemaVersion: number; maintenance: boolean }).schemaVersion).toBe(2);
    expect(info.ok && (info.data as { maintenance: boolean }).maintenance).toBe(true);
  });

  it('Codex 監査5: 移行の段階で中断した更新の再開は、バックアップ・配備をやり直さず、ロールバック先と最初のバックアップを保持する', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    const prevCore = s.store.reg!.core.versionNumber;
    // 0.3.0 のコードは配備済みで、Core が移行を確定した直後に Setup が中断した状態（migrated を保存する前）
    s.deps.release = release('0.3.0');
    s.store.reg!.update = { target: '0.3.0', stage: 'migrate', startedAt: new Date().toISOString(), prevCore, prevAdmin: s.store.reg!.admin.versionNumber, backupId: 'bak_first' };
    const backupsBefore = (handleRequest(s.core.be, { op: 'backup.list' }, 'owner') as { data: unknown[] }).data.length;
    const before = s.api.calls.length;
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(true);
    expect(s.api.calls.slice(before).some((c) => c.includes('/versions') || c.includes('/content'))).toBe(false);
    expect((handleRequest(s.core.be, { op: 'backup.list' }, 'owner') as { data: unknown[] }).data.length).toBe(backupsBefore);
  });

  it('Codex 監査5: 移行の結果が不明（応答なし）な場合は、ロック外の読み取りで移行前に見えても旧版へ戻さない', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    s.dropOps.add('system.migrate');
    s.deps.release = release('0.3.0');
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('メンテナンスを継続');
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).not.toBe(prevVersion);
    // ロールバック先（直前の版）は更新開始前の版のまま
    expect(s.store.reg!.core.previousVersionNumber).toBe(prevVersion);
  });
});
