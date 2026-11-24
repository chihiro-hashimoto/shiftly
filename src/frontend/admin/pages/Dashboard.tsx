/** ダッシュボード（今の勤務状況・今月の人件費・要対応事項） */
import { Empty, ErrorBox, Loading, Panel, Yen, useClient, useLoad, todayJst } from '../../components/ui';

interface TodayRow {
  employeeId: string;
  displayName: string;
  state: string;
  stateLabel: string;
  staleOpenSince: string | null;
}

export function DashboardPage() {
  const client = useClient();
  const month = todayJst().slice(0, 7);
  const today = useLoad(() => client.call<TodayRow[]>('attendance.today'), []);
  const cost = useLoad(() => client.call<{ actual: { total: number; incomplete: unknown[] }; forecast: { total: number }; budget: { budget: number | null; consumptionRate: number | null; forecastRate: number | null; over: boolean } }>('analytics.laborCost', { month }), [month]);
  const notes = useLoad(() => client.call<Array<{ id: string; title: string; body: string; severity: string; status: string }>>('notifications.list'), []);
  const periods = useLoad(() => client.call<{ periods: Array<{ id: string; periodKey: string; status: string; payDate: string }> }>('payroll.periods'), []);

  const working = today.data?.filter((r) => r.state === 'working' || r.state === 'on_break') ?? [];
  const unread = notes.data?.filter((n) => n.status === 'unread') ?? [];
  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="label">いま勤務中</div>
          <div className="value">{today.data ? working.length : '—'}<span className="small muted"> 名</span></div>
          <div className="sub">{working.map((w) => w.displayName).join('、') || '勤務中のスタッフはいません'}</div>
        </div>
        <div className="kpi">
          <div className="label">今月の人件費（実績・総支給ベース）</div>
          <div className="value">{cost.data ? <Yen v={cost.data.actual.total} /> : '—'}</div>
          <div className="sub">着地予測 {cost.data ? <Yen v={cost.data.forecast.total} /> : '—'}</div>
        </div>
        <div className="kpi">
          <div className="label">予算消化率</div>
          <div className="value">{cost.data?.budget.consumptionRate != null ? `${Math.round(cost.data.budget.consumptionRate * 100)}%` : '—'}</div>
          <div className="sub">{cost.data?.budget.budget ? <>予算 <Yen v={cost.data.budget.budget} />{cost.data.budget.over ? '（予測が予算超過）' : ''}</> : '予算が未設定です'}</div>
        </div>
        <div className="kpi">
          <div className="label">未読の通知</div>
          <div className="value">{notes.data ? unread.length : '—'}<span className="small muted"> 件</span></div>
          <div className="sub">打刻漏れ・給与の未確定など</div>
        </div>
      </div>
      <div className="two-col">
        <Panel title="今日の勤務状況" pad={false}>
          {today.loading && <Loading />}
          {today.error && <ErrorBox message={today.error} onRetry={today.reload} />}
          {today.data && today.data.length === 0 && <Empty>スタッフが登録されていません</Empty>}
          {today.data && today.data.length > 0 && (
            <table className="data">
              <thead>
                <tr>
                  <th>スタッフ</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {today.data.map((r) => (
                  <tr key={r.employeeId}>
                    <td>{r.displayName}</td>
                    <td>
                      <span className={`badge ${r.state === 'working' ? 'badge-board' : r.state === 'on_break' ? 'badge-brass' : ''}`}>{r.stateLabel}</span>
                      {r.staleOpenSince && <span className="badge badge-bull" style={{ marginLeft: 6 }}>退勤打刻漏れ（{r.staleOpenSince.slice(5, 16).replace('T', ' ')} 出勤）</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <div className="stack">
          <Panel title="要対応">
            {notes.loading && <Loading />}
            {notes.error && <ErrorBox message={notes.error} />}
            {notes.data && unread.length === 0 && <p className="muted">対応が必要な通知はありません</p>}
            <div className="stack" style={{ gap: 8 }}>
              {unread.slice(0, 6).map((n) => (
                <div key={n.id} className={`callout ${n.severity === 'critical' ? 'callout-bull' : n.severity === 'warning' ? 'callout-warn' : ''}`}>
                  <strong>{n.title}</strong>
                  <div className="small">{n.body}</div>
                </div>
              ))}
            </div>
          </Panel>
          <Panel title="給与の状況">
            {periods.loading && <Loading />}
            {periods.error && <ErrorBox message={periods.error} />}
            {periods.data && periods.data.periods.length === 0 && <p className="muted">給与計算期間はまだ作成されていません（給与計算ページで作成）</p>}
            {periods.data?.periods.slice(0, 4).map((p) => (
              <div key={p.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                <span>{p.periodKey}（支払日 {p.payDate}）</span>
                <span className="badge">{STATUS[p.status] ?? p.status}</span>
              </div>
            ))}
          </Panel>
        </div>
      </div>
    </>
  );
}

export const STATUS: Record<string, string> = {
  uncomputed: '未集計',
  draft: '仮計算',
  review: '確認待ち',
  confirmed: '給与確定',
  issued: '明細発行済み',
  superseded: '訂正済み（旧版）',
};
