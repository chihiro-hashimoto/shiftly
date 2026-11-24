/** アプリ内通知（打刻漏れ・給与の未確定・バックアップ失敗など） F21 */
import { useState } from 'react';
import { Empty, ErrorBox, Loading, Panel, useAction, useClient, useLoad, WEEKDAYS } from '../../components/ui';
import type { NotificationRow } from '../../../shared/types';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

type Status = NotificationRow['status'];
type Severity = NotificationRow['severity'];
type StatusFilter = 'all' | Status;

const SEVERITY: Record<Severity, { label: string; badge: string; color: string }> = {
  critical: { label: '重要', badge: 'badge-bull', color: 'var(--bull)' },
  warning: { label: '注意', badge: 'badge-warn', color: 'var(--warn)' },
  info: { label: 'お知らせ', badge: 'badge-info', color: 'var(--info)' },
};

const STATUS: Record<Status, { label: string; badge: string }> = {
  unread: { label: '未読', badge: 'badge-board' },
  read: { label: '既読', badge: '' },
  resolved: { label: '対応済み', badge: 'badge-brass' },
};

const KIND_LABEL: Record<string, string> = {
  missing_clock_in: '出勤打刻なし',
  missing_clock_out: '退勤打刻漏れ',
  missing_break_end: '休憩終了漏れ',
  late: '遅刻',
  early_leave: '早退',
  absence: '欠勤の可能性',
  abnormal_hours: '長時間勤務',
  insufficient_break: '休憩不足',
  payroll_unconfirmed: '給与の未確定',
  pay_conditions_missing: '給与条件の未入力',
  leave_expiring: '有給休暇の時効',
  leave_5day_obligation: '年5日の取得義務',
  budget_over: '人件費予算',
  backup_failed: 'バックアップ失敗',
  drive_capacity: 'Drive 容量',
  update_available: 'アップデート',
  min_wage_violation: '最低賃金',
};

function fmtDateTime(iso: string): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}
function fmtDate(d: string): string {
  const wd = WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
  return wd ? `${d}（${wd}）` : d;
}

export function NotificationsPage() {
  const client = useClient();
  const { busy, run } = useAction();
  const [includeResolved, setIncludeResolved] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [severity, setSeverity] = useState<'all' | Severity>('all');
  const [scanResult, setScanResult] = useState<number | null>(null);
  const list = useLoad(() => client.call<NotificationRow[]>('notifications.list', { includeResolved }), [includeResolved]);

  const rows = list.data ?? [];
  const shown = rows.filter((n) => (filter === 'all' || n.status === filter) && (severity === 'all' || n.severity === severity));
  const unread = rows.filter((n) => n.status === 'unread');
  const count = (s: Status) => rows.filter((n) => n.status === s).length;

  const setStatus = async (n: NotificationRow, status: Status) => {
    const msg = status === 'resolved' ? '対応済みにしました' : status === 'read' ? '既読にしました' : '未読に戻しました';
    const r = await run(() => client.call<NotificationRow>('notifications.update', { id: n.id, status }), msg);
    if (r) list.reload();
  };
  const markAllRead = async () => {
    const targets = shown.filter((n) => n.status === 'unread');
    if (!targets.length) return;
    const r = await run(async () => {
      for (const n of targets) await client.call('notifications.update', { id: n.id, status: 'read' });
      return targets.length;
    }, `${targets.length}件を既読にしました`);
    if (r !== undefined) list.reload();
  };
  const scan = async () => {
    const r = await run(() => client.call<{ created: number }>('notifications.scan'));
    if (r) {
      list.reload();
      setScanResult(r.created);
    }
  };
  const chooseFilter = (f: StatusFilter) => {
    setFilter(f);
    if (f === 'resolved') setIncludeResolved(true);
  };

  return (
    <div style={PAGE_STYLE}>
      <div className="kpis">
        <div className="kpi">
          <div className="label">未読</div>
          <div className="value">{list.data ? unread.length : '—'}<span className="small muted"> 件</span></div>
          <div className="sub">うち重要 {list.data ? unread.filter((n) => n.severity === 'critical').length : '—'} 件</div>
        </div>
        <div className="kpi">
          <div className="label">既読（未対応）</div>
          <div className="value">{list.data ? count('read') : '—'}<span className="small muted"> 件</span></div>
          <div className="sub">対応が済んだら「対応済み」にしてください</div>
        </div>
        <div className="kpi">
          <div className="label">通知の確認</div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn btn-primary" onClick={scan} disabled={busy}>
              今すぐ確認
            </button>
          </div>
          <div className="sub" style={{ marginTop: 6 }}>
            {scanResult === null ? '打刻漏れ・給与の未確定などの確認は毎日自動でも実行されます' : scanResult > 0 ? `新しい通知が ${scanResult} 件見つかりました` : '新しい通知はありませんでした'}
          </div>
        </div>
      </div>

      <Panel
        title="通知一覧"
        actions={
          <>
            <button className="btn btn-sm" onClick={markAllRead} disabled={busy || !shown.some((n) => n.status === 'unread')}>
              表示中の未読をすべて既読にする
            </button>
            <button className="btn btn-sm btn-ghost" onClick={list.reload} disabled={list.loading}>
              再読み込み
            </button>
          </>
        }
        pad={false}
      >
        <div className="row" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-2)', gap: 12 }}>
          <div className="row" role="group" aria-label="状態で絞り込み" style={{ gap: 4 }}>
            {(
              [
                ['all', 'すべて'],
                ['unread', `未読${list.data ? ` ${count('unread')}` : ''}`],
                ['read', '既読'],
                ['resolved', '対応済み'],
              ] as Array<[StatusFilter, string]>
            ).map(([k, label]) => (
              <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : ''}`} aria-pressed={filter === k} onClick={() => chooseFilter(k)}>
                {label}
              </button>
            ))}
          </div>
          <label className="row small">
            重要度
            <select className="input" style={{ width: 130 }} value={severity} onChange={(e) => setSeverity(e.target.value as 'all' | Severity)}>
              <option value="all">すべて</option>
              <option value="critical">重要</option>
              <option value="warning">注意</option>
              <option value="info">お知らせ</option>
            </select>
          </label>
          <label className="check small">
            <input
              type="checkbox"
              checked={includeResolved}
              onChange={(e) => {
                setIncludeResolved(e.target.checked);
                if (!e.target.checked && filter === 'resolved') setFilter('all');
              }}
            />
            対応済みも表示
          </label>
        </div>
        {list.loading && <Loading />}
        {list.error && (
          <div className="panel-body">
            <ErrorBox message={list.error} onRetry={list.reload} />
          </div>
        )}
        {list.data && !list.loading && shown.length === 0 && (
          <Empty>{rows.length === 0 ? '通知はありません' : '条件に一致する通知はありません'}</Empty>
        )}
        {list.data && !list.loading && shown.length > 0 && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {shown.map((n) => (
              <NotificationItem key={n.id} n={n} busy={busy} onStatus={setStatus} />
            ))}
          </ul>
        )}
        {list.data && rows.length >= 200 && <p className="small muted" style={{ padding: '8px 18px' }}>新しい順に最大200件まで表示しています。</p>}
      </Panel>
      <p className="small muted">
        通知は店長のみが確認できる内容と、権限を委任したスタッフにも表示される内容（打刻漏れ・シフト関連など）があります。同じ内容の通知は重複して作成されません。
      </p>
    </div>
  );
}

function NotificationItem({ n, busy, onStatus }: { n: NotificationRow; busy: boolean; onStatus: (n: NotificationRow, s: Status) => void }) {
  const sev = SEVERITY[n.severity] ?? SEVERITY.info;
  const st = STATUS[n.status] ?? STATUS.read;
  const unread = n.status === 'unread';
  return (
    <li
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px 16px',
        padding: '12px 18px',
        borderBottom: '1px solid var(--line-2)',
        borderLeft: `4px solid ${sev.color}`,
        background: unread ? '#fbfdfc' : undefined,
        opacity: n.status === 'resolved' ? 0.75 : 1,
      }}
    >
      <div style={{ flex: '1 1 360px', minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <span className={`badge ${sev.badge}`}>{sev.label}</span>
          <span className={`badge ${st.badge}`}>{st.label}</span>
          <span className="small muted">{KIND_LABEL[n.kind] ?? n.kind}</span>
        </div>
        <div style={{ fontWeight: unread ? 700 : 600, marginTop: 4 }}>{n.title}</div>
        <div className="small" style={{ color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>
          {n.body}
        </div>
        <div className="small muted" style={{ marginTop: 2 }}>
          {n.relatedDate && <>関連日 <span className="num">{fmtDate(n.relatedDate)}</span>　</>}
          通知日時 <span className="num">{fmtDateTime(n.createdAt)}</span>
        </div>
      </div>
      <div className="row" style={{ alignSelf: 'center', gap: 6 }}>
        {n.status === 'unread' && (
          <button className="btn btn-sm" disabled={busy} onClick={() => onStatus(n, 'read')}>
            既読にする
          </button>
        )}
        {n.status === 'read' && (
          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => onStatus(n, 'unread')}>
            未読に戻す
          </button>
        )}
        {n.status !== 'resolved' ? (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => onStatus(n, 'resolved')}>
            対応済みにする
          </button>
        ) : (
          <button className="btn btn-sm" disabled={busy} onClick={() => onStatus(n, 'read')}>
            未対応に戻す
          </button>
        )}
      </div>
    </li>
  );
}
