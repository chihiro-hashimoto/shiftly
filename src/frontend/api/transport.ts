/**
 * API 通信層
 * - GAS 本番: google.script.run（staffApi / adminApi）
 * - プレビュー: ブラウザ内のモック Core（メモリ上のみ。端末へ保存しない）
 * 業務データを含む応答はメモリ上でのみ扱い、localStorage 等へは保存しない。
 */
export type ApiResult<T = unknown> = { ok: true; data: T; epoch?: number | null } | { ok: false; error: { code: string; message: string }; epoch?: number | null };

export interface Transport {
  mode: 'staff' | 'admin';
  call(req: { op: string; args?: unknown; requestId?: string; device?: string; session?: string; adminSession?: string; epoch?: number }): Promise<ApiResult>;
}

interface GoogleScriptRun {
  withSuccessHandler(fn: (r: string) => void): GoogleScriptRun;
  withFailureHandler(fn: (e: Error) => void): GoogleScriptRun;
  [fn: string]: unknown;
}
declare const google: { script: { run: GoogleScriptRun } } | undefined;

export class GasTransport implements Transport {
  constructor(readonly mode: 'staff' | 'admin') {}
  call(req: { op: string; args?: unknown; requestId?: string; device?: string; session?: string; adminSession?: string; epoch?: number }): Promise<ApiResult> {
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

/** 復元より前に読み込んだ画面（古い世代）を検知したときの通知先（D-026。画面全体を作り直す案内を出す） */
const staleListeners = new Set<() => void>();
export function onStaleView(fn: () => void): () => void {
  staleListeners.add(fn);
  return () => {
    staleListeners.delete(fn);
  };
}

/**
 * UI から使うクライアント（端末トークン・セッションを付与。トークンはメモリ上のみ）
 * 復元世代（D-026）: このクライアントが最初に受け取った世代を固定し、以後のすべての要求に付ける。固定した世代は途中で
 * 置き換えない（古い画面の編集内容に新しい世代を付け直して送らない）。異なる世代の応答や STALE_VIEW を受け取ったら、
 * 画面全体を作り直す（クライアントも作り直す）までの間、古い画面として扱う。再ログインしても固定した世代は変わらない
 */
export class Client {
  device = '';
  session = '';
  /** 管理者モードのセッション（v1.3。メモリ上のみ。ブラウザに保存しない） */
  adminSession = '';
  /** 固定した復元世代（未受信は undefined。サーバーに記録がない場合は null） */
  epoch: number | null | undefined = undefined;
  /** 復元より前に読み込んだ画面と判明したか */
  stale = false;
  constructor(readonly transport: Transport) {}
  private markStale() {
    if (this.stale) return;
    this.stale = true;
    for (const f of [...staleListeners]) f();
  }
  async raw<T>(op: string, args?: unknown, opts: { requestId?: string } = {}): Promise<ApiResult<T>> {
    const r = (await this.transport.call({
      op,
      args,
      requestId: opts.requestId ?? newRequestId(),
      device: this.device || undefined,
      session: this.session || undefined,
      adminSession: this.adminSession || undefined,
      ...(typeof this.epoch === 'number' ? { epoch: this.epoch } : {}),
    })) as ApiResult<T>;
    if (r.epoch !== undefined) {
      if (this.epoch === undefined) this.epoch = r.epoch;
      else if (r.epoch !== this.epoch) this.markStale();
    }
    if (!r.ok && r.error.code === 'STALE_VIEW') this.markStale();
    return r;
  }
  async call<T>(op: string, args?: unknown, opts: { requestId?: string } = {}): Promise<T> {
    const r = await this.raw<T>(op, args, opts);
    if (!r.ok) throw new ApiError(r.error.code, r.error.message);
    return r.data;
  }
}
