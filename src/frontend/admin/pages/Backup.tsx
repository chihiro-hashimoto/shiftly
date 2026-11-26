/** バックアップ・復元 F26 */
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, Panel, useAction, useClient, useLoad, useToast } from '../../components/ui';
import type { BackupHistory, StoreSettings } from '../../../shared/types';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

const KIND_LABEL: Record<BackupHistory['kind'], string> = {
  daily: '日次',
  monthly: '月次',
  pre_update: '更新前',
  manual: '手動',
};
const KIND_BADGE: Record<BackupHistory['kind'], string> = {
  daily: '',
  monthly: 'badge-info',
  pre_update: 'badge-brass',
  manual: 'badge-board',
};

interface RestoreResult {
  restoredFrom: string;
  preservedRowsReinserted: number;
  previousDatabaseId: string;
  integrity: { ok: boolean; issues: string[]; checkedAt: string; counts: { employees: number } };
  note: string;
}

const CONFIRM_WORD = '復元する';

function fmtDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}
function fmtBytes(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function noteText(b: BackupHistory): string {
  if (b.note === 'manual request') return '管理画面から実行';
  return b.note;
}
function restorable(b: BackupHistory): boolean {
  return b.status === 'ok' && !!b.driveFileId;
}

export function BackupPage() {
  const client = useClient();
  // 店舗 iPad の管理者モードでは復元できない（Google 所有者に限定。Codex 監査18 #2）
  const isSharedDevice = client.transport.mode === 'staff';
  const { busy, run } = useAction();
  const list = useLoad(() => client.call<BackupHistory[]>('backup.list'), []);
  const st = useLoad(() => client.call<StoreSettings>('settings.get'), []);
  const [target, setTarget] = useState<BackupHistory | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const toast = useToast();
  const [kindFilter, setKindFilter] = useState<'' | BackupHistory['kind']>('');

  const rows = list.data ?? [];
  const lastOk = rows.find((b) => b.status === 'ok' && b.driveFileId);
  const latest = rows[0];
  const shown = rows.filter((b) => !kindFilter || b.kind === kindFilter);

  const runManual = async () => {
    setRunError(null);
    const r = await run(() => client.call<BackupHistory>('backup.run', { kind: 'manual' }));
    if (r) {
      list.reload();
      if (r.status === 'ok') toast('ok', 'バックアップを作成しました');
      else setRunError(`バックアップに失敗しました: ${r.note}`);
    }
  };

  return (
    <div style={PAGE_STYLE}>
      <div className="kpis">
        <div className="kpi">
          <div className="label">最新の正常なバックアップ</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>{list.data ? (lastOk ? fmtDateTime(lastOk.createdAt) : 'なし') : '—'}</div>
          <div className="sub">{lastOk ? `${KIND_LABEL[lastOk.kind]}・${fmtBytes(lastOk.sizeBytes)}` : '日次バックアップは毎日自動で作成されます'}</div>
        </div>
        <div className="kpi">
          <div className="label">直近の実行結果</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>
            {latest ? latest.status === 'ok' ? <span style={{ color: 'var(--board-deep)' }}>正常</span> : <span style={{ color: 'var(--bull)' }}>失敗</span> : '—'}
          </div>
          <div className="sub">{latest ? `${KIND_LABEL[latest.kind]}（${fmtDateTime(latest.createdAt)}）` : 'まだ実行されていません'}</div>
        </div>
        <div className="kpi">
          <div className="label">保存する世代数</div>
          <div className="value" style={{ fontSize: '1.6rem' }}>
            {st.data ? <>日次 {st.data.dailyBackupGenerations}・月次 {st.data.monthlyBackupGenerations}</> : '—'}
          </div>
          <div className="sub">
            初期値は日次30世代・月次12世代。勤怠・給与の記録は {st.data ? `${st.data.retentionYears}年` : '5年'}保存（初期値5年）。変更は「店舗設定」から
          </div>
        </div>
      </div>

      <Panel
        title="バックアップ一覧"
        actions={
          <>
            <select className="input" style={{ width: 130, minHeight: 32 }} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as '' | BackupHistory['kind'])} aria-label="種類で絞り込み">
              <option value="">すべての種類</option>
              <option value="daily">日次</option>
              <option value="monthly">月次</option>
              <option value="pre_update">更新前</option>
              <option value="manual">手動</option>
            </select>
            <button className="btn btn-primary btn-sm" onClick={runManual} disabled={busy}>
              {busy && !target ? 'バックアップ中…' : '今すぐバックアップ'}
            </button>
          </>
        }
        pad={false}
      >
        {isSharedDevice && (
          <div className="callout small" style={{ margin: 12 }}>
            バックアップからの復元は、稼働中のデータを切り替える操作のため、Google 所有者が管理画面（Shiftly-Admin）から行います。店舗の iPad の管理者モードでは復元できません。
          </div>
        )}
        {runError && (
          <div className="panel-body" style={{ paddingBottom: 0 }}>
            <ErrorBox message={runError} />
          </div>
        )}
        {list.loading && <Loading />}
        {list.error && <div className="panel-body"><ErrorBox message={list.error} onRetry={list.reload} /></div>}
        {list.data && !list.loading && shown.length === 0 && <Empty>{rows.length === 0 ? 'バックアップはまだありません。「今すぐバックアップ」で作成できます' : 'この種類のバックアップはありません'}</Empty>}
        {list.data && !list.loading && shown.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>種類</th>
                  <th>作成日時</th>
                  <th>状態</th>
                  <th className="r">サイズ</th>
                  <th className="r">スキーマ版</th>
                  <th>メモ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => (
                  <tr key={b.id}>
                    <td><span className={`badge ${KIND_BADGE[b.kind]}`}>{KIND_LABEL[b.kind] ?? b.kind}</span></td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(b.createdAt)}</td>
                    <td>
                      {b.status === 'ok' ? (
                        <span className="badge badge-board">正常</span>
                      ) : b.status === 'pruned' || b.note.startsWith('世代管理により削除') ? (
                        <span className="badge">削除済み</span>
                      ) : (
                        <span className="badge badge-bull">失敗</span>
                      )}
                    </td>
                    <td className="r num">{fmtBytes(b.sizeBytes)}</td>
                    <td className="r num">v{b.schemaVersion}</td>
                    <td className="small" style={{ minWidth: 160, overflowWrap: 'anywhere' }}>{noteText(b) || <span className="muted">—</span>}</td>
                    <td className="r">
                      {restorable(b) && !isSharedDevice && (
                        <button className="btn btn-sm" onClick={() => setTarget(b)} disabled={busy}>
                          このバックアップから復元
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {result && <RestoreResultPanel r={result} onClose={() => setResult(null)} />}

      <div className="two-col">
        <Panel title="バックアップの仕組み">
          <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li><strong>日次</strong>: 毎日自動で作成し、設定した世代数（初期値30世代）を超えた古いものから削除します。</li>
            <li><strong>月次</strong>: 毎月1日に自動で作成し、設定した世代数（初期値12世代）を保持します。</li>
            <li><strong>更新前</strong>: アップデートの直前に自動で作成します（自動削除しません）。</li>
            <li><strong>手動</strong>: この画面から作成したもの、復元の直前に自動で作成したもの（自動削除しません）。</li>
            <li>バックアップは管理者の Google ドライブ（Shiftly のバックアップ用フォルダ）に保存されます。</li>
          </ul>
        </Panel>
        <Panel title="Google アカウントを失った場合に備えて">
          <p className="small">
            バックアップは管理者の Google アカウント内に保存されるため、アカウントにログインできなくなるとバックアップも利用できなくなります。別の Google アカウントへの共有や外部メディアへの保管など、アカウント外での保管手順は
            <strong>運用ガイド（docs/operations-guide.md）</strong>を参照してください。
          </p>
          <p className="small muted" style={{ marginTop: 8 }}>Shiftly はバックアップを外部へ自動で転送しません。</p>
        </Panel>
      </div>

      {target && (
        <RestoreModal
          b={target}
          onClose={() => setTarget(null)}
          onDone={(r) => {
            setTarget(null);
            setResult(r);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function RestoreModal({ b, onClose, onDone }: { b: BackupHistory; onClose: () => void; onDone: (r: RestoreResult) => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const ok = text.trim() === CONFIRM_WORD;
  const submit = async () => {
    const r = await run(() => client.call<RestoreResult>('backup.restore', { backupId: b.id, confirmText: text.trim() }), 'バックアップから復元しました');
    if (r) onDone(r);
  };
  return (
    <Modal
      title="バックアップから復元"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            キャンセル
          </button>
          <button className="btn btn-danger" onClick={submit} disabled={!ok || busy}>
            {busy ? '復元中…' : '復元を実行'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="callout callout-warn">
          <strong>{KIND_LABEL[b.kind]}バックアップ（{fmtDateTime(b.createdAt)} 作成・スキーマ v{b.schemaVersion}）</strong>の内容に戻します。
        </div>
        <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
          <li>復元の直前に、現在のデータの<strong>バックアップが自動で作成</strong>されます（一覧の「手動」）。問題があればそこから戻せます。</li>
          <li>このバックアップ以降に記録された<strong>打刻・手動の休憩・有給の付与と取得・シフトの変更履歴・出力の履歴・監査ログは保持</strong>され、復元後のデータに再投入されます。</li>
          <li>
            <strong>スタッフ・PIN・管理者パスワード・権限・店舗端末・勤怠修正の確認状態・休憩の申告・早出残業申請・確定済みの給与と明細は、現在の状態を引き継ぎます</strong>（巻き戻りません）。
          </li>
          <li>店舗設定・雇用条件・給与条件（時給・月給・交通費・手当）・控除・給与調整・シフト・予算は、<strong>バックアップ時点の内容に戻ります</strong>。</li>
          <li>確定済みの給与がある期間は、復元後に給与の画面で「復元後の確認」を終えるまで、確定・訂正・明細の発行ができません（現在の条件で計算し直した結果が確定時と全項目で一致する必要があります）。</li>
          <li>復元の前に開いていた画面からは保存できません。画面を更新してから操作してください。</li>
          <li><strong>全スタッフのログイン（セッション）が失効</strong>します。店舗 iPad では各自が PIN で再度ログインしてください。</li>
          <li>現在<strong>失効済みの店舗端末は失効のまま</strong>です（バックアップ時点で有効だった端末も復活しません）。</li>
        </ul>
        <Field label={`確認のため「${CONFIRM_WORD}」と入力してください`}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={CONFIRM_WORD} autoComplete="off" aria-invalid={text !== '' && !ok} />
        </Field>
      </div>
    </Modal>
  );
}

function RestoreResultPanel({ r, onClose }: { r: RestoreResult; onClose: () => void }) {
  return (
    <Panel
      title="復元の結果"
      actions={
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          閉じる
        </button>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <div className={`callout ${r.integrity.ok ? 'callout-board' : 'callout-bull'}`}>
          {r.integrity.ok ? '整合性チェック: 問題は見つかりませんでした。' : `整合性チェック: ${r.integrity.issues.length} 件の問題が見つかりました。内容を確認してください。`}
        </div>
        {r.integrity.issues.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
            {r.integrity.issues.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        )}
        <dl className="small" style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px' }}>
          <dt className="muted">復元元</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{r.restoredFrom}</dd>
          <dt className="muted">再投入した記録</dt>
          <dd style={{ margin: 0 }}>{r.preservedRowsReinserted} 件（バックアップ以降の打刻・修正・監査ログ等）</dd>
          <dt className="muted">復元前のデータベース</dt>
          <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{r.previousDatabaseId}</dd>
          <dt className="muted">チェック日時</dt>
          <dd style={{ margin: 0 }}>{fmtDateTime(r.integrity.checkedAt)}（スタッフ {r.integrity.counts.employees} 名）</dd>
        </dl>
        <p className="small">{r.note}</p>
      </div>
    </Panel>
  );
}
