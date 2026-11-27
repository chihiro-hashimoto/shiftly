/**
 * ブラウザでの権限承認・初期化の画面（A案・D-029）
 *
 * 共通の Shiftly Setup の「Google の権限を承認して初期化」「Google の権限を承認して接続」は、Shiftly-Staff / Shiftly-Admin の
 * テスト用 URL（/dev。プロジェクトの編集者＝Google 所有者だけが開ける）を `#shiftly-init=…` 付きで開く。この画面はその場合にだけ
 * 表示し、所有者の操作（ボタン）で初期化・接続を実行する。スクリプトエディタは開かない。
 *
 * - Staff: google.script.run.shiftlyWebInitialize(確認コード)。サーバーで「操作しているアカウント＝実行するアカウント」と
 *   確認コードのハッシュを確かめる（src/gas/core.ts）。匿名の公開 URL から開いても初期化されない
 * - Admin: google.script.run.shiftlyAuthorize()（Admin は「自分のみ」がアクセスできる。Core との接続を設定する）
 * 確認コードは画面に表示しない・端末に保存しない。URL のフラグメント（#）は Google のサーバーに送られない
 */
import { useEffect, useState, type ReactNode } from 'react';

interface ScriptRun {
  withSuccessHandler(fn: (r: unknown) => void): ScriptRun;
  withFailureHandler(fn: (e: Error) => void): ScriptRun;
  [fn: string]: unknown;
}
declare const google:
  | {
      script: {
        run: ScriptRun;
        url?: { getLocation(cb: (loc: { hash?: string }) => void): void };
      };
    }
  | undefined;

/** フラグメント（# の後）から初期化の指示を取り出す。形式が合わない場合は null */
export function parseInitHash(hash: string | undefined | null): string | null {
  const h = (hash ?? '').replace(/^#/, '');
  const m = /(?:^|&)shiftly-init=([0-9a-f]{64}|admin)(?:&|$)/.exec(h);
  return m ? m[1]! : null;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

/**
 * role の画面で、URL に初期化の指示がある場合だけ初期化の画面を表示し、それ以外は children（通常の画面）を表示する。
 * GAS の外（プレビュー）では常に通常の画面
 */
export function WebInitGate({ role, children }: { role: 'staff' | 'admin'; children: ReactNode }) {
  const inGas = typeof google !== 'undefined' && !!google.script.url;
  const [checked, setChecked] = useState(!inGas);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    if (!inGas) return;
    try {
      google!.script.url!.getLocation((loc) => {
        setToken(parseInitHash(loc.hash));
        setChecked(true);
      });
    } catch {
      setChecked(true);
    }
  }, [inGas]);
  if (!checked) return null;
  const valid = token && (role === 'admin' ? token === 'admin' : token !== 'admin');
  if (!valid) return <>{children}</>;
  return <WebInitPanel role={role} code={token} />;
}

export function WebInitPanel({ role, code, run }: { role: 'staff' | 'admin'; code: string; run?: () => Promise<{ ok: boolean; message?: string }> }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [msg, setMsg] = useState('');
  const name = role === 'staff' ? 'Shiftly-Staff（店舗 iPad 用の本体）' : 'Shiftly-Admin（管理画面）';
  const exec = async () => {
    setPhase('running');
    setMsg('');
    try {
      const r = await (run ?? (() => callServer(role, code)))();
      setPhase(r.ok ? 'done' : 'error');
      setMsg(r.message ?? '');
    } catch (e) {
      setPhase('error');
      setMsg(e instanceof Error ? e.message : '実行できませんでした');
    }
  };
  return (
    <div className="setup">
      <main className="s-main" style={{ maxWidth: 640 }}>
        <section className="panel">
          <div className="panel-head">
            <h1 style={{ fontSize: '1.25rem', margin: 0 }}>{role === 'staff' ? 'Shiftly の初期化' : '管理画面の接続'}</h1>
          </div>
          <div className="panel-body stack">
            <p className="small">
              {name}を、あなたの Google アカウントの中で使えるように設定します。
              {role === 'staff'
                ? 'Google ドライブに「Shiftly」フォルダとデータベース（スプレッドシート）を作成し、毎日のバックアップの予約を登録します。Shiftly が作成したファイル以外にはアクセスしません。'
                : '管理画面と Shiftly 本体の接続を設定します。'}
            </p>
            {phase === 'done' ? (
              <div className="callout callout-board" role="status">
                <strong>完了しました。</strong>
                <div className="small">このタブを閉じて Shiftly Setup の画面に戻り、「確認して続行」を押してください。</div>
              </div>
            ) : (
              <>
                {phase === 'error' && (
                  <div className="callout callout-bull" role="alert">
                    <strong>完了できませんでした</strong>
                    <div className="small">{msg}</div>
                    <div className="small">解決しない場合は、Shiftly Setup の画面に表示される「うまくいかない場合」の方法（スクリプトエディタで実行）を使ってください。</div>
                  </div>
                )}
                <button className="btn btn-primary btn-lg" disabled={phase === 'running'} onClick={() => void exec()}>
                  {phase === 'running' ? '実行中…' : role === 'staff' ? '初期化する' : '接続する'}
                </button>
              </>
            )}
            <p className="small muted">この画面は、Shiftly を構築した Google アカウントでだけ使えます。店舗の iPad では開かないでください。</p>
          </div>
        </section>
      </main>
    </div>
  );
}

function callServer(role: 'staff' | 'admin', code: string): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    if (typeof google === 'undefined') return reject(new Error('Google Apps Script の環境ではありません'));
    const run = google.script.run
      .withSuccessHandler((r: unknown) => {
        if (role === 'admin') return resolve({ ok: !!(r as { ok?: boolean } | null)?.ok });
        try {
          const j = JSON.parse(String(r)) as { ok: boolean; error?: { message?: string } };
          resolve({ ok: j.ok, message: j.error?.message });
        } catch {
          reject(new Error('サーバーの応答を読み取れませんでした'));
        }
      })
      .withFailureHandler((e: Error) => reject(new Error(e?.message || '通信に失敗しました')));
    if (role === 'staff') (run.shiftlyWebInitialize as (c: string) => void)(code);
    else (run.shiftlyAuthorize as () => void)();
  });
}
