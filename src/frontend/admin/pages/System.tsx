/** システム情報・整合性チェック・保守作業の案内（管理者向け）。アプリの自動更新・自動ロールバックは v1.3 では提供しない（D-027 B案） */
import { useState } from 'react';
import { ErrorBox, Field, Loading, Panel, useAction, useClient, useLoad } from '../../components/ui';
import { validateAdminPassword } from '../../../shared/crypto';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

interface SystemInfo {
  envId: string | null;
  schemaVersion: number;
  expectedSchemaVersion: number;
  appVersion: string | null;
  codeVersion: string;
  maintenance: boolean;
  /** Google 所有者の保守作業の状態（D-027） */
  maintenanceWork?: { active: boolean; startedAt: string | null; readable: boolean };
  /** 画面の世代の記録があるか（ない場合は業務の更新が止まっている） */
  epochAvailable?: boolean;
  initializedAt: string | null;
  platform: string;
  storage: { limit: number | null; usage: number } | null;
}
interface Integrity {
  ok: boolean;
  issues: string[];
  checkedAt: string;
  counts: { employees: number };
}
function fmtDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}
function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
const PLATFORM_LABEL: Record<string, string> = { gas: 'Google Apps Script', mock: 'プレビュー（モック）' };

export function SystemPage() {
  const client = useClient();
  const info = useLoad(() => client.call<SystemInfo>('system.info'), []);
  const i = info.data;
  const rate = i?.storage && i.storage.limit ? i.storage.usage / i.storage.limit : null;
  const schemaMismatch = i ? i.schemaVersion !== i.expectedSchemaVersion : false;
  const versionMismatch = i ? i.appVersion !== i.codeVersion : false;

  return (
    <div style={PAGE_STYLE}>
      {info.loading && !i && <Loading />}
      {info.error && <ErrorBox message={info.error} onRetry={info.reload} />}
      {i && (
        <>
          {(i.maintenance || i.maintenanceWork?.active) && (
            <div className="callout callout-warn" role="status">
              <strong>保守作業中です。</strong>スタッフの打刻・データの更新は停止しています{i.maintenanceWork?.startedAt ? `（開始: ${fmtDateTime(i.maintenanceWork.startedAt)}）` : ''}。打刻は紙のタイムカードに記録してください。再開は Google 所有者が保守作業の終了（Shiftly-Staff のエディタの shiftlyMaintenanceFinish）で行います。この画面からは解除できません。
            </div>
          )}
          {i.epochAvailable === false && !i.maintenanceWork?.active && (
            <div className="callout callout-bull" role="status">
              <strong>データの更新を停止しています。</strong>画面の世代の記録を確認できません。Google 所有者が保守作業（運用手順書「保守作業」）を行うと再開します。
            </div>
          )}
          <AdminPasswordPanel />
          <div className="kpis">
            <div className="kpi">
              <div className="label">アプリのバージョン</div>
              <div className="value">{i.appVersion ?? '—'}</div>
              <div className="sub">{versionMismatch ? <span style={{ color: 'var(--warn)' }}>プログラムは {i.codeVersion}（記録と一致しません。Google 所有者に確認してください）</span> : `プログラム ${i.codeVersion}`}</div>
            </div>
            <div className="kpi">
              <div className="label">データベースの構造（スキーマ版）</div>
              <div className="value">
                v{i.schemaVersion}
                <span className="small muted"> / 期待 v{i.expectedSchemaVersion}</span>
              </div>
              <div className="sub">{schemaMismatch ? <span style={{ color: 'var(--bull)' }}>不一致: Google 所有者に確認してください（自動では更新しません）</span> : '一致しています'}</div>
            </div>
            <div className="kpi">
              <div className="label">保守作業</div>
              <div className="value" style={{ color: i.maintenance || i.maintenanceWork?.active ? 'var(--warn)' : 'var(--board-deep)' }}>{i.maintenance || i.maintenanceWork?.active ? '保守作業中' : '通常稼働'}</div>
              <div className="sub">{i.maintenance || i.maintenanceWork?.active ? 'データの更新を停止中' : 'スタッフは通常どおり利用できます'}</div>
            </div>
            <div className="kpi">
              <div className="label">Google ドライブの容量</div>
              <div className="value">{rate !== null ? `${Math.round(rate * 100)}%` : '—'}</div>
              {rate !== null && (
                <div className={`bar ${rate > 0.9 ? 'over' : ''}`} style={{ margin: '6px 0 4px' }} aria-hidden="true">
                  <i style={{ width: `${Math.min(100, rate * 100)}%` }} />
                </div>
              )}
              <div className="sub">
                {i.storage ? (i.storage.limit ? `${fmtBytes(i.storage.usage)} / ${fmtBytes(i.storage.limit)} 使用` : `${fmtBytes(i.storage.usage)} 使用（上限なし）`) : '容量を取得できませんでした'}
                {rate !== null && rate > 0.9 && <span style={{ color: 'var(--bull)' }}>　空き容量が少なくなっています</span>}
              </div>
            </div>
          </div>
          <Panel title="環境情報" actions={<button className="btn btn-sm btn-ghost" onClick={info.reload} disabled={info.loading}>再読み込み</button>}>
            <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 20px' }}>
              <dt className="muted small">環境ID</dt>
              <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{i.envId ?? '—'}</dd>
              <dt className="muted small">初期設定日時</dt>
              <dd style={{ margin: 0 }} className="num">{fmtDateTime(i.initializedAt)}</dd>
              <dt className="muted small">実行環境</dt>
              <dd style={{ margin: 0 }}>{PLATFORM_LABEL[i.platform] ?? i.platform}</dd>
            </dl>
            <p className="small muted" style={{ marginTop: 8 }}>環境IDは問い合わせ・復旧の際に環境を特定するための識別子です（秘密情報ではありません）。</p>
          </Panel>
        </>
      )}

      <IntegrityPanel />

      <MaintenanceGuide />
    </div>
  );
}

function IntegrityPanel() {
  const client = useClient();
  const { busy, run } = useAction();
  const [res, setRes] = useState<Integrity | null>(null);
  const check = async () => {
    const r = await run(() => client.call<Integrity>('system.integrityCheck'));
    if (r) setRes(r);
  };
  return (
    <Panel
      title="整合性チェック"
      actions={
        <button className="btn btn-primary btn-sm" onClick={check} disabled={busy}>
          {busy ? 'チェック中…' : '整合性チェックを実行'}
        </button>
      }
    >
      <p className="small muted">データベース内の参照関係（存在しないスタッフを参照する記録など）・重複・未完了の書き込み処理・スキーマ版を確認します。データは変更しません。</p>
      {res && <IntegrityResult r={res} />}
    </Panel>
  );
}

function IntegrityResult({ r }: { r: Integrity }) {
  return (
    <div className="stack" style={{ gap: 8, marginTop: 12 }} data-testid="integrity-result">
      <div className={`callout ${r.ok ? 'callout-board' : 'callout-bull'}`}>
        {r.ok ? '問題は見つかりませんでした。' : `${r.issues.length} 件の問題が見つかりました。`}
        <span className="small muted">　{fmtDateTime(r.checkedAt)} 確認・スタッフ {r.counts.employees} 名</span>
      </div>
      {r.issues.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 48 }}>#</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {r.issues.map((x, idx) => (
                <tr key={idx}>
                  <td className="num">{idx + 1}</td>
                  <td>{x}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!r.ok && <p className="small muted">解消できない場合は、Google 所有者に連絡してください。データの復元は安全性確保のため、Google所有者による保守作業として行います。</p>}
    </div>
  );
}

/** 保守作業の案内（D-027 B案。v1.3 は「正常時は自動・異常時は手動」） */
function MaintenanceGuide() {
  return (
    <Panel title="アップデート・データの復元（保守作業）">
      <div className="stack" style={{ gap: 10 }}>
        <p className="small">
          v1.3 では、アプリの自動更新・自動ロールバック・アプリ内のデータの復元を行いません。<strong>データの復元は安全性確保のため、Google所有者による保守作業として行います。</strong>アプリの更新も同じく、Google 所有者が保守作業として行います。
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li>保守作業の間は、スタッフの打刻・データの更新・定期処理が止まります。打刻は紙のタイムカードに記録してください。</li>
          <li>保守作業の終了時に、全スタッフ・管理者のログインが解除されます。作業前に開いていた画面は読み込み直してください。</li>
          <li>手順は運用手順書（docs/operations-guide.md「保守作業」）にあります。</li>
        </ul>
      </div>
    </Panel>
  );
}

function AdminPasswordPanel() {
  const client = useClient();
  const st = useLoad(() => client.call<{ configured: boolean; setBy: string | null; passwordChangedAt: string | null; locked: boolean; lockedUntil: string | null; activeSessions: number; idleTimeoutSec: number }>('adminAuth.status'), []);
  const { busy, run } = useAction();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const err = pw ? validateAdminPassword(pw) : null;
  const d = st.data;
  const submit = async () => {
    const v = pw;
    setPw('');
    setPw2('');
    const r = await run(() => client.call('adminAuth.setPassword', { password: v }), d?.configured ? '管理者パスワードを再設定しました' : '管理者パスワードを設定しました');
    if (r) st.reload();
  };
  return (
    <Panel title="管理者パスワード（店舗 iPad の「管理者ページ」）">
      {st.loading && !d && <Loading />}
      {st.error && <ErrorBox message={st.error} onRetry={st.reload} />}
      {d && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            {d.configured ? <span className="badge badge-board">設定済み</span> : <span className="badge badge-warn">未設定（店舗 iPad から管理者ページに入れません）</span>}
            {d.passwordChangedAt && <span className="small muted">最終変更 {d.passwordChangedAt.slice(0, 16).replace('T', ' ')}（{d.setBy === 'owner' ? 'Google 所有者' : '管理者'}）</span>}
            {d.locked && <span className="badge badge-bull">入力失敗によりロック中</span>}
            <span className="small muted">有効な管理者モード {d.activeSessions} 件</span>
          </div>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              if (!err && pw && pw === pw2) void submit();
            }}
          >
            <Field label={d.configured ? '新しいパスワード（再設定）' : '管理者パスワード'} hint="12文字以上・英大文字/英小文字/数字/記号のうち3種類以上">
              <input className="input" type="password" autoComplete="new-password" maxLength={128} value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            <Field label="確認のためもう一度">
              <input className="input" type="password" autoComplete="new-password" maxLength={128} value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </Field>
            <div className="row" style={{ gridColumn: '1/-1' }}>
              <button type="submit" className="btn btn-primary" disabled={busy || !pw || !!err || pw !== pw2}>
                {d.configured ? '再設定' : '設定'}
              </button>
              {d.locked && (
                <button type="button" className="btn" disabled={busy} onClick={async () => (await run(() => client.call('adminAuth.unlock'), 'ロックを解除しました')) && st.reload()}>
                  ロックを解除
                </button>
              )}
              {d.activeSessions > 0 && (
                <button type="button" className="btn" disabled={busy} onClick={async () => (await run(() => client.call('adminAuth.revokeSessions'), 'すべての管理者モードを終了しました')) && st.reload()}>
                  すべての管理者モードを終了
                </button>
              )}
            </div>
          </form>
          {err && <span className="small" style={{ color: 'var(--bull)' }}>{err}</span>}
          {!err && pw2 && pw !== pw2 && <span className="small" style={{ color: 'var(--bull)' }}>確認用のパスワードが一致しません</span>}
          <p className="small muted">
            店舗 iPad の右上「管理者ページ」から入るためのパスワードです（スタッフの PIN とは別）。設定・再設定は Google 所有者のこの画面からのみ行えます。再設定すると、すべての管理者モードが終了します。システムの更新・復旧は、引き続き Google 所有者の操作が必要です。
          </p>
        </div>
      )}
    </Panel>
  );
}
