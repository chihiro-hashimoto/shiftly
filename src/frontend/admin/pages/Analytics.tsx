/** 人件費分析・予算（F22 人件費分析 / F23 予算） */
import { useEffect, useRef, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Minutes, Panel, Yen, todayJst, useAction, useClient, useLoad, WEEKDAYS } from '../../components/ui';
import type { Budget } from '../../../shared/types';

/** ページのルート（表の最小幅で管理画面のグリッド列が広がり、スマホ幅で横スクロールが出るのを防ぐ） */
const PAGE_ROOT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

// ------------------------------------------------------------------ 型
interface Cell {
  amount: number | null;
  minutes: number;
}
interface Report {
  from: string;
  to: string;
  /** 給与閲覧権限がなく、個人の給与が推定できる場合は null（非表示） */
  total: number | null;
  byDate: Record<string, Cell>;
  byWeekday: Cell[];
  byHour: Cell[];
  byEmployee: Array<{ employeeId: string; name: string; amount: number; minutes: number }>;
  incomplete: Array<{ employeeId: string; name: string; reason: string }>;
  employerCostEstimate: number | null;
}
interface BudgetStatusView {
  month: string;
  budget: number | null;
  actualToDate: number | null;
  plannedRemaining: number | null;
  forecast: number | null;
  consumptionRate: number | null;
  forecastRate: number | null;
  over: boolean | null;
  dailyOver: string[];
}
interface LaborResp {
  month: string;
  actual: Report;
  planned: { total: number | null; employerCostEstimate: number | null };
  forecast: { total: number | null };
  budget: BudgetStatusView;
  method: Budget['laborCostAllocation'];
  individualVisible: boolean;
  /** 個人の給与が推定できるため、一部の金額を非表示にしている */
  amountsHidden?: boolean;
}

const METHOD: Record<Budget['laborCostAllocation'], string> = {
  by_worked_minutes: '実労働時間に比例して配賦',
  by_calendar_day: '暦日で均等に配賦',
  by_scheduled_days: '所定労働日で均等に配賦',
};
const HIDDEN = '非表示（個人の給与が推定できるため）';

function addMonth(m: string, n: number): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(mo / 12);
  const mm = ((mo % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
function daysOf(month: string): string[] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}
const wdOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
function shortYen(v: number): string {
  if (Math.abs(v) >= 10000) return `${(v / 10000).toLocaleString('ja-JP', { maximumFractionDigits: v >= 100000 ? 0 : 1 })}万`;
  return `${Math.round(v).toLocaleString('ja-JP')}`;
}

const LOCAL_CSS = `
.an-month{display:flex;align-items:center;gap:6px}
.an-chart{position:relative}
.an-chart svg{display:block;width:100%;height:auto}
.an-chart .an-tip{position:absolute;top:4px;pointer-events:none;background:var(--ink);color:#fff;border-radius:6px;padding:6px 10px;font-size:.8rem;line-height:1.45;white-space:nowrap;z-index:2;transform:translateX(-50%)}
.an-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:.82rem;color:var(--ink-2)}
.an-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.an-legend i.line{height:3px;border-radius:2px;vertical-align:3px;width:16px}
.an-daily{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:8px 12px}
.an-daily label{display:grid;grid-template-columns:4.4em minmax(0,1fr);align-items:center;gap:6px;font-size:.85rem}
.an-tables{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
`;

// ------------------------------------------------------------------ ページ
export function AnalyticsPage() {
  const client = useClient();
  const [month, setMonth] = useState(todayJst().slice(0, 7));
  const data = useLoad(() => client.call<LaborResp>('analytics.laborCost', { month }), [month]);
  const budget = useLoad(() => client.call<Budget | null>('budgets.get', { month }), [month]);
  const today = todayJst();
  const d = data.data && data.data.month === month ? data.data : null;

  return (
    <div style={PAGE_ROOT}>
      <style>{LOCAL_CSS}</style>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="an-month">
          <button className="btn btn-sm" onClick={() => setMonth(addMonth(month, -1))} aria-label="前の月">
            ‹ 前月
          </button>
          <input className="input" type="month" value={month} onChange={(e) => /^\d{4}-\d{2}$/.test(e.target.value) && setMonth(e.target.value)} style={{ width: 160 }} aria-label="対象月" />
          <button className="btn btn-sm" onClick={() => setMonth(addMonth(month, 1))} aria-label="次の月">
            翌月 ›
          </button>
          {month !== today.slice(0, 7) && (
            <button className="btn btn-sm btn-ghost" onClick={() => setMonth(today.slice(0, 7))}>
              今月
            </button>
          )}
        </div>
        {data.loading && d && <span className="small muted">更新中…</span>}
      </div>

      {data.loading && !d && <Loading text="人件費を集計しています…" />}
      {data.error && <ErrorBox message={data.error} onRetry={data.reload} />}
      {d && <CostReport d={d} budget={budget.data ?? null} today={today} />}

      <BudgetForm
        key={`${month}-${budget.data?.id ?? 'none'}-${budget.data?.version ?? 0}`}
        month={month}
        current={budget.data ?? null}
        loading={budget.loading && !budget.data}
        error={budget.error}
        onSaved={() => {
          budget.reload();
          data.reload();
        }}
      />
    </div>
  );
}

function CostReport({ d, budget, today }: { d: LaborResp; budget: Budget | null; today: string }) {
  const b = d.budget;
  const a = d.actual;
  const employer = a.employerCostEstimate;
  const overBy = b.budget !== null && d.forecast.total !== null ? d.forecast.total - b.budget : null;
  const isPast = d.month < today.slice(0, 7);
  const isFuture = d.month > today.slice(0, 7);
  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="label">実績（{isFuture ? 'まだありません' : isPast ? '月間' : '今日まで'}）</div>
          <div className="value"><Yen v={a.total} /></div>
          <div className="sub">予定（公開シフトのみ）<Yen v={d.planned.total} /></div>
        </div>
        <div className="kpi">
          <div className="label">着地予測</div>
          <div className="value"><Yen v={d.forecast.total} /></div>
          <div className="sub">実績 ＋ 明日以降の公開シフト</div>
        </div>
        <div className="kpi">
          <div className="label">予算消化率</div>
          <div className="value">{pct(b.consumptionRate)}</div>
          {b.budget !== null ? (
            <>
              <div className={`bar ${b.over ? 'over' : ''}`} style={{ margin: '6px 0 4px' }} role="img" aria-label={`予算消化率 ${pct(b.consumptionRate)}、予測 ${pct(b.forecastRate)}`}>
                <i style={{ width: `${Math.min(100, (b.consumptionRate ?? 0) * 100)}%` }} />
              </div>
              <div className="sub">
                予算 <Yen v={b.budget} />・予測 {pct(b.forecastRate)}
              </div>
            </>
          ) : (
            <div className="sub">この月の予算は未設定です（下で設定できます）</div>
          )}
        </div>
        <div className="kpi">
          <div className="label">会社負担込みの概算（実績）</div>
          <div className="value">{employer === null || a.total === null ? '—' : <Yen v={a.total + employer} />}</div>
          <div className="sub">{employer === null ? '会社負担率が未設定のため算出できません（店舗設定）' : <>うち会社負担の概算 <Yen v={employer} /></>}</div>
        </div>
      </div>

      {d.amountsHidden && (
        <div className="callout callout-board small">人件費が発生したスタッフが少ないため、個人の給与が推定できる金額（合計・予測・日別・曜日別の一部またはすべて）を表示していません。</div>
      )}
      {b.over === true && (
        <div className="callout callout-bull" role="alert">
          <strong>予算超過の見込み</strong>　着地予測が予算を <Yen v={overBy} /> 上回る見込みです。
          {b.dailyOver.length > 0 && <div className="small">日別予算を超えた日: {b.dailyOver.map((x) => `${Number(x.slice(8))}日`).join('、')}</div>}
        </div>
      )}
      {!b.over && b.dailyOver.length > 0 && (
        <div className="callout callout-warn">日別予算を超えた日: {b.dailyOver.map((x) => `${Number(x.slice(8))}日`).join('、')}</div>
      )}

      <Panel title="日別の人件費" actions={<span className="small muted">{METHOD[d.method]}（月給制）</span>}>
        <DailyChart d={d} budget={budget} today={today} />
      </Panel>

      <div className="an-tables">
        <Panel title="曜日別" pad={false}>
          <WeekdayTable cells={a.byWeekday} />
        </Panel>
        <Panel title="時間帯別（時給制のみ）" pad={false}>
          <HourTable cells={a.byHour} visible={d.individualVisible} />
        </Panel>
        <Panel title="スタッフ別" pad={false}>
          {!d.individualVisible ? (
            <Empty>{HIDDEN}。給与の閲覧権限が必要です。</Empty>
          ) : a.byEmployee.length === 0 ? (
            <Empty>この月に在籍しているスタッフがいません</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>スタッフ</th>
                    <th className="r">実働</th>
                    <th className="r">人件費</th>
                    <th className="r">構成比</th>
                  </tr>
                </thead>
                <tbody>
                  {a.byEmployee
                    .slice()
                    .sort((x, y) => y.amount - x.amount)
                    .map((e) => (
                      <tr key={e.employeeId}>
                        <td>
                          {e.name}
                          {a.incomplete.some((x) => x.employeeId === e.employeeId) && <span className="badge badge-warn" style={{ marginLeft: 6 }}>不完全</span>}
                        </td>
                        <td className="r"><Minutes v={e.minutes} /></td>
                        <td className="r"><Yen v={e.amount} /></td>
                        <td className="r num">{a.total ? `${Math.round((e.amount / a.total) * 100)}%` : '—'}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="この数字の見方">
        <div className="stack" style={{ gap: 10 }}>
          {a.incomplete.length > 0 && (
            <div className="callout callout-warn small">
              <strong>金額が不完全です</strong>　給与条件の未設定・未確認があるスタッフの金額は不完全な値です
              {d.individualVisible ? `（${a.incomplete.map((x) => x.name).join('、')}）` : `（${a.incomplete.length}名）`}。「給与条件」ページで設定を確認してください。
            </div>
          )}
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            <li>
              <strong>実績</strong>は今日までの勤怠から仮計算した値で、<strong>給与確定前の未確定の値</strong>です（控除は含みません）。<strong>予定</strong>は公開済みシフトから計算した値、<strong>着地予測</strong>は実績に明日以降の公開シフトを足した値です。
            </li>
            <li>
              ここでの人件費は<strong>総支給額ベース</strong>（賃金・割増・手当・交通費）です。会社が負担する社会保険料等を含む<strong>総人件費</strong>は、店舗設定の会社負担率による概算で、実際の保険料とは異なります。
            </li>
            <li>月給制スタッフの月給・手当などは、予算設定の配賦方法に従って日別に按分しています。時間帯別は時給制の勤務時間分のみです。</li>
            <li>予算を超えても、勤怠の記録や給与計算を制限することはありません。予算はシフト作成の目安として使ってください。</li>
          </ul>
        </div>
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ 日別バーチャート（SVG）
function DailyChart({ d, budget, today }: { d: LaborResp; budget: Budget | null; today: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.max(300, Math.round(es[0]!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const days = daysOf(d.month);
  const monthly = d.budget.budget;
  const perDay = (day: string): number | null => {
    if (budget?.dailyAmounts?.[day] !== undefined) return budget.dailyAmounts[day]!;
    return monthly !== null ? monthly / days.length : null;
  };
  const hasDaily = !!budget && Object.keys(budget.dailyAmounts ?? {}).length > 0;
  const vals = days.map((x) => d.actual.byDate[x]?.amount ?? 0);
  const budgets = days.map(perDay);
  const max = Math.max(1, ...vals.map((v) => v ?? 0), ...budgets.map((v) => v ?? 0)) * 1.1;
  const H = 240;
  const padL = 46;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = H - padT - padB;
  const slot = plotW / days.length;
  const bw = Math.max(3, Math.min(22, slot - 2));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const step = (() => {
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  })();
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  const labelEvery = slot < 14 ? 5 : slot < 22 ? 2 : 1;
  const over = new Set(d.budget.dailyOver);
  const todayIdx = days.indexOf(today);
  const allZero = vals.every((v) => !v) && budgets.every((v) => v === null);

  const hi = hover !== null ? days[hover]! : null;
  const hiCell = hi ? d.actual.byDate[hi] : null;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="an-legend">
        <span><i style={{ background: 'var(--board)' }} />実績（日別）</span>
        <span><i className="line" style={{ background: 'var(--brass)' }} />{hasDaily ? '日別予算（未設定日は月間予算の日割り）' : '日割り予算（月間予算 ÷ 日数）'}</span>
        <span><i style={{ background: 'var(--bull)' }} />日別予算を超えた日</span>
        {!d.individualVisible && <span><i style={{ background: 'repeating-linear-gradient(45deg,#c9cfca 0 3px,#eef0ee 3px 6px)' }} />非表示の日</span>}
      </div>
      <div className="an-chart" ref={wrap} onMouseLeave={() => setHover(null)}>
        {allZero && <div className="small muted" style={{ position: 'absolute', top: 70, width: '100%', textAlign: 'center' }}>この月の実績・予算はまだありません</div>}
        <svg viewBox={`0 0 ${w} ${H}`} width={w} height={H} role="img" aria-label={`${d.month} の日別人件費（実績と予算）`}>
          <defs>
            <pattern id="an-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#eef0ee" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="#c9cfca" strokeWidth="3" />
            </pattern>
          </defs>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="var(--line-2)" strokeWidth={1} />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-num)">
                {t === 0 ? '0' : shortYen(t)}
              </text>
            </g>
          ))}
          {todayIdx >= 0 && <line x1={padL + slot * todayIdx + slot / 2} x2={padL + slot * todayIdx + slot / 2} y1={padT} y2={padT + plotH} stroke="var(--ink-3)" strokeDasharray="3 3" strokeWidth={1} />}
          {days.map((day, i) => {
            const cell = d.actual.byDate[day];
            const v = cell?.amount;
            const cx = padL + slot * i + slot / 2;
            const masked = cell && v === null;
            const h = masked ? 14 : v ? Math.max(1, plotH - (y(v) - padT)) : 0;
            const top = padT + plotH - h;
            const r = Math.min(4, bw / 2, h);
            const fill = masked ? 'url(#an-hatch)' : over.has(day) ? 'var(--bull)' : 'var(--board)';
            const bv = budgets[i];
            const wdN = wdOf(day);
            return (
              <g key={day}>
                {h > 0 && <path d={`M${cx - bw / 2},${top + h} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${top + h} Z`} fill={fill} opacity={hover === null || hover === i ? 1 : 0.55} />}
                {bv !== null && bv !== undefined && <line x1={cx - slot / 2 + 1} x2={cx + slot / 2 - 1} y1={y(bv)} y2={y(bv)} stroke="var(--brass)" strokeWidth={2} strokeLinecap="round" />}
                {(i % labelEvery === 0 || i === days.length - 1) && (
                  <text x={cx} y={H - 8} textAnchor="middle" fontSize="11" fontFamily="var(--font-num)" fill={wdN === 0 ? 'var(--bull)' : wdN === 6 ? 'var(--info)' : 'var(--ink-3)'} fontWeight={day === today ? 700 : 400}>
                    {i + 1}
                  </text>
                )}
                <rect x={cx - slot / 2} y={padT} width={slot} height={plotH + 14} fill="transparent" onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
                  <title>{`${day}（${WEEKDAYS[wdN]}） 実績 ${v === null || v === undefined ? (masked ? '非表示' : '¥0') : `¥${Math.round(v).toLocaleString('ja-JP')}`}${bv !== null && bv !== undefined ? ` / 予算 ¥${Math.round(bv).toLocaleString('ja-JP')}` : ''}`}</title>
                </rect>
              </g>
            );
          })}
          <line x1={padL} x2={w - padR} y1={padT + plotH} y2={padT + plotH} stroke="var(--line)" strokeWidth={1} />
        </svg>
        {hi && hover !== null && (
          <div className="an-tip" style={{ left: Math.min(Math.max(padL + slot * hover + slot / 2, 90), w - 90) }}>
            <div>
              {hi}（{WEEKDAYS[wdOf(hi)]}）{hi === today ? ' 今日' : hi > today ? ' 予定日' : ''}
            </div>
            <div>
              実績 {hiCell?.amount === null ? '非表示' : `¥${Math.round(hiCell?.amount ?? 0).toLocaleString('ja-JP')}`}
              {hiCell && hiCell.minutes > 0 && `・${Math.floor(hiCell.minutes / 60)}時間${Math.round(hiCell.minutes % 60)}分`}
            </div>
            {budgets[hover] !== null && <div>予算 ¥{Math.round(budgets[hover]!).toLocaleString('ja-JP')}</div>}
          </div>
        )}
      </div>
      <details>
        <summary className="small" style={{ cursor: 'pointer' }}>日別の表で見る</summary>
        <div className="table-wrap" style={{ maxHeight: 320, marginTop: 8 }}>
          <table className="data">
            <thead>
              <tr>
                <th>日付</th>
                <th className="r">実働</th>
                <th className="r">実績</th>
                <th className="r">予算</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day, i) => {
                const c = d.actual.byDate[day];
                return (
                  <tr key={day}>
                    <td className="num">
                      {day.slice(5)}（{WEEKDAYS[wdOf(day)]}）{over.has(day) && <span className="badge badge-bull" style={{ marginLeft: 6 }}>超過</span>}
                    </td>
                    <td className="r">{c && c.minutes ? <Minutes v={c.minutes} /> : <span className="muted">—</span>}</td>
                    <td className="r">{c?.amount === null ? <span className="small muted">非表示</span> : <Yen v={c?.amount ?? 0} />}</td>
                    <td className="r">{budgets[i] === null ? <span className="muted">—</span> : <Yen v={budgets[i]} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
      {!d.individualVisible && <p className="small muted" style={{ margin: 0 }}>時間帯別・スタッフ別と、本人以外に人件費が発生したスタッフが3名未満の集計は、個人の給与が推定できるため金額を表示しません。</p>}
    </div>
  );
}

function WeekdayTable({ cells }: { cells: Cell[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>曜日</th>
            <th className="r">実働</th>
            <th className="r">人件費</th>
            <th className="r">1時間あたり</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c, i) => (
            <tr key={i}>
              <td>{WEEKDAYS[i]}曜日</td>
              <td className="r">{c.minutes ? <Minutes v={c.minutes} /> : <span className="muted">—</span>}</td>
              <td className="r">{c.amount === null ? <span className="small muted">非表示</span> : <Yen v={c.amount} />}</td>
              <td className="r">{c.amount !== null && c.minutes > 0 ? <Yen v={(c.amount / c.minutes) * 60} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HourTable({ cells, visible }: { cells: Cell[]; visible: boolean }) {
  if (!visible) return <Empty>{HIDDEN}</Empty>;
  const hours = cells
    .map((c, h) => ({ c, h }))
    .filter(({ c }) => c.minutes > 0 || (c.amount ?? 0) > 0)
    .sort((a, b) => ((a.h - 5 + 24) % 24) - ((b.h - 5 + 24) % 24));
  if (hours.length === 0) return <Empty>この月の時給制の勤務はまだありません</Empty>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>時間帯</th>
            <th className="r">延べ実働</th>
            <th className="r">人件費</th>
          </tr>
        </thead>
        <tbody>
          {hours.map(({ c, h }) => (
            <tr key={h}>
              <td className="num">
                {String(h).padStart(2, '0')}:00–{String((h + 1) % 24).padStart(2, '0')}:00
              </td>
              <td className="r"><Minutes v={c.minutes} /></td>
              <td className="r">{c.amount === null ? <span className="small muted">非表示</span> : <Yen v={c.amount} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ 予算設定（F23）
function BudgetForm({ month, current, loading, error, onSaved }: { month: string; current: Budget | null; loading: boolean; error: string | null; onSaved: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [amount, setAmount] = useState(current ? String(current.monthlyAmount) : '');
  const [method, setMethod] = useState<Budget['laborCostAllocation']>(current?.laborCostAllocation ?? 'by_worked_minutes');
  const [daily, setDaily] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(current?.dailyAmounts ?? {}).map(([k, v]) => [k, String(v)])));
  const days = daysOf(month);
  const amountOk = /^\d+$/.test(amount.trim());
  const dailyBad = Object.values(daily).some((v) => v.trim() !== '' && !/^\d+$/.test(v.trim()));
  const dailySum = Object.values(daily).reduce((a, v) => a + (/^\d+$/.test(v.trim()) ? Number(v) : 0), 0);
  const dailyCount = Object.values(daily).filter((v) => v.trim() !== '').length;
  const save = async () => {
    const dailyAmounts: Record<string, number> = {};
    for (const [k, v] of Object.entries(daily)) if (v.trim() !== '') dailyAmounts[k] = Number(v.trim());
    if (await run(() => client.call('budgets.upsert', { month, monthlyAmount: Number(amount.trim()), dailyAmounts, laborCostAllocation: method }), `${month} の予算を保存しました`)) onSaved();
  };
  return (
    <Panel title={`${month} の予算設定`} actions={current ? <span className="small muted">最終更新 {current.updatedAt.slice(0, 16).replace('T', ' ')}</span> : <span className="badge">未設定</span>}>
      {loading && <Loading />}
      {error && <ErrorBox message={error} />}
      {!loading && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <Field label="月間予算（人件費・総支給ベース）" hint="円">
              <input className="input num" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="例: 650000" aria-invalid={amount !== '' && !amountOk} />
            </Field>
            <Field label="月給制の日別配賦方法">
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value as Budget['laborCostAllocation'])}>
                {Object.entries(METHOD).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </Field>
          </div>
          <details open={dailyCount > 0}>
            <summary className="small" style={{ cursor: 'pointer' }}>
              日別予算（任意）{dailyCount > 0 && `：${dailyCount}日分 合計 ¥${dailySum.toLocaleString('ja-JP')}`}
            </summary>
            <p className="small muted" style={{ margin: '6px 0 8px' }}>入力した日だけ日別予算として使い、その日の実績が上回ると「超過」として表示します。空欄の日はグラフ上で月間予算の日割りを目安として表示します。</p>
            <div className="an-daily">
              {days.map((day) => {
                const n = wdOf(day);
                return (
                  <label key={day}>
                    <span className="num" style={{ color: n === 0 ? 'var(--bull)' : n === 6 ? 'var(--info)' : undefined }}>
                      {Number(day.slice(8))}日({WEEKDAYS[n]})
                    </span>
                    <input className="input num" inputMode="numeric" value={daily[day] ?? ''} onChange={(e) => setDaily({ ...daily, [day]: e.target.value })} aria-label={`${day} の日別予算`} style={{ padding: '4px 8px', minHeight: 34 }} />
                  </label>
                );
              })}
            </div>
          </details>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small muted">予算は目安です。予算を超えても勤怠の記録や給与計算は制限されません。</span>
            <button className="btn btn-primary" disabled={busy || !amountOk || dailyBad} onClick={save}>
              予算を保存
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
