/**
 * Shiftly Setup（初期セットアップウィザード F29 / 中断・再開 F34 / 更新 F36 / ロールバック F37）
 * サーバー側（src/gas/setup.ts）の状態機械を 1 工程ずつ進める。進捗は Google 側に保存され、
 * この画面を閉じても途中から再開できる（端末には保存しない）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Wordmark } from '../components/brand';
import { QrCode } from '../components/qr';
import { USER_SETTINGS_URL, type PublicState, type StepResult } from '../../setup/installer';
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
  // まだ構築を始めていない（Setup の記録がない）: 構築の内容と確認事項を表示する（A案・D-029）
  const notStarted = !!st && !st.envId && !st.complete;
  const apiOff = res?.error?.code === 'USER_API_DISABLED';
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

        {notStarted && <BuildPlan email={st.currentEmail} />}

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
                      {apiOff && (
                        <a className="btn btn-sm" style={{ marginTop: 8 }} href={USER_SETTINGS_URL} target="_blank" rel="noopener noreferrer">
                          Google の設定画面を開く
                        </a>
                      )}
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
                      {res.waitingFor.initUrl && (
                        <a className="btn btn-primary btn-sm" style={{ marginTop: 8 }} href={res.waitingFor.initUrl} target="_blank" rel="noopener noreferrer">
                          {res.waitingFor.step === 'admin.authorize' ? 'Google の権限を承認して接続' : 'Google の権限を承認して初期化'}
                        </a>
                      )}
                      {res.waitingFor.initUrl && res.waitingFor.openUrl && (
                        <p className="small" style={{ margin: '10px 0 0' }}>
                          うまくいかない場合: 下のボタンでスクリプトエディタを開き、関数の選択欄で「shiftlyAuthorize」を選んで「実行」→ 権限を確認して「許可」→ この画面で「確認して続行」を押してください。
                        </p>
                      )}
                      {res.waitingFor.openUrl && (
                        <a className="btn btn-sm" style={{ marginTop: 8 }} href={res.waitingFor.openUrl} target="_blank" rel="noopener noreferrer">
                          スクリプトエディタを開く
                        </a>
                      )}
                    </div>
                  )}
                  {busy && (
                    <div className="loading-block small" role="status">
                      <div className="spinner" />
                      {nextStep ? `「${nextStep.label}」を実行しています…（Google の処理に数十秒かかることがあります。画面を閉じないでください）` : '実行しています…'}
                    </div>
                  )}
                  <div className="row">
                    {res?.error ? (
                      <button className="btn btn-primary btn-lg" disabled={busy || (!!res.error.confirm && !confirmed)} onClick={() => void exec('retry', res.error!.step, res.error!.confirm ? confirmed : undefined)}>
                        {busy ? '実行中…' : res.error.confirm ? '確認したので再実行' : apiOff ? '設定が完了したので再確認' : '再実行'}
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
      <section className="callout" aria-label="次に行うこと">
        <strong>次に行うこと</strong>
        <ol className="small" style={{ margin: '6px 0 0', paddingLeft: 20 }}>
          <li>下の「管理画面を開く」で管理画面を開き、「システム・保守」で<strong>管理者パスワード</strong>（12 文字以上）を設定します（店舗 iPad の「管理者ページ」に入るためのパスワードです）。</li>
          <li>「店舗設定」「スタッフ・権限」で、営業時間・締め日・スタッフ・給与条件を登録します（実データの登録は、導入手順書の公開前の確認を終えてから）。</li>
          <li>「店舗端末」で<strong>登録コード</strong>を発行します。</li>
          <li>店舗 iPad の Safari で下の QR コードを読み取り、共有メニューの「ホーム画面に追加」で追加して、登録コードを入力します（iPad では Google にログインしないでください）。</li>
        </ol>
      </section>
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

/** 構築を始める前に、構築先のアカウント・作成するもの・保存先・必要な権限・確認事項を表示する（A案・D-029） */
function BuildPlan({ email }: { email: string | null }) {
  return (
    <section className="panel" style={{ marginBottom: 20 }} aria-label="構築の内容">
      <div className="panel-head">
        <h2>構築の内容</h2>
      </div>
      <div className="panel-body stack small">
        <p>
          <strong>構築先の Google アカウント:</strong> {email ?? '確認できません（画面を再読み込みしてください）'}
          <br />
          <span className="muted">店舗の Google 所有者のアカウントであることを確認してください。違う場合は、このタブを閉じ、正しいアカウントだけでログインしたブラウザ（シークレットウィンドウ等）で開き直してください。</span>
        </p>
        <div>
          <strong>あなたの Google アカウントの中に作成するもの</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            <li>Google ドライブの「Shiftly」フォルダとデータベース（スプレッドシート）・バックアップ</li>
            <li>Apps Script のプロジェクト 2 つ（Shiftly-Staff: 店舗 iPad 用の本体／Shiftly-Admin: 管理画面）</li>
            <li>Setup の記録ファイル（Google ドライブの「Shiftly Setup Registry.json」）</li>
          </ul>
        </div>
        <p>
          <strong>保存先:</strong> 勤怠・給与・スタッフの情報は、あなたの Google ドライブだけに保存します。Shiftly Setup の提供者（開発者）の Google ドライブには保存しません。Setup の進み具合の記録（店舗名・アカウント・作成したプロジェクトの ID）は、あなたの Google ドライブと、Setup の中のあなた専用の保存領域（Google のユーザーごとの保存領域）に保存します。費用はかかりません。
        </p>
        <div>
          <strong>Google の確認画面で許可を求める権限</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            <li>Apps Script のプロジェクトの作成・コードの配置・デプロイ（Shiftly-Staff・Shiftly-Admin を作るため）</li>
            <li>Shiftly が作成したファイルだけの Google ドライブの操作（データベース・記録ファイル。ほかのファイルは見ません）</li>
            <li>外部への接続（Google の API と、作成した Shiftly-Staff への接続）・メールアドレスの確認（アカウントの取り違えの防止）</li>
          </ul>
        </div>
        <div>
          <strong>始める前の確認</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
            <li>途中で Google の確認画面が数回表示されます。内容を確認してから「許可」を押してください（Shiftly が代わりに許可することはありません）。</li>
            <li>「Google Apps Script API」がオフの場合は、案内に従って Google の設定画面でオンにします（1 回だけ）。</li>
            <li>画面で課金（クレジットカード）の登録を求められた場合は中止し、提供者に連絡してください。</li>
          </ul>
        </div>
      </div>
    </section>
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
