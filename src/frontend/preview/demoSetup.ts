/**
 * プレビュー用: Shiftly Setup の画面確認のためのデモ（Google へは接続しない）
 * 実際の Installer を、メモリ上の擬似 Apps Script API・擬似 Core で動かす。
 * 「管理者の操作が必要」な権限承認工程は、確認ボタンを押すと承認済みとして扱う（デモのみ）。
 */
import { AppsScriptApi, type Http, type ScriptFile } from '../../setup/apps-script-api';
import { Installer, type Registry, type ReleaseBundle, type SecretRegistry } from '../../setup/installer';
import { sha256 } from '../../shared/sha256';
import { toHex, utf8 } from '../../shared/crypto';
import type { SetupTransport } from '../setup/SetupApp';

const sha = (s: string) => toHex(sha256(utf8(s)));
const rnd = (n: number) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return toHex(b);
};

export function createDemoSetupTransport(): SetupTransport {
  const projects = new Map<string, { title: string; files: ScriptFile[]; v: number; deps: Map<string, number>; desc: Map<string, string> }>();
  let seq = 0;
  const http: Http = (method, url, body) => {
    const m = url.match(/\/projects(?:\/([^/?]+))?(?:\/(content|versions|deployments)(?:\/([^/?]+))?)?/)!;
    const [, id, sub, depId] = m;
    if (method === 'POST' && !id) {
      const sid = `demo_script_${++seq}`;
      projects.set(sid, { title: (body as { title: string }).title, files: [], v: 0, deps: new Map(), desc: new Map() });
      return { status: 200, body: JSON.stringify({ scriptId: sid }) };
    }
    const p = id ? projects.get(id) : undefined;
    if (!p) return { status: 404, body: '{"error":{"message":"not found"}}' };
    const dep = (d: string, v: number) => ({ deploymentId: d, deploymentConfig: { versionNumber: v, description: p.desc.get(d) }, entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: `https://script.google.com/macros/s/${d}/exec` } }] });
    if (method === 'GET' && !sub) return { status: 200, body: JSON.stringify({ scriptId: id, title: p.title }) };
    if (method === 'GET' && sub === 'content') return { status: 200, body: JSON.stringify({ files: p.files }) };
    if (method === 'GET' && sub === 'deployments' && !depId) return { status: 200, body: JSON.stringify({ deployments: [...p.deps.entries()].map(([d, v]) => dep(d, v)) }) };
    if (method === 'PUT' && sub === 'content') {
      p.files = (body as { files: ScriptFile[] }).files;
      return { status: 200, body: '{}' };
    }
    if (method === 'POST' && sub === 'versions') return { status: 200, body: JSON.stringify({ versionNumber: ++p.v }) };
    if (method === 'POST' && sub === 'deployments') {
      const d = `DEMO${id}`;
      p.deps.set(d, (body as { versionNumber: number }).versionNumber);
      p.desc.set(d, (body as { description?: string }).description ?? '');
      return { status: 200, body: JSON.stringify(dep(d, p.v)) };
    }
    if (sub === 'deployments' && depId) {
      if (method === 'PUT') {
        const c = (body as { deploymentConfig: { versionNumber: number; description?: string } }).deploymentConfig;
        p.deps.set(depId, c.versionNumber);
        if (c.description) p.desc.set(depId, c.description);
      }
      return { status: 200, body: JSON.stringify(dep(depId, p.deps.get(depId) ?? 1)) };
    }
    return { status: 400, body: '{}' };
  };
  const files: ScriptFile[] = [{ name: 'Code', type: 'SERVER_JS', source: '/* demo */' }];
  const release: ReleaseBundle = { version: '0.1.0', core: files, admin: files, hashes: { 'core/Code': sha('/* demo */'), 'admin/Code': sha('/* demo */') } };
  let store: { reg: Registry | null; secrets: SecretRegistry | null } = { reg: null, secrets: null };
  const core = { initialized: false, adminPaired: false, setupPaired: false, authorizeAsked: { core: false, admin: false } };
  const inst = () =>
    new Installer({
      api: new AppsScriptApi(http),
      release,
      load: () => ({ reg: store.reg ? structuredClone(store.reg) : null, secrets: store.secrets ? { ...store.secrets } : null }),
      save: (reg, secrets) => {
        store = { reg: structuredClone(reg), secrets: { ...secrets } };
      },
      userEmail: () => 'owner@example.invalid（デモ）',
      randomHex: rnd,
      sha256Hex: sha,
      now: () => new Date().toISOString(),
      postCore: (_u, body) => {
        const b = body as { kind: string };
        if (b.kind === 'ping') {
          // デモ: 一度「操作が必要」を表示した後の確認で承認済みとみなす
          if (core.authorizeAsked.core) core.initialized = true;
          if (core.authorizeAsked.admin) core.adminPaired = true;
          return { ok: true, data: { app: 'shiftly-core', version: '0.1.0', schemaVersion: 1, initialized: core.initialized, envId: store.reg?.envId, adminPaired: core.adminPaired, setupPaired: core.setupPaired } };
        }
        if (b.kind === 'pair') {
          core.setupPaired = true;
          return { ok: true, data: { key: rnd(32) } };
        }
        return { ok: false };
      },
      callCoreAsSetup: (_u, _k, req) =>
        req.op === 'system.integrityCheck' || req.op === 'system.storageCheck' ? { ok: true, data: { ok: true, issues: [], items: [] } } : { ok: false, error: { code: 'FORBIDDEN', message: 'デモでは対応していません' } },
      // デモ: Google ドライブの記録ファイルはない（本番は全ページを一覧して点検する。src/gas/setup.ts）
      registryReport: () => ({ ok: true, issues: [] }),
    });
  return {
    demo: true,
    async call<T>(action: string, args?: Record<string, unknown>): Promise<T> {
      await new Promise((r) => setTimeout(r, 300));
      const i = inst();
      let r: unknown;
      if (action === 'state') r = i.state();
      else if ((action === 'run' || action === 'retry') && !i.hasRegistry() && !(action === 'retry' && args?.step === 'account' && args?.confirmedNoDuplicate === true)) {
        // 本番の Setup（src/gas/setup.ts）と同じく、記録がない場合は「初めての構築」の確認を求める
        r = {
          state: i.state(),
          waitingFor: null,
          error: { step: 'account', message: 'Setup の記録が見つかりません。初めての構築として進めてよいかの確認が必要です', fix: '初めての構築の場合は、確認のチェックを付けて実行してください', confirm: 'この Google アカウントで Shiftly を構築するのは初めてです（以前に構築した環境はありません）' },
        };
      } else if (action === 'run' || action === 'retry') {
        if (action === 'retry') i.retry(String(args?.step) as never, args?.confirmedNoDuplicate === true);
        r = i.runUntilBlocked({ storeName: typeof args?.storeName === 'string' ? args.storeName : undefined }, 20);
        const w = (r as { waitingFor: { step: string } | null }).waitingFor;
        if (w?.step === 'core.authorize') core.authorizeAsked.core = true;
        if (w?.step === 'admin.authorize') core.authorizeAsked.admin = true;
      } else if (action === 'attach') r = i.attach(String(args?.step) as never, typeof args?.id === 'string' ? args.id : '');
      // 更新・ロールバックは v1.3 では提供しない（本番の Setup と同じく拒否する。D-027）
      else if (action === 'checkUpdate' || action === 'applyUpdate' || action === 'rollback') throw new Error('アプリの更新・ロールバックは v1.3 では Setup から行いません（Google 所有者の保守作業）');
      return r as T;
    },
  };
}
