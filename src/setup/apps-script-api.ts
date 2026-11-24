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
    readonly reason: 'API_DISABLED' | 'PERMISSION' | 'NOT_FOUND' | 'QUOTA' | 'OTHER',
    message: string,
  ) {
    super(message);
  }
}

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
    return this.req('POST', '/projects', { title });
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
    return this.req('POST', `/projects/${encodeURIComponent(scriptId)}/versions`, { description });
  }
  createDeployment(scriptId: string, versionNumber: number, description: string): Deployment {
    return this.req('POST', `/projects/${encodeURIComponent(scriptId)}/deployments`, { versionNumber, manifestFileName: 'appsscript', description });
  }
  updateDeployment(scriptId: string, deploymentId: string, versionNumber: number, description: string): Deployment {
    return this.req('PUT', `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`, {
      deploymentConfig: { versionNumber, manifestFileName: 'appsscript', description },
    });
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
  deploymentConfig?: { versionNumber?: number };
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
  if (/User has not enabled the Apps Script API/i.test(all)) return new AppsScriptApiError(r.status, 'API_DISABLED', msg);
  // 呼び出し元 Cloud プロジェクトで API が無効
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(all)) return new AppsScriptApiError(r.status, 'API_DISABLED', msg);
  if (r.status === 404) return new AppsScriptApiError(404, 'NOT_FOUND', msg);
  if (r.status === 401 || r.status === 403) return new AppsScriptApiError(r.status, 'PERMISSION', msg);
  if (r.status === 429) return new AppsScriptApiError(429, 'QUOTA', msg);
  return new AppsScriptApiError(r.status, 'OTHER', msg);
}
