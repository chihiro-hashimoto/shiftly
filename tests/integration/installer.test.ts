/**
 * Shiftly Setup インストーラーの統合テスト
 * Apps Script API はフェイク、Core はメモリ上のモック（doPost 相当の振る舞いを再現）
 */
import { describe, expect, it } from 'vitest';
import { AppsScriptApi, type Http, type ScriptFile } from '../../src/setup/apps-script-api';
import { Installer, type InstallerDeps, type Registry, type SecretRegistry, type ReleaseBundle } from '../../src/setup/installer';
import { createMockEnv } from '../../src/backend/mock';
import { handleRequest, signOwnerEnvelope, verifyEnvelope, SECRET_KEYS } from '../../src/backend/index';
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
  /** Google ドライブの Setup の記録ファイルの点検の結果（テストで問題を注入する。既定は問題なし。実環境の点検は src/gas/setup.ts） */
  const registryIssues: string[] = [];
  const deps: InstallerDeps = {
    registryReport: () => ({ ok: registryIssues.length === 0, issues: [...registryIssues] }),
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
  return { api, store, core, deps, dropOps, throwOps, registryIssues, make: () => new Installer(deps) };
}

/**
 * 構築の完了前の所有者の確認（D-027。Codex 監査24 A4 による仕様変更）: 自動では確かめられないプロジェクトの重複を、所有者が確認したと
 * 明示する（確認の工程の案内に、確認のチェックを付けて「再実行」する操作）。完了を確かめるテストは、この操作を入力として追加する
 */
function confirmProjects(s: { make: () => Installer }, r: ReturnType<Installer['runUntilBlocked']>) {
  if (r.error?.step !== 'verify' || !r.error.confirm) return r;
  const inst = s.make();
  inst.retry('verify', true);
  return inst.runUntilBlocked({}, 20);
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
    r = confirmProjects(s, s.make().runUntilBlocked({}, 20));
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
    r = confirmProjects(s, inst.runUntilBlocked({}, 20));
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
    expect(confirmProjects(s, inst2.runUntilBlocked({}, 20)).state.complete).toBe(true);
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
    // 許可リスト（400・401・403・429）以外の 4xx は、作成済みかどうか分からないものとして扱う（D-026 の独立した点検 #1）
    { name: '401（認証されていない）', fault: { status: 401, created: false }, unknown: false },
    { name: '404（作成済み）', fault: { status: 404, created: true }, unknown: true },
    { name: '409（作成済み）', fault: { status: 409, created: true }, unknown: true },
    { name: '410（作成されていない）', fault: { status: 410, created: false }, unknown: true },
    { name: '499（取消。作成済み）', fault: { status: 499, created: true }, unknown: true },
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
    { name: '401（認証されていない）', fault: { status: 401, created: false }, unknown: false, created: false },
    { name: '404（作成済み）', fault: { status: 404, created: true }, unknown: true, created: true },
    { name: '409（作成済み）', fault: { status: 409, created: true }, unknown: true, created: true },
    { name: '410（作成されていない）', fault: { status: 410, created: false }, unknown: true, created: false },
    { name: '499（取消。作成済み）', fault: { status: 499, created: true }, unknown: true, created: true },
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
    return confirmProjects(s, r);
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
      it('作成の要求の前の記録（目印）の保存に失敗: 作成を要求しない。以後も確認の明示まで作らず、確認の後に 1 つだけ作る', () => {
        const s = setup();
        if (which === 'admin') advanceTo(s, 'core');
        failSaves(s, (r) => !!r[which].deployingAt, 1);
        if (which === 'admin') s.core.authorize();
        const r1 = run(s, which === 'core' ? { storeName: '店' } : {});
        expect(r1.error?.step).toBe(dstep);
        expect(depsOf(s, which).size).toBe(0);
        const r2 = run(s);
        expect(depsOf(s, which).size).toBe(0);
        if (r2.error?.confirm) {
          const i = s.make();
          i.retry(dstep, true);
          i.runUntilBlocked({}, 20);
        }
        expect(finish(s).state.complete).toBe(true);
        expect(depsOf(s, which).size).toBe(1);
      });
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

  // Admin のプロジェクト・デプロイでも、作成の失敗の種類を Staff と同じく回す（Staff は「作成の失敗の種類」「デプロイの作成の失敗の種類」）
  const KINDS: Array<{ name: string; fault: { status: number; created: boolean } | 'throw' | 'noid'; unknown: boolean; created: boolean }> = [
    { name: '400', fault: { status: 400, created: false }, unknown: false, created: false },
    { name: '403', fault: { status: 403, created: false }, unknown: false, created: false },
    { name: '429', fault: { status: 429, created: false }, unknown: false, created: false },
    { name: '500', fault: { status: 500, created: false }, unknown: true, created: false },
    { name: '503', fault: { status: 503, created: false }, unknown: true, created: false },
    { name: '504（作成済み）', fault: { status: 504, created: true }, unknown: true, created: true },
    { name: '通信の例外', fault: 'throw', unknown: true, created: false },
    { name: '2xx で ID なし（作成済み）', fault: 'noid', unknown: true, created: true },
    { name: '401', fault: { status: 401, created: false }, unknown: false, created: false },
    { name: '404（作成済み）', fault: { status: 404, created: true }, unknown: true, created: true },
    { name: '409（作成済み）', fault: { status: 409, created: true }, unknown: true, created: true },
    { name: '499（取消。作成済み）', fault: { status: 499, created: true }, unknown: true, created: true },
  ];
  for (const k of KINDS) {
    it(`Admin のプロジェクトの作成の失敗: ${k.name}`, () => {
      const s = setup();
      advanceTo(s, 'core');
      s.api.faults.createProject.push(k.fault);
      s.core.authorize();
      const r1 = run(s);
      expect(r1.error?.step).toBe('admin.create');
      expect(!!r1.error?.confirm).toBe(k.unknown);
      if (k.unknown) {
        const i = s.make();
        i.retry('admin.create'); // 確認の明示なし
        expect(i.runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
        expect(projectsOf(s, 'admin')).toHaveLength(k.created ? 1 : 0);
        if (k.created) expect(s.make().attach('admin.create', projectsOf(s, 'admin')[0]![0]).ok).toBe(true);
        else {
          const j = s.make();
          j.retry('admin.create', true);
          j.runUntilBlocked({}, 20);
        }
      } else {
        const i = s.make();
        i.retry('admin.create');
        i.runUntilBlocked({}, 20);
      }
      expect(finish(s).state.complete).toBe(true);
      expect(projectsOf(s, 'admin')).toHaveLength(1);
    });
    it(`Admin のデプロイの作成の失敗: ${k.name}`, () => {
      const s = setup();
      advanceTo(s, 'core');
      s.api.faults.createDeployment.push(k.fault);
      s.core.authorize();
      const r1 = run(s);
      expect(r1.error?.step).toBe('admin.deploy');
      expect(!!r1.error?.confirm).toBe(k.unknown);
      if (k.unknown && !k.created) {
        const i = s.make();
        i.retry('admin.deploy');
        expect(i.runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
        expect(depsOf(s, 'admin').size).toBe(0);
        const j = s.make();
        j.retry('admin.deploy', true);
        j.runUntilBlocked({}, 20);
      } else if (!k.unknown) {
        const i = s.make();
        i.retry('admin.deploy');
        i.runUntilBlocked({}, 20);
      }
      // 作成済み（結果不明）の場合は、確認なしの再実行で一覧の照合により使う
      expect(finish(s).state.complete).toBe(true);
      expect(depsOf(s, 'admin').size).toBe(1);
    });
  }

  it('独立した点検 #6: 関連付けは、作成の結果を確認できないと案内された失敗中の工程だけ。関連付けの後は後続の工程と最後の確認をやり直す', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    const done = finish(s);
    expect(done.state.complete).toBe(true);
    const id = ref(s, 'core').scriptId!;
    // 完了済みの環境・案内されていない工程では受け付けない
    for (const st of ['core.create', 'core.deploy', 'admin.create', 'admin.deploy'] as const) expect(s.make().attach(st, id).ok, st).toBe(false);
    expect(ref(s, 'core').url).toBeTruthy();
    // 案内された工程（記録のプロジェクトの照会の 404）では受け付け、後続の工程（最後の確認を含む）を消す
    s.store.reg!.steps['core.create'] = { status: 'error', at: new Date().toISOString() };
    s.api.faults.getProject404 = 1;
    const i = s.make();
    i.retry('core.create');
    expect(i.runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
    expect(s.make().attach('core.create', id).ok).toBe(true);
    // 記録と同じプロジェクトの関連付け: その工程と最後の確認をやり直す（デプロイの記録・接続は残す。消すとデプロイを二重に作る）
    for (const st of ['core.create', 'verify'] as const) expect(s.store.reg!.steps[st], st).toBeUndefined();
    expect(ref(s, 'core').deploymentId).toBeTruthy();
    expect(finish(s).state.complete).toBe(true);
    expect(projectsOf(s, 'core')).toHaveLength(1);
    expect(depsOf(s, 'core').size).toBe(1);
  });

  it('再点検 #3: 記録しているデプロイが照会で見つかった後の別の理由の失敗では、関連付けを受け付けない', () => {
    const s = setup();
    s.api.faults.omitDeployVersion = 'all'; // デプロイを作成・記録したが、版を確かめられずに止まった状態
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.api.faults.omitDeployVersion = '';
    s.api.faults.getDeployment404 = 1; // 一時的な 404 →「見つからない」の案内
    const i1 = s.make();
    i1.retry('core.deploy');
    expect(i1.runUntilBlocked({}, 20).error?.confirm).toBeTruthy();
    // 照会が回復して見つかったが、切替が別の理由（5xx）で失敗した
    s.api.faults.scriptFail.set(ref(s, 'core').scriptId!, 2);
    const i2 = s.make();
    i2.retry('core.deploy');
    const r = i2.runUntilBlocked({}, 20);
    expect(r.error?.step).toBe('core.deploy');
    expect(r.error?.confirm).toBeUndefined();
    expect(s.make().attach('core.deploy', ref(s, 'core').deploymentId!).ok).toBe(false);
  });

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

  it('構築の完了前の検証: Core の保管先の点検で問題があれば完了しない（点検の結果を検証に使う）', () => {
    const s = setup();
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.env.storageIssues.push('「Shiftly/03_Exports（フォルダ）」が Google ドライブに 2 つあります（1 つのはず）');
    const r = finish(s);
    expect(r.error?.step).toBe('verify');
    expect(r.error?.message).toContain('03_Exports');
    expect(r.state.complete).toBe(false);
    s.core.env.storageIssues.length = 0;
    const i = s.make();
    i.retry('verify');
    expect(confirmProjects(s, i.runUntilBlocked({}, 20)).state.complete).toBe(true);
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

describe('D-027 B案: Setup による既存環境の更新・ロールバックを提供しない／構築の完了の条件（Codex 監査24 A4）', () => {
  /** Admin の接続まで進め、確認の工程の結果を返す（所有者の確認はしない） */
  const toVerify = (s: ReturnType<typeof setup>) => {
    s.make().runUntilBlocked({ storeName: '店' }, 20);
    s.core.authorize();
    s.make().runUntilBlocked({}, 20);
    const bs = [...s.api.projects.values()].find((p) => p.title.startsWith('Shiftly-Admin'))!.files.find((f) => f.name === 'bootstrap')!;
    s.core.post({ kind: 'pair', role: 'admin', pairingCode: JSON.parse(bs.source.replace('var SHIFTLY_ADMIN_BOOTSTRAP = ', '').replace(/;\n$/, '')).pairingCode });
    return s.make().runUntilBlocked({}, 20);
  };

  it('Setup の更新・ロールバックの処理は配布物に含めない（インストーラーに更新・ロールバックの操作がない）', () => {
    const proto = Installer.prototype as unknown as Record<string, unknown>;
    for (const m of ['checkUpdate', 'applyUpdate', 'rollbackCode', 'applyUpdateInner', 'rollbackCodeInner']) expect(proto[m]).toBeUndefined();
  });

  it('Setup の鍵では、v1.3 で提供しない Core の操作（更新・移行・復元・メンテナンスの切替）を実行できず、Core のデータも変わらない', () => {
    const s = setup();
    const r = confirmProjects(s, toVerify(s));
    expect(r.state.complete).toBe(true);
    const before = JSON.stringify(s.core.env.adapter.snapshot());
    for (const op of ['system.prepareUpdate', 'system.migrate', 'system.finishUpdate', 'system.setMaintenance', 'backup.restore', 'maintenance.begin', 'maintenance.finish']) {
      const res = s.deps.callCoreAsSetup(s.store.reg!.core.url!, s.store.secrets!.setupKey!, { op, args: { targetVersion: '0.2.0', on: true, confirmText: '保守を開始する' } });
      expect(res.ok, op).toBe(false);
    }
    expect(JSON.stringify(s.core.env.adapter.snapshot())).toBe(before);
    expect(s.core.env.secrets.get('SHIFTLY_MAINTENANCE')).toBeNull();
  });

  it('構築を完了した環境を、別の版の Setup で作り直さない（コードの配置・デプロイの操作をしない）', () => {
    const s = setup();
    confirmProjects(s, toVerify(s));
    expect(s.store.reg!.appVersion).toBe('0.1.0');
    // 別の版の Setup で開き、工程の一部が未完了の状態（記録の破損・手での編集など）を作る
    s.deps.release = release('0.2.0');
    delete s.store.reg!.steps['core.upload'];
    const calls = s.api.calls.length;
    const r = s.make().runUntilBlocked({}, 20);
    expect(r.error?.message).toContain('この Setup（0.2.0）では変更しません');
    expect(r.state.complete).toBe(false);
    expect(s.api.calls.length).toBe(calls);
  });

  it('自動では確かめられない項目（プロジェクトの重複）は、所有者の確認を明示するまで完了しない。確認の明示は案内の後の再実行だけ', () => {
    const s = setup();
    const r = toVerify(s);
    expect(r.error?.step).toBe('verify');
    expect(r.error?.confirm).toContain('1 つずつであることを確認しました');
    expect(r.state.complete).toBe(false);
    expect(r.state.verification?.ownerConfirmed).toBeUndefined();
    // 確認の明示なしの再実行では完了しない
    const i = s.make();
    i.retry('verify');
    const r2 = i.runUntilBlocked({}, 20);
    expect(r2.state.complete).toBe(false);
    expect(r2.error?.confirm).toBeTruthy();
    // 確認を明示すると完了し、確認した項目を記録する
    const r3 = confirmProjects(s, r2);
    expect(r3.state.complete).toBe(true);
    expect(r3.state.verification!.ownerConfirmed).toEqual(r3.state.verification!.unverified);
    expect(s.store.reg!.projectsConfirmed).toMatchObject({ core: s.store.reg!.core.scriptId, admin: s.store.reg!.admin.scriptId });
  });

  it('所有者の確認は、確認したときのプロジェクトに結び付ける（プロジェクトが変わった場合は確認し直す）', () => {
    const s = setup();
    confirmProjects(s, toVerify(s));
    s.store.reg!.projectsConfirmed = { ...s.store.reg!.projectsConfirmed!, admin: 'script_other' };
    delete s.store.reg!.steps.verify;
    const r = s.make().runUntilBlocked({}, 20);
    expect(r.state.complete).toBe(false);
    expect(r.error?.confirm).toBeTruthy();
  });

  it('別の理由で確認の工程が失敗した後は、確認の明示を受け付けない（直近の案内が確認を求めた場合だけ）', () => {
    const s = setup();
    s.registryIssues.push('Google ドライブに、この環境の Setup の記録ファイル（Shiftly Setup Registry.json）が 2 つあります');
    const r = toVerify(s);
    expect(r.error?.step).toBe('verify');
    expect(r.error?.confirm).toBeUndefined();
    const i = s.make();
    i.retry('verify', true);
    expect(s.store.reg!.projectsConfirmed).toBeUndefined();
    expect(i.runUntilBlocked({}, 20).state.complete).toBe(false);
  });

  it('Setup の記録ファイルの重複・不一致は完了の前に検出し、所有者に確認を求めて完了しない（自動では削除しない）', () => {
    const s = setup();
    s.registryIssues.push('Google ドライブに、この環境の Setup の記録ファイル（Shiftly Setup Registry.json）が 2 つあります（1 つのはず）');
    const r = toVerify(s);
    expect(r.error?.step).toBe('verify');
    expect(r.error?.message).toContain('記録ファイル');
    expect(r.state.complete).toBe(false);
    // 所有者が整理した後の再実行で、確認を経て完了する
    s.registryIssues.length = 0;
    const i = s.make();
    i.retry('verify');
    expect(confirmProjects(s, i.runUntilBlocked({}, 20)).state.complete).toBe(true);
  });

  it('Setup の記録ファイルを点検できない（一覧の途中の失敗・点検できない環境）場合は完了しない', () => {
    const s = setup();
    s.deps.registryReport = () => {
      throw new Error('Drive: 検索に失敗しました（2 ページ目）');
    };
    const r = confirmProjects(s, toVerify(s));
    expect(r.state.complete).toBe(false);
    expect(r.error?.message).toContain('点検できませんでした');
    const s2 = setup();
    delete s2.deps.registryReport;
    const r2 = confirmProjects(s2, toVerify(s2));
    expect(r2.state.complete).toBe(false);
    expect(r2.error?.message).toContain('点検できない環境');
  });
});
