/**
 * 申請・確認（v1.3）
 * - 早出・残業申請の承認・一部承認・差戻し・却下
 * - シフト外の勤務（未申請を含む）の確認: 実労働として登録／実労働なしとして確認
 * - スタッフ本人による勤怠修正・休憩の申告の確認
 * 申請の却下・差戻しは実労働の賃金不払いを意味しない。未確認のシフト外時間がある間は給与を確定できない
 */
import { useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, Panel, shiftDate, todayJst, useAction, useClient, useLoad, useToast } from '../../components/ui';

const CAT: Record<string, string> = { early: '早出', late: '残業', between: 'シフト間', no_shift: 'シフト未登録', other: 'その他' };
const STATUS: Record<string, string> = { pending: '申請中', approved: '承認済み', returned: '差戻し', rejected: '却下', cancelled: '取消', confirmed: '確認済み' };
const WORK: Record<string, string> = { work: '実労働', no_work: '実労働なし', unconfirmed: '未確認' };
const hm = (iso: string | null) => (iso ? iso.slice(11, 16) : '—');
const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');
const local = (iso: string) => iso.slice(0, 16);
/** 時刻の表示（秒がある場合は秒まで） */
const hms = (iso: string) => (iso.slice(17, 19) && iso.slice(17, 19) !== '00' ? iso.slice(11, 19) : iso.slice(11, 16));
/** 長さの表示（1 分未満は秒） */
const dur = (g: { minutes: number; seconds?: number }) => (g.minutes === 0 && g.seconds ? `${g.seconds}秒` : `${g.minutes}分`);

interface Req {
  id: string;
  employeeId: string;
  displayName?: string;
  workDate: string;
  category: string;
  requestedStart: string;
  requestedEnd: string;
  requestedMinutes: number;
  approvedStart: string | null;
  approvedEnd: string | null;
  approvedMinutes: number;
  partial: boolean;
  reason: string;
  identityVerified: boolean;
  status: string;
  workConfirmation: string;
  reviewComment: string;
  history: Array<{ id: string; action: string; actorKind: string; comment: string; createdAt: string }>;
}

const CSS = `.rq-cards{display:grid;gap:10px}.rq-card{border:1px solid var(--line-2);border-radius:10px;padding:12px 14px;display:grid;gap:6px;background:var(--paper,#fff)}
.rq-card .top{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}.rq-card .acts{display:flex;flex-wrap:wrap;gap:6px}
.rq-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.rq-tabs .btn{min-height:44px}`;

export function RequestsPage() {
  const [tab, setTab] = useState<'overtime' | 'offshift' | 'corrections'>('overtime');
  const client = useClient();
  const summary = useLoad(() => client.call<{ overtimePending: number; correctionsPending: number; correctionsUnreviewed: number; breakDeclarationsPending: number; offShiftUnresolvedSessions: number; basis: string }>('requests.summary'), [tab]);
  const s = summary.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      <style>{CSS}</style>
      <div className="rq-tabs" role="tablist" aria-label="申請・確認の種類">
        <button role="tab" aria-selected={tab === 'overtime'} className={`btn ${tab === 'overtime' ? 'btn-primary' : ''}`} onClick={() => setTab('overtime')}>
          早出・残業申請{s ? `（未処理 ${s.overtimePending}）` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'offshift'} className={`btn ${tab === 'offshift' ? 'btn-primary' : ''}`} onClick={() => setTab('offshift')}>
          シフト外の勤務{s ? `（未確認 ${s.offShiftUnresolvedSessions}）` : ''}
        </button>
        <button role="tab" aria-selected={tab === 'corrections'} className={`btn ${tab === 'corrections' ? 'btn-primary' : ''}`} onClick={() => setTab('corrections')}>
          勤怠修正・休憩の申告{s ? `（${s.correctionsPending + s.correctionsUnreviewed + s.breakDeclarationsPending}）` : ''}
        </button>
      </div>
      {s && s.basis === 'actual' && <div className="callout">給与計算の時間基準が「打刻の実績どおり」に設定されています（店舗設定）。シフト外の勤務の確認は給与計算に影響しません。</div>}
      <div className="callout small">
        申請の却下・差戻しは申請内容の扱いです。実際に働いた時間は、申請がなくても・却下した場合でも、実労働として確認して給与に含めてください。未確認のシフト外の時間があるスタッフの給与は確定できません。
      </div>
      {tab === 'overtime' && <OvertimeTab onChanged={summary.reload} />}
      {tab === 'offshift' && <OffShiftTab onChanged={summary.reload} />}
      {tab === 'corrections' && <CorrectionsTab onChanged={summary.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------ 早出・残業申請
function OvertimeTab({ onChanged }: { onChanged: () => void }) {
  const client = useClient();
  const [status, setStatus] = useState('pending');
  const list = useLoad(() => client.call<Req[]>('overtime.list', { status }), [status]);
  const [review, setReview] = useState<Req | null>(null);
  return (
    <Panel
      title="早出・残業申請"
      actions={
        <select className="input" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状態で絞り込み">
          <option value="pending">申請中</option>
          <option value="returned">差戻し</option>
          <option value="approved">承認済み</option>
          <option value="rejected">却下</option>
          <option value="confirmed">確認済み（管理者登録）</option>
          <option value="all">すべて</option>
        </select>
      }
    >
      {list.loading && <Loading />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <Empty>該当する申請はありません</Empty>}
      <div className="rq-cards">
        {list.data?.map((r) => (
          <div key={r.id} className="rq-card">
            <div className="top">
              <strong>{r.displayName}</strong>
              <span className="badge">{CAT[r.category] ?? r.category}</span>
              <span className="num">
                {r.workDate} {hm(r.requestedStart)}〜{hm(r.requestedEnd)}（{r.requestedMinutes}分）
              </span>
              <span className={`badge ${r.status === 'pending' ? 'badge-warn' : r.status === 'approved' || r.status === 'confirmed' ? 'badge-board' : ''}`}>{STATUS[r.status] ?? r.status}</span>
              <span className="badge badge-info">実労働: {WORK[r.workConfirmation]}{r.partial ? `（一部 ${hm(r.approvedStart)}〜${hm(r.approvedEnd)}）` : ''}</span>
              {!r.identityVerified && <span className="badge badge-bull">本人未確認（PIN 未設定）</span>}
            </div>
            <div className="small">理由: {r.reason}</div>
            {r.reviewComment && <div className="small muted">確認コメント: {r.reviewComment}</div>}
            {r.history.length > 1 && (
              <details className="small muted">
                <summary>履歴（{r.history.length}件）</summary>
                <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {r.history.map((h) => (
                    <li key={h.id}>
                      {h.createdAt.slice(0, 16).replace('T', ' ')} {h.action}（{h.actorKind}）{h.comment && `: ${h.comment}`}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {r.status !== 'cancelled' && (
              <div className="acts">
                <button className="btn btn-sm btn-primary" onClick={() => setReview(r)}>
                  {r.status === 'pending' ? '確認・承認' : '処理を変更'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {review && (
        <ReviewModal
          req={review}
          onClose={() => setReview(null)}
          onDone={() => {
            setReview(null);
            list.reload();
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}

function ReviewModal({ req, onClose, onDone }: { req: Req; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const toast = useToast();
  const { busy, run } = useAction();
  const [action, setAction] = useState<'approve' | 'partial' | 'return' | 'reject' | 'cancel'>('approve');
  const [start, setStart] = useState(local(req.requestedStart));
  const [end, setEnd] = useState(local(req.requestedEnd));
  const [comment, setComment] = useState('');
  const [wc, setWc] = useState<'no_work' | 'unconfirmed'>('unconfirmed');
  const [remainder, setRemainder] = useState<'no_work' | 'unconfirmed'>('unconfirmed');
  const needComment = action !== 'approve';
  const submit = async () => {
    const args: Record<string, unknown> = { requestId: req.id, action, comment };
    if (action === 'partial') Object.assign(args, { approvedStart: start, approvedEnd: end, remainder });
    if (action === 'reject') args.workConfirmation = wc;
    const r = await run(() => client.call<{ warning: string | null }>('overtime.review', args), '処理しました');
    if (r) {
      if (r.warning) toast('info', r.warning);
      onDone();
    }
  };
  return (
    <Modal
      title={`${req.displayName}さんの${CAT[req.category] ?? ''}申請`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || (needComment && comment.trim().length < 2)} onClick={submit}>
            確定
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <p className="num">
          申請: {req.workDate} {hm(req.requestedStart)}〜{hm(req.requestedEnd)}（{req.requestedMinutes}分）{!req.identityVerified && <span className="badge badge-bull" style={{ marginLeft: 6 }}>本人未確認</span>}
        </p>
        <div className="row" role="radiogroup" aria-label="処理">
          {(
            [
              ['approve', '承認（全時間を実労働）'],
              ['partial', '一部承認'],
              ['return', '差戻し'],
              ['reject', '却下'],
              ['cancel', '取消'],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="check" style={{ minHeight: 44, alignItems: 'center' }}>
              <input type="radio" name="act" checked={action === k} onChange={() => setAction(k)} style={{ marginTop: 0 }} />
              <span>{l}</span>
            </label>
          ))}
        </div>
        {action === 'partial' && (
          <div className="form-grid">
            <Field label="実労働として認める開始">
              <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label="実労働として認める終了">
              <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Field>
            <div style={{ gridColumn: '1/-1' }}>
              <Field label="申請された時間のうち、承認しなかった残りの時間">
                <select className="input" value={remainder} onChange={(e) => setRemainder(e.target.value as 'no_work' | 'unconfirmed')}>
                  <option value="unconfirmed">未確認のまま（後で確認する。給与は確定できません）</option>
                  <option value="no_work">実労働はなかった（本人への確認などで確かめた）</option>
                </select>
              </Field>
            </div>
          </div>
        )}
        {action === 'reject' && (
          <Field label="この時間の実労働の扱い">
            <select className="input" value={wc} onChange={(e) => setWc(e.target.value as 'no_work' | 'unconfirmed')}>
              <option value="unconfirmed">未確認のまま（後で確認する。給与は確定できません）</option>
              <option value="no_work">実労働はなかった（私的滞在・待機なし等を確認済み）</option>
            </select>
          </Field>
        )}
        <Field label={needComment ? 'コメント・理由（必須）' : 'コメント（任意）'}>
          <textarea className="input" rows={2} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ シフト外の勤務
interface OffRow {
  employeeId: string;
  displayName: string;
  laborDate: string;
  sessionKey: string;
  start: string;
  end: string | null;
  original: { clockIn: string | null; clockOut: string | null };
  timeBasis: {
    shifts: Array<{ start: string; end: string }>;
    payableMinutes: number;
    unresolvedMinutes: number;
    candidates: Array<{ category: string; start: string; end: string; minutes: number; segments: Array<{ start: string; end: string; minutes: number; seconds?: number; resolution: string }> }>;
  };
}

function OffShiftTab({ onChanged }: { onChanged: () => void }) {
  const client = useClient();
  const to = todayJst();
  const [from, setFrom] = useState(shiftDate(to, -31));
  const [onlyUnresolved, setOnlyUnresolved] = useState(true);
  const list = useLoad(() => client.call<{ rows: OffRow[] }>('offshift.list', { from, to, unresolvedOnly: onlyUnresolved }), [from, onlyUnresolved]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<null | 'work' | 'no_work'>(null);
  const items = (list.data?.rows ?? []).flatMap((r) =>
    r.timeBasis.candidates.flatMap((c) =>
      c.segments
        .filter((g) => g.resolution === 'unresolved')
        .map((g) => ({ key: `${r.sessionKey}|${g.start}`, employeeId: r.employeeId, displayName: r.displayName, laborDate: r.laborDate, category: c.category, start: g.start, end: g.end, minutes: g.minutes, seconds: g.seconds })),
    ),
  );
  const picked = items.filter((i) => sel[i.key]);
  return (
    <Panel title="シフト外の勤務（未申請を含む）">
      <div className="row" style={{ marginBottom: 10 }}>
        <Field label="開始日">
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <label className="check small" style={{ minHeight: 44, alignItems: 'center' }}>
          <input type="checkbox" checked={onlyUnresolved} onChange={(e) => setOnlyUnresolved(e.target.checked)} style={{ marginTop: 0 }} />
          <span>未確認のみ</span>
        </label>
      </div>
      {list.loading && <Loading />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.rows.length === 0 && <Empty>{onlyUnresolved ? '未確認のシフト外の勤務はありません' : 'シフト外の勤務はありません'}</Empty>}
      <div className="rq-cards">
        {list.data?.rows.map((r) => (
          <div key={r.sessionKey} className="rq-card">
            <div className="top">
              <strong>{r.displayName}</strong>
              <span className="num">{r.laborDate}</span>
              <span className="small">
                シフト {r.timeBasis.shifts.length ? r.timeBasis.shifts.map((s) => `${hm(s.start)}〜${hm(s.end)}`).join('、') : 'なし'}／打刻 {hm(r.original.clockIn)}〜{hm(r.original.clockOut)}／修正後 {hm(r.start)}〜{hm(r.end)}
              </span>
              <span className="badge badge-board">給与対象 {r.timeBasis.payableMinutes}分</span>
            </div>
            {r.timeBasis.candidates.map((c) =>
              c.segments.map((g) => {
                const key = `${r.sessionKey}|${g.start}`;
                return (
                  <label key={key} className="check" style={{ minHeight: 44, alignItems: 'center' }}>
                    {g.resolution === 'unresolved' ? <input type="checkbox" checked={!!sel[key]} onChange={(e) => setSel((x) => ({ ...x, [key]: e.target.checked }))} style={{ marginTop: 0 }} /> : <span style={{ width: 18 }} />}
                    <span>
                      {CAT[c.category]} {md(g.start)} {hms(g.start)}〜{hms(g.end)}（{dur(g)}）{' '}
                      <span className={`badge ${g.resolution === 'unresolved' ? 'badge-warn' : g.resolution === 'work' ? 'badge-board' : ''}`}>{g.resolution === 'unresolved' ? '未確認' : g.resolution === 'work' ? '実労働' : '実労働なし'}</span>
                    </span>
                  </label>
                );
              }),
            )}
          </div>
        ))}
      </div>
      {items.length > 0 && (
        <div className="row" style={{ marginTop: 12 }}>
          <span className="small">選択 {picked.length} 件</span>
          <button className="btn" onClick={() => setSel(Object.fromEntries(items.map((i) => [i.key, true])))}>
            すべて選択
          </button>
          <button className="btn btn-primary" disabled={!picked.length} onClick={() => setConfirm('work')}>
            実労働として登録
          </button>
          <button className="btn" disabled={!picked.length} onClick={() => setConfirm('no_work')}>
            実労働なしとして確認
          </button>
        </div>
      )}
      {confirm && (
        <ConfirmOffShift
          result={confirm}
          items={picked}
          onClose={() => setConfirm(null)}
          onDone={() => {
            setConfirm(null);
            setSel({});
            list.reload();
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}

function ConfirmOffShift({ result, items, onClose, onDone }: { result: 'work' | 'no_work'; items: Array<{ employeeId: string; displayName: string; category: string; start: string; end: string; minutes: number; seconds?: number }>; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const toast = useToast();
  const { busy, run } = useAction();
  const [comment, setComment] = useState('');
  return (
    <Modal
      title={result === 'work' ? '実労働として登録' : '実労働なしとして確認'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || comment.trim().length < 2}
            onClick={async () => {
              const r = await run(
                () => client.call<{ warning: string | null }>('offshift.confirm', { comment, // 候補区間の正確な開始・終了（秒まで）を送る（同じ分の別の候補区間まで確認済みにしない。Codex 監査3 #2）
                items: items.map((i) => ({ employeeId: i.employeeId, category: i.category, start: i.start.slice(0, 19), end: i.end.slice(0, 19), result })) }),
                '確認を登録しました',
              );
              if (r) {
                if (r.warning) toast('info', r.warning);
                onDone();
              }
            }}
          >
            登録
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
          {items.map((i) => (
            <li key={`${i.employeeId}${i.start}`}>
              {i.displayName} {CAT[i.category]} {md(i.start)} {hms(i.start)}〜{hms(i.end)}（{dur(i)}）
            </li>
          ))}
        </ul>
        {result === 'no_work' && (
          <div className="callout callout-warn small">
            準備・片付け・待機など、指揮命令下にあった時間は労働時間です。本人への確認などにより、実際に業務をしていなかったことを確かめた場合のみ「実労働なし」としてください。
          </div>
        )}
        <Field label="確認内容・理由（必須）">
          <textarea className="input" rows={2} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 本人の勤怠修正・休憩の申告
interface CorrGroup {
  groupId: string;
  displayName: string;
  createdAt: string;
  reason: string;
  identityVerified: boolean;
  status: string;
  reviewStatus: string;
  items: Array<{ id: string; action: string; newType: string | null; newAt: string | null; before: string }>;
}
interface Decl {
  id: string;
  displayName: string;
  laborDate: string;
  kind: string;
  intervals: Array<{ start: string; end: string }>;
  reason: string;
  identityVerified: boolean;
  status: string;
  reviewStatus: string;
}
const TYPE: Record<string, string> = { clock_in: '出勤', clock_out: '退勤', break_start: '休憩開始', break_end: '休憩終了' };
const DECL: Record<string, string> = { as_scheduled: '予定どおり取得', not_taken: '取得できなかった', custom: '実際の休憩を申告' };

function CorrectionsTab({ onChanged }: { onChanged: () => void }) {
  const client = useClient();
  const list = useLoad(() => client.call<{ corrections: CorrGroup[]; breakDeclarations: Decl[] }>('attendance.reviewList'), []);
  const toast = useToast();
  const { busy, run } = useAction();
  const [reject, setReject] = useState<{ kind: 'correction' | 'break'; id: string } | null>(null);
  const [comment, setComment] = useState('');
  const act = async (kind: 'correction' | 'break', id: string, action: 'approve' | 'reject', c = '') => {
    const r = await run(() => client.call<{ warning: string | null }>('attendance.review', { kind, id, action, comment: c }), action === 'approve' ? '確認しました' : '却下しました');
    if (r) {
      if (r.warning) toast('info', r.warning);
      list.reload();
      onChanged();
    }
  };
  return (
    <Panel title="スタッフ本人による勤怠修正・休憩の申告">
      {list.loading && <Loading />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.corrections.length + list.data.breakDeclarations.length === 0 && <Empty>確認が必要な修正・申告はありません</Empty>}
      <div className="rq-cards">
        {list.data?.corrections.map((g) => (
          <div key={g.groupId} className="rq-card">
            <div className="top">
              <strong>{g.displayName}</strong>
              <span className="small muted">{g.createdAt.slice(0, 16).replace('T', ' ')} 申告</span>
              <span className={`badge ${g.reviewStatus === 'pending' ? 'badge-warn' : 'badge-info'}`}>{g.reviewStatus === 'pending' ? '承認待ち（未反映）' : '反映済み・未確認'}</span>
              {!g.identityVerified && <span className="badge badge-bull">本人未確認（PIN 未設定）</span>}
            </div>
            <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
              {g.items.map((i) => {
                const before = (() => {
                  try {
                    const b = JSON.parse(i.before || '{}') as { at?: string };
                    return b.at ? `${b.at.slice(0, 16).replace('T', ' ')} → ` : '（記録なし）→ ';
                  } catch {
                    return '';
                  }
                })();
                return (
                  <li key={i.id}>
                    {TYPE[i.newType ?? ''] ?? i.action}: {before}
                    {i.newAt ? i.newAt.slice(0, 16).replace('T', ' ') : '無効化'}
                  </li>
                );
              })}
            </ul>
            <div className="small">理由: {g.reason}</div>
            <div className="acts">
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('correction', g.groupId, 'approve')}>
                {g.reviewStatus === 'pending' ? '承認して反映' : '確認済みにする'}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setReject({ kind: 'correction', id: g.groupId })}>
                却下
              </button>
            </div>
          </div>
        ))}
        {list.data?.breakDeclarations.map((d) => (
          <div key={d.id} className="rq-card">
            <div className="top">
              <strong>{d.displayName}</strong>
              <span className="num">{d.laborDate}</span>
              <span className="badge">休憩: {DECL[d.kind]}</span>
              <span className={`badge ${d.status === 'pending' ? 'badge-warn' : 'badge-info'}`}>{d.status === 'pending' ? '承認待ち（未反映）' : '反映済み・未確認'}</span>
              {!d.identityVerified && <span className="badge badge-bull">本人未確認（PIN 未設定）</span>}
            </div>
            {d.intervals.length > 0 && <div className="small num">{d.intervals.map((i) => `${hm(i.start)}〜${hm(i.end)}`).join('、')}</div>}
            {d.reason && <div className="small">理由: {d.reason}</div>}
            <div className="acts">
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act('break', d.id, 'approve')}>
                {d.status === 'pending' ? '承認して反映' : '確認済みにする'}
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setReject({ kind: 'break', id: d.id })}>
                却下
              </button>
            </div>
          </div>
        ))}
      </div>
      {reject && (
        <Modal
          title="却下の理由"
          onClose={() => setReject(null)}
          footer={
            <>
              <button className="btn" onClick={() => setReject(null)}>
                キャンセル
              </button>
              <button
                className="btn btn-danger"
                disabled={busy || comment.trim().length < 2}
                onClick={async () => {
                  await act(reject.kind, reject.id, 'reject', comment);
                  setReject(null);
                  setComment('');
                }}
              >
                却下する
              </button>
            </>
          }
        >
          <p className="small">却下すると、この修正・申告は勤怠に反映されません（反映済みの場合は取り消されます）。記録は履歴として残ります。</p>
          <textarea className="input" rows={2} maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} aria-label="却下の理由" />
        </Modal>
      )}
    </Panel>
  );
}
