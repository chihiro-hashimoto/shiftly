/** 給与条件（時給ルール・月給・交通費・手当・雇用条件） F12/F13/F15/F16 */
import { useMemo, useState, type ReactNode } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, Panel, WEEKDAYS, Yen, todayJst, useAction, useClient, useLoad } from '../../components/ui';
import type { Allowance, EmploymentHistory, PayrollPeriod, PremiumBaseCategory, SalaryRule, TransportMethod, TransportRule, WageRule } from '../../../shared/types';
import { validateWageRule } from '../../../shared/wage';

interface EmpLite {
  id: string;
  displayName: string;
  status: string;
  payType: 'hourly' | 'monthly';
}
interface Conf {
  wageRules: WageRule[];
  wageConflicts: Array<[string, string]>;
  salaryRules: SalaryRule[];
  transportRules: TransportRule[];
  allowances: Allowance[];
}

// ------------------------------------------------------------------ ラベル
const WAGE_KIND: Record<WageRule['kind'], string> = { base: '基本時給', weekday: '曜日別', timeband: '時間帯別', holiday: '祝日', special_date: '特定日' };
const DEFAULT_PRIORITY: Record<WageRule['kind'], number> = { base: 0, weekday: 10, timeband: 20, holiday: 30, special_date: 40 };
const TRANSPORT_LABEL: Record<TransportMethod, string> = { unset: '未設定', none: '支給なし', per_day: '日額（出勤日数×日額）', monthly: '月額（定額）', actual: '実費（給与期間ごとに入力）' };
const ALLOWANCE_KIND: Record<Allowance['kind'], string> = { fixed_monthly: '月額固定', per_workday: '出勤日ごと', per_hour: '労働時間ごと', variable: '変動（期間ごとに入力）' };
const PREMIUM_LABEL: Record<PremiumBaseCategory, string> = {
  include: '算入する（除外しない）',
  exclude_family: '除外: 家族手当',
  exclude_commute: '除外: 通勤手当',
  exclude_separation: '除外: 別居手当',
  exclude_education: '除外: 子女教育手当',
  exclude_housing: '除外: 住宅手当',
  exclude_temporary: '除外: 臨時に支払われた賃金',
  exclude_over_month: '除外: 1か月を超える期間ごとに支払われる賃金',
};

// ------------------------------------------------------------------ ユーティリティ
const UNSET = '未設定（給与確定不可）';
function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function effectiveOn<T extends { effectiveFrom: string; effectiveTo: string | null }>(rows: T[], d: string): T[] {
  return rows.filter((r) => r.effectiveFrom <= d && (r.effectiveTo === null || d <= r.effectiveTo)).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
}
function period(r: { effectiveFrom: string; effectiveTo: string | null }): string {
  return `${r.effectiveFrom} 〜 ${r.effectiveTo ?? ''}`;
}
function rowState(r: { effectiveFrom: string; effectiveTo: string | null }, today: string): ReactNode {
  if (r.effectiveTo !== null && r.effectiveTo < today) return <span className="badge">終了</span>;
  if (r.effectiveFrom > today) return <span className="badge badge-info">予定</span>;
  return <span className="badge badge-board">適用中</span>;
}
function hmText(min: number | null): string {
  if (min === null) return '';
  return `${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}`;
}
function weekdaysText(ws: number[]): string {
  return ws.length === 0 ? '' : ws.map((w) => WEEKDAYS[w]).join('・');
}
function normTime(raw: string): string | null {
  const s = raw.trim().replace(/：/g, ':');
  const a = /^(\d{1,2}):(\d{2})$/.exec(s);
  const b = /^(\d{3,4})$/.exec(s);
  let h: number;
  let m: number;
  if (a) {
    h = Number(a[1]);
    m = Number(a[2]);
  } else if (b) {
    const x = b[1]!.padStart(4, '0');
    h = Number(x.slice(0, 2));
    m = Number(x.slice(2));
  } else return null;
  if (m > 59 || h > 47) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
/** 整数入力の解析（空欄は null、不正は NaN） */
function intOrNull(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}
function Unset({ text = UNSET }: { text?: string }) {
  return <span className="badge badge-warn">{text}</span>;
}

const CSS = `
.pc-page table.data th,.pc-page table.data td{white-space:nowrap}
.pc-page table.data td.wrap{white-space:normal;min-width:12em}
.pc-hm{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pc-hm input{width:84px}
.pc-wd{display:flex;gap:4px;flex-wrap:wrap}
.pc-wd button{min-width:44px;min-height:40px;padding:0 8px}
.pc-status{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.pc-status>div{border:1px solid var(--line-2);border-radius:var(--radius-s);padding:10px 12px;display:grid;gap:4px}
.pc-status .k{font-size:.82rem;color:var(--ink-2);font-weight:600}
.pc-picker{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.pc-picker .field{min-width:min(320px,100%)}
.pc-radio{display:flex;flex-wrap:wrap;gap:6px 16px}
.pc-radio .check{min-height:36px;align-items:center}
.pc-radio .check input{margin-top:0}
.pc-sub{border:1px solid var(--line-2);border-radius:var(--radius-m);padding:12px 14px;display:grid;gap:10px}
`;

// ------------------------------------------------------------------ 入力部品（ページ内）
/** 分を「時間」「分」の2欄で入力する */
function HmInput({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  const [h, setH] = useState(value === null ? '' : String(Math.floor(value / 60)));
  const [m, setM] = useState(value === null ? '' : String(value % 60));
  const emit = (hh: string, mm: string) => {
    if (hh.trim() === '' && mm.trim() === '') return onChange(null);
    const H = hh.trim() === '' ? 0 : Number(hh);
    const M = mm.trim() === '' ? 0 : Number(mm);
    if (!Number.isInteger(H) || !Number.isInteger(M) || H < 0 || M < 0 || M > 59) return onChange(NaN);
    onChange(H * 60 + M);
  };
  return (
    <div className="pc-hm">
      <input className="input num" type="number" min={0} inputMode="numeric" aria-label={`${label}（時間）`} value={h} onChange={(e) => { setH(e.target.value); emit(e.target.value, m); }} />
      <span>時間</span>
      <input className="input num" type="number" min={0} max={59} inputMode="numeric" aria-label={`${label}（分）`} value={m} onChange={(e) => { setM(e.target.value); emit(h, e.target.value); }} />
      <span>分</span>
    </div>
  );
}

function WeekdayPicker({ value, onChange, label }: { value: number[]; onChange: (v: number[]) => void; label: string }) {
  return (
    <div className="pc-wd" role="group" aria-label={label}>
      {[1, 2, 3, 4, 5, 6, 0].map((w) => {
        const on = value.includes(w);
        return (
          <button key={w} type="button" className={`btn btn-sm ${on ? 'btn-primary' : ''}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== w) : [...value, w].sort())}>
            {WEEKDAYS[w]}
          </button>
        );
      })}
    </div>
  );
}

function YenInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <div className="pc-hm">
      <input className="input num" style={{ width: 140 }} type="number" min={0} inputMode="numeric" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
      <span>円</span>
    </div>
  );
}

function RangeFields({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <>
      <Field label="適用開始日">
        <input className="input" type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
      </Field>
      <Field label="適用終了日" hint="空欄は期限なし">
        <input className="input" type="date" value={to} onChange={(e) => onTo(e.target.value)} />
      </Field>
    </>
  );
}

function Errors({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <ul className="small" role="alert" style={{ margin: 0, paddingLeft: '1.2em', color: 'var(--bull)' }}>
      {list.map((x) => (
        <li key={x}>{x}</li>
      ))}
    </ul>
  );
}

function FormModal({ title, busy, disabled, onClose, onSave, children }: { title: string; busy: boolean; disabled: boolean; onClose: () => void; onSave: () => void; children: ReactNode }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || disabled} onClick={onSave}>
            保存
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>{children}</div>
    </Modal>
  );
}

/** 給与期間ごとの金額（変動手当・実費交通費） */
function PeriodAmounts({ periods, value, onChange, label }: { periods: PayrollPeriod[] | null; value: Record<string, string>; onChange: (v: Record<string, string>) => void; label: string }) {
  if (periods === null) return <p className="small muted">給与計算期間を読み込めませんでした。</p>;
  if (periods.length === 0) return <p className="small muted">給与計算期間がまだありません。給与計算ページで期間を作成してから入力してください（未入力の期間は給与確定できません）。</p>;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>給与期間</th>
            <th>対象日</th>
            <th>{label}</th>
          </tr>
        </thead>
        <tbody>
          {periods.slice(0, 6).map((p) => (
            <tr key={p.id}>
              <td>{p.periodKey}</td>
              <td className="num small">
                {p.from}〜{p.to}
              </td>
              <td>
                <YenInput label={`${p.periodKey} ${label}`} value={value[p.id] ?? ''} onChange={(v) => onChange({ ...value, [p.id]: v })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function toAmountStrings(r: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]));
}
function fromAmountStrings(r: Record<string, string>): { value: Record<string, number>; error: boolean } {
  const out: Record<string, number> = {};
  let error = false;
  for (const [k, v] of Object.entries(r)) {
    if (v.trim() === '') continue;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) error = true;
    else out[k] = n;
  }
  return { value: out, error };
}

// ------------------------------------------------------------------ ページ本体
type Editing =
  | { kind: 'wage'; row: WageRule | null }
  | { kind: 'salary'; row: SalaryRule | null }
  | { kind: 'transport'; row: TransportRule | null }
  | { kind: 'allowance'; row: Allowance | null }
  | { kind: 'employment'; row: EmploymentHistory | null };

/**
 * 給与条件（時給ルール・月給設定・手当・交通費・雇用条件）
 * v1.3: 独立したナビゲーションは廃止し、「スタッフ・権限」の各スタッフの「時給ルール」「月給設定」から対象スタッフを固定して開く
 */
export function PayConditionsPage({ fixedEmployeeId }: { fixedEmployeeId?: string } = {}) {
  const client = useClient();
  const today = todayJst();
  const [includeRetired, setIncludeRetired] = useState(!!fixedEmployeeId);
  const emps = useLoad(() => client.call<EmpLite[]>('employees.list', { includeRetired }), [includeRetired]);
  const [picked, setPicked] = useState(fixedEmployeeId ?? '');
  // 対象スタッフを固定した場合は、一覧に見つからなくても別のスタッフに切り替えない（取り違え防止）
  const empId = fixedEmployeeId ? (emps.data?.some((e) => e.id === fixedEmployeeId) ? fixedEmployeeId : '') : picked && emps.data?.some((e) => e.id === picked) ? picked : (emps.data?.[0]?.id ?? '');
  const emp = emps.data?.find((e) => e.id === empId) ?? null;
  const conf = useLoad(() => (empId ? client.call<Conf>('payconf.get', { employeeId: empId }) : Promise.resolve(null)), [empId]);
  const empl = useLoad(() => (empId ? client.call<EmploymentHistory[]>('employment.list', { employeeId: empId }) : Promise.resolve(null)), [empId]);
  const periods = useLoad(
    () =>
      client
        .call<{ periods: PayrollPeriod[] }>('payroll.periods')
        .then((r) => r.periods)
        .catch(() => null),
    [],
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const done = () => {
    setEditing(null);
    conf.reload();
    empl.reload();
  };

  return (
    <div className="pc-page" style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <style>{CSS}</style>
      <Panel>
        {fixedEmployeeId ? (
          <div className="pc-picker" data-testid="pc-target">
            <div>
              <div className="small muted">対象スタッフ</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                {emp ? `${emp.displayName}（${emp.payType === 'monthly' ? '月給制' : '時給制'}）` : emps.loading ? '読み込み中…' : '対象のスタッフが見つかりません'}
              </div>
            </div>
          </div>
        ) : (
        <div className="pc-picker">
          <Field label="スタッフ">
            <select className="input" value={empId} onChange={(e) => setPicked(e.target.value)} disabled={!emps.data?.length}>
              {(emps.data ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.displayName}（{e.payType === 'monthly' ? '月給制' : '時給制'}）{e.status === 'retired' ? '・退職' : ''}
                </option>
              ))}
            </select>
          </Field>
          <label className="check small" style={{ minHeight: 40, alignItems: 'center' }}>
            <input type="checkbox" checked={includeRetired} onChange={(e) => setIncludeRetired(e.target.checked)} style={{ marginTop: 0 }} />
            <span>退職者も表示</span>
          </label>
        </div>
        )}
        {emps.loading && !emps.data && <Loading />}
        {emps.error && <ErrorBox message={emps.error} onRetry={emps.reload} />}
        {emps.data && emps.data.length === 0 && <Empty>スタッフが登録されていません。「スタッフ・権限」で登録してください。</Empty>}
        <p className="small muted" style={{ marginTop: 10 }}>
          給与条件の変更は監査ログに記録されます。確定済みの給与は確定時の条件で保存されているため、ここでの変更による影響はありません。自分自身の給与条件は変更できません。
        </p>
      </Panel>

      {emp && (conf.loading || empl.loading) && !conf.data && <Loading />}
      {conf.error && <ErrorBox message={conf.error} onRetry={conf.reload} />}
      {empl.error && <ErrorBox message={empl.error} onRetry={empl.reload} />}

      {emp && conf.data && empl.data && (
        <>
          <StatusPanel emp={emp} conf={conf.data} employment={empl.data} today={today} />
          {emp.payType === 'hourly' ? (
            <>
              <WageSection conf={conf.data} today={today} onEdit={(row) => setEditing({ kind: 'wage', row })} />
              {conf.data.salaryRules.length > 0 && <SalarySection rules={conf.data.salaryRules} today={today} onEdit={(row) => setEditing({ kind: 'salary', row })} note="このスタッフは時給制のため、月給条件は給与計算に使用されません。" />}
            </>
          ) : (
            <>
              <SalarySection rules={conf.data.salaryRules} today={today} onEdit={(row) => setEditing({ kind: 'salary', row })} />
              {conf.data.wageRules.length > 0 && <WageSection conf={conf.data} today={today} onEdit={(row) => setEditing({ kind: 'wage', row })} note="このスタッフは月給制のため、時給ルールは給与計算に使用されません。" />}
            </>
          )}
          <TransportSection rules={conf.data.transportRules} today={today} onEdit={(row) => setEditing({ kind: 'transport', row })} />
          <AllowanceSection rows={conf.data.allowances} today={today} onEdit={(row) => setEditing({ kind: 'allowance', row })} />
          <EmploymentSection rows={empl.data} today={today} onEdit={(row) => setEditing({ kind: 'employment', row })} />
        </>
      )}

      {emp && editing?.kind === 'wage' && <WageModal employeeId={emp.id} row={editing.row} onClose={() => setEditing(null)} onDone={done} />}
      {emp && editing?.kind === 'salary' && <SalaryModal employeeId={emp.id} row={editing.row} onClose={() => setEditing(null)} onDone={done} />}
      {emp && editing?.kind === 'transport' && <TransportModal employeeId={emp.id} row={editing.row} periods={periods.data} onClose={() => setEditing(null)} onDone={done} />}
      {emp && editing?.kind === 'allowance' && <AllowanceModal employeeId={emp.id} row={editing.row} periods={periods.data} onClose={() => setEditing(null)} onDone={done} />}
      {emp && editing?.kind === 'employment' && <EmploymentModal employeeId={emp.id} payType={emp.payType} row={editing.row} onClose={() => setEditing(null)} onDone={done} />}
    </div>
  );
}

// ------------------------------------------------------------------ 設定状況
function StatusPanel({ emp, conf, employment, today }: { emp: EmpLite; conf: Conf; employment: EmploymentHistory[]; today: string }) {
  const items: Array<{ k: string; v: ReactNode }> = [];
  if (emp.payType === 'hourly') {
    const base = effectiveOn(conf.wageRules.filter((r) => r.kind === 'base'), today)[0];
    items.push({ k: '基本時給', v: base ? <Yen v={base.hourlyRate} /> : <Unset /> });
    items.push({ k: '時給ルールの矛盾', v: conf.wageConflicts.length ? <span className="badge badge-bull">{conf.wageConflicts.length}件（給与確定不可）</span> : <span className="badge badge-board">なし</span> });
  } else {
    const sr = effectiveOn(conf.salaryRules, today)[0];
    items.push({ k: '月額基本給', v: sr ? <Yen v={sr.monthlySalary} /> : <Unset /> });
    items.push({ k: '給与規定の確認', v: !sr ? <Unset /> : sr.confirmed ? <span className="badge badge-board">確認済み</span> : <Unset text="未確認（給与確定不可）" /> });
    if (sr) items.push({ k: '1か月平均所定労働時間', v: sr.monthlyScheduledMinutes ? <span className="num">{hmText(sr.monthlyScheduledMinutes)}</span> : <Unset /> });
  }
  const tr = effectiveOn(conf.transportRules, today)[0];
  items.push({ k: '交通費', v: !tr || tr.method === 'unset' ? <Unset /> : <span>{TRANSPORT_LABEL[tr.method]}</span> });
  const al = effectiveOn(conf.allowances, today);
  items.push({ k: '適用中の手当', v: al.length ? <span>{al.map((a) => a.name).join('、')}</span> : <span className="muted">なし</span> });
  const em = effectiveOn(employment, today)[0];
  items.push({
    k: '雇用条件（所定労働日数・時間）',
    v: !em ? <span className="badge badge-warn">未設定</span> : em.weeklyScheduledDays === null && em.yearlyScheduledDays === null ? <span className="badge badge-warn">所定日数が未設定</span> : <span className="badge badge-board">設定済み</span>,
  });
  return (
    <Panel title={`設定状況（${today} 時点）`}>
      <div className="pc-status">
        {items.map((i) => (
          <div key={i.k}>
            <span className="k">{i.k}</span>
            <span>{i.v}</span>
          </div>
        ))}
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>
        「未設定（給与確定不可）」の項目があると、給与計算で仮計算はできても給与を確定できません。支給しない項目も「支給なし」などを明示して登録してください。
      </p>
    </Panel>
  );
}

// ------------------------------------------------------------------ 時給ルール
function wageCondition(r: WageRule): string {
  switch (r.kind) {
    case 'base':
      return 'すべての勤務';
    case 'weekday':
      return weekdaysText(r.weekdays);
    case 'timeband':
      return `${r.timeFrom ?? ''}〜${r.timeTo ?? ''}${r.weekdays.length ? `（${weekdaysText(r.weekdays)}）` : '（全曜日）'}`;
    case 'holiday':
      return '店舗設定の祝日';
    case 'special_date':
      return r.specialDates.length > 3 ? `${r.specialDates.slice(0, 3).join('、')} ほか${r.specialDates.length - 3}日` : r.specialDates.join('、');
  }
}

function WageSection({ conf, today, onEdit, note }: { conf: Conf; today: string; onEdit: (r: WageRule | null) => void; note?: string }) {
  const conflictIds = new Set(conf.wageConflicts.flat());
  const byId = new Map(conf.wageRules.map((r) => [r.id, r]));
  const rows = [...conf.wageRules].sort((a, b) => b.priority - a.priority || (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return (
    <Panel title="時給ルール" actions={<button className="btn btn-primary btn-sm" onClick={() => onEdit(null)}>ルールを追加</button>} pad={false}>
      <div className="panel-body stack" style={{ gap: 8, paddingBottom: 8 }}>
        {note && <div className="callout">{note}</div>}
        <p className="small muted">勤務時間ごとに、条件に当てはまるルールのうち優先度が最も高いものを適用します。曜日・祝日・時間帯は営業日で判定します（例: 営業日切替が5:00なら金曜26:00の勤務は金曜扱い）。</p>
        {conf.wageConflicts.length > 0 && (
          <div className="callout callout-bull" role="alert">
            <strong>ルールの矛盾があります（解消するまで給与確定できません）</strong>
            {conf.wageConflicts.map(([a, b]) => {
              const x = byId.get(a);
              const y = byId.get(b);
              return (
                <div key={`${a}-${b}`} className="small">
                  「{x ? `${WAGE_KIND[x.kind]} ${wageCondition(x)} ¥${x.hourlyRate.toLocaleString('ja-JP')}` : a}」と「{y ? `${WAGE_KIND[y.kind]} ${wageCondition(y)} ¥${y.hourlyRate.toLocaleString('ja-JP')}` : b}」が同じ優先度（{x?.priority}）で重なっています。
                </div>
              );
            })}
            <div className="small">優先度を変えるか、適用期間・条件が重ならないよう調整してください。暫定計算では高い時給を使用します。</div>
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty>時給ルールがありません。まず「基本時給」を登録してください（{UNSET}）。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>種別</th>
                <th>条件</th>
                <th className="r">時給</th>
                <th>深夜割増</th>
                <th className="r">優先度</th>
                <th>適用期間</th>
                <th>状態</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{WAGE_KIND[r.kind]}</td>
                  <td className="wrap">
                    {wageCondition(r)}
                    {r.note && <div className="small muted">{r.note}</div>}
                  </td>
                  <td className="r">
                    <Yen v={r.hourlyRate} />
                  </td>
                  <td className="small">{r.includesNightPremium ? <>込み（算定基礎 <Yen v={r.premiumBaseRate} />）</> : '別途加算'}</td>
                  <td className="r num">{r.priority}</td>
                  <td className="num small">{period(r)}</td>
                  <td>
                    {rowState(r, today)}
                    {conflictIds.has(r.id) && (
                      <span className="badge badge-bull" style={{ marginLeft: 4 }}>
                        矛盾
                      </span>
                    )}
                  </td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => onEdit(r)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function WageModal({ employeeId, row, onClose, onDone }: { employeeId: string; row: WageRule | null; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => ({
    kind: row?.kind ?? ('base' as WageRule['kind']),
    hourlyRate: row ? String(row.hourlyRate) : '',
    effectiveFrom: row?.effectiveFrom ?? todayJst(),
    effectiveTo: row?.effectiveTo ?? '',
    weekdays: row?.weekdays ?? [],
    timeFrom: row?.timeFrom ?? '22:00',
    timeTo: row?.timeTo ?? '29:00',
    specialDates: row?.specialDates ?? [],
    priority: String(row?.priority ?? 0),
    includesNightPremium: row?.includesNightPremium ?? false,
    premiumBaseRate: row?.premiumBaseRate ? String(row.premiumBaseRate) : '',
    note: row?.note ?? '',
  }));
  const [newDate, setNewDate] = useState('');
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const tf = f.kind === 'timeband' ? normTime(f.timeFrom) : null;
  const tt = f.kind === 'timeband' ? normTime(f.timeTo) : null;
  const rate = intOrNull(f.hourlyRate);
  const base = intOrNull(f.premiumBaseRate);
  const prio = intOrNull(f.priority);
  const candidate: Partial<WageRule> = {
    kind: f.kind,
    hourlyRate: rate ?? NaN,
    effectiveFrom: f.effectiveFrom,
    effectiveTo: f.effectiveTo || null,
    weekdays: f.kind === 'weekday' || f.kind === 'timeband' ? f.weekdays : [],
    timeFrom: tf,
    timeTo: tt,
    specialDates: f.kind === 'special_date' ? f.specialDates : [],
    includesNightPremium: f.includesNightPremium,
    premiumBaseRate: f.includesNightPremium ? base : null,
  };
  const errors: string[] = [];
  if (!isDate(f.effectiveFrom)) errors.push('適用開始日を入力してください');
  if (f.kind === 'timeband' && (!tf || !tt)) errors.push('時間帯は HH:MM で入力してください（翌日は 29:00 のように 24 以上で表記）');
  if (prio === null || Number.isNaN(prio) || prio < 0 || prio > 1000) errors.push('優先度は0〜1000の整数で入力してください');
  if (f.kind !== 'timeband' || (tf && tt)) errors.push(...validateWageRule(candidate));
  const nightNeed = f.includesNightPremium && base && base > 0 ? Math.ceil(base * 1.25) : null;

  const save = async () => {
    const r = await run(
      () =>
        client.call<{ conflicts: Array<[string, string]> }>('payconf.upsertWageRule', {
          id: row?.id,
          version: row?.version,
          employeeId,
          ...candidate,
          priority: prio,
          note: f.note.trim(),
        }),
      '時給ルールを保存しました',
    );
    if (r) onDone();
  };

  return (
    <FormModal title={row ? '時給ルールを編集' : '時給ルールを追加'} busy={busy} disabled={errors.length > 0} onClose={onClose} onSave={save}>
      <div className="form-grid">
        <Field label="種別">
          <select
            className="input"
            value={f.kind}
            onChange={(e) => {
              const k = e.target.value as WageRule['kind'];
              set({ kind: k, ...(row ? {} : { priority: String(DEFAULT_PRIORITY[k]) }) });
            }}
          >
            {(Object.keys(WAGE_KIND) as WageRule['kind'][]).map((k) => (
              <option key={k} value={k}>
                {WAGE_KIND[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="時給">
          <YenInput label="時給" value={f.hourlyRate} onChange={(v) => set({ hourlyRate: v })} />
        </Field>
        <Field label="優先度" hint="大きいほど優先">
          <input className="input num" type="number" min={0} max={1000} value={f.priority} onChange={(e) => set({ priority: e.target.value })} />
        </Field>
      </div>
      <div className="form-grid">
        <RangeFields from={f.effectiveFrom} to={f.effectiveTo} onFrom={(v) => set({ effectiveFrom: v })} onTo={(v) => set({ effectiveTo: v })} />
      </div>
      {(f.kind === 'weekday' || f.kind === 'timeband') && (
        <div className="field">
          <span>
            曜日{f.kind === 'timeband' && <span className="hint">　未選択は全曜日</span>}
          </span>
          <WeekdayPicker label="曜日" value={f.weekdays} onChange={(v) => set({ weekdays: v })} />
        </div>
      )}
      {f.kind === 'timeband' && (
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
          <Field label="開始時刻" hint="営業日0:00から">
            <input className="input num" inputMode="numeric" value={f.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} placeholder="22:00" />
          </Field>
          <Field label="終了時刻" hint="翌5時は29:00">
            <input className="input num" inputMode="numeric" value={f.timeTo} onChange={(e) => set({ timeTo: e.target.value })} placeholder="29:00" />
          </Field>
        </div>
      )}
      {f.kind === 'holiday' && <p className="small muted">店舗設定の「祝日」リストに含まれる営業日に適用します（法定休日の割増とは別です）。</p>}
      {f.kind === 'special_date' && (
        <div className="field">
          <span>特定日</span>
          <div className="row">
            <input className="input" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} style={{ width: 180 }} aria-label="追加する日付" />
            <button type="button" className="btn btn-sm" disabled={!isDate(newDate) || f.specialDates.includes(newDate)} onClick={() => { set({ specialDates: [...f.specialDates, newDate].sort() }); setNewDate(''); }}>
              追加
            </button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {f.specialDates.length === 0 && <span className="small muted">日付を追加してください</span>}
            {f.specialDates.map((d) => (
              <button key={d} type="button" className="btn btn-sm" onClick={() => set({ specialDates: f.specialDates.filter((x) => x !== d) })} aria-label={`${d} を削除`}>
                <span className="num">{d}</span> ×
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="pc-sub">
        <label className="check">
          <input type="checkbox" checked={f.includesNightPremium} onChange={(e) => set({ includesNightPremium: e.target.checked })} />
          <span>
            この時給に法定の深夜割増（25%）を含めている
            <div className="small muted">含める場合、深夜割増は別途加算しません。時間外・休日の割増は下の算定基礎時給で計算します。</div>
          </span>
        </label>
        {f.includesNightPremium && (
          <Field label="割増算定基礎となる通常の時給" hint="深夜割増を含まない時給">
            <YenInput label="割増算定基礎となる通常の時給" value={f.premiumBaseRate} onChange={(v) => set({ premiumBaseRate: v })} />
          </Field>
        )}
        {nightNeed !== null && <p className="small muted">深夜割増込みの時給は通常時給×1.25 以上（¥{nightNeed.toLocaleString('ja-JP')} 以上）が必要です。</p>}
      </div>
      <Field label="メモ" hint="任意">
        <input className="input" maxLength={200} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <p className="small muted">同じ優先度で条件と期間が重なり時給が異なるルールは矛盾として扱われ、解消するまで給与を確定できません。時給を改定する場合は、旧ルールに適用終了日を入れてから新しいルールを追加してください。</p>
      <Errors list={errors} />
    </FormModal>
  );
}

// ------------------------------------------------------------------ 月給
function SalarySection({ rules, today, onEdit, note }: { rules: SalaryRule[]; today: string; onEdit: (r: SalaryRule | null) => void; note?: string }) {
  const rows = [...rules].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return (
    <Panel title="月給制の条件" actions={<button className="btn btn-primary btn-sm" onClick={() => onEdit(null)}>条件を追加</button>} pad={false}>
      {note && (
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          <div className="callout">{note}</div>
        </div>
      )}
      {rows.length === 0 ? (
        <Empty>月給条件がありません（{UNSET}）。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>適用期間</th>
                <th className="r">月額基本給</th>
                <th>1か月平均所定</th>
                <th>所定労働日・時間</th>
                <th>法定内残業</th>
                <th>固定残業代</th>
                <th>欠勤控除</th>
                <th>遅刻早退控除</th>
                <th>規定の確認</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num small">
                    {period(r)}
                    <div>{rowState(r, today)}</div>
                  </td>
                  <td className="r">
                    <Yen v={r.monthlySalary} />
                  </td>
                  <td>{r.monthlyScheduledMinutes ? <span className="num">{hmText(r.monthlyScheduledMinutes)}</span> : <Unset />}</td>
                  <td className="small">
                    {r.scheduledWeekdays.length ? weekdaysText(r.scheduledWeekdays) : <span className="muted">曜日未設定</span>}
                    {' ／ '}
                    {r.scheduledDailyMinutes !== null ? hmText(r.scheduledDailyMinutes) : <span className="muted">時間未設定</span>}
                  </td>
                  <td>{r.inLegalOvertimeRate !== null ? `${r.inLegalOvertimeRate}%` : <Unset text="未設定（該当月は確定不可）" />}</td>
                  <td className="small">{r.fixedOvertime?.enabled ? <>
                      <Yen v={r.fixedOvertime.amount} />（対象 {hmText(r.fixedOvertime.coveredMinutes)}）
                    </> : 'なし'}</td>
                  <td className="small">{r.absenceDeduction === null ? <Unset text="規定未確認" /> : r.absenceDeduction.enabled ? `控除する（月給÷${r.absenceDeduction.divisorDays ?? '—'}日）` : '控除しない'}</td>
                  <td className="small">{r.lateEarlyDeduction === null ? <Unset text="規定未確認" /> : r.lateEarlyDeduction.enabled ? '控除する' : '控除しない'}</td>
                  <td>{r.confirmed ? <span className="badge badge-board">確認済み</span> : <Unset text="未確認（給与確定不可）" />}</td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => onEdit(r)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ padding: '10px 18px 14px' }}>
        時間単価＝（月給＋割増算定基礎に算入する手当）÷1か月平均所定労働時間。法定時間外・休日労働は月給に含まれないため、100%部分と割増を別途支給します。欠勤・遅刻早退の控除は、給与計算で管理者が承認した調整のみが対象です（シフトから自動では控除しません）。
      </p>
    </Panel>
  );
}

type Tri = 'unset' | 'off' | 'on';
function SalaryModal({ employeeId, row, onClose, onDone }: { employeeId: string; row: SalaryRule | null; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => ({
    effectiveFrom: row?.effectiveFrom ?? todayJst(),
    effectiveTo: row?.effectiveTo ?? '',
    monthlySalary: row ? String(row.monthlySalary) : '',
    monthlyScheduledMinutes: row?.monthlyScheduledMinutes ?? null,
    scheduledWeekdays: row?.scheduledWeekdays ?? [],
    scheduledDailyMinutes: row?.scheduledDailyMinutes ?? null,
    inLegalOvertimeRate: row?.inLegalOvertimeRate ? String(row.inLegalOvertimeRate) : '',
    foEnabled: row?.fixedOvertime?.enabled ?? false,
    foAmount: row?.fixedOvertime ? String(row.fixedOvertime.amount) : '',
    foMinutes: row?.fixedOvertime?.coveredMinutes ?? null,
    absence: (row?.absenceDeduction === null || row?.absenceDeduction === undefined ? 'unset' : row.absenceDeduction.enabled ? 'on' : 'off') as Tri,
    divisorDays: row?.absenceDeduction?.divisorDays ? String(row.absenceDeduction.divisorDays) : '',
    lateEarly: (row?.lateEarlyDeduction === null || row?.lateEarlyDeduction === undefined ? 'unset' : row.lateEarlyDeduction.enabled ? 'on' : 'off') as Tri,
    confirmed: row?.confirmed ?? false,
    note: row?.note ?? '',
  }));
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const salary = intOrNull(f.monthlySalary);
  const foAmount = intOrNull(f.foAmount);
  const divisor = intOrNull(f.divisorDays);
  const errors: string[] = [];
  if (!isDate(f.effectiveFrom)) errors.push('適用開始日を入力してください');
  if (f.effectiveTo && f.effectiveTo < f.effectiveFrom) errors.push('適用終了日は開始日以降にしてください');
  if (salary === null || Number.isNaN(salary) || salary < 1 || salary > 10_000_000) errors.push('月額基本給を1〜10,000,000円の整数で入力してください');
  if (f.monthlyScheduledMinutes !== null && (Number.isNaN(f.monthlyScheduledMinutes) || f.monthlyScheduledMinutes < 60 || f.monthlyScheduledMinutes > 31 * 24 * 60)) errors.push('1か月平均所定労働時間は1時間以上で入力してください');
  if (f.scheduledDailyMinutes !== null && (Number.isNaN(f.scheduledDailyMinutes) || f.scheduledDailyMinutes > 1440)) errors.push('1日の所定労働時間を正しく入力してください');
  if (f.foEnabled) {
    if (foAmount === null || Number.isNaN(foAmount) || foAmount < 0) errors.push('固定残業代の金額を入力してください');
    if (f.foMinutes === null || Number.isNaN(f.foMinutes) || f.foMinutes <= 0 || f.foMinutes > 100 * 60) errors.push('固定残業代の対象時間を入力してください');
  }
  if (f.absence === 'on' && (divisor === null || Number.isNaN(divisor) || divisor < 1 || divisor > 31)) errors.push('欠勤控除の除数（日数）を1〜31で入力してください');

  // 固定残業代の妥当性（手当を含まない概算）
  const unit = salary && f.monthlyScheduledMinutes && f.monthlyScheduledMinutes > 0 ? (salary * 60) / f.monthlyScheduledMinutes : null;
  const foUnit = f.foEnabled && foAmount && f.foMinutes && f.foMinutes > 0 ? (foAmount * 60) / f.foMinutes : null;

  const save = async () => {
    const r = await run(
      () =>
        client.call('payconf.upsertSalaryRule', {
          id: row?.id,
          version: row?.version,
          employeeId,
          effectiveFrom: f.effectiveFrom,
          effectiveTo: f.effectiveTo || null,
          monthlySalary: salary,
          monthlyScheduledMinutes: f.monthlyScheduledMinutes,
          scheduledWeekdays: f.scheduledWeekdays,
          scheduledDailyMinutes: f.scheduledDailyMinutes,
          inLegalOvertimeRate: f.inLegalOvertimeRate ? Number(f.inLegalOvertimeRate) : null,
          fixedOvertime: f.foEnabled ? { enabled: true, amount: foAmount, coveredMinutes: f.foMinutes } : null,
          absenceDeduction: f.absence === 'unset' ? null : { enabled: f.absence === 'on', divisorDays: f.absence === 'on' ? divisor : null },
          lateEarlyDeduction: f.lateEarly === 'unset' ? null : { enabled: f.lateEarly === 'on' },
          confirmed: f.confirmed,
          note: f.note.trim(),
        }),
      '月給条件を保存しました',
    );
    if (r) onDone();
  };
  const tri = (name: string, value: Tri, onChange: (v: Tri) => void, labels: [string, string, string]) => (
    <div className="pc-radio" role="radiogroup" aria-label={name}>
      {(['unset', 'off', 'on'] as Tri[]).map((t, i) => (
        <label key={t} className="check">
          <input type="radio" name={name} checked={value === t} onChange={() => onChange(t)} />
          <span>{labels[i]}</span>
        </label>
      ))}
    </div>
  );

  return (
    <FormModal title={row ? '月給条件を編集' : '月給条件を追加'} busy={busy} disabled={errors.length > 0} onClose={onClose} onSave={save}>
      <div className="form-grid">
        <RangeFields from={f.effectiveFrom} to={f.effectiveTo} onFrom={(v) => set({ effectiveFrom: v })} onTo={(v) => set({ effectiveTo: v })} />
        <Field label="月額基本給">
          <YenInput label="月額基本給" value={f.monthlySalary} onChange={(v) => set({ monthlySalary: v })} />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="1か月平均所定労働時間" hint="時間単価・最低賃金判定の基礎">
          <HmInput label="1か月平均所定労働時間" value={f.monthlyScheduledMinutes} onChange={(v) => set({ monthlyScheduledMinutes: v })} />
        </Field>
        <Field label="1日の所定労働時間">
          <HmInput label="1日の所定労働時間" value={f.scheduledDailyMinutes} onChange={(v) => set({ scheduledDailyMinutes: v })} />
        </Field>
      </div>
      {f.monthlyScheduledMinutes === null && <p className="small" style={{ color: 'var(--warn)' }}>1か月平均所定労働時間が{UNSET}。例: (365日−年間休日)×1日所定時間÷12。</p>}
      <div className="field">
        <span>所定労働日（曜日）<span className="hint">　公開シフトがない日の所定時間の判定に使用</span></span>
        <WeekdayPicker label="所定労働日" value={f.scheduledWeekdays} onChange={(v) => set({ scheduledWeekdays: v })} />
      </div>
      <div className="field">
        <span>法定内残業（所定時間を超え法定時間内の労働）の支払率</span>
        <div className="pc-radio" role="radiogroup" aria-label="法定内残業の支払率">
          {[
            ['', '未設定'],
            ['100', '100%（通常の賃金）'],
            ['125', '125%（割増して支払う）'],
          ].map(([v, l]) => (
            <label key={v} className="check">
              <input type="radio" name="inlegal" checked={f.inLegalOvertimeRate === v} onChange={() => set({ inLegalOvertimeRate: v ?? '' })} />
              <span>{l}</span>
            </label>
          ))}
        </div>
        {!f.inLegalOvertimeRate && <span className="small" style={{ color: 'var(--warn)' }}>未設定の場合、法定内残業が発生した月は給与を確定できません。就業規則の定めに従って選択してください。</span>}
      </div>

      <div className="pc-sub">
        <label className="check">
          <input type="checkbox" checked={f.foEnabled} onChange={(e) => set({ foEnabled: e.target.checked })} />
          <span>固定残業代（みなし残業代）を支給する</span>
        </label>
        {f.foEnabled && (
          <>
            <div className="form-grid">
              <Field label="固定残業代の金額">
                <YenInput label="固定残業代の金額" value={f.foAmount} onChange={(v) => set({ foAmount: v })} />
              </Field>
              <Field label="対象となる時間外労働の時間">
                <HmInput label="固定残業の対象時間" value={f.foMinutes} onChange={(v) => set({ foMinutes: v })} />
              </Field>
            </div>
            {unit && foUnit ? (
              <p className="small">
                固定残業代の1時間あたり <strong className="num">¥{Math.floor(foUnit).toLocaleString('ja-JP')}</strong>／必要額（時間単価×1.25）
                <strong className="num"> ¥{Math.ceil(unit * 1.25).toLocaleString('ja-JP')}</strong>{' '}
                {foUnit >= unit * 1.25 ? <span className="badge badge-board">充足</span> : <span className="badge badge-bull">不足（給与確定不可）</span>}
                <span className="muted">（算入手当を含まない概算）</span>
              </p>
            ) : (
              <p className="small muted">月額基本給・1か月平均所定労働時間・金額・対象時間を入力すると、法定の時間外賃金を満たしているか確認できます。</p>
            )}
            <p className="small muted">実際の時間外賃金が固定残業代を超えた月は、超過分を別途支給します。</p>
          </>
        )}
      </div>

      <div className="pc-sub">
        <div className="field">
          <span>欠勤控除の規定</span>
          {tri('absence', f.absence, (v) => set({ absence: v }), ['未確認', '控除しない', '控除する'])}
        </div>
        {f.absence === 'on' && (
          <Field label="日額の算定除数（日）" hint="月給÷この日数＝1日あたり控除額">
            <input className="input num" style={{ width: 120 }} type="number" min={1} max={31} value={f.divisorDays} onChange={(e) => set({ divisorDays: e.target.value })} />
          </Field>
        )}
        <div className="field">
          <span>遅刻・早退控除の規定</span>
          {tri('lateearly', f.lateEarly, (v) => set({ lateEarly: v }), ['未確認', '控除しない', '控除する'])}
        </div>
        <p className="small muted">「未確認」のまま欠勤・遅刻早退の調整を登録すると、その月は給与を確定できません。遅刻早退の控除額は月給÷1か月平均所定労働時間×分数（円未満切捨て）です。</p>
      </div>

      <label className="check callout" style={{ borderLeftColor: f.confirmed ? 'var(--board)' : 'var(--warn)', background: f.confirmed ? 'var(--board-soft)' : 'var(--warn-soft)' }}>
        <input type="checkbox" checked={f.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} />
        <span>
          <strong>就業規則・賃金規程と照合し、上記の内容が正しいことを確認しました</strong>
          <div className="small">確認済みにするまで、このスタッフの給与は確定できません。</div>
        </span>
      </label>
      <Field label="メモ" hint="任意">
        <input className="input" maxLength={300} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <Errors list={errors} />
    </FormModal>
  );
}

// ------------------------------------------------------------------ 交通費
function TransportSection({ rules, today, onEdit }: { rules: TransportRule[]; today: string; onEdit: (r: TransportRule | null) => void }) {
  const rows = [...rules].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return (
    <Panel title="交通費" actions={<button className="btn btn-primary btn-sm" onClick={() => onEdit(null)}>交通費を設定</button>} pad={false}>
      {rows.length === 0 ? (
        <Empty>交通費が{UNSET}。支給しない場合も「支給なし」を登録してください。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>適用期間</th>
                <th>支給方式</th>
                <th className="r">金額</th>
                <th className="r">月の上限</th>
                <th>メモ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num small">
                    {period(r)}
                    <div>{rowState(r, today)}</div>
                  </td>
                  <td>{r.method === 'unset' ? <Unset /> : TRANSPORT_LABEL[r.method]}</td>
                  <td className="r">{r.method === 'per_day' || r.method === 'monthly' ? <Yen v={r.amount} /> : r.method === 'actual' ? <span className="small muted">期間ごと（{Object.keys(r.actualAmounts).length}期間入力済み）</span> : '—'}</td>
                  <td className="r">{r.monthlyCap !== null ? <Yen v={r.monthlyCap} /> : <span className="muted">なし</span>}</td>
                  <td className="small wrap">{r.note || <span className="muted">—</span>}</td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => onEdit(r)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function TransportModal({ employeeId, row, periods, onClose, onDone }: { employeeId: string; row: TransportRule | null; periods: PayrollPeriod[] | null; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => ({
    effectiveFrom: row?.effectiveFrom ?? todayJst(),
    effectiveTo: row?.effectiveTo ?? '',
    method: row?.method ?? ('per_day' as TransportMethod),
    amount: row && (row.method === 'per_day' || row.method === 'monthly') ? String(row.amount) : '',
    monthlyCap: row?.monthlyCap !== null && row?.monthlyCap !== undefined ? String(row.monthlyCap) : '',
    actual: toAmountStrings(row?.actualAmounts ?? {}),
    note: row?.note ?? '',
  }));
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const amount = intOrNull(f.amount);
  const cap = intOrNull(f.monthlyCap);
  const actual = fromAmountStrings(f.actual);
  const needAmount = f.method === 'per_day' || f.method === 'monthly';
  const errors: string[] = [];
  if (!isDate(f.effectiveFrom)) errors.push('適用開始日を入力してください');
  if (f.effectiveTo && f.effectiveTo < f.effectiveFrom) errors.push('適用終了日は開始日以降にしてください');
  if (needAmount && (amount === null || Number.isNaN(amount) || amount < 0 || amount > 1_000_000)) errors.push('金額を0〜1,000,000円の整数で入力してください');
  if (cap !== null && (Number.isNaN(cap) || cap < 0)) errors.push('上限は0以上の整数で入力してください');
  if (actual.error) errors.push('実費の金額は0以上の整数で入力してください');

  const save = async () => {
    const r = await run(
      () =>
        client.call('payconf.upsertTransport', {
          id: row?.id,
          version: row?.version,
          employeeId,
          effectiveFrom: f.effectiveFrom,
          effectiveTo: f.effectiveTo || null,
          method: f.method,
          amount: needAmount ? amount : 0,
          monthlyCap: cap,
          // 画面に表示していない期間の入力も保持する
          actualAmounts: actual.value,
          note: f.note.trim(),
        }),
      '交通費を保存しました',
    );
    if (r) onDone();
  };

  return (
    <FormModal title={row ? '交通費を編集' : '交通費を設定'} busy={busy} disabled={errors.length > 0} onClose={onClose} onSave={save}>
      <div className="form-grid">
        <RangeFields from={f.effectiveFrom} to={f.effectiveTo} onFrom={(v) => set({ effectiveFrom: v })} onTo={(v) => set({ effectiveTo: v })} />
        <Field label="支給方式">
          <select className="input" value={f.method} onChange={(e) => set({ method: e.target.value as TransportMethod })}>
            {(Object.keys(TRANSPORT_LABEL) as TransportMethod[]).map((k) => (
              <option key={k} value={k}>
                {TRANSPORT_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {f.method === 'unset' && <div className="callout callout-warn">「未設定」のままでは給与を確定できません。支給しない場合は「支給なし」を選んでください。</div>}
      <div className="form-grid">
        {needAmount && (
          <Field label={f.method === 'per_day' ? '1日あたりの金額' : '月額'}>
            <YenInput label="金額" value={f.amount} onChange={(v) => set({ amount: v })} />
          </Field>
        )}
        {f.method !== 'none' && f.method !== 'unset' && (
          <Field label="1か月の支給上限" hint="空欄は上限なし">
            <YenInput label="1か月の支給上限" value={f.monthlyCap} onChange={(v) => set({ monthlyCap: v })} />
          </Field>
        )}
      </div>
      {f.method === 'actual' && (
        <div className="field">
          <span>給与期間ごとの実費</span>
          <PeriodAmounts periods={periods} value={f.actual} onChange={(v) => set({ actual: v })} label="実費" />
        </div>
      )}
      <Field label="メモ" hint="任意（経路など）">
        <input className="input" maxLength={200} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <p className="small muted">交通費は総支給額に含めます。非課税限度額の判定・課税区分は控除の入力側で扱います。</p>
      <Errors list={errors} />
    </FormModal>
  );
}

// ------------------------------------------------------------------ 手当
function AllowanceSection({ rows, today, onEdit }: { rows: Allowance[]; today: string; onEdit: (r: Allowance | null) => void }) {
  const sorted = [...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return (
    <Panel title="手当" actions={<button className="btn btn-primary btn-sm" onClick={() => onEdit(null)}>手当を追加</button>} pad={false}>
      {sorted.length === 0 ? (
        <Empty>手当はありません（手当がない場合は登録不要です）</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>名称</th>
                <th>頻度</th>
                <th className="r">金額</th>
                <th>割増算定基礎</th>
                <th>最低賃金</th>
                <th>適用期間</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a) => (
                <tr key={a.id}>
                  <td className="wrap">
                    {a.name}
                    {a.note && <div className="small muted">{a.note}</div>}
                  </td>
                  <td>{ALLOWANCE_KIND[a.kind]}</td>
                  <td className="r">{a.kind === 'variable' ? <span className="small muted">期間ごと</span> : <><Yen v={a.amount} />{a.kind === 'per_hour' ? '/時' : a.kind === 'per_workday' ? '/日' : '/月'}</>}</td>
                  <td className="small">{a.premiumBaseCategory === 'include' ? '算入' : PREMIUM_LABEL[a.premiumBaseCategory]}</td>
                  <td className="small">{a.includeInMinimumWage ? '算入' : '算入しない'}</td>
                  <td className="num small">
                    {period(a)}
                    <div>{rowState(a, today)}</div>
                  </td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => onEdit(a)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function AllowanceModal({ employeeId, row, periods, onClose, onDone }: { employeeId: string; row: Allowance | null; periods: PayrollPeriod[] | null; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => ({
    name: row?.name ?? '',
    kind: row?.kind ?? ('fixed_monthly' as Allowance['kind']),
    amount: row && row.kind !== 'variable' ? String(row.amount) : '',
    effectiveFrom: row?.effectiveFrom ?? todayJst(),
    effectiveTo: row?.effectiveTo ?? '',
    premiumBaseCategory: row?.premiumBaseCategory ?? ('include' as PremiumBaseCategory),
    includeInMinimumWage: row?.includeInMinimumWage ?? false,
    periodAmounts: toAmountStrings(row?.periodAmounts ?? {}),
    note: row?.note ?? '',
  }));
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const amount = intOrNull(f.amount);
  const pa = fromAmountStrings(f.periodAmounts);
  const errors: string[] = [];
  if (!f.name.trim()) errors.push('手当の名称を入力してください');
  if (!isDate(f.effectiveFrom)) errors.push('適用開始日を入力してください');
  if (f.effectiveTo && f.effectiveTo < f.effectiveFrom) errors.push('適用終了日は開始日以降にしてください');
  if (f.kind !== 'variable' && (amount === null || Number.isNaN(amount) || amount < 0 || amount > 10_000_000)) errors.push('金額を0以上の整数で入力してください');
  if (pa.error) errors.push('期間ごとの金額は0以上の整数で入力してください');

  const save = async () => {
    const r = await run(
      () =>
        client.call('payconf.upsertAllowance', {
          id: row?.id,
          version: row?.version,
          employeeId,
          name: f.name.trim(),
          kind: f.kind,
          amount: f.kind === 'variable' ? 0 : amount,
          effectiveFrom: f.effectiveFrom,
          effectiveTo: f.effectiveTo || null,
          premiumBaseCategory: f.premiumBaseCategory,
          includeInMinimumWage: f.includeInMinimumWage,
          periodAmounts: pa.value,
          note: f.note.trim(),
        }),
      '手当を保存しました',
    );
    if (r) onDone();
  };

  return (
    <FormModal title={row ? '手当を編集' : '手当を追加'} busy={busy} disabled={errors.length > 0} onClose={onClose} onSave={save}>
      <div className="form-grid">
        <Field label="名称">
          <input className="input" maxLength={30} value={f.name} placeholder="例: 深夜手当、資格手当" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="支給の頻度">
          <select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value as Allowance['kind'] })}>
            {(Object.keys(ALLOWANCE_KIND) as Allowance['kind'][]).map((k) => (
              <option key={k} value={k}>
                {ALLOWANCE_KIND[k]}
              </option>
            ))}
          </select>
        </Field>
        {f.kind !== 'variable' && (
          <Field label={f.kind === 'per_hour' ? '1時間あたりの金額' : f.kind === 'per_workday' ? '出勤1日あたりの金額' : '月額'}>
            <YenInput label="金額" value={f.amount} onChange={(v) => set({ amount: v })} />
          </Field>
        )}
      </div>
      <div className="form-grid">
        <RangeFields from={f.effectiveFrom} to={f.effectiveTo} onFrom={(v) => set({ effectiveFrom: v })} onTo={(v) => set({ effectiveTo: v })} />
      </div>
      {f.kind === 'variable' && (
        <div className="field">
          <span>給与期間ごとの金額</span>
          <PeriodAmounts periods={periods} value={f.periodAmounts} onChange={(v) => set({ periodAmounts: v })} label="金額" />
        </div>
      )}
      <div className="pc-sub">
        <Field label="割増賃金の算定基礎">
          <select className="input" value={f.premiumBaseCategory} onChange={(e) => set({ premiumBaseCategory: e.target.value as PremiumBaseCategory })}>
            {(Object.keys(PREMIUM_LABEL) as PremiumBaseCategory[]).map((k) => (
              <option key={k} value={k}>
                {PREMIUM_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        <p className="small">
          割増賃金（残業・休日・深夜）の算定基礎から除外できるのは、労働基準法施行規則21条に定める7種類（家族手当・通勤手当・別居手当・子女教育手当・住宅手当・臨時に支払われた賃金・1か月を超える期間ごとに支払われる賃金）だけです。それ以外の手当は除外できません。名称ではなく実態で判断します（例: 全員一律の住宅手当は除外できません）。
        </p>
        <label className="check">
          <input type="checkbox" checked={f.includeInMinimumWage} onChange={(e) => set({ includeInMinimumWage: e.target.checked })} />
          <span>
            最低賃金の判定に算入する
            <div className="small muted">精皆勤手当・通勤手当・家族手当、臨時の賃金、時間外・休日・深夜の割増賃金は最低賃金の計算に含めません。</div>
          </span>
        </label>
      </div>
      <Field label="メモ" hint="任意">
        <input className="input" maxLength={200} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <Errors list={errors} />
    </FormModal>
  );
}

// ------------------------------------------------------------------ 雇用条件
function EmploymentSection({ rows, today, onEdit }: { rows: EmploymentHistory[]; today: string; onEdit: (r: EmploymentHistory | null) => void }) {
  const sorted = useMemo(() => [...rows].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)), [rows]);
  const cell = (v: ReactNode | null) => (v === null || v === '' ? <span className="badge badge-warn">未設定</span> : v);
  return (
    <Panel title="雇用条件（所定労働日数・時間）" actions={<button className="btn btn-primary btn-sm" onClick={() => onEdit(null)}>雇用条件を追加</button>} pad={false}>
      {sorted.length === 0 ? (
        <Empty>雇用条件が未設定です。有給休暇の付与日数の判定や、手当の割増算定に必要です。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>適用期間</th>
                <th>給与形態</th>
                <th>週所定日数</th>
                <th>週所定時間</th>
                <th>年間所定日数</th>
                <th>1日所定時間</th>
                <th>1か月平均所定時間</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td className="num small">
                    {period(r)}
                    <div>{rowState(r, today)}</div>
                  </td>
                  <td>{r.payType === 'monthly' ? '月給制' : '時給制'}</td>
                  <td className="num">{cell(r.weeklyScheduledDays !== null ? `${r.weeklyScheduledDays}日` : null)}</td>
                  <td className="num">{cell(r.weeklyScheduledMinutes !== null ? hmText(r.weeklyScheduledMinutes) : null)}</td>
                  <td className="num">{r.yearlyScheduledDays !== null ? `${r.yearlyScheduledDays}日` : <span className="muted">—</span>}</td>
                  <td className="num">{cell(r.dailyScheduledMinutes !== null ? hmText(r.dailyScheduledMinutes) : null)}</td>
                  <td className="num">{r.monthlyAverageScheduledMinutes !== null ? hmText(r.monthlyAverageScheduledMinutes) : <span className="muted">—</span>}</td>
                  <td className="r">
                    <button className="btn btn-sm" onClick={() => onEdit(r)}>
                      編集
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted" style={{ padding: '10px 18px 14px' }}>
        有給休暇は、週所定30時間以上または週5日以上（年間217日以上）なら通常付与、それ未満は週所定日数（または年間所定日数）に応じた比例付与です。1日所定時間は日額手当の割増算定と有給の賃金（通常の賃金方式）、1か月平均所定時間は時給制の月額手当の割増算定に使います。
      </p>
    </Panel>
  );
}

function EmploymentModal({ employeeId, payType, row, onClose, onDone }: { employeeId: string; payType: 'hourly' | 'monthly'; row: EmploymentHistory | null; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(() => ({
    effectiveFrom: row?.effectiveFrom ?? todayJst(),
    effectiveTo: row?.effectiveTo ?? '',
    payType: row?.payType ?? payType,
    weeklyScheduledDays: row?.weeklyScheduledDays !== null && row?.weeklyScheduledDays !== undefined ? String(row.weeklyScheduledDays) : '',
    weeklyScheduledMinutes: row?.weeklyScheduledMinutes ?? null,
    yearlyScheduledDays: row?.yearlyScheduledDays !== null && row?.yearlyScheduledDays !== undefined ? String(row.yearlyScheduledDays) : '',
    dailyScheduledMinutes: row?.dailyScheduledMinutes ?? null,
    monthlyAverageScheduledMinutes: row?.monthlyAverageScheduledMinutes ?? null,
    note: row?.note ?? '',
  }));
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const wd = intOrNull(f.weeklyScheduledDays);
  const yd = intOrNull(f.yearlyScheduledDays);
  const errors: string[] = [];
  if (!isDate(f.effectiveFrom)) errors.push('適用開始日を入力してください');
  if (f.effectiveTo && f.effectiveTo < f.effectiveFrom) errors.push('適用終了日は開始日以降にしてください');
  if (wd !== null && (Number.isNaN(wd) || wd < 0 || wd > 7)) errors.push('週所定労働日数は0〜7日で入力してください');
  if (yd !== null && (Number.isNaN(yd) || yd < 0 || yd > 366)) errors.push('年間所定労働日数は0〜366日で入力してください');
  const mins: Array<[number | null, string, number]> = [
    [f.weeklyScheduledMinutes, '週所定労働時間', 7 * 24 * 60],
    [f.dailyScheduledMinutes, '1日所定労働時間', 24 * 60],
    [f.monthlyAverageScheduledMinutes, '1か月平均所定労働時間', 31 * 24 * 60],
  ];
  for (const [v, l, max] of mins) if (v !== null && (Number.isNaN(v) || v < 0 || v > max)) errors.push(`${l}を正しく入力してください`);

  const save = async () => {
    const r = await run(
      () =>
        client.call('employment.upsert', {
          ...(row ? { id: row.id, version: row.version } : {}),
          employeeId,
          effectiveFrom: f.effectiveFrom,
          effectiveTo: f.effectiveTo || null,
          payType: f.payType,
          weeklyScheduledDays: wd,
          weeklyScheduledMinutes: f.weeklyScheduledMinutes,
          yearlyScheduledDays: yd,
          dailyScheduledMinutes: f.dailyScheduledMinutes,
          monthlyAverageScheduledMinutes: f.monthlyAverageScheduledMinutes,
          note: f.note.trim(),
        }),
      '雇用条件を保存しました',
    );
    if (r) onDone();
  };

  return (
    <FormModal title={row ? '雇用条件を編集' : '雇用条件を追加'} busy={busy} disabled={errors.length > 0} onClose={onClose} onSave={save}>
      <div className="form-grid">
        <RangeFields from={f.effectiveFrom} to={f.effectiveTo} onFrom={(v) => set({ effectiveFrom: v })} onTo={(v) => set({ effectiveTo: v })} />
        <Field label="給与形態">
          <select className="input" value={f.payType} onChange={(e) => set({ payType: e.target.value as 'hourly' | 'monthly' })}>
            <option value="hourly">時給制</option>
            <option value="monthly">月給制</option>
          </select>
        </Field>
      </div>
      <div className="form-grid">
        <Field label="週所定労働日数" hint="日">
          <input className="input num" type="number" min={0} max={7} value={f.weeklyScheduledDays} onChange={(e) => set({ weeklyScheduledDays: e.target.value })} />
        </Field>
        <Field label="週所定労働時間">
          <HmInput label="週所定労働時間" value={f.weeklyScheduledMinutes} onChange={(v) => set({ weeklyScheduledMinutes: v })} />
        </Field>
        <Field label="年間所定労働日数" hint="週で定めない場合">
          <input className="input num" type="number" min={0} max={366} value={f.yearlyScheduledDays} onChange={(e) => set({ yearlyScheduledDays: e.target.value })} />
        </Field>
        <Field label="1日の所定労働時間">
          <HmInput label="1日の所定労働時間" value={f.dailyScheduledMinutes} onChange={(v) => set({ dailyScheduledMinutes: v })} />
        </Field>
        <Field label="1か月平均所定労働時間">
          <HmInput label="1か月平均所定労働時間" value={f.monthlyAverageScheduledMinutes} onChange={(v) => set({ monthlyAverageScheduledMinutes: v })} />
        </Field>
      </div>
      <p className="small muted">空欄の項目は「未設定」として保存されます。シフト制で日数が決まっていない場合は、雇用契約書（労働条件通知書）に記載した日数・時間を入力してください。</p>
      <Field label="メモ" hint="任意">
        <input className="input" maxLength={300} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <Errors list={errors} />
    </FormModal>
  );
}
