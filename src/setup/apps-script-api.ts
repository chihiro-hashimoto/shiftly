/**
 * Apps Script API（REST v1）クライアント
 * https://developers.google.com/apps-script/api/reference/rest
 * HTTP 実装は注入（GAS: UrlFetchApp + ScriptApp.getOAuthToken() / テスト: フェイク）
 * OAuth アクセストークンはサーバー側でのみ扱い、ログ・URL・ブラウザへ出さない。
 */

export interface HttpResponse {
  status: number;
  body: string;
}
export type Http = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => HttpResponse;

export interface ScriptFile {
  name: string;
  type: 'SERVER_JS' | 'HTML' | 'JSON';
  source: string;
}

export class AppsScriptApiError extends Error {
  constructor(
    readonly status: number,
    /**
     * 失敗の分類（A案・D-029。401・403 をすべて「API が無効」とは見なさない）
     * USER_API_DISABLED: 利用者の設定（script.google.com/home/usersettings）で Apps Script API がオフ
     * PROJECT_API_DISABLED: Setup に紐づく Google Cloud プロジェクトで API が無効（共通の Setup では開発者側の設定）
     * UNAUTHENTICATED: 401（承認の失効・未承認）／ SCOPE: 必要な権限（スコープ）が承認されていない ／ PERMISSION: その他の 403
     */
    readonly reason: 'USER_API_DISABLED' | 'PROJECT_API_DISABLED' | 'UNAUTHENTICATED' | 'SCOPE' | 'PERMISSION' | 'NOT_FOUND' | 'QUOTA' | 'OTHER',
    message: string,
  ) {
    super(message);
  }
}

/**
 * 成功（2xx）の応答に、作成したものの ID（版の番号）がない。作成されたかどうかは分からないものとして扱う
 * （AppsScriptApiError ではないため、Installer の createOutcomeUnknown は「結果が分からない」と判定する。D-025 S1。独立した点検 S1-2）
 */
export class AppsScriptMalformedResponse extends Error {}

const BASE = 'https://script.googleapis.com/v1';

export class AppsScriptApi {
  constructor(private readonly http: Http) {}

  private req<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): T {
    const r = this.http(method, `${BASE}${path}`, body);
    if (r.status >= 200 && r.status < 300) return (r.body ? JSON.parse(r.body) : {}) as T;
    throw toError(r);
  }

  /** API が利用可能か（存在しない ID を GET し、404 なら利用可能） */
  probe(): { ok: true } | { ok: false; reason: AppsScriptApiError['reason']; message: string } {
    try {
      this.req('GET', '/projects/shiftly-probe-nonexistent');
      return { ok: true };
    } catch (e) {
      if (e instanceof AppsScriptApiError) {
        if (e.status === 404 || (e.status === 400 && e.reason === 'OTHER')) return { ok: true };
        return { ok: false, reason: e.reason, message: e.message };
      }
      return { ok: false, reason: 'OTHER', message: String(e) };
    }
  }

  createProject(title: string): { scriptId: string } {
    const r = this.req<{ scriptId?: unknown }>('POST', '/projects', { title });
    if (typeof r.scriptId !== 'string' || !r.scriptId) throw new AppsScriptMalformedResponse('プロジェクトの作成の応答に ID がありません');
    return { ...r, scriptId: r.scriptId };
  }
  getProject(scriptId: string): { scriptId: string; title: string } | null {
    try {
      return this.req('GET', `/projects/${encodeURIComponent(scriptId)}`);
    } catch (e) {
      if (e instanceof AppsScriptApiError && e.status === 404) return null;
      throw e;
    }
  }
  updateContent(scriptId: string, files: ScriptFile[]): void {
    this.req('PUT', `/projects/${encodeURIComponent(scriptId)}/content`, { files });
  }
  getContent(scriptId: string, versionNumber?: number): { files: ScriptFile[] } {
    return this.req('GET', `/projects/${encodeURIComponent(scriptId)}/content${versionNumber ? `?versionNumber=${versionNumber}` : ''}`);
  }
  createVersion(scriptId: string, description: string): { versionNumber: number } {
    const r = this.req<{ versionNumber?: unknown }>('POST', `/projects/${encodeURIComponent(scriptId)}/versions`, { description });
    if (typeof r.versionNumber !== 'number' || !Number.isSafeInteger(r.versionNumber) || r.versionNumber < 1) throw new AppsScriptMalformedResponse('版の作成の応答に版の番号がありません');
    return { versionNumber: r.versionNumber };
  }
  createDeployment(scriptId: string, versionNumber: number, description: string): Deployment {
    const r = this.req<Partial<Deployment>>('POST', `/projects/${encodeURIComponent(scriptId)}/deployments`, { versionNumber, manifestFileName: 'appsscript', description });
    if (typeof r.deploymentId !== 'string' || !r.deploymentId) throw new AppsScriptMalformedResponse('デプロイの作成の応答に ID がありません');
    return r as Deployment;
  }
  updateDeployment(scriptId: string, deploymentId: string, versionNumber: number, description: string): Deployment {
    const r = this.req<Partial<Deployment>>('PUT', `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`, {
      deploymentConfig: { versionNumber, manifestFileName: 'appsscript', description },
    });
    // 切替の対象の ID は分かっているため、応答に ID がなければ要求した ID を使う
    return { ...r, deploymentId: typeof r.deploymentId === 'string' && r.deploymentId ? r.deploymentId : deploymentId } as Deployment;
  }
  /** デプロイの一覧（作成の応答が失われた場合の照合に使う。Codex 監査17 #3） */
  listDeployments(scriptId: string): Deployment[] {
    const out: Deployment[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = this.req<{ deployments?: Deployment[]; nextPageToken?: string }>(
        'GET',
        `/projects/${encodeURIComponent(scriptId)}/deployments${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      );
      out.push(...(r.deployments ?? []));
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return out;
  }
  /**
   * 最新のコード（HEAD）のテスト用 URL（…/dev）。プロジェクトの編集者（所有者）だけが開ける（A案・D-029）。
   * 所有者がブラウザで開いて Google の権限を承認し、初期化を実行するために使う。見つからない場合は null（エディタでの実行に切り替える）。
   * 【未検証】Apps Script API の一覧が HEAD のデプロイを返す形式は、Google の実環境で確認する（docs/live-verification.md L43）
   */
  headDevUrl(scriptId: string): string | null {
    const head = this.listDeployments(scriptId).find((d) => d.deploymentConfig?.versionNumber === undefined);
    if (!head) return null;
    const u = webAppUrl(head);
    if (u && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/dev$/.test(u)) return u;
    return /^[A-Za-z0-9_-]+$/.test(head.deploymentId) ? `https://script.google.com/macros/s/${head.deploymentId}/dev` : null;
  }
  getDeployment(scriptId: string, deploymentId: string): Deployment | null {
    try {
      return this.req('GET', `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`);
    } catch (e) {
      if (e instanceof AppsScriptApiError && e.status === 404) return null;
      throw e;
    }
  }
}

export interface Deployment {
  deploymentId: string;
  deploymentConfig?: { versionNumber?: number; description?: string };
  entryPoints?: Array<{ entryPointType: string; webApp?: { url: string } }>;
}

export function webAppUrl(d: Deployment): string | null {
  return d.entryPoints?.find((e) => e.entryPointType === 'WEB_APP')?.webApp?.url ?? null;
}

function toError(r: HttpResponse): AppsScriptApiError {
  let msg = `HTTP ${r.status}`;
  let reasonText = '';
  try {
    const j = JSON.parse(r.body) as { error?: { message?: string; status?: string; details?: Array<{ reason?: string }> } };
    msg = j.error?.message ?? msg;
    reasonText = `${j.error?.status ?? ''} ${(j.error?.details ?? []).map((d) => d.reason ?? '').join(' ')}`;
  } catch {
    /* 本文が JSON でない */
  }
  const all = `${msg} ${reasonText}`;
  // 利用者設定（script.google.com/home/usersettings）で API が無効
  if (/User has not enabled the Apps Script API/i.test(all)) return new AppsScriptApiError(r.status, 'USER_API_DISABLED', msg);
  // 呼び出し元 Cloud プロジェクトで API が無効（利用者の操作では直せない。共通の Setup では開発者側の設定）
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(all)) return new AppsScriptApiError(r.status, 'PROJECT_API_DISABLED', msg);
  if (r.status === 404) return new AppsScriptApiError(404, 'NOT_FOUND', msg);
  if (r.status === 401) return new AppsScriptApiError(401, 'UNAUTHENTICATED', msg);
  // 承認画面で一部の権限だけを許可した等（403 ACCESS_TOKEN_SCOPE_INSUFFICIENT）
  if (r.status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i.test(all)) return new AppsScriptApiError(403, 'SCOPE', msg);
  if (r.status === 403) return new AppsScriptApiError(403, 'PERMISSION', msg);
  if (r.status === 429) return new AppsScriptApiError(429, 'QUOTA', msg);
  return new AppsScriptApiError(r.status, 'OTHER', msg);
}
