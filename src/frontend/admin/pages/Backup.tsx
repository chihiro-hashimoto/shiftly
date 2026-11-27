/** バックアップ F26（アプリ内の復元は v1.3 では提供しない。D-027 B案。復元は Google 所有者の保守作業） */
import { useState } from 'react';
import { Empty, ErrorBox, Loading, Panel, useAction, useClient, useLoad, useToast } from '../../components/ui';
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

/** 画面に表示する復元の案内（D-027。ユーザー指定の文言） */
export const RESTORE_NOTICE = 'データの復元は安全性確保のため、Google所有者による保守作業として行います。';

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
export function BackupPage() {
  const client = useClient();
  const { busy, run } = useAction();
  const list = useLoad(() => client.call<BackupHistory[]>('backup.list'), []);
  const st = useLoad(() => client.call<StoreSettings>('settings.get'), []);
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
              {busy ? 'バックアップ中…' : '今すぐバックアップ'}
            </button>
          </>
        }
        pad={false}
      >
        <div className="callout small" style={{ margin: 12 }} role="note">
          <strong>{RESTORE_NOTICE}</strong> 復元が必要な場合は、Google 所有者が運用手順書「データの復元（保守作業）」に従って行います（作業中は打刻を紙のタイムカードに切り替えます）。この画面には復元のボタンはありません。
        </div>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="two-col">
        <Panel title="バックアップの仕組み">
          <ul className="small" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li><strong>日次</strong>: 毎日自動で作成し、設定した世代数（初期値30世代）を超えた古いものから削除します。</li>
            <li><strong>月次</strong>: 毎月1日に自動で作成し、設定した世代数（初期値12世代）を保持します。</li>
            <li><strong>更新前</strong>: 以前の版の更新で作成したもの（v1.3 ではアプリの自動更新を行わないため、新しくは作成されません）。</li>
            <li><strong>手動</strong>: この画面から作成したもの、Google 所有者の保守作業の開始時に自動で作成したもの（自動削除しません）。</li>
            <li>バックアップに失敗した場合は、通知（重要）でお知らせします。</li>
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

    </div>
  );
}
