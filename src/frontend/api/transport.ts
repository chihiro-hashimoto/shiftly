/**
 * API 通信層
 * - GAS 本番: google.script.run（staffApi / adminApi）
 * - プレビュー: ブラウザ内のモック Core（メモリ上のみ。端末へ保存しない）
 * 業務データを含む応答はメモリ上でのみ扱い、localStorage 等へは保存しない。
 */
export type ApiResult<T = unknown> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export interface Transport {
  mode: 'staff' | 'admin';
  call(req: { op: string; args?: unknown; requestId?: string; device?: string; session?: string; adminSession?: string }): Promise<ApiResult>;
}

interface GoogleScriptRun {
  withSuccessHandler(fn: (r: string) => void): GoogleScriptRun;
  withFailureHandler(fn: (e: Error) => void): GoogleScriptRun;
  [fn: string]: unknown;
}
declare const google: { script: { run: GoogleScriptRun } } | undefined;

export class GasTransport implements Transport {
  constructor(readonly mode: 'staff' | 'admin') {}
  call(req: { op: string; args?: unknown; requestId?: string; device?: string; session?: string; adminSession?: string }): Promise<ApiResult> {
    const fn = this.mode === 'staff' ? 'staffApi' : 'adminApi';
    return new Promise((resolve) => {
      if (typeof google === 'undefined') {
        resolve({ ok: false, error: { code: 'NO_GAS', message: 'Google Apps Script の環境ではありません' } });
        return;
      }
      const run = google.script.run
        .withSuccessHandler((r: string) => {
          try {
            resolve(JSON.parse(r) as ApiResult);
          } catch {
            resolve({ ok: false, error: { code: 'BAD_RESPONSE', message: 'サーバーの応答を読み取れませんでした' } });
          }
        })
        .withFailureHandler(() => resolve({ ok: false, error: { code: 'NETWORK', message: '通信に失敗しました。ネットワークを確認してください' } }));
      (run[fn] as (s: string) => void)(JSON.stringify(req));
    });
  }
}

export function newRequestId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return `r${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** UI から使うクライアント（端末トークン・セッションを付与。トークンはメモリ上のみ） */
export class Client {
  device = '';
  session = '';
  /** 管理者モードのセッション（v1.3。メモリ上のみ。ブラウザに保存しない） */
  adminSession = '';
  constructor(readonly transport: Transport) {}
  async raw<T>(op: string, args?: unknown, opts: { requestId?: string } = {}): Promise<ApiResult<T>> {
    return (await this.transport.call({
      op,
      args,
      requestId: opts.requestId ?? newRequestId(),
      device: this.device || undefined,
      session: this.session || undefined,
      adminSession: this.adminSession || undefined,
    })) as ApiResult<T>;
  }
  async call<T>(op: string, args?: unknown, opts: { requestId?: string } = {}): Promise<T> {
    const r = await this.raw<T>(op, args, opts);
    if (!r.ok) throw new ApiError(r.error.code, r.error.message);
    return r.data;
  }
}
