/**
 * 共通の Shiftly Setup（A案・D-029）の統合テスト
 * - Apps Script API の失敗の分類（401・403 をすべて「API が無効」とは扱わない）と画面向けの分類コード
 * - ブラウザでの権限承認・初期化の案内（テスト用 URL /dev と確認コード）。見つからない場合はエディタでの実行に切り替える
 * - Core のブラウザでの初期化（shiftlyWebInitialize）: 所有者・確認コード・回数の制限（ビルド済みバンドルをエミュレータで実行）
 * - 利用者の間の分離: Setup は Script Properties・Script Cache を使わず、OAuth トークンを画面に返さない
 * ※ いずれもモック・エミュレーションでの確認。Google の実環境での確認は docs/live-verification.md（L41〜L49）
 */
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AppsScriptApi, type Http, type ScriptFile } from '../../src/setup/apps-script-api';
import { Installer, apiFailure, type InstallerDeps, type Registry, type ReleaseBundle, type SecretRegistry } from '../../src/setup/installer';
import { GasEmulator } from '../helpers/gas-emulator';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const errBody = (message: string, status = '', reason = '') => JSON.stringify({ error: { message, status, details: reason ? [{ reason }] : [] } });

describe('Apps Script API の失敗の分類（A案・D-029）', () => {
  const cases: Array<[string, number, string, string]> = [
    ['利用者の設定でオフ', 403, errBody('User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry.', 'PERMISSION_DENIED'), 'USER_API_DISABLED'],
    ['Setup の Cloud プロジェクトで無効', 403, errBody('Apps Script API has not been used in project 123 before or it is disabled.', 'PERMISSION_DENIED', 'SERVICE_DISABLED'), 'PROJECT_API_DISABLED'],
    ['承認の失効（401）', 401, errBody('Request had invalid authentication credentials.', 'UNAUTHENTICATED'), 'UNAUTHENTICATED'],
    ['権限の一部だけを許可（403 スコープ不足）', 403, errBody('Request had insufficient authentication scopes.', 'PERMISSION_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'), 'SCOPE'],
    ['その他の 403', 403, errBody('The caller does not have permission', 'PERMISSION_DENIED'), 'PERMISSION'],
    ['利用上限', 429, errBody('Quota exceeded', 'RESOURCE_EXHAUSTED'), 'QUOTA'],
  ];
  for (const [name, status, body, reason] of cases) {
    it(`${name} → ${reason}`, () => {
      const api = new AppsScriptApi(() => ({ status, body }));
      const p = api.probe();
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toBe(reason);
      // 画面向けの分類コードも同じ（「Google の設定画面を開く」は USER_API_DISABLED のときだけ表示する）
      const e = apiFailure('api', p.ok ? 'OTHER' : p.reason, 'x');
      expect(e.code).toBe(reason);
      if (reason === 'USER_API_DISABLED') expect(e.fix).toContain('script.google.com/home/usersettings');
      else expect(e.message).not.toContain('オフになっています');
    });
  }
  it('存在しない ID の照会が 404 なら API は利用できる', () => {
    expect(new AppsScriptApi(() => ({ status: 404, body: errBody('not found') })).probe().ok).toBe(true);
  });
});

describe('テスト用 URL（/dev）の取得', () => {
  const list = (deployments: unknown[]): Http => () => ({ status: 200, body: JSON.stringify({ deployments }) });
  it('HEAD のデプロイの Web アプリの URL（…/dev）を使う', () => {
    const api = new AppsScriptApi(list([{ deploymentId: 'AKv1', deploymentConfig: { versionNumber: 1, description: 'Shiftly 1.3.0' } }, { deploymentId: 'AKhead', deploymentConfig: {}, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/AKhead/dev' } }] }]));
    expect(api.headDevUrl('s')).toBe('https://script.google.com/macros/s/AKhead/dev');
  });
  it('URL がない場合は HEAD のデプロイの ID から組み立てる', () => {
    expect(new AppsScriptApi(list([{ deploymentId: 'AKhead', deploymentConfig: {} }])).headDevUrl('s')).toBe('https://script.google.com/macros/s/AKhead/dev');
  });
  it('HEAD がない・ID が不正な場合は null（エディタでの実行に切り替える）', () => {
    expect(new AppsScriptApi(list([{ deploymentId: 'AKv1', deploymentConfig: { versionNumber: 1 } }])).headDevUrl('s')).toBeNull();
    expect(new AppsScriptApi(list([{ deploymentId: 'bad/id?x', deploymentConfig: {} }])).headDevUrl('s')).toBeNull();
    expect(new AppsScriptApi(list([{ deploymentId: 'AKhead', deploymentConfig: {}, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://evil.example/macros/s/x/dev' } }] }])).headDevUrl('s')).toBe('https://script.google.com/macros/s/AKhead/dev');
  });
});

/** 最小の擬似 Apps Script API（HEAD のデプロイの有無・API の無効を切り替える）と擬似 Core */
function harness(o: { head?: boolean; apiOff?: 'user' | 'project' | null; listFails?: boolean } = {}) {
  let apiOff = o.apiOff ?? null;
  const projects = new Map<string, { title: string; files: ScriptFile[]; v: number; deps: Map<string, number> }>();
  let seq = 0;
  const core = { initialized: false, adminPaired: false, setupPaired: false };
  const http: Http = (method, url, body) => {
    if (apiOff === 'user') return { status: 403, body: errBody('User has not enabled the Apps Script API.', 'PERMISSION_DENIED') };
    if (apiOff === 'project') return { status: 403, body: errBody('has not been used in project 1', 'PERMISSION_DENIED', 'SERVICE_DISABLED') };
    const [, id, sub, depId] = url.match(/\/projects(?:\/([^/?]+))?(?:\/(content|versions|deployments)(?:\/([^/?]+))?)?/)!;
    if (method === 'POST' && !id) {
      const sid = `s${++seq}`;
      projects.set(sid, { title: (body as { title: string }).title, files: [], v: 0, deps: new Map() });
      return { status: 200, body: JSON.stringify({ scriptId: sid }) };
    }
    const p = id ? projects.get(id) : undefined;
    if (!p) return { status: 404, body: errBody('not found') };
    const dep = (d: string, v: number) => ({ deploymentId: d, deploymentConfig: { versionNumber: v, description: 'Shiftly 9.9.9' }, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: `https://script.google.com/macros/s/${d}/exec` } }] });
    if (method === 'GET' && !sub) return { status: 200, body: JSON.stringify({ scriptId: id, title: p.title }) };
    if (method === 'GET' && sub === 'content') return { status: 200, body: JSON.stringify({ files: p.files }) };
    if (method === 'PUT' && sub === 'content') {
      p.files = (body as { files: ScriptFile[] }).files;
      return { status: 200, body: '{}' };
    }
    if (method === 'POST' && sub === 'versions') return { status: 200, body: JSON.stringify({ versionNumber: ++p.v }) };
    if (method === 'POST' && sub === 'deployments') {
      p.deps.set(`D${id}`, p.v);
      return { status: 200, body: JSON.stringify(dep(`D${id}`, p.v)) };
    }
    if (method === 'GET' && sub === 'deployments' && !depId) {
      if (o.listFails && p.deps.size) return { status: 500, body: errBody('backend') };
      const head = { deploymentId: `H${id}`, deploymentConfig: {}, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: `https://script.google.com/macros/s/H${id}/dev` } }] };
      return { status: 200, body: JSON.stringify({ deployments: [...(o.head ? [head] : []), ...[...p.deps.entries()].map(([d, v]) => dep(d, v))] }) };
    }
    if (method === 'GET' && sub === 'deployments' && depId) return p.deps.has(depId) ? { status: 200, body: JSON.stringify(dep(depId, p.deps.get(depId)!)) } : { status: 404, body: '{}' };
    return { status: 400, body: errBody('bad') };
  };
  const files: ScriptFile[] = [{ name: 'Code', type: 'SERVER_JS', source: '/* c */' }];
  const release: ReleaseBundle = { version: '9.9.9', core: files, admin: files, hashes: { 'core/Code': sha('/* c */'), 'admin/Code': sha('/* c */') } };
  const store: { reg: Registry | null; secrets: SecretRegistry | null } = { reg: null, secrets: null };
  const deps: InstallerDeps = {
    api: new AppsScriptApi(http),
    release,
    load: () => ({ reg: store.reg ? structuredClone(store.reg) : null, secrets: store.secrets ? { ...store.secrets } : null }),
    save: (reg, s) => {
      store.reg = structuredClone(reg);
      store.secrets = { ...s };
    },
    userEmail: () => 'owner@example.invalid',
    randomHex: (n) => randomBytes(n).toString('hex'),
    sha256Hex: sha,
    now: () => new Date().toISOString(),
    postCore: (_u, b) => {
      const body = b as { kind: string };
      if (body.kind === 'ping') return { ok: true, data: { app: 'shiftly-core', version: '9.9.9', schemaVersion: 1, envId: store.reg?.envId, ...core } };
      if (body.kind === 'pair') {
        core.setupPaired = true;
        return { ok: true, data: { key: randomBytes(32).toString('hex') } };
      }
      return { ok: false };
    },
    callCoreAsSetup: () => ({ ok: true, data: { ok: true, issues: [] } }),
    registryReport: () => ({ ok: true, issues: [] }),
  };
  return { deps, store, projects, core, enableApi: () => (apiOff = null), inst: () => new Installer(deps) };
}

describe('Installer: API の無効の案内と、ブラウザでの初期化の案内（A案・D-029）', () => {
  it('利用者の設定でオフ → USER_API_DISABLED。オンにした後の「再確認」で先へ進む', () => {
    const h = harness({ apiOff: 'user', head: true });
    const r = h.inst().runUntilBlocked({ storeName: '店' }, 3);
    expect(r.error?.step).toBe('api');
    expect(r.error?.code).toBe('USER_API_DISABLED');
    h.enableApi();
    const i = h.inst();
    i.retry('api');
    const r2 = i.runUntilBlocked({ storeName: '店' }, 3);
    expect(r2.error).toBeNull();
    expect(h.store.reg?.steps.api?.status).toBe('done');
  });

  it('Cloud プロジェクト側で無効 → PROJECT_API_DISABLED（利用者に設定画面を案内しない）', () => {
    const r = harness({ apiOff: 'project' }).inst().runUntilBlocked({ storeName: '店' }, 3);
    expect(r.error?.code).toBe('PROJECT_API_DISABLED');
    expect(r.error?.fix).toContain('開発者');
  });

  it('Staff の権限承認: テスト用 URL と確認コード（ハッシュは Core の bootstrap と一致）を案内し、エディタも代わりの方法として残す', () => {
    const h = harness({ head: true });
    const r = h.inst().runUntilBlocked({ storeName: '店' }, 20);
    expect(r.waitingFor?.step).toBe('core.authorize');
    const m = /^https:\/\/script\.google\.com\/macros\/s\/H(s\d+)\/dev#shiftly-init=([0-9a-f]{64})$/.exec(r.waitingFor!.initUrl ?? '');
    expect(m).not.toBeNull();
    expect(r.waitingFor!.openUrl).toContain('script.google.com/home/projects/');
    const code = m![2]!;
    expect(sha(code)).toBe(h.store.reg!.initCodeHash);
    expect(h.store.secrets!.initCode).toBe(code);
    // Core に配置した bootstrap にハッシュだけが入り、平文は入らない
    const bs = h.projects.get(m![1]!)!.files.find((f) => f.name === 'bootstrap')!.source;
    expect(bs).toContain(h.store.reg!.initCodeHash!);
    expect(bs).not.toContain(code);
    // Drive の記録ファイルに書く Registry（秘密情報を含まない）に平文はない
    expect(JSON.stringify(h.store.reg)).not.toContain(code);
    // 承認後: Admin の接続の案内（#shiftly-init=admin）
    h.core.initialized = true;
    const r2 = h.inst().runUntilBlocked({}, 20);
    expect(r2.waitingFor?.step).toBe('admin.authorize');
    expect(r2.waitingFor?.initUrl).toMatch(/^https:\/\/script\.google\.com\/macros\/s\/Hs\d+\/dev#shiftly-init=admin$/);
  });

  for (const [name, o] of [
    ['HEAD のデプロイがない', { head: false }],
    ['デプロイの一覧の取得に失敗した', { head: true, listFails: true }],
  ] as const) {
    it(`${name}場合は、エディタでの実行だけを案内する（止めない）`, () => {
      const r = harness(o).inst().runUntilBlocked({ storeName: '店' }, 20);
      expect(r.waitingFor?.step).toBe('core.authorize');
      expect(r.waitingFor?.initUrl).toBeUndefined();
      expect(r.waitingFor?.openUrl).toContain('script.google.com/home/projects/');
      expect(r.waitingFor?.instructions.join('')).toContain('shiftlyAuthorize');
    });
  }

  it('以前の Setup で始めた構築（確認コードがない）でも、Core の配置の前に確認コードを発行する', () => {
    const h = harness({ head: true });
    h.inst().runUntilBlocked({ storeName: '店' }, 3); // account・api・store まで
    delete h.store.reg!.initCodeHash;
    delete h.store.secrets!.initCode;
    const r = h.inst().runUntilBlocked({}, 20);
    expect(r.waitingFor?.initUrl).toMatch(/#shiftly-init=[0-9a-f]{64}$/);
    expect(sha(h.store.secrets!.initCode!)).toBe(h.store.reg!.initCodeHash);
  });

  it('画面の状態に、いま開いている Google アカウントを返す（構築先の確認の表示）', () => {
    expect(harness().inst().state().currentEmail).toBe('owner@example.invalid');
  });
});

const built = existsSync('dist/gas/core/Code.js') && existsSync('dist/gas/setup/Code.js');

describe.skipIf(!built)('Core のブラウザでの初期化 shiftlyWebInitialize（エミュレーション。A案・D-029）', () => {
  const load = (withHash = true) => {
    const emu = new GasEmulator();
    const code = randomBytes(32).toString('hex');
    const core = emu.load('core', {
      SHIFTLY_BOOTSTRAP: { envId: 'env_web', storeName: 'ブラウザ店', adminPairingHash: sha('a'), setupPairingHash: sha('s'), ...(withHash ? { initCodeHash: sha(code) } : {}) },
    });
    const ping = () => JSON.parse(core.doPost({ postData: { contents: JSON.stringify({ kind: 'ping' }) } }).content).data;
    const init = (c: unknown) => JSON.parse(core.shiftlyWebInitialize(c));
    const dbs = () => [...emu.files.values()].filter((f) => f.appProperties?.shiftly === 'database').length;
    return { emu, code, core, ping, init, dbs };
  };

  it('所有者＋確認コードで初期化（DB・日次の予約）。2 回目は何もしない', () => {
    const t = load();
    const r = t.init(t.code);
    expect(r.ok).toBe(true);
    expect(t.ping().initialized).toBe(true);
    expect(t.dbs()).toBe(1);
    expect(t.emu.triggers).toEqual(['shiftlyDailyJob']);
    const again = t.init(t.code);
    expect(again.ok).toBe(true);
    expect(again.data.already).toBe(true);
    expect(t.dbs()).toBe(1);
    expect(JSON.stringify(r)).not.toContain(t.code);
  });

  for (const [name, user] of [
    ['匿名の訪問者（getActiveUser が空）', ''],
    ['別の Google アカウント（操作するアカウント ≠ 実行するアカウント）', 'other@example.invalid'],
  ] as const) {
    it(`${name}は、正しい確認コードでも初期化できない`, () => {
      const t = load();
      t.emu.activeUser = user;
      const r = t.init(t.code);
      expect(r.ok).toBe(false);
      expect(r.error.code).toBe('FORBIDDEN');
      expect(t.ping().initialized).toBe(false);
      expect(t.dbs()).toBe(0);
    });
  }

  it('確認コードが違う・形式が不正な場合は初期化しない。失敗が 10 回に達すると正しいコードも受け付けない', () => {
    const t = load();
    for (const bad of [randomBytes(32).toString('hex'), 'abc', null, 123, { code: t.code }]) expect(t.init(bad).ok).toBe(false);
    expect(t.dbs()).toBe(0);
    for (let i = 0; i < 5; i++) t.init(randomBytes(32).toString('hex'));
    const r = t.init(t.code);
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('しばらく受け付けません');
    expect(t.dbs()).toBe(0);
  });

  it('確認コードのハッシュがない環境（以前の Setup で配置）では、ブラウザでの初期化を受け付けない（エディタを案内）', () => {
    const t = load(false);
    const r = t.init(t.code);
    expect(r.ok).toBe(false);
    expect(r.error.message).toContain('shiftlyAuthorize');
    expect(t.dbs()).toBe(0);
  });

  it('エディタの shiftlyAuthorize は引き続き使える（ブラウザでの初期化の後も冪等）', () => {
    const t = load();
    expect(t.init(t.code).ok).toBe(true);
    expect(t.core.shiftlyAuthorize().created).toBe(false);
    expect(t.dbs()).toBe(1);
  });
});

describe.skipIf(!built)('共通の Setup の利用者の間の分離（A案・D-029）', () => {
  const release: ReleaseBundle = { version: '1.3.0', core: [], admin: [], hashes: {} };
  it('Setup の操作は Script Properties・Script Cache（全利用者で共有）に書かず、OAuth トークンを画面に返さない', () => {
    const emu = new GasEmulator();
    const setup = emu.load('setup', { SHIFTLY_RELEASE: release });
    const outs = [
      setup.setupApi(JSON.stringify({ action: 'state' })),
      setup.setupApi(JSON.stringify({ action: 'retry', args: { step: 'account', confirmedNoDuplicate: true, storeName: '分離店' } })),
      setup.setupApi(JSON.stringify({ action: 'run', args: {} })),
    ];
    expect(emu.scriptProps.m.size).toBe(0);
    expect(emu.cache.size).toBe(0);
    expect(emu.userProps.getProperty('SHIFTLY_SETUP_REGISTRY')).not.toBeNull(); // 記録は利用者ごとの UserProperties
    for (const o of outs) expect(o).not.toContain('emu-token');
    // 秘密情報（ペアリングコード・確認コード）は Drive の記録ファイルに書かない
    const sec = JSON.parse(emu.userProps.getProperty('SHIFTLY_SETUP_SECRETS')!) as SecretRegistry;
    const regFile = [...emu.files.values()].find((f) => f.appProperties?.shiftlySetup === 'registry')!;
    for (const v of [sec.adminPairingCode, sec.setupPairingCode, sec.initCode]) expect(regFile.data!.toString('utf8')).not.toContain(v!);
  });

  it('別の Google アカウント（UserProperties・Google ドライブが別）では、前の利用者の環境を表示しない', () => {
    const a = new GasEmulator();
    const sa = a.load('setup', { SHIFTLY_RELEASE: release });
    sa.setupApi(JSON.stringify({ action: 'retry', args: { step: 'account', confirmedNoDuplicate: true, storeName: 'A店' } }));
    const envA = JSON.parse(sa.setupApi(JSON.stringify({ action: 'state' }))).data.envId as string;
    expect(envA).toMatch(/^env_/);
    // 同じ Setup のスクリプト（Script Properties を共有）を、別の利用者（UserProperties・Drive が別）が開いた
    const b = new GasEmulator();
    b.scriptProps = a.scriptProps;
    b.cache = a.cache;
    const sb = b.load('setup', { SHIFTLY_RELEASE: release });
    const stB = JSON.parse(sb.setupApi(JSON.stringify({ action: 'state' }))).data;
    expect(stB.envId).toBeNull();
    expect(JSON.stringify(stB)).not.toContain(envA);
  });

  it('共通の Setup の配置物: 実行=アクセスしているユーザー・アクセス=Google アカウントを持つ全員・例外のログなし・スコープは自己ホスト型と同じ最小限', () => {
    const hosted = JSON.parse(readFileSync('dist/gas/setup-hosted/appsscript.json', 'utf8'));
    const self = JSON.parse(readFileSync('dist/gas/setup/appsscript.json', 'utf8'));
    expect(hosted.webapp).toEqual({ executeAs: 'USER_ACCESSING', access: 'ANYONE' });
    expect(hosted.exceptionLogging).toBe('NONE');
    expect(hosted.oauthScopes).toEqual(self.oauthScopes);
    expect(readFileSync('dist/gas/setup-hosted/Code.js', 'utf8')).toBe(readFileSync('dist/gas/setup/Code.js', 'utf8'));
    expect(readFileSync('dist/gas/setup-hosted/Release.js', 'utf8')).toBe(readFileSync('dist/gas/setup/Release.js', 'utf8'));
    // Setup のコードは全利用者で共有される保存領域を参照しない
    expect(readFileSync('dist/gas/setup/Code.js', 'utf8')).not.toMatch(/getScriptProperties|getScriptCache|getScriptLock/);
  });
});
