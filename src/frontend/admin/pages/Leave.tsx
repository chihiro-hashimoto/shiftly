/** 有給休暇（残日数・付与・取得・調整・年5日義務） F20 */
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, Panel, WEEKDAYS, todayJst, useAction, useClient, useLoad } from '../../components/ui';
import type { EmploymentHistory, LeaveGrant } from '../../../shared/types';

interface GrantView {
  id: string;
  grantDate: string;
  days: number;
  remaining: number;
  used: number;
  expiresOn: string;
  expired: boolean;
  kind: LeaveGrant['kind'];
}
interface TxView {
  id: string;
  date: string;
  days: number;
  kind: 'take' | 'adjust' | 'expire';
  reason: string;
}
interface FiveDay {
  grantId: string;
  grantDate: string;
  deadline: string;
  taken: number;
  shortfall: number;
}
interface Summary {
  balance: number;
  scheduled: number;
  overdrawn: number;
  grants: GrantView[];
  transactions: TxView[];
  fiveDay: FiveDay[];
}
interface OverviewRow extends Summary {
  employeeId: string;
  displayName: string;
}
interface Proposal {
  grantDate: string;
  serviceIndex: number;
  days: number;
  kind: 'statutory' | 'proportional';
  note: string;
}
interface Detail extends Summary {
  proposals: Proposal[];
  hireDate: string | null;
  employment: EmploymentHistory | null;
}

const KIND_LABEL: Record<LeaveGrant['kind'], string> = {
  statutory: '法定付与（通常）',
  proportional: '法定付与（比例付与）',
  initial_balance: '既存残日数（導入時の移行）',
  extra: '会社独自の特別付与',
};
const TX_LABEL: Record<TxView['kind'], string> = { take: '取得', adjust: '調整', expire: '失効' };
const EXPIRY_WARN_DAYS = 90;
const CSS = `.lv-page table.data th,.lv-page table.data td{white-space:nowrap}.lv-page table.data td.wrap{white-space:normal;min-width:14em}`;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
function fmtDays(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(1)}日`;
}
function wd(d: string): string {
  return WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()] ?? '';
}
/** 時効が近い（残あり・未失効・期限まで90日以内）付与 */
function expiringSoon(grants: GrantView[], today: string): GrantView[] {
  return grants.filter((g) => !g.expired && g.remaining > 0 && g.expiresOn > today && daysBetween(today, g.expiresOn) <= EXPIRY_WARN_DAYS);
}
/** 現在進行中（期限未到来）の年5日義務 */
function currentObligation(list: FiveDay[], today: string): FiveDay | null {
  return [...list].filter((f) => f.deadline > today && f.grantDate <= today).sort((a, b) => (a.deadline < b.deadline ? -1 : 1))[0] ?? null;
}
/** 期限を過ぎて未達の義務 */
function missedObligations(list: FiveDay[], today: string): FiveDay[] {
  return list.filter((f) => f.deadline <= today && f.shortfall > 0);
}

export function LeavePage() {
  const client = useClient();
  const today = todayJst();
  const ov = useLoad(() => client.call<OverviewRow[]>('leave.overview'), []);
  const [detail, setDetail] = useState<{ id: string; name: string } | null>(null);

  const rows = ov.data ?? [];
  const shortCount = rows.filter((r) => (currentObligation(r.fiveDay, today)?.shortfall ?? 0) > 0 || missedObligations(r.fiveDay, today).length > 0).length;
  const expCount = rows.filter((r) => expiringSoon(r.grants, today).length > 0).length;
  const totalBalance = rows.reduce((a, r) => a + r.balance, 0);

  return (
    <div className="lv-page" style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <style>{CSS}</style>
      <div className="kpis">
        <div className="kpi">
          <div className="label">在籍スタッフの残日数合計</div>
          <div className="value">{ov.data ? fmtDays(totalBalance).replace('日', '') : '—'}<span className="small muted"> 日</span></div>
          <div className="sub">取得予定分を差し引いた残日数</div>
        </div>
        <div className="kpi">
          <div className="label">年5日の取得義務が不足</div>
          <div className="value" style={shortCount ? { color: 'var(--warn)' } : undefined}>{ov.data ? shortCount : '—'}<span className="small muted"> 名</span></div>
          <div className="sub">付与10日以上の人が対象（付与日から1年以内に5日）</div>
        </div>
        <div className="kpi">
          <div className="label">{EXPIRY_WARN_DAYS}日以内に時効を迎える残あり</div>
          <div className="value">{ov.data ? expCount : '—'}<span className="small muted"> 名</span></div>
          <div className="sub">付与日から2年で時効</div>
        </div>
      </div>

      <Panel title="スタッフ別の有給休暇" actions={<button className="btn btn-sm" onClick={ov.reload}>再読み込み</button>} pad={false}>
        {ov.loading && !ov.data && <Loading />}
        {ov.error && <ErrorBox message={ov.error} onRetry={ov.reload} />}
        {ov.data && rows.length === 0 && <Empty>在籍中のスタッフがいません</Empty>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>スタッフ</th>
                  <th className="r">残日数</th>
                  <th className="r">取得予定</th>
                  <th>年5日の取得義務</th>
                  <th>時効が近い付与</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ob = currentObligation(r.fiveDay, today);
                  const missed = missedObligations(r.fiveDay, today);
                  const exp = expiringSoon(r.grants, today);
                  return (
                    <tr key={r.employeeId}>
                      <td>
                        {r.displayName}
                        {r.grants.length === 0 && <div className="small muted">付与の登録なし</div>}
                      </td>
                      <td className="r">
                        <span className="num" style={{ fontSize: '1.1rem', fontWeight: 600 }}>{fmtDays(r.balance)}</span>
                        {r.overdrawn > 0 && (
                          <div>
                            <span className="badge badge-bull">残日数超過 {fmtDays(r.overdrawn)}</span>
                          </div>
                        )}
                      </td>
                      <td className="r num">{r.scheduled > 0 ? fmtDays(r.scheduled) : '—'}</td>
                      <td>
                        {!ob && missed.length === 0 && <span className="muted small">対象の付与なし</span>}
                        {ob &&
                          (ob.shortfall > 0 ? (
                            <span className="badge badge-warn">
                              あと {fmtDays(ob.shortfall)}（期限 {ob.deadline}）
                            </span>
                          ) : (
                            <span className="badge badge-board">達成（{fmtDays(ob.taken)}取得）</span>
                          ))}
                        {missed.map((m) => (
                          <div key={m.grantId}>
                            <span className="badge badge-bull">期限超過で未達 {fmtDays(m.shortfall)}（{m.deadline}）</span>
                          </div>
                        ))}
                      </td>
                      <td>
                        {exp.length === 0 ? (
                          <span className="muted small">—</span>
                        ) : (
                          exp.map((g) => (
                            <div key={g.id} className="small">
                              <span className="badge badge-brass">{g.expiresOn} に {fmtDays(g.remaining)} 失効</span>
                            </div>
                          ))
                        )}
                      </td>
                      <td className="r">
                        <button className="btn btn-sm" onClick={() => setDetail({ id: r.employeeId, name: r.displayName })}>
                          詳細・登録
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ padding: '10px 18px 14px' }}>
          残日数は古い付与から順に消化して計算しています。時間単位の年休は労使協定が必要なため対応していません。半日単位は店舗設定で許可している場合のみ登録できます。
        </p>
      </Panel>

      {detail && (
        <DetailModal
          employeeId={detail.id}
          name={detail.name}
          onClose={() => {
            setDetail(null);
            ov.reload();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 個人詳細
type FormKind = 'grant' | 'take' | 'adjust';
interface GrantForm {
  kind: LeaveGrant['kind'];
  grantDate: string;
  days: string;
  attendanceRateConfirmed: boolean;
  note: string;
}

function DetailModal({ employeeId, name, onClose }: { employeeId: string; name: string; onClose: () => void }) {
  const client = useClient();
  const today = todayJst();
  const d = useLoad(() => client.call<Detail>('leave.detail', { employeeId }), [employeeId]);
  const [open, setOpen] = useState<FormKind | null>(null);
  const [grantInit, setGrantInit] = useState<GrantForm | null>(null);

  const startGrant = (g: Partial<GrantForm>) => {
    setGrantInit({ kind: 'statutory', grantDate: today, days: '', attendanceRateConfirmed: false, note: '', ...g });
    setOpen('grant');
  };
  const emp = d.data?.employment ?? null;

  return (
    <Modal title={`${name}さんの有給休暇`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>閉じる</button>}>
      {d.loading && !d.data && <Loading />}
      {d.error && <ErrorBox message={d.error} onRetry={d.reload} />}
      {d.data && (
        <div className="stack">
          <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div className="kpi">
              <div className="label">残日数</div>
              <div className="value">{fmtDays(d.data.balance).replace('日', '')}<span className="small muted"> 日</span></div>
              {d.data.overdrawn > 0 && <div className="sub" style={{ color: 'var(--bull)' }}>残日数を {fmtDays(d.data.overdrawn)} 超えて取得</div>}
            </div>
            <div className="kpi">
              <div className="label">取得予定</div>
              <div className="value">{fmtDays(d.data.scheduled).replace('日', '')}<span className="small muted"> 日</span></div>
              <div className="sub">今日より後の取得登録</div>
            </div>
            <div className="kpi">
              <div className="label">入社日</div>
              <div className="value" style={{ fontSize: '1.4rem' }}>{d.data.hireDate ?? '未設定'}</div>
              <div className="sub">付与日の算出に使用</div>
            </div>
          </div>

          <div className="row">
            <button className="btn btn-primary" onClick={() => startGrant({})}>
              付与を登録
            </button>
            <button className="btn" onClick={() => startGrant({ kind: 'initial_balance' })}>
              既存残日数を登録
            </button>
            <button className="btn" onClick={() => setOpen('take')}>
              取得を登録
            </button>
            <button className="btn" onClick={() => setOpen('adjust')}>
              調整
            </button>
          </div>

          {!emp && (
            <div className="callout callout-warn">
              雇用条件（週所定労働日数・時間）が未設定のため、法定の付与日数を判定できません。「給与条件」ページの雇用条件で設定してください。
            </div>
          )}
          {emp && (
            <p className="small muted">
              適用中の雇用条件: 週所定 {emp.weeklyScheduledDays ?? '未設定'}日・{emp.weeklyScheduledMinutes !== null ? `${Math.floor(emp.weeklyScheduledMinutes / 60)}時間${emp.weeklyScheduledMinutes % 60 ? `${emp.weeklyScheduledMinutes % 60}分` : ''}` : '時間未設定'}
              {emp.yearlyScheduledDays !== null && `・年間所定 ${emp.yearlyScheduledDays}日`}（{emp.effectiveFrom}〜）
            </p>
          )}

          <section className="stack" style={{ gap: 8 }}>
            <h3>付与の提案</h3>
            {!d.data.hireDate && <p className="muted small">入社日が未設定のため提案できません（「スタッフ・権限」で入社日を登録してください）。</p>}
            {d.data.hireDate && d.data.proposals.length === 0 && <p className="muted small">今後1か月以内に未登録の付与日はありません。</p>}
            {d.data.proposals.length > 0 && (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>付与日</th>
                      <th>勤続</th>
                      <th>区分</th>
                      <th className="r">日数</th>
                      <th>備考</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.data.proposals.map((p) => (
                      <tr key={p.grantDate}>
                        <td className="num">
                          {p.grantDate}
                          {p.grantDate > today && <span className="badge badge-info" style={{ marginLeft: 6 }}>予定</span>}
                        </td>
                        <td>{p.serviceIndex === 0 ? '6か月' : `${p.serviceIndex}年6か月`}</td>
                        <td>{p.kind === 'statutory' ? '通常付与' : '比例付与'}</td>
                        <td className="r num">{p.days > 0 ? fmtDays(p.days) : '—'}</td>
                        <td className="small wrap">{p.note || <span className="muted">出勤率8割以上の確認が必要</span>}</td>
                        <td className="r">
                          <button className="btn btn-sm" disabled={p.days <= 0} onClick={() => startGrant({ kind: p.kind, grantDate: p.grantDate, days: String(p.days) })}>
                            この内容で付与
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small muted">提案は入社日と雇用条件から算出した目安です。付与は自動では行いません。出勤率を確認のうえ登録してください。</p>
          </section>

          <section className="stack" style={{ gap: 8 }}>
            <h3>年5日の取得義務</h3>
            {d.data.fiveDay.length === 0 ? (
              <p className="muted small">対象となる付与（10日以上の法定付与）はありません。</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>付与日</th>
                      <th>期限</th>
                      <th className="r">取得済み</th>
                      <th>状況</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.data.fiveDay.map((f) => (
                      <tr key={f.grantId}>
                        <td className="num">{f.grantDate}</td>
                        <td className="num">{f.deadline}</td>
                        <td className="r num">{fmtDays(f.taken)}</td>
                        <td>
                          {f.shortfall === 0 ? (
                            <span className="badge badge-board">達成</span>
                          ) : f.deadline <= today ? (
                            <span className="badge badge-bull">期限超過・{fmtDays(f.shortfall)}不足</span>
                          ) : (
                            <span className="badge badge-warn">あと{fmtDays(f.shortfall)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="stack" style={{ gap: 8 }}>
            <h3>付与履歴</h3>
            {d.data.grants.length === 0 ? (
              <p className="muted small">付与の登録はありません。</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>付与日</th>
                      <th>種別</th>
                      <th className="r">付与</th>
                      <th className="r">使用</th>
                      <th className="r">残</th>
                      <th>時効</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...d.data.grants].sort((a, b) => (a.grantDate < b.grantDate ? 1 : -1)).map((g) => (
                      <tr key={g.id}>
                        <td className="num">{g.grantDate}</td>
                        <td>{KIND_LABEL[g.kind]}</td>
                        <td className="r num">{fmtDays(g.days)}</td>
                        <td className="r num">{fmtDays(g.used)}</td>
                        <td className="r num">{fmtDays(g.remaining)}</td>
                        <td className="num">
                          {g.expiresOn}{' '}
                          {g.expired ? (
                            <span className="badge">時効</span>
                          ) : g.remaining > 0 && daysBetween(today, g.expiresOn) <= EXPIRY_WARN_DAYS ? (
                            <span className="badge badge-brass">まもなく時効</span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="stack" style={{ gap: 8 }}>
            <h3>取得・調整の履歴</h3>
            {d.data.transactions.length === 0 ? (
              <p className="muted small">取得・調整の登録はありません。</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>日付</th>
                      <th>区分</th>
                      <th className="r">日数</th>
                      <th>理由・メモ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.data.transactions.map((t) => (
                      <tr key={t.id}>
                        <td className="num">
                          {t.date}（{wd(t.date)}）
                        </td>
                        <td>
                          {TX_LABEL[t.kind]}
                          {t.kind === 'take' && t.date > today && <span className="badge badge-info" style={{ marginLeft: 6 }}>予定</span>}
                        </td>
                        <td className="r num">{t.kind === 'take' ? `−${fmtDays(t.days)}` : t.days > 0 ? `+${fmtDays(t.days)}` : `−${fmtDays(-t.days)}`}</td>
                        <td className="small wrap">{t.reason || <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {open === 'grant' && grantInit && (
        <GrantModal
          employeeId={employeeId}
          initial={grantInit}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            d.reload();
          }}
        />
      )}
      {open === 'take' && (
        <TakeModal
          employeeId={employeeId}
          defaultMinutes={emp?.dailyScheduledMinutes ?? null}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            d.reload();
          }}
        />
      )}
      {open === 'adjust' && (
        <AdjustModal
          employeeId={employeeId}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            d.reload();
          }}
        />
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ 付与
function GrantModal({ employeeId, initial, onClose, onDone }: { employeeId: string; initial: GrantForm; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState<GrantForm>(initial);
  const days = Number(f.days);
  const statutory = f.kind === 'statutory' || f.kind === 'proportional';
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.grantDate)) errors.push('付与日を入力してください');
  if (!f.days.trim() || !Number.isFinite(days) || days < 0.5 || days > 40 || Math.round(days * 2) !== days * 2) errors.push('付与日数は0.5〜40日の0.5日単位で入力してください');
  if (statutory && !f.attendanceRateConfirmed) errors.push('出勤率8割以上であることの確認が必要です');
  if (f.kind === 'initial_balance' && f.note.trim().length < 2) errors.push('既存残日数の根拠を記入してください');
  const expires = /^\d{4}-\d{2}-\d{2}$/.test(f.grantDate) ? `${Number(f.grantDate.slice(0, 4)) + 2}${f.grantDate.slice(4) === '-02-29' ? '-02-28' : f.grantDate.slice(4)}` : '—';

  return (
    <Modal
      title={f.kind === 'initial_balance' ? '既存残日数を登録' : '有給休暇を付与'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || errors.length > 0}
            onClick={async () => {
              const r = await run(
                () => client.call('leave.grant', { employeeId, kind: f.kind, grantDate: f.grantDate, days, attendanceRateConfirmed: statutory ? f.attendanceRateConfirmed : false, note: f.note.trim() }),
                '有給休暇の付与を登録しました',
              );
              if (r) onDone();
            }}
          >
            登録
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <Field label="種別">
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as LeaveGrant['kind'] })}>
            {(Object.keys(KIND_LABEL) as LeaveGrant['kind'][]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {f.kind === 'initial_balance' && (
          <div className="callout callout-warn">
            既存残日数はシステムが根拠なく自動で決定することはありません。紙の有給管理簿・前のシステムの記録などで残日数と付与日を確認し、その根拠を下のメモ欄に必ず記入してください。付与日には、その残日数が発生した元の付与日（時効の起算日）を入力します。
          </div>
        )}
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          <Field label="付与日">
            <input className="input" type="date" value={f.grantDate} onChange={(e) => setF({ ...f, grantDate: e.target.value })} />
          </Field>
          <Field label="付与日数" hint="0.5日単位">
            <input className="input num" type="number" min={0.5} max={40} step={0.5} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
          </Field>
          <div className="field">
            <span>時効</span>
            <div className="input num" style={{ background: 'var(--paper)', display: 'flex', alignItems: 'center' }}>
              {expires}
            </div>
          </div>
        </div>
        {statutory && (
          <label className="check callout" style={{ borderLeftColor: 'var(--board)', background: 'var(--board-soft)' }}>
            <input type="checkbox" checked={f.attendanceRateConfirmed} onChange={(e) => setF({ ...f, attendanceRateConfirmed: e.target.checked })} />
            <span>
              <strong>出勤率8割以上を確認しました（必須）</strong>
              <div className="small">前回の付与日（初回は入社日）から今回の付与日の前日までの全労働日のうち、8割以上出勤していることを勤怠記録で確認してください。出勤率はシステムでは自動判定しません。</div>
            </span>
          </label>
        )}
        <Field label={f.kind === 'initial_balance' ? '根拠・メモ（必須）' : 'メモ'} hint={f.kind === 'initial_balance' ? '例: 紙の管理簿（2025年度）より移行' : '任意'}>
          <textarea className="input" rows={2} maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {errors.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: '1.2em', color: 'var(--warn)' }}>
            {errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 取得
function TakeModal({ employeeId, defaultMinutes, onClose, onDone }: { employeeId: string; defaultMinutes: number | null; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [date, setDate] = useState(todayJst());
  const [days, setDays] = useState<'1' | '0.5'>('1');
  const [useCustom, setUseCustom] = useState(false);
  const [h, setH] = useState('');
  const [m, setM] = useState('0');
  const [reason, setReason] = useState('');
  const custom = useCustom ? Number(h || 0) * 60 + Number(m || 0) : null;
  const customErr = useCustom && (!h.trim() || !Number.isInteger(Number(h)) || !Number.isInteger(Number(m)) || Number(m) < 0 || Number(m) > 59 || (custom ?? 0) > 1440);
  return (
    <Modal
      title="有給休暇の取得を登録"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !date || !!customErr}
            onClick={async () => {
              const r = await run(() => client.call('leave.take', { employeeId, date, days: Number(days), scheduledMinutes: custom, reason: reason.trim() }), '有給休暇の取得を登録しました');
              if (r) onDone();
            }}
          >
            登録
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          <Field label="取得日" hint="先の日付は取得予定">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="field">
            <span>取得単位</span>
            <div className="row">
              <label className="check">
                <input type="radio" name="leave-days" checked={days === '1'} onChange={() => setDays('1')} />
                <span>1日</span>
              </label>
              <label className="check">
                <input type="radio" name="leave-days" checked={days === '0.5'} onChange={() => setDays('0.5')} />
                <span>半日</span>
              </label>
            </div>
          </div>
        </div>
        {days === '0.5' && <p className="small muted">半日単位は就業規則で定め、店舗設定で許可している場合のみ登録できます（許可されていない場合は登録時にエラーになります）。</p>}
        <div className="field">
          <span>有給の賃金計算に使う所定労働時間</span>
          <label className="check">
            <input type="radio" name="leave-min" checked={!useCustom} onChange={() => setUseCustom(false)} />
            <span>
              雇用条件の1日所定労働時間を使う
              <span className="small muted">
                （{defaultMinutes !== null ? `${Math.floor(defaultMinutes / 60)}時間${defaultMinutes % 60 ? `${defaultMinutes % 60}分` : ''}${days === '0.5' ? '×0.5' : ''}` : '未設定'}）
              </span>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="leave-min" checked={useCustom} onChange={() => setUseCustom(true)} />
            <span>この日の所定労働時間を指定する（シフトが決まっていた場合など）</span>
          </label>
          {useCustom && (
            <div className="row" style={{ marginLeft: 26 }}>
              <input className="input num" style={{ width: 80 }} type="number" min={0} max={24} value={h} onChange={(e) => setH(e.target.value)} aria-label="時間" />
              時間
              <input className="input num" style={{ width: 80 }} type="number" min={0} max={59} step={5} value={m} onChange={(e) => setM(e.target.value)} aria-label="分" />
              分{days === '0.5' && <span className="small muted">（半日分の時間を入力）</span>}
            </div>
          )}
          {customErr && <span className="small" style={{ color: 'var(--bull)' }}>時間と分を正しく入力してください</span>}
          {!useCustom && defaultMinutes === null && <span className="small" style={{ color: 'var(--warn)' }}>雇用条件の1日所定労働時間が未設定です。「通常の賃金」方式では給与を確定できないため、時間を指定するか雇用条件を設定してください。</span>}
        </div>
        <Field label="メモ" hint="任意">
          <input className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="small muted">残日数が不足している場合や、同じ日に登録済みの場合は登録できません。古い付与から順に消化されます。</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 調整
function AdjustModal({ employeeId, onClose, onDone }: { employeeId: string; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [date, setDate] = useState(todayJst());
  const [sign, setSign] = useState<'+' | '-'>('-');
  const [days, setDays] = useState('');
  const [reason, setReason] = useState('');
  const n = Number(days);
  const valid = !!date && Number.isFinite(n) && n > 0 && n <= 40 && Math.round(n * 2) === n * 2 && reason.trim().length >= 2;
  return (
    <Modal
      title="有給残日数の調整"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !valid}
            onClick={async () => {
              const r = await run(() => client.call('leave.adjust', { employeeId, date, days: sign === '+' ? n : -n, reason: reason.trim() }), '調整を登録しました');
              if (r) onDone();
            }}
          >
            登録
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="callout">付与・取得の登録で表せない訂正にだけ使用します。調整は監査ログに記録され、削除できません。</div>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          <Field label="調整日">
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="増減">
            <select className="input" value={sign} onChange={(e) => setSign(e.target.value as '+' | '-')}>
              <option value="-">減らす</option>
              <option value="+">増やす</option>
            </select>
          </Field>
          <Field label="日数" hint="0.5日単位">
            <input className="input num" type="number" min={0.5} max={40} step={0.5} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <Field label="理由（必須）" hint="2文字以上">
          <textarea className="input" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <p className="small muted">増やす場合は調整日時点で有効な最新の付与に加算し、減らす場合は古い付与から順に差し引きます。</p>
      </div>
    </Modal>
  );
}
