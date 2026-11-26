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
  // 一時的な障害の注入（残り回数）。getDeployment: デプロイの照会 / putContent: コードの更新
  // scriptFail: 指定したプロジェクトの版の作成・デプロイの切替を、指定回数だけ失敗させる
  // createProject: プロジェクトの作成の失敗の注入（先頭から順に使う）。status=応答のステータス、created=Google 側で作成されたか、throw=通信の例外
  // omitDeployVersion: デプロイの応答から版の番号を除く（response=作成・切替の応答だけ / all=照会の応答も）
  const faults = {
    getDeployment: 0,
    putContent: 0,
    scriptFail: new Map<string, number>(),
    loseCreateDeployment: 0,
    createProject: [] as Array<{ status: number; created: boolean } | 'throw' | 'noid'>,
    omitDeployVersion: '' as '' | 'response' | 'all',
    // createDeployment: デプロイの作成の失敗の注入（先頭から順に使う）。noid=作成済みで成功（2xx）だが応答に ID がない
    createDeployment: [] as Array<{ status: number; created: boolean } | 'throw' | 'noid'>,
    // listLag: デプロイの一覧が、作成済みのデプロイをまだ返さない回数（一覧への反映の遅れ）
    listLag: 0,
    // getDeployment404: デプロイの個別照会が、存在するのに 404 を返す回数（一時的な照会の失敗）
    getDeployment404: 0,
    // getProject404: プロジェクトの照会が、存在するのに 404 を返す回数（一時的な照会の失敗。Codex 監査23 #4）
    getProject404: 0,
  };
  const descriptions = new Map<string, string>(); // deploymentId → 説明
  const http: Http = (method, url, body) => {
    calls.push(`${method} ${url.replace('https://script.googleapis.com/v1', '')}`);
    if (opts.apiDisabled) return { status: 403, body: JSON.stringify({ error: { message: 'User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings' } }) };
    const m = url.match(/\/projects(?:\/([^/?]+))?(?:\/(content|versions|deployments)(?:\/([^/?]+))?)?/)!;
    const [, id, sub, depId] = m;
    if (method === 'POST' && !id && faults.createProject.length) {
      const f = faults.createProject.shift()!;
      if (f === 'throw') throw new Error('Exception: Address unavailable: https://script.googleapis.com/v1/projects');
      if (f === 'noid') {
        projects.set(`script_${++n}`, { title: (body as { title: string }).title, files: [], versions: 0, deployments: new Map() });
        return { status: 200, body: '{}' };
      }
      if (f.created) projects.set(`script_${++n}`, { title: (body as { title: string }).title, files: [], versions: 0, deployments: new Map() });
      return { status: f.status, body: JSON.stringify({ error: { message: `HTTP ${f.status}` } }) };
    }
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
    if (method === 'GET' && !sub && faults.getProject404 > 0) {
      faults.getProject404--;
      return { status: 404, body: '{"error":{"message":"not found"}}' };
    }
    if (method === 'GET' && !sub) return { status: 200, body: JSON.stringify({ scriptId: id, title: p.title }) };
    if (id && ((method === 'POST' && sub === 'versions') || (method === 'PUT' && sub === 'deployments')) && (faults.scriptFail.get(decodeURIComponent(id)) ?? 0) > 0) {
      faults.scriptFail.set(decodeURIComponent(id), faults.scriptFail.get(decodeURIComponent(id))! - 1);
      return { status: 503, body: '{"error":{"message":"backend error"}}' };
    }
    if (method === 'PUT' && sub === 'content' && faults.putContent > 0) {
      faults.putContent--;
      return { status: 503, body: '{"error":{"message":"backend error"}}' };
    }
    if (method === 'GET' && sub === 'deployments' && depId && faults.getDeployment404 > 0) {
      faults.getDeployment404--;
      return { status: 404, body: '{"error":{"message":"not found"}}' };
    }
    if (method === 'GET' && sub === 'deployments' && depId && faults.getDeployment > 0) {
      faults.getDeployment--;
      return { status: 503, body: '{"error":{"message":"backend error"}}' };
    }
    if (method === 'GET' && sub === 'content') return { status: 200, body: JSON.stringify({ files: p.files }) };
    if (method === 'PUT' && sub === 'content') {
      p.files = (body as { files: ScriptFile[] }).files;
      return { status: 200, body: '{}' };
    }
    if (method === 'POST' && sub === 'versions') return { status: 200, body: JSON.stringify({ versionNumber: ++p.versions }) };
    const depFull = (did: string, v: number) => ({ deploymentId: did, deploymentConfig: { versionNumber: v, description: descriptions.get(did) }, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: `https://script.google.com/macros/s/${did}/exec` } }] });
    // 応答から版の番号を除く（実際の API の応答の違いを模す）
    const strip = (d: ReturnType<typeof depFull>) => ({ ...d, deploymentConfig: { description: d.deploymentConfig.description } });
    const dep = (did: string, v: number) => (faults.omitDeployVersion ? strip(depFull(did, v)) : depFull(did, v));
    const depGet = (did: string, v: number) => (faults.omitDeployVersion === 'all' ? strip(depFull(did, v)) : depFull(did, v));
    if (method === 'POST' && sub === 'deployments' && faults.createDeployment.length) {
      const f = faults.createDeployment.shift()!;
      if (f === 'throw') throw new Error('Exception: Address unavailable: https://script.googleapis.com/v1/projects/x/deployments');
      const created = f === 'noid' || f.created;
      if (created) {
        const did = `dep_${id}_${p.deployments.size + 1}`;
        p.deployments.set(did, (body as { versionNumber: number }).versionNumber);
        descriptions.set(did, (body as { description?: string }).description ?? '');
      }
      if (f === 'noid') return { status: 200, body: '{}' };
      return { status: f.status, body: JSON.stringify({ error: { message: `HTTP ${f.status}` } }) };
    }
    if (method === 'POST' && sub === 'deployments') {
      const did = `dep_${id}_${p.deployments.size + 1}`;
      p.deployments.set(did, (body as { versionNumber: number }).versionNumber);
      descriptions.set(did, (body as { description?: string }).description ?? '');
      if (faults.loseCreateDeployment > 0) {
        // 作成は成功したが応答が失われた（タイムアウト等）
        faults.loseCreateDeployment--;
        return { status: 504, body: '{"error":{"message":"gateway timeout"}}' };
      }
      return { status: 200, body: JSON.stringify(dep(did, (body as { versionNumber: number }).versionNumber)) };
    }
    if (method === 'GET' && sub === 'deployments' && !depId) {
      if (faults.listLag > 0) {
        faults.listLag--;
        return { status: 200, body: '{}' };
      }
      return { status: 200, body: JSON.stringify({ deployments: [...p.deployments.entries()].map(([did, v]) => dep(did, v)) }) };
    }
    if (method === 'GET' && sub === 'deployments' && depId) {
      const v = p.deployments.get(depId);
      return v ? { status: 200, body: JSON.stringify(depGet(depId, v)) } : { status: 404, body: '{}' };
    }
    if (method === 'PUT' && sub === 'deployments' && depId) {
      const v = (body as { deploymentConfig: { versionNumber: number } }).deploymentConfig.versionNumber;
      p.deployments.set(depId, v);
      return { status: 200, body: JSON.stringify(dep(depId, v)) };
    }
    return { status: 400, body: '{"error":{"message":"bad"}}' };
  };
  return { http, projects, calls, faults, descriptions };
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
      // 処理は Core で完了したが、通信が例外になった状態を模擬（UrlFetchApp.fetch のタイムアウト等）
      if (throwOps.has(op)) {
        throwOps.delete(op);
        throw new Error('Exception: Timeout');
      }
      return res;
    },
  };
  const dropOps = new Set<string>();
  const throwOps = new Set<string>();
  return { api, store, core, deps, dropOps, throwOps, make: () => new Installer(deps) };
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

  // 独立した点検 補足3: 登録済み（CONFLICT）の後の確認の失敗の種類で案内を分ける（鍵が拒否された場合だけリセットを案内する）
  const pairUntilConflict = () => {
    const s = setup({ dropSetupPairResponseOnce: true });
    s.make().runUntilBlocked({ storeName: 'テスト店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const adminBs = [...s.api.projects.values()].find((p) => p.title.startsWith('Shiftly-Admin'))!.files.find((f) => f.name === 'bootstrap')!;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: JSON.parse(adminBs.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode });
    expect(s.make().runUntilBlocked({}, 20).error?.step).toBe('setup.pair'); // 1 回目: 応答喪失（Core 側では登録済み）
    return s;
  };
  it('ペアリングの確認: 登録済みの鍵の確認が一時的に失敗した場合は、リセットを案内せず再実行を案内し、再実行で完了する', () => {
    const s = pairUntilConflict();
    s.dropOps.add('system.info'); // 確認の呼び出しの応答が失われる（一時的な失敗）
    const inst = s.make();
    inst.retry('setup.pair');
    const r = inst.runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('setup.pair');
    expect(r.error?.fix).not.toContain('リセット');
    expect(r.error?.fix).toContain('時間をおいて');
    const inst2 = s.make();
    inst2.retry('setup.pair');
    expect(inst2.runUntilBlocked({}, 20).state.complete).toBe(true);
  });
  it('ペアリングの確認: 保存済みの鍵が拒否された（別の鍵で登録済み）場合だけ、リセットを案内する', () => {
    const s = pairUntilConflict();
    s.store.secrets = { ...s.store.secrets!, pendingSetupKey: 'f'.repeat(64) }; // 登録されていない鍵
    const inst = s.make();
    inst.retry('setup.pair');
    const r = inst.runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('setup.pair');
    expect(r.error?.fix).toContain('更新用接続のリセット');
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
    // C-19 で、作成の結果が分からない失敗（5xx を含む）の再実行には、重複がないことの確認の明示（画面のチェック）が必須になったため入力を追加（アサーションは変更していない）
    inst.retry('core.create', true);
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
    // C-19 で、再実行には重複がないことの確認の明示（画面のチェック）が必須になったため入力を追加（アサーションは変更していない）
    inst.retry('core.create', true);
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
    const prevAdmin = s.store.reg!.admin.versionNumber;
    s.deps.release = release('0.3.0');
    // 前提: 0.3.0 のコードが Staff・Admin の既存デプロイに配備済み（Apps Script 上の実際のデプロイも新しい版を指す）
    for (const which of ['core', 'admin'] as const) {
      const ref = s.store.reg![which];
      const proj = s.api.projects.get(ref.scriptId!)!;
      const v = ++proj.versions;
      proj.deployments.set(ref.deploymentId!, v);
      s.store.reg![which] = { ...ref, versionNumber: v, previousVersionNumber: ref.versionNumber };
    }
    s.store.reg!.update = { target: '0.3.0', stage: 'migrate', startedAt: new Date().toISOString(), prevCore, prevAdmin, backupId: 'bak_first' };
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

  it('Codex 監査6 #1: 移行の要求で通信が例外になった場合も、移行済みとして旧版へ戻さない', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    // 更新開始時の DB を旧構造（v1）にし、移行（v1→v2）は Core で完了するが、Setup 側の通信が例外になる
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    const row = uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === 'schemaVersion')!;
    uow.update('system_metadata', { ...row, value: '1' });
    uow.flush();
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    s.throwOps.add('system.migrate');
    s.deps.release = release('0.3.0');
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('メンテナンスを継続');
    // 旧版へ戻していない（旧 Core と v2 の DB の組み合わせにしない）
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).not.toBe(prevVersion);
    expect(s.store.reg!.update?.migrated).toBe(true);
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    expect(info.ok && (info.data as { schemaVersion: number }).schemaVersion).toBe(2);
    expect(info.ok && (info.data as { maintenance: boolean }).maintenance).toBe(true);
  });

  it('Codex 監査6 #3: 移行後の失敗から手動でロールバックした後の再実行は、配備を省略せず新しい版を配備してから完了する', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    // 移行後に完了処理の応答が失われて失敗（移行済み・メンテナンス継続）
    s.dropOps.add('system.finishUpdate');
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    expect(s.store.reg!.update?.migrated).toBe(true);
    // Google 所有者が手動で旧版へロールバック
    s.make().rollbackCode();
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(prevVersion);
    // 再実行: 旧版のまま「更新しました」としない。新しい版を配備してから完了する
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(true);
    const deployed = s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!);
    expect(deployed).not.toBe(prevVersion);
    expect(deployed).toBe(s.store.reg!.core.versionNumber);
    expect(s.store.reg!.appVersion).toBe('0.3.0');
  });

  // ---- Codex 監査7 ----
  const installed = () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const code = JSON.parse([...s.api.projects.values()][1]!.files.find((f) => f.name === 'bootstrap')!.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: code });
    s.make().runUntilBlocked({}, 20);
    return s;
  };
  const coreUow = (s: ReturnType<typeof setup>) => new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
  const backups = (s: ReturnType<typeof setup>) => coreUow(s).list<{ id: string; kind: string; driveFileId: string; status: string }>('backup_history');
  const maintenance = (s: ReturnType<typeof setup>) => {
    const info = handleRequest(s.core.be, { op: 'system.info' }, 'owner');
    return info.ok && (info.data as { maintenance: boolean }).maintenance;
  };
  /** 0.3.0 のコードを Staff・Admin の既存デプロイに配備済みの状態にする（Apps Script 上の実際のデプロイも新しい版を指す） */
  const deployNew = (s: ReturnType<typeof setup>) => {
    for (const which of ['core', 'admin'] as const) {
      const ref = s.store.reg![which];
      const proj = s.api.projects.get(ref.scriptId!)!;
      const v = ++proj.versions;
      proj.deployments.set(ref.deploymentId!, v);
      s.store.reg![which] = { ...ref, versionNumber: v, previousVersionNumber: ref.versionNumber };
    }
  };

  it('Codex 監査7 #1: 移行後の再開でデプロイの照会が一時的に失敗しても、再配備・旧版へのロールバック・バックアップの取り直しをせずに中断し、再実行で完了する', () => {
    const s = installed();
    const prevCore = s.store.reg!.core.versionNumber;
    const prevAdmin = s.store.reg!.admin.versionNumber;
    s.deps.release = release('0.3.0');
    deployNew(s);
    const newCore = s.store.reg!.core.versionNumber;
    // 移行の段階で Setup が中断した状態（移行の可能性あり）
    s.store.reg!.update = { target: '0.3.0', stage: 'migrate', startedAt: new Date().toISOString(), prevCore, prevAdmin, backupId: 'bak_first', migrated: true };
    const backupsBefore = backups(s).length;
    const coreRef = s.store.reg!.core;
    const callsBefore = s.api.calls.length;
    s.api.faults.getDeployment = 1;
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('確認できなかった');
    // 何も変更していない: コードの更新・版の作成・デプロイの切替（旧版へのロールバックを含む）をしていない
    expect(s.api.calls.slice(callsBefore).some((c) => c.startsWith('PUT') || c.startsWith('POST'))).toBe(false);
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(newCore);
    expect(backups(s).length).toBe(backupsBefore);
    expect(s.store.reg!.update).toMatchObject({ stage: 'migrate', migrated: true, backupId: 'bak_first', prevCore, prevAdmin });
    // 照会が回復した後の再実行は、配備を省略して完了する
    const r2 = s.make().applyUpdate({ approveDestructive: false });
    expect(r2.ok).toBe(true);
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(newCore);
    expect(backups(s).length).toBe(backupsBefore);
  });

  it('Codex 監査7 #1: 移行の可能性がある更新を旧版へ手動で戻した後の再実行で、コードの更新に失敗しても旧版へ自動で戻さず、最初の更新前バックアップを保持する', () => {
    const s = installed();
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    s.dropOps.add('system.finishUpdate');
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    const firstBackup = s.store.reg!.update!.backupId;
    expect(firstBackup).toBeTruthy();
    s.make().rollbackCode();
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(prevVersion);
    const backupsBefore = backups(s).length;
    const ops: string[] = [];
    const orig = s.deps.callCoreAsSetup;
    s.deps.callCoreAsSetup = (url, key, req) => {
      ops.push((req as { op: string }).op);
      return orig(url, key, req);
    };
    // 再実行: コードの更新が失敗する
    s.api.faults.putContent = 1;
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('メンテナンスを継続');
    expect(maintenance(s)).toBe(true);
    // 更新前バックアップを取り直さない（Setup・Core とも最初の参照を保持）
    expect(backups(s).length).toBe(backupsBefore);
    expect(s.store.reg!.update).toMatchObject({ backupId: firstBackup, migrated: true });
    // Core の更新準備（更新前バックアップの取得・Core 側の参照の書き換え）を呼ばない
    expect(ops).not.toContain('system.prepareUpdate');
    // 再実行で新しい版を配備して完了する
    const r2 = s.make().applyUpdate({ approveDestructive: false });
    expect(r2.ok).toBe(true);
    const deployed = s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!);
    expect(deployed).not.toBe(prevVersion);
    expect(deployed).toBe(s.store.reg!.core.versionNumber);
  });

  it('Codex 監査7 #1: 承認待ちからの再開で、コードが旧版に戻っていれば、移行の前に新しい版を配備する', () => {
    const s = installed();
    const coreRef = s.store.reg!.core;
    const prevCore = coreRef.versionNumber;
    const prevAdmin = s.store.reg!.admin.versionNumber;
    s.deps.release = release('0.3.0');
    // 承認待ちの間に、コードが旧版のデプロイに戻された状態（実際のデプロイは更新開始前の版）
    s.store.reg!.update = { target: '0.3.0', stage: 'awaiting_approval', startedAt: new Date().toISOString(), prevCore, prevAdmin, backupId: 'bak_first' };
    // 移行の要求を送った時点で、デプロイの切替（PUT deployments）が済んでいたか
    let deployedBeforeMigrate: boolean | null = null;
    const orig = s.deps.callCoreAsSetup;
    s.deps.callCoreAsSetup = (url, key, req) => {
      if ((req as { op: string }).op === 'system.migrate') deployedBeforeMigrate = s.api.calls.some((c) => c.startsWith('PUT') && c.includes('/deployments/'));
      return orig(url, key, req);
    };
    const r = s.make().applyUpdate({ approveDestructive: true });
    expect(r.ok).toBe(true);
    const deployed = s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!);
    expect(deployed).not.toBe(prevCore);
    expect(deployed).toBe(s.store.reg!.core.versionNumber);
    expect(deployedBeforeMigrate).toBe(true);
  });

  it('Codex 監査7 #2: 更新前バックアップは「メンテナンス中」の状態を含む（旧版へ戻した後に旧版の Core で復元しても、確認前に打刻が再開しない）', () => {
    const s = installed();
    const ops: string[] = [];
    const orig = s.deps.callCoreAsSetup;
    s.deps.callCoreAsSetup = (url, key, req) => {
      ops.push((req as { op: string }).op);
      return orig(url, key, req);
    };
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
    // Setup は準備（更新前バックアップ）の前に、メンテナンスの開始を独立した要求として確定する（旧版の Core が準備を行う場合にも効く）
    expect(ops.indexOf('system.setMaintenance')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('system.setMaintenance')).toBeLessThan(ops.indexOf('system.prepareUpdate'));
    // 更新前バックアップの内容（旧版の Core の復元は、この値をそのまま有効にする）
    const pre = backups(s).find((b) => b.kind === 'pre_update' && b.status === 'ok')!;
    const cand = s.core.env.platform.database.prepareRestoreCopy(pre.driveFileId);
    const uowC = new UnitOfWork(cand.adapter, { now: () => Date.now(), newId: (p) => `${p}_x` });
    expect(uowC.list<{ key: string; value: string }>('system_metadata').find((m) => m.key === 'maintenance')?.value).toBe('on');
  });

  it('Codex 監査7 #2: Core の更新準備だけでも、更新前バックアップは「メンテナンス中」を含む', () => {
    const s = installed();
    const r = handleRequest(s.core.be, { op: 'system.prepareUpdate', args: { targetVersion: '0.3.0' }, requestId: 'req_prep_000001' }, 'owner');
    expect(r.ok).toBe(true);
    const pre = backups(s).find((b) => b.kind === 'pre_update' && b.status === 'ok')!;
    const cand = s.core.env.platform.database.prepareRestoreCopy(pre.driveFileId);
    const uowC = new UnitOfWork(cand.adapter, { now: () => Date.now(), newId: (p) => `${p}_x` });
    expect(uowC.list<{ key: string; value: string }>('system_metadata').find((m) => m.key === 'maintenance')?.value).toBe('on');
  });

  // ---- Codex 監査8 ----
  const failCopies = (s: ReturnType<typeof setup>) => {
    const files = s.core.env.platform.files as { copyDatabase: (...a: unknown[]) => unknown };
    files.copyDatabase = () => {
      throw new Error('Drive の容量が不足しています');
    };
  };

  it('Codex 監査8 #3: 更新前バックアップに失敗した場合は、今回開始したメンテナンスを解除し、コードを変更しない', () => {
    const s = installed();
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    expect(maintenance(s)).toBe(false);
    failCopies(s);
    s.deps.release = release('0.3.0');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('更新前バックアップに失敗');
    expect(r.message).toContain('メンテナンスを解除しました');
    expect(maintenance(s)).toBe(false);
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(prevVersion);
  });

  it('Codex 監査8 #3: 更新の開始前からメンテナンス中だった場合は、更新前バックアップの失敗後もメンテナンスを継続する', () => {
    const s = installed();
    expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: 'req_mnt_000001' }, 'owner').ok).toBe(true);
    failCopies(s);
    s.deps.release = release('0.3.0');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('開始前からメンテナンス中');
    expect(maintenance(s)).toBe(true);
  });

  it('Codex 監査8 #3: Core の更新準備だけでも、更新前バックアップの失敗時は、そのリクエストで開始したメンテナンスを解除する', () => {
    const s = installed();
    failCopies(s);
    const r = handleRequest(s.core.be, { op: 'system.prepareUpdate', args: { targetVersion: '0.3.0' }, requestId: 'req_prep_000002' }, 'owner');
    expect(r.ok).toBe(false);
    expect(maintenance(s)).toBe(false);
  });

  // ---- Codex 監査9 ----
  const deployCalls = (s: ReturnType<typeof setup>, from: number) => s.api.calls.slice(from).filter((c) => c.startsWith('PUT') && c.includes('/deployments/'));

  it('Codex 監査9 #3: 更新の開始前からメンテナンス中の環境で、準備の通信が例外になっても、配備を操作せずメンテナンスを継続する', () => {
    const s = installed();
    expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: 'req_mnt_000002' }, 'owner').ok).toBe(true);
    const from = s.api.calls.length;
    s.throwOps.add('system.prepareUpdate');
    s.deps.release = release('0.3.0');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('開始前からメンテナンス中');
    expect(deployCalls(s, from)).toEqual([]);
    expect(maintenance(s)).toBe(true);
  });

  it('Codex 監査9 #3: 準備の通信が例外になった場合、コードを変更していないためロールバックせず、今回開始したメンテナンスだけを解除する', () => {
    const s = installed();
    const coreRef = s.store.reg!.core;
    const prevVersion = coreRef.versionNumber;
    const from = s.api.calls.length;
    s.throwOps.add('system.prepareUpdate');
    s.deps.release = release('0.3.0');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('メンテナンスを解除しました');
    expect(deployCalls(s, from)).toEqual([]);
    expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(prevVersion);
    expect(maintenance(s)).toBe(false);
  });

  it('Codex 監査9 #3: 更新の開始前からメンテナンス中の環境で、コードの更新に失敗して旧版へ戻した場合も、メンテナンスを継続する', () => {
    const s = installed();
    expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: 'req_mnt_000003' }, 'owner').ok).toBe(true);
    s.api.faults.putContent = 1;
    s.deps.release = release('0.3.0');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('メンテナンスを継続');
    expect(maintenance(s)).toBe(true);
  });

  // ---- Codex 監査10 ----
  /** Staff だけ新しい版を配備した状態（Admin は更新前の版のまま） */
  const deployCoreOnly = (s: ReturnType<typeof setup>) => {
    const ref = s.store.reg!.core;
    const proj = s.api.projects.get(ref.scriptId!)!;
    const v = ++proj.versions;
    proj.deployments.set(ref.deploymentId!, v);
    s.store.reg!.core = { ...ref, versionNumber: v, previousVersionNumber: ref.versionNumber };
    return v;
  };

  it('Codex 監査10 回帰1: Staff だけ配備した時点で中断した更新の再開で、準備の通信が例外になった場合は、旧版の組に戻してから解除する（版の混在で営業を再開しない）', () => {
    const s = installed();
    const prevCore = s.store.reg!.core.versionNumber;
    const prevAdmin = s.store.reg!.admin.versionNumber;
    const coreRef = s.store.reg!.core;
    const adminRef = s.store.reg!.admin;
    s.deps.release = release('0.3.0');
    expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: 'req_mnt_000004' }, 'owner').ok).toBe(true);
    deployCoreOnly(s);
    // 前回の実行: 開始前はメンテナンス解除中。コードの更新に着手し、Staff の配備の後に中断
    s.store.reg!.update = { target: '0.3.0', stage: 'deploy', startedAt: new Date().toISOString(), prevCore, prevAdmin, backupId: 'bak_first', maintenanceBefore: false, codeTouched: true };
    s.throwOps.add('system.prepareUpdate');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    const core = s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!);
    const admin = s.api.projects.get(adminRef.scriptId!)!.deployments.get(adminRef.deploymentId!);
    // 両方とも更新前の版にそろえてから解除する
    expect([core, admin]).toEqual([prevCore, prevAdmin]);
    expect(maintenance(s)).toBe(false);
  });

  it('Codex 監査10 回帰1: Staff・Admin の版が混在している状態では、準備の段階の失敗でもメンテナンスを解除しない', () => {
    const s = installed();
    const prevCore = s.store.reg!.core.versionNumber;
    const prevAdmin = s.store.reg!.admin.versionNumber;
    s.deps.release = release('0.3.0');
    expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: 'req_mnt_000005' }, 'owner').ok).toBe(true);
    deployCoreOnly(s);
    // 記録上は準備の段階（コードの更新に未着手）だが、実際の配備は混在している（記録と実際が食い違う場合の保護）
    s.store.reg!.update = { target: '0.3.0', stage: 'prepare', startedAt: new Date().toISOString(), prevCore, prevAdmin, maintenanceBefore: false };
    s.throwOps.add('system.prepareUpdate');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('版が一致しない');
    expect(maintenance(s)).toBe(true);
  });

  // ---- Codex 監査11 ----
  it('Codex 監査11 #1: 一部のロールバックに失敗した後の「直前のバージョンに戻す」は、更新の開始時の版の組へ戻し、実際の配備がそろったことを確認してから解除する', () => {
    const s = installed();
    const coreRef = s.store.reg!.core;
    const adminRef = s.store.reg!.admin;
    const dep = (ref: typeof coreRef) => s.api.projects.get(ref.scriptId!)!.deployments.get(ref.deploymentId!);
    // 0.3.0 へ正常に更新（Staff・Admin とも新しい版。各プロジェクトの直前の版は更新前の版）
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
    const start = [dep(coreRef), dep(adminRef)];
    expect(start[0]).not.toBe(s.store.reg!.core.previousVersionNumber);
    // 0.4.0 への更新: Staff の配備の後、Admin の版の作成が失敗 → 自動ロールバックで Admin の切替も失敗（2 回目の障害）
    s.api.faults.scriptFail.set(adminRef.scriptId!, 2);
    s.deps.release = release('0.4.0');
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(false);
    expect(maintenance(s)).toBe(true);
    // 案内どおり「直前のバージョンに戻す」を再実行（手動。引数なし）
    const msg = s.make().rollbackCode();
    // 更新の開始時の組（0.3.0 の Staff／Admin）へ戻り、別々の世代にならない
    expect([dep(coreRef), dep(adminRef)]).toEqual(start);
    expect(msg).toContain('メンテナンスを解除しました');
    expect(maintenance(s)).toBe(false);
  });

  // ---- Codex 監査12: 更新・ロールバックの状態の組み合わせ ----
  /*
   * 前提: 0.3.0 へ正常に更新済み（現行の組 = cur、各プロジェクトの直前の版の組 = prev）。0.4.0 への更新を、次の各時点で失敗させる
   *   準備の失敗応答 / 準備の通信例外 / コードの更新の失敗 / Admin の版の作成の失敗 / 同（自動ロールバックの Admin の切替も失敗）/
   *   移行の応答喪失 / 移行の通信例外
   * × 更新の開始前のメンテナンス（解除中 / 中）
   * 不変条件（失敗の直後。版の組は完全一致で検証する。Codex 監査13）:
   *   N1 メンテナンスが解除されているなら、実際の配備は cur か、この更新で作成した版の組（latest）のどちらかと完全に一致
   *   N2 開始前からメンテナンス中なら、メンテナンスを継続
   *   N3 移行の可能性がある失敗では、旧版へ自動で戻さず、実際の配備は latest と完全に一致し、メンテナンスを継続
   * 手動の「直前のバージョンに戻す」の後:
   *   M1 配備に着手した更新が残っている（自動ロールバックが完了していない・移行後）なら更新の開始時の組（cur）へ、
   *      そうでなければ各プロジェクトの直前の版の組（prev）へ戻る（どちらでも Staff・Admin は同じ世代）
   *   M2 開始前からメンテナンス中なら継続、そうでなければ解除
   * 注: モックの Core は常に現行のコードで動くため、「旧版の Core と新しい構造の DB」の組み合わせ自体は検証できない（N3 は配備の版で検証）
   */
  type Failure = 'prepareError' | 'prepareThrow' | 'uploadFail' | 'adminVersionFail' | 'adminVersionAndRollbackFail' | 'migrateDrop' | 'migrateThrow';
  const FAILURES: Array<{ f: Failure; migrated: boolean; manualTo: 'cur' | 'prev' }> = [
    { f: 'prepareError', migrated: false, manualTo: 'prev' },
    { f: 'prepareThrow', migrated: false, manualTo: 'prev' },
    { f: 'uploadFail', migrated: false, manualTo: 'prev' },
    { f: 'adminVersionFail', migrated: false, manualTo: 'prev' },
    { f: 'adminVersionAndRollbackFail', migrated: false, manualTo: 'cur' },
    { f: 'migrateDrop', migrated: true, manualTo: 'cur' },
    { f: 'migrateThrow', migrated: true, manualTo: 'cur' },
  ];
  for (const { f, migrated, manualTo } of FAILURES) {
    for (const mBefore of [false, true]) {
      it(`状態の組み合わせ: ${f} × 開始前のメンテナンス=${mBefore ? '中' : '解除中'}`, () => {
        const s = installed();
        const reg = () => s.store.reg!;
        const deployedPair = () => [reg().core, reg().admin].map((r) => s.api.projects.get(r.scriptId!)!.deployments.get(r.deploymentId!)!);
        s.deps.release = release('0.3.0');
        expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
        const cur = deployedPair();
        const prev = [reg().core.previousVersionNumber!, reg().admin.previousVersionNumber!];
        expect(prev.every((v) => typeof v === 'number')).toBe(true);
        expect(prev).not.toEqual(cur);
        if (mBefore) expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: `req_mx_${f}`.slice(0, 40) }, 'owner').ok).toBe(true);
        if (f === 'prepareError') failCopies(s);
        if (f === 'prepareThrow') s.throwOps.add('system.prepareUpdate');
        if (f === 'uploadFail') s.api.faults.putContent = 1;
        if (f === 'adminVersionFail') s.api.faults.scriptFail.set(reg().admin.scriptId!, 1);
        if (f === 'adminVersionAndRollbackFail') s.api.faults.scriptFail.set(reg().admin.scriptId!, 2);
        if (f === 'migrateDrop') s.dropOps.add('system.migrate');
        if (f === 'migrateThrow') s.throwOps.add('system.migrate');
        s.deps.release = release('0.4.0');
        expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);

        // 失敗の直後
        const after = deployedPair();
        // この更新で作成した版の組（各プロジェクトの最新の版。両方とも cur より新しい場合だけ組として扱う）
        const latestRaw = [reg().core, reg().admin].map((r) => s.api.projects.get(r.scriptId!)!.versions);
        const latest = latestRaw[0]! > cur[0]! && latestRaw[1]! > cur[1]! ? latestRaw : null;
        const eq = (x: number[], y: number[] | null) => !!y && x[0] === y[0] && x[1] === y[1];
        if (!maintenance(s)) expect(eq(after, cur) || eq(after, latest)).toBe(true); // N1
        if (mBefore) expect(maintenance(s)).toBe(true); // N2
        if (migrated) {
          // N3
          expect(maintenance(s)).toBe(true);
          expect(latest).not.toBeNull();
          expect(after).toEqual(latest);
        }

        // 手動の「直前のバージョンに戻す」
        s.make().rollbackCode();
        expect(deployedPair()).toEqual(manualTo === 'cur' ? cur : prev); // M1
        expect(maintenance(s)).toBe(mBefore); // M2
      });
    }
  }

  it('状態の組み合わせ: 初回の構築直後（戻せる版がない）の「直前のバージョンに戻す」は、メンテナンスを開始せずに中止する（解除中・中のどちらも変えない）', () => {
    for (const mBefore of [false, true]) {
      const s = installed();
      const coreRef = s.store.reg!.core;
      const before = s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!);
      if (mBefore) expect(handleRequest(s.core.be, { op: 'system.setMaintenance', args: { on: true }, requestId: 'req_mnt_fresh01' }, 'owner').ok).toBe(true);
      const msg = s.make().rollbackCode();
      expect(msg).toContain('戻せる版の組');
      expect(maintenance(s)).toBe(mBefore);
      expect(s.api.projects.get(coreRef.scriptId!)!.deployments.get(coreRef.deploymentId!)).toBe(before);
    }
  });

  it('状態の組み合わせ: 開始時の組へ戻した後にもう一度「直前のバージョンに戻す」を押すと、さらに前の組へ戻る（同じ世代のまま）', () => {
    const s = installed();
    const reg = () => s.store.reg!;
    const deployedPair = () => [reg().core, reg().admin].map((r) => s.api.projects.get(r.scriptId!)!.deployments.get(r.deploymentId!)!);
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
    const cur = deployedPair();
    const prev = [reg().core.previousVersionNumber!, reg().admin.previousVersionNumber!];
    s.api.faults.scriptFail.set(reg().admin.scriptId!, 2);
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(cur);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(prev);
    expect(maintenance(s)).toBe(false);
  });

  // ---- Codex 監査13: 版の組の履歴 ----
  /** 0.3.0 へ正常に更新した状態（cur = 0.3.0 の組、prev = 構築時の組） */
  const afterGoodUpdate = () => {
    const s = installed();
    const reg = () => s.store.reg!;
    const deployedPair = () => [reg().core, reg().admin].map((r) => s.api.projects.get(r.scriptId!)!.deployments.get(r.deploymentId!)!);
    const prev = deployedPair();
    s.deps.release = release('0.3.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
    const cur = deployedPair();
    expect(cur).not.toEqual(prev);
    return { s, reg, deployedPair, prev, cur };
  };

  it('Codex 監査13 #1: 移行後に手動ロールバックを 2 回（cur → prev）行ってから「更新を再開」すると、新しい版を配備し直して完了する（旧版のまま成功にしない）', () => {
    const { s, reg, deployedPair, prev, cur } = afterGoodUpdate();
    s.dropOps.add('system.migrate');
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(cur);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(prev);
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(true);
    const latest = [reg().core, reg().admin].map((x) => s.api.projects.get(x.scriptId!)!.versions);
    expect(deployedPair()).toEqual(latest);
    expect(deployedPair()).not.toEqual(prev);
    expect(deployedPair()).not.toEqual(cur);
  });

  it('Codex 監査13 #2: 旧形式の記録（版の組の履歴・今回配備した組の記録がない）では、開始時の組へ戻した後のさらに前への手動ロールバックを中止する（世代の混在で解除しない）', () => {
    const { s, reg, deployedPair, cur } = afterGoodUpdate();
    s.api.faults.scriptFail.set(reg().admin.scriptId!, 2);
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    // 以前の Setup が保存した形式を模す（pairs・deployed・startPrevious がない）
    delete (reg() as { pairs?: unknown }).pairs;
    delete (reg().update as { deployed?: unknown }).deployed;
    delete (reg().update as { startPrevious?: unknown }).startPrevious;
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(cur);
    expect(maintenance(s)).toBe(false);
    const msg = s.make().rollbackCode();
    expect(msg).toContain('戻せる版の組');
    expect(deployedPair()).toEqual(cur);
    expect(maintenance(s)).toBe(false);
  });

  it('状態の組み合わせ: 更新の開始前のメンテナンスの状態を確認できなかった場合は、自動・手動のロールバックの後もメンテナンスを継続する', () => {
    const { s, deployedPair, prev } = afterGoodUpdate();
    s.throwOps.add('system.info'); // 更新の開始時の状態の確認だけが失敗する
    s.api.faults.putContent = 1;
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    expect(s.store.reg!.update?.maintenanceBefore).toBeUndefined();
    expect(maintenance(s)).toBe(true);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(prev);
    expect(maintenance(s)).toBe(true);
  });

  it('状態の組み合わせ: DB の構造がプログラムと一致しない場合は、手動ロールバックで版の組がそろってもメンテナンスを解除しない', () => {
    const { s, reg, deployedPair, cur } = afterGoodUpdate();
    s.api.faults.scriptFail.set(reg().admin.scriptId!, 2);
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    const uow = new UnitOfWork(s.core.env.adapter, { now: () => Date.now(), newId: (p) => `${p}_${Math.random().toString(16).slice(2, 12)}` });
    const row = uow.list<{ id: string; key: string; value: string; version: number; createdAt: string; updatedAt: string }>('system_metadata').find((m) => m.key === 'schemaVersion')!;
    uow.update('system_metadata', { ...row, value: '99' });
    uow.flush();
    const msg = s.make().rollbackCode();
    expect(deployedPair()).toEqual(cur);
    expect(msg).toContain('一致しない');
    expect(maintenance(s)).toBe(true);
  });

  // ---- Codex 監査14 ----
  it('Codex 監査14 #1: 旧形式の記録（今回配備した組の記録がない）で、Admin の再配備だけが失敗した場合、片方だけ新しい組を配備済みとみなさず、再開で両方を配備し直す', () => {
    const { s, reg, deployedPair, cur } = afterGoodUpdate();
    s.dropOps.add('system.migrate');
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(cur);
    // 再配備で Admin の版の作成だけが失敗（移行の可能性があるため旧版へは戻さない）
    s.api.faults.scriptFail.set(reg().admin.scriptId!, 1);
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    // 以前の Setup が保存した形式を模す（今回配備した組の記録がない）
    delete (reg().update as { deployed?: unknown }).deployed;
    const mixed = deployedPair();
    expect(mixed[0]).not.toBe(cur[0]);
    expect(mixed[1]).toBe(cur[1]);
    const r = s.make().applyUpdate({ approveDestructive: false });
    expect(r.ok).toBe(true);
    const latest = [reg().core, reg().admin].map((x) => s.api.projects.get(x.scriptId!)!.versions);
    expect(deployedPair()).toEqual(latest);
    expect(deployedPair()[1]).not.toBe(cur[1]);
  });

  it('Codex 監査14 #2: 履歴の前の組へ戻す手動ロールバックで Admin の切替だけが失敗した場合、再試行で保存した戻し先の組にそろえて解除する（その間の更新は止める）', () => {
    const { s, reg, deployedPair, prev } = afterGoodUpdate();
    s.api.faults.scriptFail.set(reg().admin.scriptId!, 1);
    s.make().rollbackCode();
    expect(deployedPair()[0]).toBe(prev[0]);
    expect(deployedPair()[1]).not.toBe(prev[1]);
    expect(maintenance(s)).toBe(true);
    // 途中の間は更新を始めない
    s.deps.release = release('0.4.0');
    const u = s.make().applyUpdate({ approveDestructive: false });
    expect(u.ok).toBe(false);
    expect(u.message).toContain('完了していません');
    // 再試行（障害は解消）
    const msg = s.make().rollbackCode();
    expect(deployedPair()).toEqual(prev);
    expect(msg).toContain('メンテナンスを解除しました');
    expect(maintenance(s)).toBe(false);
    expect(reg().pendingRollback ?? null).toBeNull();
  });

  it('Codex 監査14 #3: 旧形式の Registry（版の組の履歴がない）から新しい Setup で更新を始め、配備の前に失敗しても、手動ロールバックで直前の組へ戻せる', () => {
    const { s, reg, deployedPair, prev } = afterGoodUpdate();
    // 以前の Setup（v1.2 など）が保存した形式を模す（履歴がない。両方の「直前の版」は前回の更新でそろって記録済み）
    delete (reg() as { pairs?: unknown }).pairs;
    expect([reg().core.previousVersionNumber, reg().admin.previousVersionNumber]).toEqual(prev);
    s.throwOps.add('system.prepareUpdate');
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(false);
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(prev);
    expect(maintenance(s)).toBe(false);
  });

  // ---- Codex 監査15 ----
  it('Codex 監査15: 前の組へ戻す手動ロールバックがメンテナンスの開始の失敗（切替の前）で中止された場合、戻し先を残さず、その後の更新を止めない', () => {
    const { s, reg, deployedPair, cur } = afterGoodUpdate();
    const orig = s.deps.callCoreAsSetup;
    let failed = false;
    s.deps.callCoreAsSetup = (url, key, req) => {
      const r = req as { op: string; args?: { on?: boolean } };
      if (!failed && r.op === 'system.setMaintenance' && r.args?.on === true) {
        failed = true;
        return { ok: false, error: { code: 'CONFLICT', message: '一時的に処理できません' } } as never;
      }
      return orig(url, key, req);
    };
    const msg = s.make().rollbackCode();
    expect(msg).toContain('メンテナンスを開始できなかった');
    expect(deployedPair()).toEqual(cur);
    expect(maintenance(s)).toBe(false);
    expect(reg().pendingRollback ?? null).toBeNull();
    // 障害の解消後、そのまま更新できる
    s.deps.release = release('0.4.0');
    expect(s.make().applyUpdate({ approveDestructive: false }).ok).toBe(true);
    const latest = [reg().core, reg().admin].map((x) => s.api.projects.get(x.scriptId!)!.versions);
    expect(deployedPair()).toEqual(latest);
  });

  // ---- Codex 監査16・D-024（迷ったら止める） ----
  it('Codex 監査16・D-024: 前の組へ戻す途中で記録の保存が例外になった場合、例外を返さずに中止し、メンテナンスを継続したまま状態を返す（再実行で復旧できる）', () => {
    const { s, deployedPair, prev, cur } = afterGoodUpdate();
    const orig = s.deps.save;
    let thrown = false;
    s.deps.save = (r, sec) => {
      if (!thrown && (r as { pendingRollback?: unknown }).pendingRollback) {
        thrown = true;
        throw new Error('Drive への保存に失敗しました');
      }
      return orig(r, sec);
    };
    let msg = '';
    expect(() => {
      msg = s.make().rollbackCode();
    }).not.toThrow();
    expect(msg).toContain('想定外のエラー');
    expect(msg).toContain(`Staff v${cur[0]}／Admin v${cur[1]}`);
    // 切替はしていない。迷ったら止める（メンテナンスは解除しない）
    expect(deployedPair()).toEqual(cur);
    expect(maintenance(s)).toBe(true);
    // 障害の解消後の再実行で、前の組へ戻して解除する
    s.make().rollbackCode();
    expect(deployedPair()).toEqual(prev);
    expect(maintenance(s)).toBe(false);
  });

  it('D-024: 更新の失敗の後始末で記録の保存が例外になった場合も、例外を返さずに中止し、状態を返す', () => {
    const { s } = afterGoodUpdate();
    s.api.faults.putContent = 1; // コードの更新が失敗 → 自動ロールバック → 失敗の記録を保存
    const orig = s.deps.save;
    let thrown = false;
    s.deps.save = (r, sec) => {
      if (!thrown && (r as { update?: { stage?: string } }).update?.stage === 'failed') {
        thrown = true;
        throw new Error('UserProperties への保存に失敗しました');
      }
      return orig(r, sec);
    };
    s.deps.release = release('0.4.0');
    let res: { ok: boolean; message: string } = { ok: true, message: '' };
    expect(() => {
      res = s.make().applyUpdate({ approveDestructive: false });
    }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('想定外のエラー');
  });

  // ---- Codex 監査17 #3 ----
  it('Codex 監査17 #3: 初回の構築で Web アプリのデプロイの作成の応答が失われても、再開で既存のデプロイを照合して使い、二重に作らない', () => {
    const s = setup();
    s.api.faults.loseCreateDeployment = 1;
    const r1 = s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(r1.error?.step).toBe('core.deploy');
    const r2 = s.make().runUntilBlocked({}, 20);
    expect(r2.error).toBeNull();
    const coreRef = s.store.reg!.core;
    const deps = s.api.projects.get(coreRef.scriptId!)!.deployments;
    expect(deps.size).toBe(1);
    expect(deps.has(coreRef.deploymentId!)).toBe(true);
    expect(coreRef.deployingAt).toBeUndefined();
  });

  it('Codex 監査18（次の版の前）: 応答を失ったデプロイを再利用した場合も、実際のデプロイの版と Setup の記録の版が一致する', () => {
    const s = setup();
    s.api.faults.loseCreateDeployment = 1;
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(s.make().runUntilBlocked({}, 20).error).toBeNull();
    // この時点では Staff（core）までが配備済み（Admin は手動の承認の後に作られる）
    const ref = s.store.reg!.core;
    expect(ref.versionNumber).toBeDefined();
    expect(s.api.projects.get(ref.scriptId!)!.deployments.get(ref.deploymentId!)).toBe(ref.versionNumber);
  });

  it('Codex 監査17 #3: 照合で同じ説明のデプロイが複数見つかった場合は、自動で選ばずに作成を止めて確認を案内する', () => {
    const s = setup();
    s.api.faults.loseCreateDeployment = 1;
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    // 同じ説明のデプロイがもう一つある状態（手動の操作など）
    const coreRef = s.store.reg!.core;
    const proj = s.api.projects.get(coreRef.scriptId!)!;
    const [did, v] = [...proj.deployments.entries()][0]!;
    proj.deployments.set(`${did}_dup`, v);
    s.api.descriptions.set(`${did}_dup`, s.api.descriptions.get(did)!);
    const r = s.make().runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('core.deploy');
    expect(r.error?.fix).toContain('デプロイを管理');
    expect(proj.deployments.size).toBe(2);
  });

  // ---- Codex 監査19 #2: プロジェクトの作成の失敗の種類ごとの扱い（指摘の再現だけでなく、失敗の種類の全体を網羅する） ----
  /*
   * 不変条件:
   *   P1 Google が要求を拒否したこと（4xx）が分かる失敗は「作成されていない」。確認の案内を出さず、確認なしの再実行で 1 つだけ作成する
   *   P2 作成されたかどうか分からない失敗（通信の例外・5xx・応答の喪失）は、最初の失敗から確認の案内（confirm）を出す
   *   P3 P2 の後、確認の明示がない再実行では作成しない（目印を残し、再び案内する）
   *   P4 P2 の後、一覧で確認・整理したうえで確認を明示した再実行では、同名のプロジェクトはちょうど 1 つになる
   */
  const staffProjects = (s: ReturnType<typeof setup>) => [...s.api.projects.entries()].filter(([, p]) => p.title.startsWith('Shiftly-Staff'));
  const CREATE_FAILURES: Array<{ name: string; fault: { status: number; created: boolean } | 'throw' | 'noid'; unknown: boolean }> = [
    { name: '400（不正な要求）', fault: { status: 400, created: false }, unknown: false },
    { name: '403（権限なし）', fault: { status: 403, created: false }, unknown: false },
    { name: '429（利用上限）', fault: { status: 429, created: false }, unknown: false },
    { name: '500（内部エラー）', fault: { status: 500, created: false }, unknown: true },
    { name: '503（一時的に利用不可）', fault: { status: 503, created: false }, unknown: true },
    { name: '504（作成済みで応答だけ喪失）', fault: { status: 504, created: true }, unknown: true },
    { name: '通信の例外（作成されていない）', fault: 'throw', unknown: true },
    { name: '成功（2xx）だが応答に ID がない（作成済み。独立した点検 S1-2）', fault: 'noid', unknown: true },
  ];
  for (const { name, fault, unknown } of CREATE_FAILURES) {
    it(`作成の失敗の種類: ${name}`, () => {
      const s = setup();
      s.api.faults.createProject.push(fault);
      const r1 = s.make().runUntilBlocked({ storeName: '店' }, 20);
      expect(r1.error?.step).toBe('core.create');
      if (!unknown) {
        // P1
        expect(r1.error?.confirm).toBeUndefined();
        const inst = s.make();
        inst.retry('core.create');
        inst.runUntilBlocked({}, 20);
        expect(staffProjects(s)).toHaveLength(1);
        return;
      }
      // P2
      expect(r1.error?.confirm).toBeTruthy();
      expect(r1.error?.fix).toContain('script.google.com/home');
      // P3: 確認の明示がない再実行では作成しない
      const before = staffProjects(s).length;
      const inst1 = s.make();
      inst1.retry('core.create');
      const r2 = inst1.runUntilBlocked({}, 20);
      expect(r2.error?.step).toBe('core.create');
      expect(r2.error?.confirm).toBeTruthy();
      expect(staffProjects(s)).toHaveLength(before);
      // P4: 一覧で確認し、作成されていたものはゴミ箱へ移動してから、確認を明示して再実行
      for (const [id] of staffProjects(s)) s.api.projects.delete(id);
      const inst2 = s.make();
      inst2.retry('core.create', true);
      inst2.runUntilBlocked({}, 20);
      expect(staffProjects(s)).toHaveLength(1);
    });
  }

  it('作成の失敗の種類: 作成の要求の前に中断した（目印だけが残った）場合も、確認の明示なしでは作成せず、案内を出す', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 1); // 店舗名の保存など、作成の前で止める
    // 作成の要求の直前で中断した状態（目印だけがあり、案内はまだ出していない）
    s.store.reg!.core = { title: `Shiftly-Staff (${s.store.reg!.envId})`, creatingAt: new Date().toISOString() };
    const r = s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(r.error?.step).toBe('core.create');
    expect(r.error?.confirm).toBeTruthy();
    expect(staffProjects(s)).toHaveLength(0);
  });

  // ---- 独立した点検 S1-1・S1-2: デプロイの作成の失敗の種類ごとの扱い（プロジェクトと同じ不変条件 D1〜D4） ----
  /*
   * 不変条件:
   *   D1 Google が要求を拒否したこと（4xx）が分かる失敗は「作成されていない」。確認の案内を出さず、確認なしの再実行で 1 つだけ作成する
   *   D2 作成されたかどうか分からない失敗（通信の例外・5xx・応答の喪失・ID のない成功応答）は、最初の失敗から確認の案内（confirm）を出す
   *   D3 D2 の後、作成されていて一覧に現れれば、確認なしの再実行でそれを使う（作らない）。一覧に現れなければ、確認の明示なしでは作らない
   *   D4 D2 の後、確認を明示した再実行では、最初の要求と同じ説明で 1 つだけ作成する
   */
  const coreDeps = (s: ReturnType<typeof setup>) => s.api.projects.get(s.store.reg!.core.scriptId!)!.deployments;
  const DEPLOY_FAILURES: Array<{ name: string; fault: { status: number; created: boolean } | 'throw' | 'noid'; unknown: boolean; created: boolean }> = [
    { name: '400（不正な要求）', fault: { status: 400, created: false }, unknown: false, created: false },
    { name: '403（権限なし）', fault: { status: 403, created: false }, unknown: false, created: false },
    { name: '429（利用上限）', fault: { status: 429, created: false }, unknown: false, created: false },
    { name: '500（内部エラー）', fault: { status: 500, created: false }, unknown: true, created: false },
    { name: '503（一時的に利用不可）', fault: { status: 503, created: false }, unknown: true, created: false },
    { name: '504（作成済みで応答だけ喪失）', fault: { status: 504, created: true }, unknown: true, created: true },
    { name: '通信の例外（作成されていない）', fault: 'throw', unknown: true, created: false },
    { name: '成功（2xx）だが応答に ID がない（作成済み）', fault: 'noid', unknown: true, created: true },
  ];
  for (const { name, fault, unknown, created } of DEPLOY_FAILURES) {
    it(`デプロイの作成の失敗の種類: ${name}`, () => {
      const s = setup();
      s.api.faults.createDeployment.push(fault);
      const r1 = s.make().runUntilBlocked({ storeName: '店' }, 20);
      expect(r1.error?.step).toBe('core.deploy');
      if (!unknown) {
        // D1
        expect(r1.error?.confirm).toBeUndefined();
        const inst = s.make();
        inst.retry('core.deploy');
        expect(inst.runUntilBlocked({}, 20).error).toBeNull();
        expect(coreDeps(s).size).toBe(1);
        return;
      }
      // D2
      expect(r1.error?.confirm).toBeTruthy();
      expect(r1.error?.fix).toContain('デプロイを管理');
      const desc = s.store.reg!.core.deployingDescription!;
      expect(desc).toBeTruthy();
      if (created) {
        // D3（作成済み）: 確認なしの再実行で、一覧で見つけて使う
        const r2 = s.make().runUntilBlocked({}, 20);
        expect(r2.error).toBeNull();
        expect(coreDeps(s).size).toBe(1);
        expect(coreDeps(s).has(s.store.reg!.core.deploymentId!)).toBe(true);
        return;
      }
      // D3（作成されていない）: 確認の明示がない再実行（「再実行」・画面の再読み込みからの続行の両方）では作らない
      const inst1 = s.make();
      inst1.retry('core.deploy');
      const r2 = inst1.runUntilBlocked({}, 20);
      expect(r2.error?.step).toBe('core.deploy');
      expect(r2.error?.confirm).toBeTruthy();
      expect(s.make().runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
      expect(coreDeps(s).size).toBe(0);
      // D4: 確認を明示した再実行で、同じ説明で 1 つだけ作る
      const inst2 = s.make();
      inst2.retry('core.deploy', true);
      expect(inst2.runUntilBlocked({}, 20).error).toBeNull();
      expect(coreDeps(s).size).toBe(1);
      expect(s.api.descriptions.get(s.store.reg!.core.deploymentId!)).toBe(desc);
    });
  }

  it('デプロイの作成: 作成済みだが一覧への反映が遅れている間は、確認の明示なしに作らず、反映された後にそれを使う', () => {
    const s = setup();
    s.api.faults.createDeployment.push({ status: 504, created: true });
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.api.faults.listLag = 1;
    const r2 = s.make().runUntilBlocked({}, 20);
    expect(r2.error?.confirm).toBeTruthy();
    expect(coreDeps(s).size).toBe(1);
    const r3 = s.make().runUntilBlocked({}, 20);
    expect(r3.error).toBeNull();
    expect(coreDeps(s).size).toBe(1);
  });

  it('デプロイの作成: 目印だけが残り説明の記録がない場合も、確認の明示なしでは作らない', () => {
    const s = setup();
    s.api.faults.createDeployment.push({ status: 400, created: false });
    s.make().runUntilBlocked({ storeName: '店' }, 20); // core.deploy の手前まで進める（400 は目印を外す）
    s.store.reg!.core = { ...s.store.reg!.core, deployingAt: new Date().toISOString(), deployingDescription: undefined };
    const r = s.make().runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('core.deploy');
    expect(r.error?.confirm).toBeTruthy();
    expect(coreDeps(s).size).toBe(0);
  });

  // ---- Codex 監査22 #4: 記録しているデプロイが照会で見つからない場合（一時的な 404・実際に削除された場合） ----
  for (const kind of ['一時的な 404（実際はある）', '実際に削除された'] as const) {
    it(`記録しているデプロイの照会: ${kind} 場合、確認の明示なしでは新しく作らない`, () => {
      const s = setup();
      s.api.faults.omitDeployVersion = 'all'; // デプロイは作成・記録したが、版を確かめられずに止まった状態にする
      expect(s.make().runUntilBlocked({ storeName: '店' }, 20).error?.step).toBe('core.deploy');
      s.api.faults.omitDeployVersion = '';
      const deps = coreDeps(s);
      expect(deps.size).toBe(1);
      const recorded = s.store.reg!.core.deploymentId!;
      expect(deps.has(recorded)).toBe(true);
      if (kind === '実際に削除された') deps.delete(recorded);
      else s.api.faults.getDeployment404 = 1;
      const inst = s.make();
      inst.retry('core.deploy');
      const r = inst.runUntilBlocked({}, 20);
      expect(r.error?.step).toBe('core.deploy');
      expect(r.error?.confirm).toBeTruthy();
      expect(deps.size).toBe(kind === '実際に削除された' ? 0 : 1);
      if (kind === '一時的な 404（実際はある）') {
        // 確認の明示なしの再実行（照会が回復）で、記録しているデプロイを使う
        const i2 = s.make();
        i2.retry('core.deploy');
        expect(i2.runUntilBlocked({}, 20).error).toBeNull();
        expect(deps.size).toBe(1);
        expect(s.store.reg!.core.deploymentId).toBe(recorded);
        return;
      }
      // 確認の明示なしでは作らない
      const i2 = s.make();
      i2.retry('core.deploy');
      expect(i2.runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
      expect(deps.size).toBe(0);
      // 確認を明示した再実行で 1 つだけ作る
      const i3 = s.make();
      i3.retry('core.deploy', true);
      expect(i3.runUntilBlocked({}, 20).error).toBeNull();
      expect(deps.size).toBe(1);
    });
  }

  // ---- Codex 監査19（次の版の前）: デプロイの応答に版の番号がない場合 ----
  it('デプロイの作成の応答に版の番号がなくても、照会で実際の版を確かめて記録する', () => {
    const s = setup();
    s.api.faults.omitDeployVersion = 'response';
    expect(s.make().runUntilBlocked({ storeName: '店' }, 20).error).toBeNull();
    const ref = s.store.reg!.core;
    expect(ref.versionNumber).toBeDefined();
    expect(s.api.projects.get(ref.scriptId!)!.deployments.get(ref.deploymentId!)).toBe(ref.versionNumber);
  });

  it('デプロイの版を応答・照会のどちらでも確かめられない場合は、記録せずに止める', () => {
    const s = setup();
    s.api.faults.omitDeployVersion = 'all';
    const r = s.make().runUntilBlocked({ storeName: '店' }, 20);
    expect(r.error?.step).toBe('core.deploy');
    expect(r.error?.message).toContain('版を確認できません');
    expect(s.store.reg!.core.versionNumber).toBeUndefined();
  });
});

/**
 * D-026 S1: 初回の構築の外部の作成物（Staff・Admin のプロジェクト・Web アプリのデプロイ）の共通の状態管理を、
 * 作成物 × 失敗の地点 × 再実行 の組み合わせで確かめる。判定は偽 API が持つ作成物の件数（実体）で行い、エラーの応答だけでは判定しない
 *   不変条件: どの組み合わせでも、作成物は最終的にちょうど 1 つ（二重に作らない）。結果が分からない間は、確認の明示・関連付けがあるまで作らない
 */
describe('S1: 作成物 × 失敗の地点 × 再実行の組み合わせ（D-026）', () => {
  type S = ReturnType<typeof setup>;
  const projectsOf = (s: S, which: 'core' | 'admin') => [...s.api.projects.entries()].filter(([, p]) => p.title.startsWith(which === 'core' ? 'Shiftly-Staff' : 'Shiftly-Admin'));
  const depsOf = (s: S, which: 'core' | 'admin') => {
    const p = projectsOf(s, which);
    return p.length === 1 ? p[0]![1].deployments : new Map();
  };
  const ref = (s: S, which: 'core' | 'admin') => s.store.reg![which];
  /** 対象の工程の直前まで進める（admin は Staff の権限承認の後） */
  const advanceTo = (s: S, which: 'core' | 'admin') => {
    const r = s.make().runUntilBlocked({ storeName: '店' }, 20);
    if (which === 'admin') {
      s.core.authorize();
      return s.make().runUntilBlocked({}, 20);
    }
    return r;
  };
  /** 構築を最後まで進める（Admin の接続を含む） */
  const finish = (s: S) => {
    let r = s.make().runUntilBlocked({}, 20);
    if (r.waitingFor?.step === 'core.authorize') {
      s.core.authorize();
      r = s.make().runUntilBlocked({}, 20);
    }
    if (r.waitingFor?.step === 'admin.authorize') {
      const bs = projectsOf(s, 'admin')[0]![1].files.find((f) => f.name === 'bootstrap')!;
      s.core.post({ kind: 'pair', role: 'admin', pairingCode: JSON.parse(bs.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode });
      r = s.make().runUntilBlocked({}, 20);
    }
    return r;
  };
  /** Setup の入口（setupApi）と同じく、工程の外に出た例外も失敗の応答として受け止める */
  const run = (s: S, input: { storeName?: string } = {}) => {
    try {
      return s.make().runUntilBlocked(input, 20);
    } catch (e) {
      return { state: null, waitingFor: null, error: { step: 'unknown', message: e instanceof Error ? e.message : String(e), fix: '' } } as unknown as ReturnType<Installer['runUntilBlocked']>;
    }
  };
  /** 記録の保存を失敗させる（条件に合う保存を n 回） */
  const failSaves = (s: S, when: (reg: Registry) => boolean, n: number) => {
    const orig = s.deps.save;
    let left = n;
    s.deps.save = (reg, sec) => {
      if (left > 0 && when(reg)) {
        left--;
        throw new Error('記録の保存に失敗しました（模擬）');
      }
      orig(reg, sec);
    };
  };

  for (const which of ['core', 'admin'] as const) {
    const step = `${which}.create` as const;
    describe(`${which === 'core' ? 'Staff' : 'Admin'} のプロジェクト`, () => {
      it('作成の要求の前の記録（目印）の保存に失敗: 作成を要求しない。以後も確認の明示まで作らず、確認の後に 1 つだけ作る', () => {
        const s = setup();
        if (which === 'admin') advanceTo(s, 'core');
        failSaves(s, (r) => !!r[which].creatingAt, 1);
        const r1 = which === 'admin' ? (s.core.authorize(), s.make().runUntilBlocked({}, 20)) : s.make().runUntilBlocked({ storeName: '店' }, 20);
        expect(r1.error?.step).toBe(step);
        expect(projectsOf(s, which)).toHaveLength(0);
        const r2 = s.make().runUntilBlocked({}, 20);
        expect(projectsOf(s, which)).toHaveLength(0);
        if (r2.error?.confirm) {
          const i = s.make();
          i.retry(step, true);
          i.runUntilBlocked({}, 20);
        }
        expect(projectsOf(s, which)).toHaveLength(1);
      });

      for (const saveFails of [1, 2] as const) {
        it(`作成は成功したが、ID の記録の保存に失敗（${saveFails === 1 ? '1 回' : '同じ実行の中で続けて失敗し、目印の状態のまま'}）: 二重に作らず、関連付けで再開できる`, () => {
          const s = setup();
          if (which === 'admin') advanceTo(s, 'core');
          failSaves(s, (r) => !!r[which].scriptId, saveFails);
          if (which === 'admin') s.core.authorize();
          run(s, which === 'core' ? { storeName: '店' } : {});
          expect(projectsOf(s, which)).toHaveLength(1);
          const r2 = run(s);
          expect(projectsOf(s, which)).toHaveLength(1);
          if (!ref(s, which).scriptId) {
            // 記録に ID がない（目印のまま）: 確認を案内し、所有者が一覧で見つけた ID を関連付ける
            expect(r2.error?.step).toBe(step);
            expect(r2.error?.confirm).toBeTruthy();
            const created = projectsOf(s, which)[0]![0];
            expect(s.make().attach(step, 'bad id').ok).toBe(false);
            let att: { ok: boolean; message: string };
            try {
              att = s.make().attach(step, created);
            } catch (e) {
              att = { ok: false, message: `例外: ${e instanceof Error ? e.message : String(e)}` };
            }
            expect(att.message).toContain('関連付けました');
            expect(att.ok).toBe(true);
          }
          finish(s);
          expect(projectsOf(s, which)).toHaveLength(1);
          expect(ref(s, which).scriptId).toBe(projectsOf(s, which)[0]![0]);
        });
      }

      it('作成と ID の記録は成功し、工程の完了の記録の保存に失敗: 再実行で記録の ID を使い、作らない', () => {
        const s = setup();
        if (which === 'admin') advanceTo(s, 'core');
        failSaves(s, (r) => r.steps[step]?.status === 'done', 1);
        if (which === 'admin') s.core.authorize();
        s.make().runUntilBlocked(which === 'core' ? { storeName: '店' } : {}, 20);
        finish(s);
        expect(projectsOf(s, which)).toHaveLength(1);
      });

      for (const kind of ['一時的な 404（実際はある）', '実際に削除された'] as const) {
        it(`記録しているプロジェクトの照会: ${kind} → 確認の明示なしでは作らない（Codex 監査23 #4）`, () => {
          const s = setup();
          if (which === 'admin') advanceTo(s, 'core');
          if (which === 'admin') s.core.authorize();
          s.make().runUntilBlocked(which === 'core' ? { storeName: '店' } : {}, 20);
          const id = ref(s, which).scriptId!;
          expect(id).toBeTruthy();
          // 工程を「失敗」にして作成の工程からやり直す状態を作る（記録の ID はそのまま）
          s.store.reg!.steps[step] = { status: 'error', at: new Date().toISOString() };
          if (kind === '実際に削除された') s.api.projects.delete(id);
          else s.api.faults.getProject404 = 1;
          const before = projectsOf(s, which).length;
          const i1 = s.make();
          i1.retry(step);
          const r = i1.runUntilBlocked({}, 20);
          expect(r.error?.step).toBe(step);
          expect(r.error?.confirm).toBeTruthy();
          expect(projectsOf(s, which)).toHaveLength(before);
          if (kind === '一時的な 404（実際はある）') {
            finish(s); // 照会が回復: 記録のプロジェクトを使う
            expect(projectsOf(s, which)).toHaveLength(1);
            expect(ref(s, which).scriptId).toBe(id);
            return;
          }
          const i2 = s.make();
          i2.retry(step); // 確認の明示なし
          expect(i2.runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
          expect(projectsOf(s, which)).toHaveLength(0);
          const i3 = s.make();
          i3.retry(step, true);
          finish(s);
          expect(projectsOf(s, which)).toHaveLength(1);
        });
      }
    });

    describe(`${which === 'core' ? 'Staff' : 'Admin'} のデプロイ`, () => {
      const dstep = `${which}.deploy` as const;
      for (const saveFails of [1, 3] as const) {
        it(`作成は成功したが、ID の記録の保存に失敗（${saveFails} 回）: 一覧で照合して使い、二重に作らない`, () => {
          const s = setup();
          if (which === 'admin') advanceTo(s, 'core');
          failSaves(s, (r) => !!r[which].deploymentId, saveFails);
          if (which === 'admin') s.core.authorize();
          run(s, which === 'core' ? { storeName: '店' } : {});
          expect(depsOf(s, which).size).toBe(1);
          finish(s);
          expect(depsOf(s, which).size).toBe(1);
          expect(depsOf(s, which).has(ref(s, which).deploymentId!)).toBe(true);
        });
      }
      it('作成は成功したが応答を失い、一覧にもまだ現れない: 確認の明示なしでは作らず、関連付けで再開できる', () => {
        const s = setup();
        if (which === 'admin') advanceTo(s, 'core');
        s.api.faults.createDeployment.push({ status: 504, created: true });
        if (which === 'admin') s.core.authorize();
        const r1 = s.make().runUntilBlocked(which === 'core' ? { storeName: '店' } : {}, 20);
        expect(r1.error?.step).toBe(dstep);
        s.api.faults.listLag = 3;
        expect(s.make().runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
        expect(depsOf(s, which).size).toBe(1);
        const created = [...depsOf(s, which).keys()][0]!;
        expect(s.make().attach(dstep, created).ok).toBe(true);
        s.api.faults.listLag = 0;
        finish(s);
        expect(depsOf(s, which).size).toBe(1);
        expect(ref(s, which).deploymentId).toBe(created);
      });
    });
  }

  it('関連付け: 別の環境・名前のプロジェクトや、Shiftly のセットアップが作っていないデプロイは関連付けない', () => {
    const s = setup();
    s.api.faults.createProject.push({ status: 504, created: true });
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.api.projects.set('script_other_1', { title: 'Shiftly-Staff (env_other)', files: [], versions: 0, deployments: new Map() });
    expect(s.make().attach('core.create', 'script_other_1').ok).toBe(false);
    expect(s.make().attach('verify', 'script_other_1').ok).toBe(false);
  });

  it('構築の完了前の検証: 記録と一致しない Shiftly のデプロイが残っていれば完了しない（自動では削除しない）', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    const [, proj] = projectsOf(s, 'core')[0]!;
    const [did, v] = [...proj.deployments.entries()][0]!;
    proj.deployments.set(`${did}_extra`, v);
    s.api.descriptions.set(`${did}_extra`, 'Shiftly 0.3.0 (手動で作成)');
    const r = finish(s);
    expect(r.error?.step).toBe('verify');
    expect(r.error?.message).toContain('デプロイが 2 つ');
    expect(r.state.complete).toBe(false);
    expect(proj.deployments.size).toBe(2);
  });

  it('構築の完了前の検証: 自動で確かめた項目と、自動では確かめられない項目（プロジェクトの重複）を分けて記録する', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    const r = finish(s);
    expect(r.state.complete).toBe(true);
    expect(r.state.verification!.checked.length).toBeGreaterThanOrEqual(4);
    expect(r.state.verification!.unverified.join()).toContain('プロジェクト一覧');
  });
});
