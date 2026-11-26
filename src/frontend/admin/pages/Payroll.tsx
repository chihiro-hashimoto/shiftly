/** 給与計算・確定・訂正（F14 給与計算 / F17 控除・調整 / F18 締め・確定・訂正） */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Minutes, Modal, Panel, Yen, useAction, useClient, useLoad, WEEKDAYS } from '../../components/ui';
import type { DeductionEntry, PayrollAdjustment, PayrollPeriod, PayrollTotals } from '../../../shared/types';
import type { BasisLine, DailyBreakdown, IssueSeverity } from '../../../shared/payroll';
import { STATUS } from './Dashboard';

/** ページのルート（表の最小幅で管理画面のグリッド列が広がり、スマホ幅で横スクロールが出るのを防ぐ） */
const PAGE_ROOT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

// ------------------------------------------------------------------ 型
interface RestoreLock {
  restoredAt: string;
  backupId: string;
}
interface PeriodsResp {
  periods: Array<PayrollPeriod & { restoreLock?: RestoreLock | null }>;
  suggestedPeriodKey: string | null;
}
interface Issue {
  code: string;
  severity: IssueSeverity;
  message: string;
  date?: string;
  key: string;
}
interface EmpResult {
  employeeId: string;
  displayName: string;
  payType: 'hourly' | 'monthly';
  savedStatus: string;
  revision: number;
  totals: PayrollTotals;
  issues: Issue[];
  canConfirm: boolean;
  basis: BasisLine[];
  daily: DailyBreakdown[];
  confirmedTotals: PayrollTotals | null;
}
interface ComputeResp {
  period: PayrollPeriod;
  employees: EmpResult[];
}
interface ResultRow {
  id: string;
  employeeId: string;
  displayName: string;
  revision: number;
  status: string;
  confirmedAt: string | null;
  computedAt: string;
  correctionReason: string;
  totals: PayrollTotals;
}

const STEPS = ['uncomputed', 'draft', 'review', 'confirmed', 'issued'] as const;
const DED_STATUS: Record<DeductionEntry['status'], [string, string]> = {
  unentered: ['未入力', 'badge-bull'],
  entered: ['入力済み', 'badge-board'],
  explicit_none: ['控除なし（明示）', 'badge-info'],
};
const ADJ_KIND: Record<PayrollAdjustment['kind'], string> = {
  absence_days: '欠勤（日数）',
  late_early_minutes: '遅刻・早退（分）',
  manual_addition: '手動加算',
  manual_subtraction: '手動減算',
};

const fmtDT = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
const ackId = (employeeId: string, key: string) => `${employeeId}::${key}`;
const wd = (d: string) => WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];

const LOCAL_CSS = `
.pr-steps{display:flex;list-style:none;margin:0;padding:0;gap:4px}
.pr-steps li{flex:1 1 0;min-width:0;padding:6px 8px 0;border-top:4px solid var(--line);color:var(--ink-3);font-size:.82rem;line-height:1.35}
.pr-steps li .n{font-family:var(--font-num);font-weight:600;margin-right:4px}
.pr-steps li.done{border-color:var(--board);color:var(--ink-2)}
.pr-steps li.current{border-color:var(--board-deep);color:var(--ink);font-weight:700}
.pr-detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;padding:6px 0 10px}
.pr-detail h4{margin:0 0 6px;font-size:.88rem;color:var(--ink-2)}
.pr-scroll{max-height:280px;overflow:auto;border:1px solid var(--line-2);border-radius:var(--radius-s)}
.pr-amt-label{display:block;font-size:.72rem;color:var(--ink-3);line-height:1.2}
.pr-issue-list{margin:0;padding-left:18px}
.pr-issue-list li{margin:2px 0}
table.data tr.pr-open td{background:#f7faf8}
table.pr-main > tbody > tr > td:first-child{white-space:nowrap}
.pr-grid6{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px 14px}
`;

// ------------------------------------------------------------------ ページ
export function PayrollPage() {
  const client = useClient();
  const isSharedDevice = client.transport.mode === 'staff';
  const periods = useLoad(() => client.call<PeriodsResp>('payroll.periods'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const { busy, run } = useAction();

  const list = periods.data?.periods ?? [];
  const current = list.find((p) => p.id === selected) ?? list[0] ?? null;
  const suggested = periods.data?.suggestedPeriodKey ?? null;
  const suggestedExists = !!suggested && list.some((p) => p.periodKey === suggested);

  const open = async (periodKey: string) => {
    const p = await run(() => client.call<PayrollPeriod>('payroll.openPeriod', { periodKey }), `${periodKey} の給与期間を作成しました`);
    if (p) {
      setSelected(p.id);
      setNewKey('');
      periods.reload();
    }
  };

  return (
    <div style={PAGE_ROOT}>
      <style>{LOCAL_CSS}</style>
      <Panel
        title="給与計算期間"
        actions={
          <>
            {suggested && !suggestedExists && (
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void open(suggested)}>
                {suggested} の期間を作成
              </button>
            )}
            <label className="row small">
              <span className="muted">別の月を作成</span>
              <input className="input" type="month" value={newKey} onChange={(e) => setNewKey(e.target.value)} style={{ width: 160 }} aria-label="作成する対象月" />
              <button className="btn btn-sm" disabled={busy || !/^\d{4}-\d{2}$/.test(newKey)} onClick={() => void open(newKey)}>
                作成
              </button>
            </label>
          </>
        }
      >
        {periods.loading && !periods.data && <Loading />}
        {periods.error && <ErrorBox message={periods.error} onRetry={periods.reload} />}
        {periods.data && list.length === 0 && (
          <Empty>
            給与計算期間がまだありません。{suggested ? `「${suggested} の期間を作成」から始めてください。` : '対象月を指定して作成してください（店舗設定の締め日・支払日が必要です）。'}
          </Empty>
        )}
        {current && (
          <div className="stack" style={{ gap: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="row">
                <span className="small muted">対象月</span>
                <select className="input" value={current.id} onChange={(e) => setSelected(e.target.value)} style={{ width: 'auto', minWidth: 220 }}>
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.periodKey}（{STATUS[p.status] ?? p.status}）
                    </option>
                  ))}
                </select>
              </label>
              <span className="small muted">
                計算期間 <span className="num">{current.from}</span>〜<span className="num">{current.to}</span>　支払日 <span className="num">{current.payDate}</span>
              </span>
            </div>
            <Steps status={current.status} />
            {current.restoreLock && <RestoreLockNotice key={current.id} periodId={current.id} lock={current.restoreLock} onReleased={periods.reload} />}
          </div>
        )}
      </Panel>
      {current && <PeriodWork key={current.id} period={current} isSharedDevice={isSharedDevice} onPeriodChanged={periods.reload} />}
    </div>
  );
}

/** 復元で引き継いだ確定済みの給与がある期間の停止表示と解除（Codex 監査9 #1） */
function RestoreLockNotice({ periodId, lock, onReleased }: { periodId: string; lock: RestoreLock; onReleased: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  // 確定済みの総支給額と、現在の条件で計算し直した額の比較（Codex 監査17 #1）
  const review = useLoad(
    () =>
      client.call<{
        hasMonthly: boolean;
        differences: number;
        rows: Array<{ employeeId: string; displayName: string; payType: string; revision: number; confirmedGross: number; currentGross: number | null; differs: boolean }>;
      }>('payroll.restoreLockReview', { periodId }),
    [periodId],
  );
  const [checks, setChecks] = useState({ wage: false, allowance: false, deduction: false, salary: false });
  const [confirmText, setConfirmText] = useState('');
  const r = review.data;
  // 比較の読み込み中・失敗時・差があるときは解除できない（解除の可否はサーバーがその場で計算し直して判断する。Codex 監査18 #1）
  const allChecked = !!r && !review.loading && !review.error && r.differences === 0 && checks.wage && checks.allowance && checks.deduction && (!r.hasMonthly || checks.salary);
  const release = async () => {
    const res = await run(
      () =>
        client.call('payroll.releaseRestoreLock', {
          periodId,
          checkedWageRules: checks.wage,
          checkedAllowances: checks.allowance,
          checkedDeductions: checks.deduction,
          checkedSalaryRules: checks.salary,
          confirmText,
        }),
      '復元後の確認を完了しました',
    );
    if (res) onReleased();
  };
  const check = (k: keyof typeof checks, label: string) => (
    <label className="row small">
      <input type="checkbox" checked={checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="callout callout-warn" role="alert">
      <strong>復元後の給与条件の確認が必要です</strong>
      <p className="small" style={{ margin: '6px 0' }}>
        この期間は、バックアップの復元（{lock.restoredAt.slice(0, 16).replace('T', ' ')}）で確定済みの給与を引き継ぎました。復元後の給与条件（時給・月給・手当・控除など）は、確定したときと異なる可能性があります。条件を確認するまで、確定・訂正・明細の発行は停止しています。
      </p>
      {review.loading && !r && <Loading />}
      {review.error && <ErrorBox message={review.error} onRetry={review.reload} />}
      {r && (
        <div className="stack" style={{ gap: 8 }}>
          {r.differences > 0 ? (
            <div>
              <p className="small" style={{ margin: '4px 0' }}>
                <strong>確定済みの総支給額と、現在の条件で計算し直した額が異なるスタッフが {r.differences} 名います。差がある間は解除できません。</strong>
                給与条件（「スタッフ・権限」の時給ルール・月給設定、手当、控除）を確定時に合わせてから、「比較を更新」を押してください。変更が必要な場合は、解除した後に通常の訂正を行ってください。
              </p>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>スタッフ</th>
                      <th className="r">確定済み（総支給）</th>
                      <th className="r">現在の条件で計算</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows
                      .filter((x) => x.differs)
                      .map((x) => (
                        <tr key={x.employeeId}>
                          <td>
                            {x.displayName}（{x.payType === 'monthly' ? '月給' : '時給'}・第{x.revision}版）
                          </td>
                          <td className="r">
                            <Yen v={x.confirmedGross} />
                          </td>
                          <td className="r">{x.currentGross === null ? '計算できません' : <Yen v={x.currentGross} />}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="small" style={{ margin: '4px 0' }}>
              確定済みの総支給額と、現在の条件で計算し直した額は、すべてのスタッフで一致しています。
            </p>
          )}
          <fieldset className="stack" style={{ gap: 4, border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted">確定したときと一致することを確認した項目（監査ログには確認したことだけを記録します）</legend>
            {check('wage', '時給ルール')}
            {r.hasMonthly && check('salary', '月給設定（基本給・固定残業代・所定労働時間を含む）')}
            {check('allowance', '手当（通勤手当を含む）')}
            {check('deduction', '控除')}
          </fieldset>
          <Field label="確認のため「確認しました」と入力">
            <input className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} maxLength={20} style={{ maxWidth: 200 }} />
          </Field>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" disabled={busy || review.loading} onClick={() => review.reload()}>
              比較を更新
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy || !allChecked || confirmText !== '確認しました'} onClick={() => void release()}>
              復元後の確認を完了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ status }: { status: string }) {
  const idx = STEPS.indexOf(status as (typeof STEPS)[number]);
  return (
    <ol className="pr-steps" aria-label="給与の状態">
      {STEPS.map((s, i) => (
        <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
          <span className="n">{i + 1}</span>
          {STATUS[s]}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ 期間ごとの作業
function PeriodWork({ period, isSharedDevice, onPeriodChanged }: { period: PayrollPeriod; isSharedDevice: boolean; onPeriodChanged: () => void }) {
  const client = useClient();
  const [started, setStarted] = useState(period.status !== 'uncomputed');
  const comp = useLoad(() => (started ? client.call<ComputeResp>('payroll.compute', { periodId: period.id }) : Promise.resolve(null)), [period.id, started]);
  const deds = useLoad(() => client.call<DeductionEntry[]>('deductions.get', { periodId: period.id }), [period.id]);
  const results = useLoad(() => client.call<ResultRow[]>('payroll.results', { periodId: period.id }), [period.id]);
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dedFor, setDedFor] = useState<EmpResult | null>(null);
  const [adjFor, setAdjFor] = useState<EmpResult | null>(null);
  const [corrFor, setCorrFor] = useState<EmpResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const { busy, run } = useAction();

  const refresh = () => {
    comp.reload();
    deds.reload();
    results.reload();
    onPeriodChanged();
  };

  const emps = useMemo(() => comp.data?.employees ?? [], [comp.data]);
  const status = comp.data?.period?.status ?? period.status;
  // 仮計算で期間の状態が変わった場合（未集計→仮計算など）、期間一覧・ステップ表示を更新する
  useEffect(() => {
    if (comp.data?.period && comp.data.period.status !== period.status) onPeriodChanged();
  }, [comp.data, period.status, onPeriodChanged]);
  const dedMap = new Map((deds.data ?? []).map((d) => [d.employeeId, d]));
  const toggleAck = (id: string) =>
    setAcks((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const confirmIssues = (e: EmpResult) => e.issues.filter((i) => i.severity === 'confirm');
  const allAcked = (e: EmpResult) => confirmIssues(e).every((i) => acks.has(ackId(e.employeeId, i.key)));
  const alreadyConfirmed = (e: EmpResult) => !!e.confirmedTotals;
  const ready = emps.filter((e) => !alreadyConfirmed(e) && e.canConfirm && allAcked(e));
  const pending = emps.filter((e) => !alreadyConfirmed(e));
  const confirmedCount = emps.filter(alreadyConfirmed).length;
  const estimateGross = pending.reduce((a, e) => a + e.totals.grossPay, 0);
  const confirmedGross = emps.reduce((a, e) => a + (e.confirmedTotals?.grossPay ?? 0), 0);
  const confirmedNet = emps.reduce((a, e) => a + (e.confirmedTotals?.netPay ?? 0), 0);
  const blockingCount = pending.filter((e) => !e.canConfirm).length;
  const unackedCount = pending.reduce((a, e) => a + confirmIssues(e).filter((i) => !acks.has(ackId(e.employeeId, i.key))).length, 0);

  const ackKeysFor = (list: EmpResult[]) => [...new Set(list.flatMap((e) => confirmIssues(e).filter((i) => acks.has(ackId(e.employeeId, i.key))).map((i) => i.key)))];

  const doConfirm = async () => {
    const r = await run(
      () => client.call<{ confirmed: Array<{ employeeId: string; revision: number; netPay: number }> }>('payroll.confirm', { periodId: period.id, employeeIds: ready.map((e) => e.employeeId), acknowledgements: ackKeysFor(ready) }),
      `${ready.length}名の給与を確定しました`,
    );
    if (r) {
      setConfirmOpen(false);
      refresh();
    }
  };

  if (!started) {
    return (
      <Panel title="仮計算">
        <Empty>
          <p style={{ margin: '0 0 12px' }}>この期間はまだ集計していません。勤怠・給与条件・控除から給与を仮計算します（確定ではありません）。</p>
          <button className="btn btn-primary" onClick={() => setStarted(true)}>
            仮計算を実行
          </button>
        </Empty>
      </Panel>
    );
  }
  if (comp.loading && !comp.data) return <Panel title="仮計算"><Loading text="最新の勤怠・給与条件で計算しています…" /></Panel>;
  if (comp.error) return <Panel title="仮計算"><ErrorBox message={comp.error} onRetry={comp.reload} /></Panel>;
  if (!comp.data) return null;

  // 全員に共通する確定不可の理由（店舗設定に起因するもの等）はまとめて1回だけ表示する
  const commonBlocking =
    pending.length > 1
      ? pending[0]!.issues.filter((i) => i.severity === 'blocking' && i.code !== 'DEDUCTION_UNENTERED' && pending.every((e) => e.issues.some((x) => x.key === i.key && x.message === i.message)))
      : [];
  const commonKeys = new Set(commonBlocking.map((i) => i.key));
  const ownBlocking = (e: EmpResult) => e.issues.filter((i) => i.severity === 'blocking' && !commonKeys.has(i.key));
  const blocking = pending.filter((e) => ownBlocking(e).length > 0);
  const needAck = pending.filter((e) => confirmIssues(e).length > 0);
  const infos = emps.flatMap((e) => e.issues.filter((i) => i.severity === 'info').map((i) => ({ e, i })));
  const anyIssueCode = (code: string) => pending.some((e) => e.issues.some((i) => i.code === code));

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="label">見込額（未確定分の総支給）</div>
          <div className="value">{pending.length ? <Yen v={estimateGross} /> : '—'}</div>
          <div className="sub">{pending.length ? `${pending.length}名分・仮計算の値です。確定するまで変わる可能性があります` : '未確定の給与はありません'}</div>
        </div>
        <div className="kpi">
          <div className="label">確定額（総支給 / 差引支給）</div>
          <div className="value">{confirmedCount ? <Yen v={confirmedGross} /> : '—'}</div>
          <div className="sub">{confirmedCount ? <>差引 <Yen v={confirmedNet} />・{confirmedCount}名確定済み</> : 'まだ確定した給与はありません'}</div>
        </div>
        <div className="kpi">
          <div className="label">確定できる人数</div>
          <div className="value">
            {pending.length ? ready.length : emps.length ? '全員' : '—'}
            <span className="small muted">{pending.length ? ` / ${pending.length} 名` : emps.length ? ' 確定済み' : ''}</span>
          </div>
          <div className="sub">{pending.length ? `確定不可 ${blockingCount}名・未確認の項目 ${unackedCount}件` : '変更が必要な場合は各行の「訂正」から'}</div>
        </div>
      </div>

      <Panel
        title={
          <div className="row">
            <h2>スタッフ別の給与</h2>
            {comp.loading && <span className="small muted">再計算中…</span>}
          </div>
        }
        actions={
          <>
            <button className="btn btn-sm" disabled={comp.loading} onClick={refresh}>
              最新の勤怠で再計算
            </button>
            {(status === 'draft' || status === 'uncomputed') && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={async () => {
                  if (await run(() => client.call('payroll.submitReview', { periodId: period.id }), '確認待ちにしました')) refresh();
                }}
              >
                確認待ちにする
              </button>
            )}
            <button className="btn btn-sm btn-primary" disabled={busy || ready.length === 0} onClick={() => setConfirmOpen(true)}>
              給与を確定（{ready.length}名）
            </button>
          </>
        }
        pad={false}
      >
        {emps.length === 0 ? (
          <Empty>この期間に在籍しているスタッフがいません</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data pr-main">
              <thead>
                <tr>
                  <th>スタッフ</th>
                  <th>状態</th>
                  <th className="r">総支給</th>
                  <th className="r">控除</th>
                  <th className="r">差引支給</th>
                  <th>控除入力</th>
                  <th>課題</th>
                  <th>確定可否</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {emps.map((e) => {
                  const conf = e.confirmedTotals;
                  const t = conf ?? e.totals;
                  const nb = e.issues.filter((i) => i.severity === 'blocking').length;
                  const nc = confirmIssues(e).length;
                  const nUn = confirmIssues(e).filter((i) => !acks.has(ackId(e.employeeId, i.key))).length;
                  const ni = e.issues.filter((i) => i.severity === 'info').length;
                  const ded = dedMap.get(e.employeeId);
                  const dst = DED_STATUS[ded?.status ?? 'unentered'];
                  const drift = conf && conf.netPay !== e.totals.netPay;
                  const isOpen = expanded === e.employeeId;
                  return (
                    <Fragment key={e.employeeId}>
                      <tr className={isOpen ? 'pr-open' : ''}>
                        <td>
                          <button className="btn btn-ghost btn-sm" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : e.employeeId)} style={{ padding: '0 4px', minHeight: 0 }}>
                            {isOpen ? '▾' : '▸'} {e.displayName}
                          </button>
                          <div className="small muted" style={{ paddingLeft: 22 }}>{e.payType === 'monthly' ? '月給制' : '時給制'}・実働 <Minutes v={e.totals.workMinutes} /></div>
                        </td>
                        <td>
                          <span className={`badge ${conf ? 'badge-board' : ''}`}>{conf ? STATUS[e.savedStatus] ?? e.savedStatus : status === 'review' ? STATUS.review : STATUS.draft}</span>
                          {e.revision > 1 && <div className="small muted">第{e.revision}版（訂正あり）</div>}
                        </td>
                        <td className="r">
                          <span className="pr-amt-label">{conf ? '確定額' : '見込額'}</span>
                          <Yen v={t.grossPay} />
                        </td>
                        <td className="r">
                          <span className="pr-amt-label">&nbsp;</span>
                          <Yen v={t.deductionTotal} />
                        </td>
                        <td className="r">
                          <span className="pr-amt-label">&nbsp;</span>
                          <strong><Yen v={t.netPay} /></strong>
                          {drift && (
                            <div className="small" style={{ color: 'var(--warn)' }}>
                              再計算額 <Yen v={e.totals.netPay} />
                            </div>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${dst[1]}`}>{dst[0]}</span>
                        </td>
                        <td>
                          <span className="row" style={{ gap: 4 }}>
                            {nb > 0 && <span className="badge badge-bull">確定不可 {nb}</span>}
                            {nc > 0 && <span className={`badge ${nUn ? 'badge-warn' : 'badge-board'}`}>要確認 {nc - nUn}/{nc}</span>}
                            {ni > 0 && <span className="badge badge-info">参考 {ni}</span>}
                            {nb + nc + ni === 0 && <span className="muted small">なし</span>}
                          </span>
                        </td>
                        <td>
                          {conf ? (
                            <span className="badge badge-board">確定済み</span>
                          ) : !e.canConfirm ? (
                            <span className="badge badge-bull">確定不可</span>
                          ) : nUn > 0 ? (
                            <span className="badge badge-warn">確認待ち</span>
                          ) : (
                            <span className="badge badge-board">確定できます</span>
                          )}
                        </td>
                        <td className="r" style={{ whiteSpace: 'nowrap' }}>
                          {!conf && (
                            <>
                              <button className="btn btn-sm" onClick={() => setDedFor(e)}>控除</button>{' '}
                              <button className="btn btn-sm" onClick={() => setAdjFor(e)}>調整</button>
                            </>
                          )}
                          {conf && (
                            <button className="btn btn-sm" onClick={() => setCorrFor(e)}>
                              訂正
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="pr-open">
                          <td colSpan={9}>
                            <EmpDetail e={e} history={(results.data ?? []).filter((r) => r.employeeId === e.employeeId)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ padding: '8px 16px 12px', margin: 0 }}>
          「見込額」は現時点の勤怠・給与条件による仮計算で、確定前は変わる可能性があります。「確定額」は確定時の内容で保存され、その後に時給などを変更しても変わりません（変更する場合は「訂正」）。行をクリックすると計算の内訳を表示します。
        </p>
      </Panel>

      <Panel title="確定前チェック">
        <div className="stack">
          <section>
            <h3 style={{ margin: '0 0 6px' }}>確定不可の理由</h3>
            {blocking.length === 0 && commonBlocking.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>確定を妨げる問題はありません。</p>
            ) : (
              <div className="callout callout-bull">
                <div className="stack" style={{ gap: 10 }}>
                  {commonBlocking.length > 0 && (
                    <div>
                      <strong>全スタッフ共通</strong>
                      <ul className="pr-issue-list">
                        {commonBlocking.map((i) => (
                          <li key={i.key}>
                            {i.message}
                            {i.date && <span className="num">（{i.date}）</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {blocking.map((e) => (
                    <div key={e.employeeId}>
                      <strong>{e.displayName}</strong>
                      <ul className="pr-issue-list">
                        {ownBlocking(e)
                          .map((i) => (
                            <li key={i.key}>
                              {i.message}
                              {i.date && <span className="num">（{i.date}）</span>}
                              {i.code === 'DEDUCTION_UNENTERED' && (
                                <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => setDedFor(e)}>
                                  控除を入力
                                </button>
                              )}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
                </div>
                {anyIssueCode('PAYROLL_RULES_UNCONFIRMED') && (
                  <div className="row" style={{ marginTop: 10 }}>
                    {isSharedDevice ? (
                      <span className="small">店舗の給与規定の確認は管理者が管理画面（店舗設定）で行います。</span>
                    ) : (
                      <button className="btn btn-sm" onClick={() => setRulesOpen(true)}>
                        店舗の給与規定を確認する
                      </button>
                    )}
                  </div>
                )}
                {(anyIssueCode('MISSING_CLOCK_OUT') || anyIssueCode('OPEN_SESSION') || anyIssueCode('BREAK_NOT_ENDED')) && (
                  <p className="small" style={{ margin: '8px 0 0' }}>打刻漏れは「勤怠」ページで修正してから再計算してください。</p>
                )}
              </div>
            )}
          </section>
          <section>
            <h3 style={{ margin: '0 0 6px' }}>確認が必要な項目</h3>
            {needAck.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>個別の確認が必要な項目はありません。</p>
            ) : (
              <div className="callout callout-warn">
                <p className="small" style={{ margin: '0 0 8px' }}>内容を確認し、問題がなければチェックしてください。チェックした項目は確定時に「確認済み」として記録されます。</p>
                <div className="stack" style={{ gap: 10 }}>
                  {needAck.map((e) => (
                    <div key={e.employeeId}>
                      <strong>{e.displayName}</strong>
                      <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                        {confirmIssues(e).map((i) => {
                          const id = ackId(e.employeeId, i.key);
                          return (
                            <label key={i.key} className="check" style={{ alignItems: 'flex-start' }}>
                              <input type="checkbox" checked={acks.has(id)} onChange={() => toggleAck(id)} />
                              <span>
                                {i.message}
                                {i.date && <span className="num">（{i.date}・{wd(i.date)}）</span>}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
          {infos.length > 0 && (
            <section>
              <h3 style={{ margin: '0 0 6px' }}>参考</h3>
              <div className="callout">
                <ul className="pr-issue-list">
                  {infos.map(({ e, i }) => (
                    <li key={`${e.employeeId}-${i.key}`}>
                      {e.displayName}: {i.message}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>
      </Panel>

      {confirmOpen && (
        <Modal
          title={`${period.periodKey} の給与を確定`}
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmOpen(false)}>キャンセル</button>
              <button className="btn btn-primary" disabled={busy || ready.length === 0} onClick={doConfirm}>
                {ready.length}名の給与を確定する
              </button>
            </>
          }
        >
          <div className="stack" style={{ gap: 12 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>スタッフ</th>
                  <th className="r">総支給</th>
                  <th className="r">差引支給</th>
                </tr>
              </thead>
              <tbody>
                {ready.map((e) => (
                  <tr key={e.employeeId}>
                    <td>{e.displayName}</td>
                    <td className="r"><Yen v={e.totals.grossPay} /></td>
                    <td className="r"><Yen v={e.totals.netPay} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pending.length > ready.length && (
              <div className="callout callout-warn small">
                次のスタッフは確定不可または未確認の項目があるため、今回は確定しません: {pending.filter((e) => !ready.includes(e)).map((e) => e.displayName).join('、')}
              </div>
            )}
            <p className="small muted" style={{ margin: 0 }}>
              確定すると、計算に使った勤怠・給与条件・内訳が保存されます。確定後に内容を変える場合は「訂正」（理由必須・新しい版を作成）を使います。自分自身の給与はスタッフ権限では確定できません。
            </p>
          </div>
        </Modal>
      )}
      {dedFor && <DeductionModal emp={dedFor} periodId={period.id} entry={dedMap.get(dedFor.employeeId) ?? null} onClose={() => setDedFor(null)} onSaved={() => { setDedFor(null); refresh(); }} />}
      {adjFor && <AdjustmentModal emp={adjFor} periodId={period.id} onClose={() => { setAdjFor(null); refresh(); }} />}
      {corrFor && <CorrectionModal emp={corrFor} periodId={period.id} onClose={() => setCorrFor(null)} onDone={() => { setCorrFor(null); refresh(); }} />}
      {rulesOpen && <PayrollRulesModal onClose={() => setRulesOpen(false)} onDone={() => { setRulesOpen(false); refresh(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ 内訳（行展開）
function TotalsList({ t }: { t: PayrollTotals }) {
  const rows: Array<[string, number]> = [
    ['基本給・基本賃金', t.basePay],
    ['所定時間外賃金', t.extraHoursBasePay],
    ['時間外割増', t.overtimePremium],
    ['時間外割増（月60時間超）', t.over60Premium],
    ['休日割増', t.holidayPremium],
    ['深夜割増', t.nightPremium],
    ['固定残業代', t.fixedOvertimePay],
    ['固定残業代超過分', t.fixedOvertimeExcess],
    ['有給休暇賃金', t.paidLeavePay],
    ...t.allowances.map((a): [string, number] => [a.name, a.amount]),
    ['交通費', t.transport],
    ['欠勤・遅刻早退控除', -t.absenceDeduction],
  ];
  return (
    <table className="data">
      <tbody>
        {rows
          .filter(([, v]) => v !== 0)
          .map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="r"><Yen v={v} /></td>
            </tr>
          ))}
        <tr>
          <td><strong>総支給額</strong></td>
          <td className="r"><strong><Yen v={t.grossPay} /></strong></td>
        </tr>
        {t.deductions.map((d) => (
          <tr key={d.name}>
            <td className="muted">控除: {d.name}</td>
            <td className="r"><Yen v={-d.amount} /></td>
          </tr>
        ))}
        <tr>
          <td><strong>差引支給額</strong></td>
          <td className="r"><strong><Yen v={t.netPay} /></strong></td>
        </tr>
      </tbody>
    </table>
  );
}

function EmpDetail({ e, history }: { e: EmpResult; history: ResultRow[] }) {
  const worked = e.daily.filter((d) => d.workMinutes > 0);
  const versions = history.filter((h) => h.revision > 0).sort((a, b) => b.revision - a.revision);
  return (
    <div className="pr-detail">
      <div>
        <h4>計算の根拠（{e.confirmedTotals ? '最新の勤怠による再計算' : '見込額'}）</h4>
        {e.basis.length === 0 ? (
          <p className="muted small">計算根拠はありません</p>
        ) : (
          <table className="data">
            <tbody>
              {e.basis.map((b, i) => (
                <tr key={`${b.label}-${i}`}>
                  <td>
                    {b.label}
                    <div className="small muted num">{b.detail}</div>
                  </td>
                  <td className="r"><Yen v={b.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h4 style={{ marginTop: 12 }}>支給・控除（{e.confirmedTotals ? `確定額・第${e.revision}版` : '見込額'}）</h4>
        <TotalsList t={e.confirmedTotals ?? e.totals} />
      </div>
      <div>
        <h4>
          勤務日別（{worked.length}日・実働 <Minutes v={e.totals.workMinutes} />）
        </h4>
        {worked.length === 0 ? (
          <p className="muted small">この期間の勤務はありません</p>
        ) : (
          <div className="pr-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>労働日</th>
                  <th className="r">実働</th>
                  <th className="r">時間外</th>
                  <th className="r">深夜</th>
                  <th className="r">休日</th>
                </tr>
              </thead>
              <tbody>
                {worked.map((d) => (
                  <tr key={d.date}>
                    <td className="num">
                      {d.date.slice(5)}（{wd(d.date)}）
                    </td>
                    <td className="r"><Minutes v={d.workMinutes} /></td>
                    <td className="r">{d.overtimeMinutes ? <Minutes v={d.overtimeMinutes} /> : <span className="muted">—</span>}</td>
                    <td className="r">{d.nightMinutes ? <Minutes v={d.nightMinutes} /> : <span className="muted">—</span>}</td>
                    <td className="r">{d.holidayMinutes ? <Minutes v={d.holidayMinutes} /> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {versions.length > 0 && (
          <>
            <h4 style={{ marginTop: 12 }}>確定・訂正の履歴</h4>
            <table className="data">
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id}>
                    <td>
                      第{v.revision}版 <span className={`badge ${v.status === 'superseded' ? '' : 'badge-board'}`}>{STATUS[v.status] ?? v.status}</span>
                      <div className="small muted">
                        {fmtDT(v.confirmedAt)}
                        {v.correctionReason && `・訂正理由: ${v.correctionReason}`}
                      </div>
                    </td>
                    <td className="r"><Yen v={v.totals.netPay} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 控除入力（F17）
const DED_FIELDS = [
  ['incomeTax', '所得税'],
  ['residentTax', '住民税'],
  ['healthInsurance', '健康保険料'],
  ['nursingInsurance', '介護保険料'],
  ['pension', '厚生年金保険料'],
  ['employmentInsurance', '雇用保険料'],
] as const;
type DedKey = (typeof DED_FIELDS)[number][0];

function toInt(s: string): number | null {
  if (s.trim() === '') return 0;
  if (!/^\d+$/.test(s.trim())) return null;
  return Number(s.trim());
}

function DeductionModal({ emp, periodId, entry, onClose, onSaved }: { emp: EmpResult; periodId: string; entry: DeductionEntry | null; onClose: () => void; onSaved: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [status, setStatus] = useState<DeductionEntry['status']>(entry?.status ?? 'unentered');
  const [vals, setVals] = useState<Record<DedKey, string>>(() => Object.fromEntries(DED_FIELDS.map(([k]) => [k, entry && entry.status === 'entered' ? String(entry[k]) : ''])) as Record<DedKey, string>);
  const [others, setOthers] = useState<Array<{ name: string; amount: string; basis: 'statutory' | 'labor_agreement' }>>(() => (entry?.others ?? []).map((o) => ({ name: o.name, amount: String(o.amount), basis: o.basis })));
  const [note, setNote] = useState(entry?.note ?? '');
  const invalid =
    status === 'entered' && (DED_FIELDS.some(([k]) => toInt(vals[k]) === null) || others.some((o) => !o.name.trim() || toInt(o.amount) === null));
  const total = status === 'entered' ? DED_FIELDS.reduce((a, [k]) => a + (toInt(vals[k]) ?? 0), 0) + others.reduce((a, o) => a + (toInt(o.amount) ?? 0), 0) : 0;
  const save = async () => {
    const args: Record<string, unknown> = { employeeId: emp.employeeId, periodId, status, note };
    if (status === 'entered') {
      for (const [k] of DED_FIELDS) args[k] = toInt(vals[k]) ?? 0;
      args.others = others.map((o) => ({ name: o.name.trim(), amount: toInt(o.amount) ?? 0, basis: o.basis }));
    }
    if (await run(() => client.call('deductions.upsert', args), '控除を保存しました')) onSaved();
  };
  return (
    <Modal
      title={`${emp.displayName}さんの控除（税・社会保険料等）`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn btn-primary" disabled={busy || invalid} onClick={save}>保存</button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="callout small">
          控除額は手動で入力します（税率表等からの自動計算・年末調整は行いません）。<strong>未入力は0円とはみなさず、給与を確定できません。</strong>控除がない場合は「控除なし」を明示してください。
        </div>
        <fieldset className="row" style={{ border: 0, padding: 0, margin: 0, gap: 16 }}>
          <legend className="sr-only">入力状態</legend>
          {(['unentered', 'entered', 'explicit_none'] as const).map((s) => (
            <label key={s} className="check">
              <input type="radio" name="ded-status" checked={status === s} onChange={() => setStatus(s)} />
              {s === 'unentered' ? '未入力' : s === 'entered' ? '金額を入力する' : '控除なし（0円を明示）'}
            </label>
          ))}
        </fieldset>
        {status === 'entered' && (
          <>
            <div className="pr-grid6">
              {DED_FIELDS.map(([k, label]) => (
                <Field key={k} label={label} hint="円">
                  <input className="input num" inputMode="numeric" value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} placeholder="0" aria-invalid={toInt(vals[k]) === null} />
                </Field>
              ))}
            </div>
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong className="small">その他の控除</strong>
                <button className="btn btn-sm" disabled={others.length >= 10} onClick={() => setOthers([...others, { name: '', amount: '', basis: 'labor_agreement' }])}>
                  行を追加
                </button>
              </div>
              {others.length === 0 && <p className="small muted" style={{ margin: '4px 0 0' }}>なし</p>}
              {others.map((o, i) => (
                <div key={i} className="row" style={{ marginTop: 6 }}>
                  <input className="input" style={{ flex: '2 1 140px', width: 'auto' }} placeholder="控除名（例: 社員旅行積立）" value={o.name} maxLength={30} onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="控除名" />
                  <input className="input num" style={{ flex: '1 1 90px', width: 'auto' }} placeholder="金額" inputMode="numeric" value={o.amount} onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="金額" />
                  <select className="input" style={{ flex: '1 1 150px', width: 'auto' }} value={o.basis} onChange={(e) => setOthers(others.map((x, j) => (j === i ? { ...x, basis: e.target.value as 'statutory' | 'labor_agreement' } : x)))} aria-label="控除の根拠">
                    <option value="statutory">法令に基づく</option>
                    <option value="labor_agreement">労使協定に基づく</option>
                  </select>
                  <button className="btn btn-sm btn-ghost" onClick={() => setOthers(others.filter((_, j) => j !== i))}>削除</button>
                </div>
              ))}
              <p className="small muted" style={{ margin: '6px 0 0' }}>法令に基づかない控除（労使協定に基づくもの）は、確定時に協定の有無の確認を求めます。</p>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <span className="muted">控除合計</span> <strong><Yen v={total} /></strong>
            </div>
          </>
        )}
        <Field label="メモ" hint="任意">
          <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 給与調整（F17）
function AdjustmentModal({ emp, periodId, onClose }: { emp: EmpResult; periodId: string; onClose: () => void }) {
  const client = useClient();
  const list = useLoad(() => client.call<PayrollAdjustment[]>('adjustments.list', { periodId }), [periodId]);
  const { busy, run } = useAction();
  const [kind, setKind] = useState<PayrollAdjustment['kind']>('manual_addition');
  const [qty, setQty] = useState('');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const mine = (list.data ?? []).filter((a) => a.employeeId === emp.employeeId);
  const manual = kind === 'manual_addition' || kind === 'manual_subtraction';
  const qtyOk = kind === 'absence_days' ? /^\d+(\.5)?$/.test(qty) && Number(qty) >= 0.5 && Number(qty) <= 31 : kind === 'late_early_minutes' ? /^\d+$/.test(qty) && Number(qty) >= 1 : true;
  const amtOk = !manual || (/^\d+$/.test(amount) && Number(amount) >= 1);
  const valid = qtyOk && amtOk && reason.trim().length >= 2;
  const add = async () => {
    const args: Record<string, unknown> = { employeeId: emp.employeeId, periodId, kind, reason: reason.trim(), label: label.trim() };
    if (kind === 'absence_days' || kind === 'late_early_minutes') args.quantity = Number(qty);
    if (manual) args.amount = Number(amount);
    if (await run(() => client.call('adjustments.add', args), '調整を追加しました')) {
      setQty('');
      setAmount('');
      setLabel('');
      setReason('');
      list.reload();
    }
  };
  return (
    <Modal title={`${emp.displayName}さんの給与調整`} onClose={onClose} wide footer={<button className="btn" onClick={onClose}>閉じる（再計算）</button>}>
      <div className="stack" style={{ gap: 14 }}>
        <div className="callout small">
          欠勤日数・遅刻早退の分数は<strong>管理者が承認した分のみ</strong>入力してください。シフトとの差（遅刻・早退・欠勤）から自動では控除しません。月給制で控除規定が未設定の場合は確定できません。時給制では不就労時間はもともと支給されないため、欠勤・遅刻早退の調整は適用されません。
        </div>
        <section>
          <h3 style={{ margin: '0 0 6px' }}>この期間の調整</h3>
          {list.loading && <Loading />}
          {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
          {list.data && mine.length === 0 && <p className="muted small" style={{ margin: 0 }}>調整はありません</p>}
          {mine.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>種別</th>
                    <th className="r">数量・金額</th>
                    <th>理由</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {mine.map((a) => {
                    const cancelled = a.reason.startsWith('[取消]');
                    return (
                      <tr key={a.id} style={cancelled ? { color: 'var(--ink-3)' } : undefined}>
                        <td>
                          {ADJ_KIND[a.kind]}
                          {a.label && <div className="small muted">{a.label}</div>}
                        </td>
                        <td className="r">
                          {a.kind === 'absence_days' ? <span className="num">{a.quantity}日</span> : a.kind === 'late_early_minutes' ? <span className="num">{a.quantity}分</span> : <Yen v={a.kind === 'manual_subtraction' ? -(a.amount ?? 0) : a.amount ?? 0} />}
                        </td>
                        <td className="small">{a.reason}</td>
                        <td className="r">
                          {cancelled ? (
                            <span className="badge">取消済み</span>
                          ) : (
                            <button
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={async () => {
                                if (await run(() => client.call('adjustments.remove', { id: a.id }), '調整を取り消しました')) list.reload();
                              }}
                            >
                              取消
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ margin: '6px 0 0' }}>取消した調整も履歴として残ります。</p>
        </section>
        <section className="stack" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>調整を追加</h3>
          <div className="form-grid">
            <Field label="種別">
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value as PayrollAdjustment['kind'])}>
                {Object.entries(ADJ_KIND).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
            {kind === 'absence_days' && (
              <Field label="欠勤日数" hint="0.5日単位">
                <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
            )}
            {kind === 'late_early_minutes' && (
              <Field label="遅刻・早退の合計（分）">
                <input className="input num" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
            )}
            {manual && (
              <>
                <Field label="金額" hint="円">
                  <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label="項目名" hint="明細に表示">
                  <input className="input" value={label} maxLength={30} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'manual_addition' ? '例: 精算金' : '例: 前払い精算'} />
                </Field>
              </>
            )}
          </div>
          <Field label="理由（必須）" hint="監査ログに記録されます">
            <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {kind === 'manual_subtraction' && <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>手動の減額は、法令または労使協定上の根拠がある場合のみ行ってください（確定時に確認を求めます）。</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" disabled={busy || !valid} onClick={add}>
              追加
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 訂正（F18）
function CorrectionModal({ emp, periodId, onClose, onDone }: { emp: EmpResult; periodId: string; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [reason, setReason] = useState('');
  const [acks, setAcks] = useState<Set<string>>(new Set());
  const conf = emp.confirmedTotals!;
  const ci = emp.issues.filter((i) => i.severity === 'confirm');
  const blocking = emp.issues.filter((i) => i.severity === 'blocking');
  const ok = emp.canConfirm && reason.trim().length >= 2 && ci.every((i) => acks.has(i.key));
  const submit = async () => {
    const r = await run(() => client.call<{ revision: number }>('payroll.correct', { periodId, employeeId: emp.employeeId, reason: reason.trim(), acknowledgements: [...acks] }), '給与を訂正しました（新しい版を作成）');
    if (r) onDone();
  };
  const rows: Array<[string, number, number]> = [
    ['総支給額', conf.grossPay, emp.totals.grossPay],
    ['控除合計', conf.deductionTotal, emp.totals.deductionTotal],
    ['差引支給額', conf.netPay, emp.totals.netPay],
  ];
  return (
    <Modal
      title={`${emp.displayName}さんの給与を訂正`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>キャンセル</button>
          <button className="btn btn-primary" disabled={busy || !ok} onClick={submit}>
            訂正して第{emp.revision + 1}版を作成
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <p className="small" style={{ margin: 0 }}>
          最新の勤怠・給与条件・控除で再計算した内容を新しい版（第{emp.revision + 1}版）として確定します。<strong>現在の第{emp.revision}版は削除されず、「訂正済み（旧版）」として保持されます。</strong>発行済みの明細も旧版として残り、再発行が必要になります。
        </p>
        <table className="data">
          <thead>
            <tr>
              <th />
              <th className="r">現在（第{emp.revision}版）</th>
              <th className="r">訂正後</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, a, b]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="r"><Yen v={a} /></td>
                <td className="r" style={a !== b ? { fontWeight: 700 } : undefined}><Yen v={b} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {blocking.length > 0 && (
          <div className="callout callout-bull small">
            <strong>確定不可の理由があるため訂正できません</strong>
            <ul className="pr-issue-list">
              {blocking.map((i) => (
                <li key={i.key}>{i.message}{i.date && `（${i.date}）`}</li>
              ))}
            </ul>
          </div>
        )}
        {ci.length > 0 && (
          <div className="callout callout-warn small">
            <div style={{ marginBottom: 4 }}>確認が必要な項目</div>
            {ci.map((i) => (
              <label key={i.key} className="check" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={acks.has(i.key)}
                  onChange={() =>
                    setAcks((s) => {
                      const n = new Set(s);
                      if (n.has(i.key)) n.delete(i.key);
                      else n.add(i.key);
                      return n;
                    })
                  }
                />
                <span>{i.message}{i.date && `（${i.date}）`}</span>
              </label>
            ))}
          </div>
        )}
        <Field label="訂正理由（必須）" hint="2文字以上・監査ログと履歴に記録">
          <textarea className="input" rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="例: 11/5 の退勤時刻の修正を反映" />
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 店舗の給与規定の確認（管理者のみ）
interface SettingsLite {
  workingTimeSystem: string;
  weekStartDay: number | null;
  statutoryHolidayWeekday: number | null;
  weekly44Confirmed: boolean;
  agreement36: string;
  payrollClosingDay: number | null;
  payMonthOffset: number | null;
  payDay: number | null;
  yenRounding: string;
  minimumWages: Array<{ effectiveFrom: string; hourly: number; label: string }>;
  paidLeaveWageMethod: string;
  payrollRulesConfirmedAt: string | null;
}
const WTS: Record<string, string> = { unset: '未設定', standard: '通常の労働時間制' };
const PLM: Record<string, string> = { unset: '未設定', normal: '通常の賃金', average: '平均賃金', standard_remuneration: '標準報酬日額' };

function PayrollRulesModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const s = useLoad(() => client.call<SettingsLite>('settings.get'), []);
  const { busy, run } = useAction();
  const day = (n: number | null) => (n === null ? '未設定' : `${WEEKDAYS[n]}曜日`);
  const d = s.data;
  const rows: Array<[string, string]> = d
    ? [
        ['労働時間制度', WTS[d.workingTimeSystem] ?? '変形労働時間制等（未対応）'],
        ['週の起算曜日', day(d.weekStartDay)],
        ['法定休日', day(d.statutoryHolidayWeekday)],
        ['週44時間特例', d.weekly44Confirmed ? '適用する' : '適用しない（週40時間）'],
        ['締め日・支払日', d.payrollClosingDay === null || d.payDay === null || d.payMonthOffset === null ? '未設定' : `${d.payrollClosingDay === 0 ? '末日' : `${d.payrollClosingDay}日`}締め・${['当月', '翌月', '翌々月'][d.payMonthOffset] ?? `${d.payMonthOffset}か月後`}${d.payDay === 0 ? '末日' : `${d.payDay}日`}払い`],
        ['円未満の端数処理', d.yenRounding === 'half_up' ? '50銭以上切上げ' : d.yenRounding === 'ceil' ? '切上げ' : d.yenRounding],
        ['最低賃金', d.minimumWages.length ? d.minimumWages.map((m) => `${m.effectiveFrom}〜 ${m.hourly}円（${m.label}）`).join(' / ') : '未設定'],
        ['有給休暇の賃金', PLM[d.paidLeaveWageMethod] ?? d.paidLeaveWageMethod],
      ]
    : [];
  return (
    <Modal
      title="店舗の給与規定の確認"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>閉じる</button>
          <button
            className="btn btn-primary"
            disabled={busy || !d}
            onClick={async () => {
              if (await run(() => client.call('settings.confirmPayrollRules'), '給与規定を確認済みにしました')) onDone();
            }}
          >
            この内容で確認済みにする
          </button>
        </>
      }
    >
      {s.loading && <Loading />}
      {s.error && <ErrorBox message={s.error} onRetry={s.reload} />}
      {d && (
        <div className="stack" style={{ gap: 10 }}>
          <table className="data">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <th style={{ width: 150, position: 'static' }}>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted" style={{ margin: 0 }}>
            内容を変更する場合は「店舗設定」で変更してください（変更すると再度の確認が必要になります）。法令解釈を含む設定は、必要に応じて社会保険労務士等に確認してください。
          </p>
        </div>
      )}
    </Modal>
  );
}
