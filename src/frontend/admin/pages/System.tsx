/** システム情報・整合性チェック・アップデート（店長向け） F35/F36/F37 */
import { useState } from 'react';
import { ErrorBox, Loading, Modal, Panel, useAction, useClient, useLoad } from '../../components/ui';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

interface SystemInfo {
  envId: string | null;
  schemaVersion: number;
  expectedSchemaVersion: number;
  appVersion: string | null;
  codeVersion: string;
  maintenance: boolean;
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
interface MigrateResult {
  applied: string[];
  requiresApproval: string[];
}
interface FinishResult {
  appVersion: string;
  integrity: Integrity;
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
  const [releaseOpen, setReleaseOpen] = useState(false);
  const { busy, run } = useAction();
  const i = info.data;
  const rate = i?.storage && i.storage.limit ? i.storage.usage / i.storage.limit : null;
  const schemaMismatch = i ? i.schemaVersion !== i.expectedSchemaVersion : false;
  const versionMismatch = i ? i.appVersion !== i.codeVersion : false;

  const release = async () => {
    const r = await run(() => client.call<{ maintenance: boolean }>('system.setMaintenance', { on: false }), 'メンテナンスを解除しました');
    if (r) {
      setReleaseOpen(false);
      info.reload();
    }
  };

  return (
    <div style={PAGE_STYLE}>
      {info.loading && !i && <Loading />}
      {info.error && <ErrorBox message={info.error} onRetry={info.reload} />}
      {i && (
        <>
          {i.maintenance && (
            <div className="callout callout-warn" role="status">
              <strong>メンテナンス中です。</strong>スタッフの打刻・更新操作は停止しています。アップデートが中断した場合は下の「更新が中断した場合」の手順を実行してください。更新が完了しているのにメンテナンスが続いている場合は、手動で解除できます。
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-sm" onClick={() => setReleaseOpen(true)} disabled={busy}>
                  メンテナンスを解除
                </button>
              </div>
            </div>
          )}
          <div className="kpis">
            <div className="kpi">
              <div className="label">アプリのバージョン</div>
              <div className="value">{i.appVersion ?? '—'}</div>
              <div className="sub">{versionMismatch ? <span style={{ color: 'var(--warn)' }}>プログラムは {i.codeVersion}（更新が完了していない可能性）</span> : `プログラム ${i.codeVersion}`}</div>
            </div>
            <div className="kpi">
              <div className="label">データベースの構造（スキーマ版）</div>
              <div className="value">
                v{i.schemaVersion}
                <span className="small muted"> / 期待 v{i.expectedSchemaVersion}</span>
              </div>
              <div className="sub">{schemaMismatch ? <span style={{ color: 'var(--bull)' }}>不一致: DB 更新が必要です</span> : '一致しています'}</div>
            </div>
            <div className="kpi">
              <div className="label">メンテナンス</div>
              <div className="value" style={{ color: i.maintenance ? 'var(--warn)' : 'var(--board-deep)' }}>{i.maintenance ? 'メンテナンス中' : '通常稼働'}</div>
              <div className="sub">{i.maintenance ? 'スタッフの書き込みを停止中' : 'スタッフは通常どおり利用できます'}</div>
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

      <div className="two-col">
        <UpdateGuide />
        <ResumeUpdate onChanged={info.reload} />
      </div>

      {releaseOpen && (
        <Modal
          title="メンテナンスを解除しますか？"
          onClose={() => setReleaseOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setReleaseOpen(false)}>
                キャンセル
              </button>
              <button className="btn btn-primary" onClick={release} disabled={busy}>
                解除する
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 10 }}>
            <p>スタッフの打刻・更新操作を再開します。</p>
            {(schemaMismatch || versionMismatch) && (
              <div className="callout callout-bull small">
                データベースの構造またはアプリのバージョンが一致していません。更新が完了していない状態で解除すると、データが正しく保存されない可能性があります。先に「更新が中断した場合」の手順を実行することをおすすめします。
              </div>
            )}
          </div>
        </Modal>
      )}
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
      {!r.ok && <p className="small muted">解消できない場合は、バックアップからの復元（「バックアップ」ページ）を検討してください。</p>}
    </div>
  );
}

function UpdateGuide() {
  return (
    <Panel title="アップデートの手順">
      <div className="stack" style={{ gap: 10 }}>
        <p className="small">
          アップデートは、店長のパソコンから <strong>「Shiftly Setup」</strong>を開いて実行します。この画面から新しいバージョンを取得することはありません。
        </p>
        <ol className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li><strong>更新前バックアップ</strong>: メンテナンス状態にしてスタッフの書き込みを止め、現在のデータをバックアップします（失敗した場合は更新を中止）。</li>
          <li><strong>コード更新</strong>: アプリのプログラムを新しいバージョンに差し替えます。</li>
          <li><strong>DB 更新</strong>: 必要に応じてデータベースの構造を更新します。</li>
          <li><strong>動作確認</strong>: 整合性チェックを行い、問題がなければメンテナンスを解除します。</li>
        </ol>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li>失敗した場合は、Shiftly Setup から以前のバージョンへ<strong>ロールバック</strong>できます。データは更新前バックアップ（「バックアップ」ページの「更新前」）から復元できます。</li>
          <li>列の削除などデータが失われる可能性のある<strong>破壊的な DB 変更は、店長の承認なしには実行しません</strong>。</li>
          <li>営業時間外など、スタッフが打刻しない時間帯に実行してください。</li>
        </ul>
      </div>
    </Panel>
  );
}

function ResumeUpdate({ onChanged }: { onChanged: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [mig, setMig] = useState<MigrateResult | null>(null);
  const [approve, setApprove] = useState(false);
  const [fin, setFin] = useState<FinishResult | null>(null);
  const [acceptIssues, setAcceptIssues] = useState(false);

  const migrate = async (approveDestructive: boolean) => {
    const r = await run(() => client.call<MigrateResult>('system.migrate', { approveDestructive }));
    if (r) {
      setMig(r);
      setApprove(false);
      setFin(null);
      onChanged();
    }
  };
  const finish = async () => {
    const r = await run(() => client.call<FinishResult>('system.finishUpdate', { acceptIntegrityIssues: acceptIssues }), '更新を完了しました');
    if (r) {
      setFin(r);
      onChanged();
    }
  };
  const needsApproval = !!mig && mig.requiresApproval.length > 0;

  return (
    <Panel title="更新が中断した場合">
      <div className="stack" style={{ gap: 12 }}>
        <p className="small">
          Shiftly Setup での更新が途中で止まった場合（メンテナンスのまま・スキーマ版が不一致など）は、次の順に実行してください。通常は操作不要です。
        </p>
        <div style={{ borderLeft: '3px solid var(--line)', paddingLeft: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong className="small">1. DB 更新を再実行</strong>
            <button className="btn btn-sm" onClick={() => migrate(false)} disabled={busy}>
              DB 更新を再実行
            </button>
          </div>
          <p className="small muted">データベースの構造を最新にします。破壊的な変更が含まれる場合は実行せず、内容を表示します。</p>
          {mig && !needsApproval && (
            <div className="callout callout-board small" style={{ marginTop: 6 }}>
              {mig.applied.length ? (
                <>
                  適用した変更:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
                    {mig.applied.map((x, idx) => (
                      <li key={idx}>{x}</li>
                    ))}
                  </ul>
                </>
              ) : (
                'データベースの構造はすでに最新です（適用した変更はありません）。'
              )}
            </div>
          )}
          {needsApproval && (
            <div className="callout callout-bull small" style={{ marginTop: 6 }}>
              <strong>次の変更はデータが失われる可能性があるため、承認が必要です（まだ実行していません）。</strong>
              <ul style={{ margin: '4px 0 8px', paddingLeft: 20 }}>
                {mig.requiresApproval.map((x, idx) => (
                  <li key={idx}>{x}</li>
                ))}
              </ul>
              <p>実行前に「バックアップ」ページで更新前バックアップがあることを確認してください。</p>
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} />
                <span>上記の変更内容を確認し、実行を承認します</span>
              </label>
              <div style={{ marginTop: 8 }}>
                <button className="btn btn-danger btn-sm" onClick={() => migrate(true)} disabled={!approve || busy}>
                  承認して DB 更新を実行
                </button>
              </div>
            </div>
          )}
        </div>
        <div style={{ borderLeft: '3px solid var(--line)', paddingLeft: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong className="small">2. 更新を完了</strong>
            <button className="btn btn-sm btn-primary" onClick={finish} disabled={busy || needsApproval}>
              更新を完了する
            </button>
          </div>
          <p className="small muted">整合性チェックを行い、アプリのバージョンを記録してメンテナンスを解除します。問題が見つかった場合はメンテナンスを継続します。</p>
          <label className="check" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={acceptIssues} onChange={(e) => setAcceptIssues(e.target.checked)} />
            <span className="small">整合性チェックで問題が見つかっても完了する（表示された問題の内容を確認済み。スキーマ版の不一致は対象外）</span>
          </label>
          {fin && (
            <div style={{ marginTop: 6 }}>
              <p className="small">バージョン {fin.appVersion} として更新を完了しました。</p>
              <IntegrityResult r={fin.integrity} />
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
