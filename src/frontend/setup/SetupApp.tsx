/**
 * Shiftly Setup（初期セットアップウィザード F29 / 中断・再開 F34 / 更新 F36 / ロールバック F37）
 * サーバー側（src/gas/setup.ts）の状態機械を 1 工程ずつ進める。進捗は Google 側に保存され、
 * この画面を閉じても途中から再開できる（端末には保存しない）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Wordmark } from '../components/brand';
import { QrCode } from '../components/qr';
import type { PublicState, StepResult } from '../../setup/installer';
import './setup.css';

export interface SetupTransport {
  call<T>(action: string, args?: Record<string, unknown>): Promise<T>;
  demo?: boolean;
}

declare const google: { script: { run: Record<string, unknown> & { withSuccessHandler: (f: (r: string) => void) => { withFailureHandler: (f: (e: Error) => void) => Record<string, (s: string) => void> } } } } | undefined;

export const gasSetupTransport: SetupTransport = {
  call<T>(action: string, args?: Record<string, unknown>) {
    return new Promise<T>((resolve, reject) => {
      if (typeof google === 'undefined') return reject(new Error('Google Apps Script の環境ではありません'));
      google.script.run
        .withSuccessHandler((r: string) => {
          const j = JSON.parse(r) as { ok: boolean; data?: T; error?: { message: string } };
          if (j.ok) resolve(j.data as T);
          else reject(new Error(j.error?.message ?? 'エラー'));
        })
        .withFailureHandler((e: Error) => reject(new Error(e.message || '通信に失敗しました')))
        .setupApi!(JSON.stringify({ action, args }));
    });
  },
};

export function SetupApp({ transport = gasSetupTransport, notice }: { transport?: SetupTransport; notice?: string }) {
  const [st, setSt] = useState<PublicState | null>(null);
  const [res, setRes] = useState<StepResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // 作成の結果が分からない場合の確認（確認するまで「再実行」を押せない。Codex 監査19 #2）
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [res]);
  // 既存のプロジェクト・デプロイの関連付け（作成の結果が分からない・記録したものが見つからない場合。D-026 S1）
  const [attachId, setAttachId] = useState('');
  const [attachMsg, setAttachMsg] = useState('');
  useEffect(() => {
    setAttachId('');
    setAttachMsg('');
  }, [res]);
  const attach = async (step: string) => {
    setBusy(true);
    setAttachMsg('');
    try {
      const r = await transport.call<{ ok: boolean; message: string }>('attach', { step, id: attachId.trim() });
      setAttachMsg(r.message);
      if (r.ok) {
        setRes(null);
        await load();
      }
    } catch (e) {
      setAttachMsg(e instanceof Error ? e.message : '関連付けに失敗しました');
    } finally {
      setBusy(false);
    }
  };
  const [storeName, setStoreName] = useState('');

  const load = useCallback(async () => {
    try {
      setSt(await transport.call<PublicState>('state'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : '状態を取得できませんでした');
    }
  }, [transport]);
  useEffect(() => {
    void load();
  }, [load]);

  const exec = async (action: 'run' | 'retry', step?: string, confirmedNoDuplicate?: boolean) => {
    setBusy(true);
    setErr('');
    try {
      const r = await transport.call<StepResult>(action, { storeName: storeName || undefined, step, ...(confirmedNoDuplicate ? { confirmedNoDuplicate: true } : {}) });
      setRes(r);
      setSt(r.state);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '実行に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const needStore = st && !st.storeName;
  const nextStep = st?.steps.find((s) => s.status !== 'done');
  return (
    <div className="setup">
      {notice && <div className="sample-banner">{notice}</div>}
      <header className="s-head">
        <Wordmark size={30} />
        <span className="s-sub">セットアップ</span>
      </header>
      <main className="s-main">
        <section className="s-intro">
          <h1>{st?.complete ? 'Shiftly の準備ができました' : 'Shiftly を管理者の Google アカウントに準備します'}</h1>
          {!st?.complete && (
            <p className="muted">
              Shiftly 用のフォルダ・データベース（スプレッドシート）・アプリ本体を、管理者の Google ドライブ内に作成します。Shiftly が作成したファイル以外にはアクセスしません。途中で画面を閉じても、次回この画面を開くと続きから再開できます。
            </p>
          )}
          {st?.ownerEmail && <p className="small muted">Google アカウント: {st.ownerEmail}　／　環境ID: {st.envId}</p>}
        </section>

        {err && <div className="callout callout-bull" role="alert">{err}</div>}
        {!st && !err && <div className="loading-block"><div className="spinner" />状態を確認しています…</div>}

        {st && (
          <div className="s-grid">
            <ol className="s-steps" aria-label="セットアップの工程">
              {st.steps.map((s) => (
                <li key={s.id} className={`s-step ${s.status}${nextStep?.id === s.id ? ' current' : ''}`}>
                  <span className="s-mark" aria-hidden="true">{s.status === 'done' ? '✓' : s.status === 'error' ? '!' : ''}</span>
                  <span>
                    {s.label}
                    {s.manual && <span className="badge badge-brass" style={{ marginLeft: 6 }}>管理者の操作が必要</span>}
                    {s.status === 'error' && s.message && <span className="s-msg">{s.message}</span>}
                  </span>
                </li>
              ))}
            </ol>

            <div className="s-panel">
              {!st.complete && (
                <>
                  {needStore && (
                    <label className="field">
                      <span>店舗名</span>
                      <input className="input" value={storeName} onChange={(e) => setStoreName(e.target.value)} maxLength={60} placeholder="例: ダーツバー〇〇" />
                    </label>
                  )}
                  {res?.error && (
                    <div className="callout callout-bull" role="alert">
                      <strong>{res.error.message}</strong>
                      <div className="small">対処方法: {res.error.fix}</div>
                      {res.error.confirm && (
                        <label className="row small" style={{ marginTop: 8 }}>
                          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                          <span>{res.error.confirm}</span>
                        </label>
                      )}
                      {res.error.confirm && /\.(create|deploy)$/.test(res.error.step) && (
                        <div className="row small" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                          <label className="field" style={{ flex: '1 1 220px' }}>
                            <span>既存の ID を関連付ける（Apps Script の画面で見つけた{res.error.step.endsWith('.create') ? 'プロジェクト' : 'デプロイ'}の ID）</span>
                            <input className="input" value={attachId} onChange={(e) => setAttachId(e.target.value)} maxLength={200} autoComplete="off" />
                          </label>
                          <button className="btn btn-sm" disabled={busy || attachId.trim().length < 3} onClick={() => void attach(res.error!.step)}>
                            関連付ける
                          </button>
                        </div>
                      )}
                      {attachMsg && <div className="small">{attachMsg}</div>}
                    </div>
                  )}
                  {res?.waitingFor && (
                    <div className="callout callout-board">
                      <strong>管理者の操作が必要です</strong>
                      <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
                        {res.waitingFor.instructions.map((t) => (
                          <li key={t}>{t}</li>
                        ))}
                      </ol>
                      {res.waitingFor.openUrl && (
                        <a className="btn btn-sm" style={{ marginTop: 8 }} href={res.waitingFor.openUrl} target="_blank" rel="noopener noreferrer">
                          スクリプトエディタを開く
                        </a>
                      )}
                    </div>
                  )}
                  <div className="row">
                    {res?.error ? (
                      <button className="btn btn-primary btn-lg" disabled={busy || (!!res.error.confirm && !confirmed)} onClick={() => void exec('retry', res.error!.step, res.error!.confirm ? confirmed : undefined)}>
                        {busy ? '実行中…' : res.error.confirm ? '確認したので再実行' : '再実行'}
                      </button>
                    ) : (
                      <button className="btn btn-primary btn-lg" disabled={busy || (!!needStore && !storeName.trim())} onClick={() => void exec('run')}>
                        {busy ? '実行中…' : res?.waitingFor ? '確認して続行' : st.steps.some((s) => s.status === 'done') ? '続きから実行' : 'セットアップを開始'}
                      </button>
                    )}
                  </div>
                  <p className="small muted">Google の権限確認画面が表示された場合は、内容を確認して許可してください。Shiftly が承認を代わりに行うことはありません。</p>
                </>
              )}
              {st.complete && <Complete st={st} />}
            </div>
          </div>
        )}
        {st?.complete && <MaintenanceNote />}
      </main>
    </div>
  );
}

function Complete({ st }: { st: PublicState }) {
  return (
    <div className="stack">
      <div className="callout callout-board">セットアップが完了しました（バージョン {st.installedVersion ?? '—'}）。</div>
      {st.verification && (
        <div className="small">
          <strong>完了前の確認</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            {st.verification.checked.map((c) => (
              <li key={c}>確認済み: {c}</li>
            ))}
          </ul>
          {st.verification.unverified.length > 0 && (
            <div className="callout" style={{ marginTop: 8 }}>
              <strong>自動では確認できない項目（所有者が確認済み）</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                {st.verification.unverified.map((c) => (
                  <li key={c}>{(st.verification?.ownerConfirmed ?? []).includes(c) ? '所有者が確認: ' : '未確認: '}{c}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="s-urls">
        <div>
          <h3>管理者用（管理画面）</h3>
          <p className="small muted">管理者の Google アカウントでのみ開けます。ブックマークしてください。店舗の共用 iPad では開かないでください。</p>
          {st.adminUrl && (
            <a className="btn btn-primary" href={st.adminUrl} target="_blank" rel="noopener noreferrer">
              管理画面を開く
            </a>
          )}
        </div>
        <div>
          <h3>スタッフ用（店舗 iPad）</h3>
          <p className="small muted">iPad の Safari でこの QR を読み取り、ホーム画面に追加してください。初回は管理画面「店舗端末」で発行する登録コードを入力します。</p>
          {st.staffUrl && <QrCode text={st.staffUrl} label="スタッフ用URLのQRコード" />}
          <p className="small" style={{ wordBreak: 'break-all' }}>{st.staffUrl}</p>
        </div>
      </div>
    </div>
  );
}

/** v1.3 では Setup からのアプリの更新・ロールバックを提供しない（D-027 B案）。案内だけを表示する */
function MaintenanceNote() {
  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>アップデート・保守</h2>
      </div>
      <div className="panel-body stack">
        <p className="small">
          v1.3 では、構築済みの環境のアプリの更新・ロールバックを Setup から行いません。データの復元・アプリの更新は、安全性確保のため Google 所有者による保守作業として行います（導入手順書・運用手順書「保守作業」）。
        </p>
      </div>
    </section>
  );
}
