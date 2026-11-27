/** 勤怠（一覧・詳細・修正・紙タイムカードからの登録・シフトとの比較） F08/F09/F11 */
import { useState } from 'react';
import { AnomalyBadges, Empty, ErrorBox, Field, Loading, Minutes, Modal, Panel, timeOf, todayJst, useAction, useClient, useLoad, WEEKDAYS } from '../../components/ui';

interface SessionView {
  laborDate: string;
  businessDate: string;
  start: string;
  end: string | null;
  breakMinutes: number;
  workMinutes: number;
  anomalies: string[];
  open: boolean;
}
interface EmpSessions {
  employeeId: string;
  displayName: string;
  sessions: SessionView[];
}

function monthStart(d: string) {
  return `${d.slice(0, 7)}-01`;
}

export function AttendancePage() {
  const client = useClient();
  const [from, setFrom] = useState(monthStart(todayJst()));
  const [to, setTo] = useState(todayJst());
  const [view, setView] = useState<'list' | 'compare'>('list');
  const [detail, setDetail] = useState<{ id: string; name: string } | null>(null);
  const list = useLoad(() => client.call<EmpSessions[]>('attendance.list', { from, to }), [from, to]);
  return (
    <>
      <Panel
        title={
          <div className="row">
            <button className={`btn btn-sm ${view === 'list' ? 'btn-primary' : ''}`} onClick={() => setView('list')}>
              勤務実績
            </button>
            <button className={`btn btn-sm ${view === 'compare' ? 'btn-primary' : ''}`} onClick={() => setView('compare')}>
              シフトとの比較
            </button>
          </div>
        }
        actions={
          <>
            <label className="row small">
              期間
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ maxWidth: 160 }} />〜
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ maxWidth: 160 }} />
            </label>
          </>
        }
        pad={false}
      >
        {view === 'list' && (
          <>
            {list.loading && <Loading />}
            {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
            {list.data && list.data.length === 0 && <Empty>スタッフが登録されていません</Empty>}
            {list.data && list.data.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>スタッフ</th>
                      <th className="r">勤務回数</th>
                      <th className="r">実働合計</th>
                      <th className="r">休憩合計</th>
                      <th>要確認</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((e) => {
                      const anomalies = [...new Set(e.sessions.flatMap((s) => s.anomalies))];
                      return (
                        <tr key={e.employeeId}>
                          <td>{e.displayName}</td>
                          <td className="r num">{e.sessions.length}</td>
                          <td className="r"><Minutes v={e.sessions.reduce((a, s) => a + s.workMinutes, 0)} /></td>
                          <td className="r"><Minutes v={e.sessions.reduce((a, s) => a + s.breakMinutes, 0)} /></td>
                          <td><AnomalyBadges list={anomalies} /></td>
                          <td className="r">
                            <button className="btn btn-sm" onClick={() => setDetail({ id: e.employeeId, name: e.displayName })}>
                              明細・修正
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
        {view === 'compare' && <Compare from={from} to={to} />}
      </Panel>
      {detail && <DetailModal employeeId={detail.id} name={detail.name} from={from} to={to} onClose={() => { setDetail(null); list.reload(); }} />}
    </>
  );
}

function Compare({ from, to }: { from: string; to: string }) {
  const client = useClient();
  const r = useLoad(() => client.call<{ rows: Array<{ shiftId: string; employeeId: string; date: string; plannedStart: string; plannedEnd: string; actual: SessionView[]; flags: string[] }> }>('attendance.compareShifts', { from, to }), [from, to]);
  const names = useLoad(() => client.call<Array<{ id: string; displayName: string }>>('employees.list'), []);
  if (r.loading) return <Loading />;
  if (r.error) return <ErrorBox message={r.error} onRetry={r.reload} />;
  if (!r.data!.rows.length) return <Empty>この期間に公開済みのシフトはありません</Empty>;
  const nm = new Map((names.data ?? []).map((n) => [n.id, n.displayName]));
  const FLAG: Record<string, [string, string]> = { late: ['遅刻', 'badge-warn'], early_leave: ['早退', 'badge-warn'], absence: ['欠勤', 'badge-bull'], missing_clock_in: ['出勤打刻なし', 'badge-bull'] };
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>日付</th>
            <th>スタッフ</th>
            <th>予定</th>
            <th>実績</th>
            <th>判定</th>
          </tr>
        </thead>
        <tbody>
          {r.data!.rows.map((x) => (
            <tr key={x.shiftId}>
              <td>{x.date}（{WEEKDAYS[new Date(`${x.date}T00:00:00Z`).getUTCDay()]}）</td>
              <td>{nm.get(x.employeeId) ?? ''}</td>
              <td className="num">{x.plannedStart}–{x.plannedEnd}</td>
              <td className="num">{x.actual.map((a) => `${timeOf(a.start)}–${timeOf(a.end)}`).join(', ') || '—'}</td>
              <td>
                {x.flags.length === 0 ? <span className="badge badge-board">予定どおり</span> : x.flags.map((f) => <span key={f} className={`badge ${FLAG[f]?.[1] ?? ''}`} style={{ marginRight: 4 }}>{FLAG[f]?.[0] ?? f}</span>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ padding: '8px 12px' }}>遅刻・早退はシフトとの比較結果の表示のみで、給与から自動では控除しません。</p>
    </div>
  );
}

interface Detail {
  originals: Array<{ id: string; type: string; at: string; source: string; note: string }>;
  corrections: Array<{ id: string; action: string; newType: string | null; newAt: string | null; reason: string; actorId: string; createdAt: string; before: string }>;
  sessions: SessionView[];
}

const TYPE_LABEL: Record<string, string> = { clock_in: '出勤', clock_out: '退勤', break_start: '休憩開始', break_end: '休憩終了' };
const ACTION_LABEL: Record<string, string> = { add: '追加', replace: '変更', void: '取消' };

function DetailModal({ employeeId, name, from, to, onClose }: { employeeId: string; name: string; from: string; to: string; onClose: () => void }) {
  const client = useClient();
  const d = useLoad(() => client.call<Detail>('attendance.detail', { employeeId, from, to }), [employeeId, from, to]);
  const [form, setForm] = useState<null | { action: 'add' | 'replace' | 'void'; targetEventId?: string; type: string; at: string; reason: string; paper: boolean }>(null);
  const [brk, setBrk] = useState<null | { start: string; end: string; reason: string }>(null);
  const { busy, run } = useAction();
  const save = async () => {
    if (!form) return;
    const r = await run(
      () =>
        client.call<{ warning: string | null }>('attendance.correct', {
          employeeId,
          action: form.action,
          targetEventId: form.targetEventId,
          type: form.type,
          at: form.at,
          reason: form.reason,
          source: form.paper ? 'paper_recovery' : undefined,
        }),
      '勤怠を修正しました',
    );
    if (r) {
      if (r.warning) alert(r.warning);
      setForm(null);
      d.reload();
    }
  };
  return (
    <Modal title={`${name}さんの勤怠（${from}〜${to}）`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>閉じる</button>}>
      {d.loading && <Loading />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data && (
        <div className="stack">
          <div className="row">
            <button className="btn btn-sm btn-primary" onClick={() => setForm({ action: 'add', type: 'clock_in', at: `${to}T09:00`, reason: '', paper: false })}>
              打刻を追加
            </button>
            <button className="btn btn-sm" onClick={() => setForm({ action: 'add', type: 'clock_in', at: `${to}T09:00`, reason: '', paper: true })}>
              紙のタイムカードから登録
            </button>
            <button className="btn btn-sm" onClick={() => setBrk({ start: `${to}T12:00`, end: `${to}T13:00`, reason: '' })}>
              休憩を登録
            </button>
          </div>
          <h3>勤務（修正後）</h3>
          {d.data.sessions.length === 0 ? (
            <p className="muted">この期間の勤務はありません</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>労働日</th>
                  <th>出勤</th>
                  <th>退勤</th>
                  <th className="r">休憩</th>
                  <th className="r">実働</th>
                  <th>注意</th>
                </tr>
              </thead>
              <tbody>
                {d.data.sessions.map((s) => (
                  <tr key={s.start}>
                    <td>{s.laborDate}</td>
                    <td className="num">{s.start.slice(5, 16).replace('T', ' ')}</td>
                    <td className="num">{s.end ? s.end.slice(5, 16).replace('T', ' ') : '—'}</td>
                    <td className="r"><Minutes v={s.breakMinutes} /></td>
                    <td className="r"><Minutes v={s.workMinutes} /></td>
                    <td><AnomalyBadges list={s.anomalies} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3>打刻原本（変更不可）</h3>
          <table className="data">
            <thead>
              <tr>
                <th>日時</th>
                <th>種別</th>
                <th>記録元</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.data.originals.map((o) => (
                <tr key={o.id}>
                  <td className="num">{o.at.slice(0, 16).replace('T', ' ')}</td>
                  <td>{TYPE_LABEL[o.type]}</td>
                  <td className="small muted">{o.source === 'kiosk' ? '店舗端末' : o.source}{o.note && `（${o.note}）`}</td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => setForm({ action: 'replace', targetEventId: o.id, type: o.type, at: o.at.slice(0, 16), reason: '', paper: false })}>
                      変更
                    </button>{' '}
                    <button className="btn btn-sm" onClick={() => setForm({ action: 'void', targetEventId: o.id, type: o.type, at: o.at.slice(0, 16), reason: '', paper: false })}>
                      取消
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>修正履歴</h3>
          {d.data.corrections.length === 0 ? (
            <p className="muted">修正はありません</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>修正日時</th>
                  <th>内容</th>
                  <th>理由</th>
                  <th>修正者</th>
                </tr>
              </thead>
              <tbody>
                {d.data.corrections.map((c) => (
                  <tr key={c.id}>
                    <td className="num">{c.createdAt.slice(0, 16).replace('T', ' ')}</td>
                    <td>
                      {ACTION_LABEL[c.action]} {c.newType ? TYPE_LABEL[c.newType] : ''} {c.newAt ? c.newAt.slice(5, 16).replace('T', ' ') : ''}
                      {c.before && <div className="small muted">修正前: {(() => { try { const b = JSON.parse(c.before) as { type: string; at: string }; return `${TYPE_LABEL[b.type]} ${b.at.slice(5, 16).replace('T', ' ')}`; } catch { return ''; } })()}</div>}
                    </td>
                    <td>{c.reason}</td>
                    <td>{c.actorId === 'owner' ? '管理者' : 'スタッフ（委任）'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {form && (
        <Modal
          title={form.paper ? '紙のタイムカードから登録' : form.action === 'void' ? '打刻を取消' : form.action === 'replace' ? '打刻を変更' : '打刻を追加'}
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setForm(null)}>
                キャンセル
              </button>
              <button className="btn btn-primary" disabled={busy || form.reason.trim().length < 2} onClick={save}>
                保存
              </button>
            </>
          }
        >
          <div className="stack">
            {form.action !== 'void' && (
              <>
                <Field label="種別">
                  <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                    {Object.entries(TYPE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field label="日時">
                  <input className="input" type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
                </Field>
              </>
            )}
            <Field label="理由（必須）" hint="監査ログに記録されます">
              <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={300} />
            </Field>
            <p className="small muted">打刻原本は変更されず、修正内容が別に記録されます。</p>
          </div>
        </Modal>
      )}
      {brk && (
        <Modal
          title="休憩を登録"
          onClose={() => setBrk(null)}
          footer={
            <>
              <button className="btn" onClick={() => setBrk(null)}>
                キャンセル
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || brk.reason.trim().length < 2}
                onClick={async () => {
                  const r = await run(() => client.call('attendance.addBreak', { employeeId, ...brk }), '休憩を登録しました');
                  if (r) {
                    setBrk(null);
                    d.reload();
                  }
                }}
              >
                保存
              </button>
            </>
          }
        >
          <div className="stack">
            <Field label="開始">
              <input className="input" type="datetime-local" value={brk.start} onChange={(e) => setBrk({ ...brk, start: e.target.value })} />
            </Field>
            <Field label="終了">
              <input className="input" type="datetime-local" value={brk.end} onChange={(e) => setBrk({ ...brk, end: e.target.value })} />
            </Field>
            <Field label="理由（必須）">
              <input className="input" value={brk.reason} onChange={(e) => setBrk({ ...brk, reason: e.target.value })} />
            </Field>
            <p className="small muted">実際に取得した休憩のみ登録してください。取得していない休憩を登録してはいけません。</p>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
