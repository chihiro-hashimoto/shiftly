/** 店舗設定（営業時間・労働時間制度・締め日・最低賃金・保存期間など） F27 */
import { useState, type ReactNode } from 'react';
import { ErrorBox, Field, Loading, Panel, useAction, useClient, useLoad, useToast, WEEKDAYS } from '../../components/ui';
import { ApiError } from '../../api/transport';
import type { BusinessHours, MinimumWageEntry, StoreSettings } from '../../../shared/types';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

type Key = keyof StoreSettings;
type UpdateResult = { settings: StoreSettings; payrollRulesReset: boolean };
type OnSaved = (r: UpdateResult) => void;

const UNSET = '未設定';
const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => i + 1);

function fmtDateTime(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '—';
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function dayLabel(d: number | null): string {
  if (d === null) return UNSET;
  return d === 0 ? '末日' : `${d}日`;
}
/** '26:00' → '翌2:00' の補足表示 */
function nextDayHint(t: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 24 ? `翌${h - 24}:${m[2]}` : null;
}
function intOrNull(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ------------------------------------------------------------------ 共通: セクション（変更項目のみ送信）
function useSection<K extends Key>(s: StoreSettings, keys: readonly K[], onSaved: OnSaved, groups: ReadonlyArray<readonly K[]> = []) {
  const client = useClient();
  const { busy, run } = useAction();
  const pick = (src: StoreSettings) => Object.fromEntries(keys.map((k) => [k, src[k]])) as Pick<StoreSettings, K>;
  const [draft, setDraft] = useState<Pick<StoreSettings, K>>(() => pick(s));
  const changed = keys.filter((k) => !same(draft[k], s[k]));
  const set = <F extends K>(k: F, v: StoreSettings[F]) => setDraft((d) => ({ ...d, [k]: v }));
  const save = async () => {
    const patch: Partial<StoreSettings> = {};
    const sendKeys = new Set<K>(changed);
    // 同時に送る必要がある項目（締め日・支払月・支払日など）
    for (const g of groups) if (g.some((k) => sendKeys.has(k))) g.forEach((k) => sendKeys.add(k));
    for (const k of sendKeys) (patch as Record<string, unknown>)[k] = draft[k];
    if (!sendKeys.size) return;
    const r = await run(() => client.call<UpdateResult>('settings.update', patch), '設定を保存しました');
    if (r) {
      setDraft(pick(r.settings));
      onSaved(r);
    }
  };
  const reset = () => setDraft(pick(s));
  return { draft, set, changed, save, reset, busy };
}

function Section({ id, title, desc, dirty, busy, onSave, onReset, children, payroll }: { id: string; title: string; desc?: ReactNode; dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void; children: ReactNode; payroll?: boolean }) {
  return (
    <div id={id} style={{ scrollMarginTop: 16 }}>
      <Panel
        title={
          <div>
            <h2 className="row" style={{ gap: 8 }}>
              {title}
              {payroll && <span className="badge badge-info" title="変更すると給与規定の確認がリセットされます">給与計算に影響</span>}
              {dirty && <span className="badge badge-warn">未保存の変更</span>}
            </h2>
            {desc && <p className="small muted" style={{ marginTop: 2 }}>{desc}</p>}
          </div>
        }
      >
        <div className="stack" style={{ gap: 14 }}>
          {children}
          <div className="row" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
            <button className="btn btn-sm btn-ghost" onClick={onReset} disabled={!dirty || busy}>
              元に戻す
            </button>
            <button className="btn btn-primary btn-sm" onClick={onSave} disabled={!dirty || busy}>
              保存
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="small muted" style={{ marginTop: 2 }}>{children}</p>;
}

// ------------------------------------------------------------------ ページ
const SECTIONS: Array<[string, string]> = [
  ['st-store', '店舗情報'],
  ['st-hours', '営業時間'],
  ['st-labor', '労働時間制度'],
  ['st-pay', '締め日・支払日'],
  ['st-minwage', '最低賃金'],
  ['st-leave', '有給休暇'],
  ['st-holidays', '祝日'],
  ['st-cost', '人件費分析'],
  ['st-security', '端末のセキュリティ'],
  ['st-payslip', '給与明細'],
  ['st-retention', '保存期間'],
];

export function SettingsPage() {
  const client = useClient();
  const toast = useToast();
  const load = useLoad(() => client.call<StoreSettings>('settings.get'), []);
  const [s, setS] = useState<StoreSettings | null>(null);
  const [resetNotice, setResetNotice] = useState(false);
  const cur = s ?? load.data;

  if (load.loading && !cur) return <Loading />;
  if (load.error && !cur) return <ErrorBox message={load.error} onRetry={load.reload} />;
  if (!cur) return null;

  const onSaved: OnSaved = (r) => {
    setS(r.settings);
    if (r.payrollRulesReset) {
      setResetNotice(true);
      toast('info', '給与規定の確認がリセットされました');
    }
  };
  const props = { s: cur, onSaved };

  return (
    <div style={PAGE_STYLE}>
      <ConfirmRules s={cur} resetNotice={resetNotice} onConfirmed={(x) => { setS(x); setResetNotice(false); }} />
      <nav aria-label="設定の項目" className="row" style={{ gap: 6 }}>
        {SECTIONS.map(([id, label]) => (
          <button key={id} className="btn btn-sm" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {label}
          </button>
        ))}
      </nav>
      <div style={{ display: 'grid', gap: 18, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 560px), 1fr))', alignItems: 'start' }}>
        <StoreSection {...props} />
        <HoursSection {...props} />
        <LaborSection {...props} />
        <PaySection {...props} />
        <MinWageSection {...props} />
        <LeaveSection {...props} />
        <HolidaySection {...props} />
        <CostSection {...props} />
        <SecuritySection {...props} />
        <PayslipSection {...props} />
        <RetentionSection {...props} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 給与規定の確認
function ConfirmRules({ s, resetNotice, onConfirmed }: { s: StoreSettings; resetNotice: boolean; onConfirmed: (s: StoreSettings) => void }) {
  const client = useClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checks: Array<[string, boolean]> = [
    ['労働時間制度', s.workingTimeSystem !== 'unset'],
    ['週の起算曜日', s.weekStartDay !== null],
    ['法定休日', s.statutoryHolidayWeekday !== null],
    ['締め日・支払日', s.payrollClosingDay !== null && s.payMonthOffset !== null && s.payDay !== null],
    ['最低賃金', s.minimumWages.length > 0],
    ['有給休暇の賃金算定方法', s.paidLeaveWageMethod !== 'unset'],
  ];
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.call<StoreSettings>('settings.confirmPayrollRules');
      onConfirmed(r);
      toast('ok', '給与規定を確認済みにしました');
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : '確認に失敗しました');
    } finally {
      setBusy(false);
    }
  };
  const confirmed = !!s.payrollRulesConfirmedAt;
  return (
    <Panel
      title={
        <div>
          <h2 className="row" style={{ gap: 8 }}>
            給与規定の確認
            {confirmed ? <span className="badge badge-board">確認済み</span> : <span className="badge badge-warn">未確認</span>}
          </h2>
          <p className="small muted" style={{ marginTop: 2 }}>
            {confirmed ? `${fmtDateTime(s.payrollRulesConfirmedAt)} に確認済み。給与計算に関わる設定を変更すると確認はリセットされます。` : '給与を確定する前に、下記の設定内容が就業規則・労使協定と一致していることを確認してください。'}
          </p>
        </div>
      }
      actions={
        <button className="btn btn-primary" onClick={confirm} disabled={busy}>
          {confirmed ? '再確認する' : '給与規定を確認する'}
        </button>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        {resetNotice && <div className="callout callout-warn">給与計算に関わる設定が変更されたため、<strong>給与規定の確認がリセットされました</strong>。内容を確認のうえ、もう一度「給与規定を確認する」を押してください。</div>}
        {error && <ErrorBox message={error} />}
        <div className="row" style={{ gap: 6 }}>
          {checks.map(([label, ok]) => (
            <span key={label} className={`badge ${ok ? 'badge-board' : 'badge-bull'}`}>
              {ok ? '✓' : '未設定'} {label}
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------ 各セクション
interface SecProps {
  s: StoreSettings;
  onSaved: OnSaved;
}

function StoreSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['storeName', 'storeAddress'] as const, onSaved);
  return (
    <Section id="st-store" title="店舗情報" desc="給与明細・出力ファイルに表示されます。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset}>
      <div className="form-grid">
        <Field label="店舗名" hint="60文字まで">
          <input className="input" value={x.draft.storeName} maxLength={60} onChange={(e) => x.set('storeName', e.target.value)} />
        </Field>
        <Field label="所在地" hint="任意・200文字まで">
          <input className="input" value={x.draft.storeAddress} maxLength={200} onChange={(e) => x.set('storeAddress', e.target.value)} />
        </Field>
      </div>
      <Hint>タイムゾーン: 日本時間（Asia/Tokyo）固定</Hint>
    </Section>
  );
}

function HoursSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['businessHours', 'businessDayCutoff'] as const, onSaved);
  const hours = [...x.draft.businessHours].sort((a, b) => a.weekday - b.weekday);
  const setDay = (w: number, patch: Partial<BusinessHours>) =>
    x.set(
      'businessHours',
      hours.map((h) => (h.weekday === w ? { ...h, ...patch, ...(patch.closed === false && h.closed ? { open: h.open === '00:00' ? '18:00' : h.open, close: h.close === '00:00' ? '26:00' : h.close } : {}) } : h)),
    );
  return (
    <Section
      id="st-hours"
      title="営業時間・営業日"
      desc="シフト表の表示範囲と、営業日（日付の区切り）の判定に使います。"
      dirty={x.changed.length > 0}
      busy={x.busy}
      onSave={x.save}
      onReset={x.reset}
      payroll={x.changed.includes('businessDayCutoff')}
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>曜日</th>
              <th>定休日</th>
              <th>開店</th>
              <th>閉店</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h) => (
              <tr key={h.weekday}>
                <td style={{ fontWeight: 600, color: h.weekday === 0 ? 'var(--bull)' : h.weekday === 6 ? 'var(--info)' : undefined }}>{WEEKDAYS[h.weekday]}</td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={h.closed} onChange={(e) => setDay(h.weekday, { closed: e.target.checked })} aria-label={`${WEEKDAYS[h.weekday]}曜日を定休日にする`} />
                  </label>
                </td>
                <td>
                  <input className="input num" style={{ width: 84 }} value={h.closed ? '' : h.open} disabled={h.closed} placeholder={h.closed ? '定休日' : '18:00'} maxLength={5} inputMode="numeric" aria-label={`${WEEKDAYS[h.weekday]}曜日の開店時刻`} onChange={(e) => setDay(h.weekday, { open: e.target.value })} />
                </td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    <input className="input num" style={{ width: 84 }} value={h.closed ? '' : h.close} disabled={h.closed} placeholder={h.closed ? '' : '26:00'} maxLength={5} inputMode="numeric" aria-label={`${WEEKDAYS[h.weekday]}曜日の閉店時刻`} onChange={(e) => setDay(h.weekday, { close: e.target.value })} />
                    {!h.closed && nextDayHint(h.close) && <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{nextDayHint(h.close)}</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Hint>時刻は HH:MM（24時間表記）。日付をまたぐ閉店時刻は 24:00 以降で入力します（例: 翌2時 → 26:00）。</Hint>
      <div className="form-grid">
        <Field label="営業日の切替時刻" hint="給与計算に影響">
          <input className="input num" type="time" value={x.draft.businessDayCutoff} onChange={(e) => x.set('businessDayCutoff', e.target.value)} />
        </Field>
      </div>
      <Hint>例: 05:00 の場合、当日 5:00〜翌 4:59 の打刻を同じ営業日として表示・集計し、曜日別・祝日の時給もこの営業日で判定します。法定の「1日」（暦日）の判定には使いません。</Hint>
    </Section>
  );
}

const WTS_LABEL: Record<StoreSettings['workingTimeSystem'], string> = {
  unset: `${UNSET}`,
  standard: '通常の労働時間制（1日8時間・週40時間）',
  monthly_variable: '1か月単位の変形労働時間制（未対応）',
  yearly_variable: '1年単位の変形労働時間制（未対応）',
  flextime: 'フレックスタイム制（未対応）',
};

function WeekdaySelect({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <select className="input" value={value === null ? '' : String(value)} onChange={(e) => onChange(intOrNull(e.target.value))} aria-label={label}>
      <option value="">{UNSET}</option>
      {WEEKDAYS.map((w, i) => (
        <option key={i} value={i}>{w}曜日</option>
      ))}
    </select>
  );
}

function LaborSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['workingTimeSystem', 'weekStartDay', 'statutoryHolidayWeekday', 'weekly44Confirmed', 'agreement36', 'overtime60StartDay'] as const, onSaved);
  const d = x.draft;
  const unsupported = d.workingTimeSystem !== 'standard' && d.workingTimeSystem !== 'unset';
  return (
    <Section id="st-labor" title="労働時間制度・週・休日" desc="就業規則・労使協定の内容に合わせて設定してください。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset} payroll>
      <Field label="労働時間制度">
        <select className="input" value={d.workingTimeSystem} onChange={(e) => x.set('workingTimeSystem', e.target.value as StoreSettings['workingTimeSystem'])}>
          {Object.entries(WTS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>
      {d.workingTimeSystem === 'unset' && <div className="callout callout-warn small">労働時間制度が未設定のため、給与を確定できません。</div>}
      {unsupported && (
        <div className="callout callout-bull small">
          Shiftly は通常の労働時間制のみに対応しています。変形労働時間制・フレックスタイム制を選択すると時間外労働を正しく計算できないため、<strong>正式な給与確定ができません</strong>。社会保険労務士等に確認のうえ、別の方法で計算してください。
        </div>
      )}
      <div className="form-grid">
        <Field label="週の起算曜日">
          <WeekdaySelect value={d.weekStartDay} onChange={(v) => x.set('weekStartDay', v)} label="週の起算曜日" />
        </Field>
        <Field label="法定休日">
          <WeekdaySelect value={d.statutoryHolidayWeekday} onChange={(v) => x.set('statutoryHolidayWeekday', v)} label="法定休日" />
        </Field>
      </div>
      <Hint>
        週の起算曜日は週40時間の判定に使います。就業規則に定めがない場合は日曜日です。法定休日（週1日）の労働は35%以上の割増になります。法定休日以外の休日（所定休日）の労働は、週40時間を超えた分が時間外労働になります。
      </Hint>
      <label className="check">
        <input type="checkbox" checked={d.weekly44Confirmed} onChange={(e) => x.set('weekly44Confirmed', e.target.checked)} />
        <span>
          週44時間の特例を適用する
          <span className="small muted" style={{ display: 'block' }}>
            常時使用する労働者が10人未満で、商業・接客娯楽業（飲食店等）・保健衛生業・映画演劇業のいずれかに該当する事業場のみ。要件を店長が確認した場合のみチェックしてください。
          </span>
        </span>
      </label>
      {d.weekly44Confirmed && (
        <div className="callout callout-warn small">
          スタッフの人数だけで自動的に適用することはありません。業種と「常時10人未満」の要件（パート・アルバイトを含む）を満たしていることを確認してください。要件を満たさなくなった場合はチェックを外してください。
        </div>
      )}
      <div className="form-grid">
        <Field label="36協定" hint="記録のみ">
          <select className="input" value={d.agreement36} onChange={(e) => x.set('agreement36', e.target.value as StoreSettings['agreement36'])}>
            <option value="unset">{UNSET}</option>
            <option value="concluded">締結・届出済み</option>
            <option value="not_concluded">締結していない</option>
          </select>
        </Field>
        <Field label="月60時間の起算日">
          <select className="input" value={d.overtime60StartDay === null ? '' : String(d.overtime60StartDay)} onChange={(e) => x.set('overtime60StartDay', intOrNull(e.target.value))}>
            <option value="">{UNSET}（給与計算期間の初日から）</option>
            {DAY_OPTIONS.map((n) => (
              <option key={n} value={n}>毎月{n}日</option>
            ))}
          </select>
        </Field>
      </div>
      {d.agreement36 === 'not_concluded' && <div className="callout callout-warn small">36協定を締結・届出していない場合、法定時間外労働・法定休日労働をさせることはできません。</div>}
      <Hint>36協定の状況は記録のみで、割増賃金は実際の労働時間に基づいて計算します。月60時間を超える時間外労働は50%以上の割増になります（起算日は賃金規程の定めに合わせます）。</Hint>
    </Section>
  );
}

function PaySection({ s, onSaved }: SecProps) {
  const g = ['payrollClosingDay', 'payMonthOffset', 'payDay'] as const;
  const x = useSection(s, [...g, 'yenRounding'] as const, onSaved, [g]);
  const d = x.draft;
  const daySelect = (k: 'payrollClosingDay' | 'payDay', label: string) => (
    <select className="input" value={d[k] === null ? '' : String(d[k])} onChange={(e) => x.set(k, intOrNull(e.target.value))} aria-label={label}>
      <option value="">{UNSET}</option>
      {DAY_OPTIONS.map((n) => (
        <option key={n} value={n}>{n}日</option>
      ))}
      <option value="0">末日</option>
    </select>
  );
  const summary = d.payrollClosingDay !== null && d.payMonthOffset !== null && d.payDay !== null ? `毎月${dayLabel(d.payrollClosingDay)}締め、${d.payMonthOffset === 1 ? '翌月' : '当月'}${dayLabel(d.payDay)}払い` : null;
  return (
    <Section id="st-pay" title="締め日・支払日・端数処理" desc="給与計算期間と支払日を決めます。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset} payroll>
      <div className="form-grid">
        <Field label="締め日">{daySelect('payrollClosingDay', '締め日')}</Field>
        <Field label="支払月">
          <select className="input" value={d.payMonthOffset === null ? '' : String(d.payMonthOffset)} onChange={(e) => x.set('payMonthOffset', intOrNull(e.target.value))}>
            <option value="">{UNSET}</option>
            <option value="0">当月</option>
            <option value="1">翌月</option>
          </select>
        </Field>
        <Field label="支払日">{daySelect('payDay', '支払日')}</Field>
      </div>
      <div className={`callout small ${summary ? '' : 'callout-warn'}`}>{summary ?? '締め日・支払月・支払日のいずれかが未設定のため、給与計算期間を作成できません。'}</div>
      <Hint>支払日が休日の場合の前倒し・後ろ倒しは自動では行いません。給与計算期間を作成した後に変更しても、作成済みの期間には反映されません。</Hint>
      <Field label="円未満の端数処理" hint="1時間あたり賃金・割増賃金">
        <select className="input" value={d.yenRounding} onChange={(e) => x.set('yenRounding', e.target.value as StoreSettings['yenRounding'])}>
          <option value="half_up">50銭未満切り捨て・50銭以上切り上げ</option>
          <option value="ceil">1円未満切り上げ</option>
        </select>
      </Field>
      <Hint>項目ごとの期間合計で1回だけ円未満を処理します（労働時間の30分単位などの切り捨ては行いません）。欠勤・遅刻早退の控除は労働者に不利にならないよう円未満を切り捨てます。</Hint>
    </Section>
  );
}

function MinWageSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['minimumWages'] as const, onSaved);
  const rows = x.draft.minimumWages;
  const setRow = (i: number, patch: Partial<MinimumWageEntry>) => x.set('minimumWages', rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => x.set('minimumWages', [...rows, { effectiveFrom: '', hourly: 0, label: '', sourceNote: '' }]);
  const remove = (i: number) => x.set('minimumWages', rows.filter((_, j) => j !== i));
  const sortedSaved = [...s.minimumWages].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return (
    <Section
      id="st-minwage"
      title="最低賃金"
      desc="時給・月給の換算額が最低賃金を下回らないかの確認に使います。改定のたびに行を追加してください（古い行は過去の給与の確認に使うため削除しないでください）。"
      dirty={x.changed.length > 0}
      busy={x.busy}
      onSave={x.save}
      onReset={x.reset}
      payroll
    >
      {rows.length === 0 && <div className="callout callout-warn small">最低賃金が{UNSET}のため、給与を確定できません。</div>}
      {rows.map((r, i) => (
        <div key={i} style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--radius-s)', padding: 12 }}>
          <div className="form-grid">
            <Field label="適用開始日">
              <input className="input" type="date" value={r.effectiveFrom} onChange={(e) => setRow(i, { effectiveFrom: e.target.value })} />
            </Field>
            <Field label="時間額（円）">
              <input className="input num" type="number" min={1} max={10000} step={1} value={r.hourly || ''} onChange={(e) => setRow(i, { hourly: intOrNull(e.target.value) ?? 0 })} />
            </Field>
            <Field label="名称" hint="例: 〇〇県 地域別最低賃金">
              <input className="input" value={r.label} maxLength={60} onChange={(e) => setRow(i, { label: e.target.value })} />
            </Field>
          </div>
          <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 260px' }}>
              <Field label="根拠メモ" hint="確認した公式資料（厚生労働省・労働局のページ名、確認日など）">
                <input className="input" value={r.sourceNote} maxLength={300} onChange={(e) => setRow(i, { sourceNote: e.target.value })} />
              </Field>
            </div>
            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--bull)' }} onClick={() => remove(i)}>
              この行を削除
            </button>
          </div>
        </div>
      ))}
      <div>
        <button className="btn btn-sm" onClick={add} disabled={rows.length >= 50}>
          ＋ 最低賃金を追加
        </button>
      </div>
      {sortedSaved[0] && (
        <Hint>
          保存済みの最新: {sortedSaved[0].effectiveFrom} から {sortedSaved[0].hourly.toLocaleString('ja-JP')} 円（{sortedSaved[0].label}）
        </Hint>
      )}
      <Hint>金額は自動取得しません。必ず厚生労働省「地域別最低賃金の全国一覧」等の公式資料で確認して入力してください。特定（産業別）最低賃金が適用される場合は高い方を入力します。</Hint>
    </Section>
  );
}

function LeaveSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['paidLeaveWageMethod', 'halfDayLeaveAllowed'] as const, onSaved);
  const d = x.draft;
  return (
    <Section id="st-leave" title="有給休暇" desc="就業規則で定めた方法を選んでください。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset} payroll>
      <Field label="有給休暇の賃金の算定方法">
        <select className="input" value={d.paidLeaveWageMethod} onChange={(e) => x.set('paidLeaveWageMethod', e.target.value as StoreSettings['paidLeaveWageMethod'])}>
          <option value="unset">{UNSET}</option>
          <option value="normal">通常の賃金（所定労働時間労働した場合に支払われる賃金）</option>
          <option value="average">平均賃金（直前3か月の確定給与から算出）</option>
          <option value="standard_remuneration">健康保険の標準報酬日額（未対応）</option>
        </select>
      </Field>
      {d.paidLeaveWageMethod === 'unset' && <div className="callout callout-warn small">算定方法が{UNSET}のため、有給休暇の取得がある期間の給与を確定できません。</div>}
      {d.paidLeaveWageMethod === 'standard_remuneration' && <div className="callout callout-bull small">標準報酬日額による算定（労使協定が必要）には対応していないため、有給休暇の取得がある期間の給与を確定できません。</div>}
      <label className="check">
        <input type="checkbox" checked={d.halfDayLeaveAllowed} onChange={(e) => x.set('halfDayLeaveAllowed', e.target.checked)} />
        <span>
          半日単位の取得を認める
          <span className="small muted" style={{ display: 'block' }}>就業規則で半日単位の取得を定めている場合のみ。時間単位の年休（労使協定が必要）には対応していません。</span>
        </span>
      </label>
    </Section>
  );
}

function HolidaySection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['publicHolidays'] as const, onSaved);
  const [input, setInput] = useState('');
  const [bulk, setBulk] = useState('');
  const list = [...x.draft.publicHolidays].sort();
  const addDates = (ds: string[]) => {
    const valid = ds.map((v) => v.trim()).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));
    x.set('publicHolidays', [...new Set([...list, ...valid])].sort());
  };
  const years = [...new Set(list.map((d) => d.slice(0, 4)))];
  return (
    <Section id="st-holidays" title="祝日" desc="店舗の時給ルール（祝日の時給）に使います。法定休日・割増賃金とは関係ありません。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset} payroll>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <div style={{ width: 180 }}>
          <Field label="日付を追加">
            <input className="input" type="date" value={input} onChange={(e) => setInput(e.target.value)} />
          </Field>
        </div>
        <button className="btn btn-sm" onClick={() => { addDates([input]); setInput(''); }} disabled={!input}>
          追加
        </button>
      </div>
      <details>
        <summary className="small" style={{ cursor: 'pointer' }}>まとめて追加（1行に1日付、YYYY-MM-DD）</summary>
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <textarea className="input num" rows={4} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'2027-01-01\n2027-01-11'} />
          <div>
            <button className="btn btn-sm" onClick={() => { addDates(bulk.split(/[\s,、]+/)); setBulk(''); }} disabled={!bulk.trim()}>
              まとめて追加
            </button>
          </div>
        </div>
      </details>
      {list.length === 0 ? (
        <p className="small muted">登録された祝日はありません（祝日の時給を使わない場合は登録不要です）。</p>
      ) : (
        years.map((y) => (
          <div key={y}>
            <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{y}年（{list.filter((d) => d.startsWith(y)).length}日）</div>
            <div className="row" style={{ gap: 6 }}>
              {list
                .filter((d) => d.startsWith(y))
                .map((d) => (
                  <span key={d} className="badge" style={{ paddingRight: 2 }}>
                    <span className="num">{d.slice(5)}（{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}）</span>
                    <button className="btn btn-ghost" style={{ minHeight: 20, padding: '0 6px', fontSize: '0.8rem' }} aria-label={`${d} を削除`} onClick={() => x.set('publicHolidays', list.filter((v) => v !== d))}>
                      ×
                    </button>
                  </span>
                ))}
            </div>
          </div>
        ))
      )}
      <Hint>祝日は自動では取得しません。内閣府「国民の祝日について」等で確認して入力してください。</Hint>
    </Section>
  );
}

function CostSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['employerCostRatePercent'] as const, onSaved);
  const v = x.draft.employerCostRatePercent;
  return (
    <Section id="st-cost" title="人件費分析" desc="「人件費・予算」ページの概算にのみ使います。給与計算・明細には使いません。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset}>
      <div className="form-grid">
        <Field label="会社負担率（%）" hint="0〜50・空欄で未設定">
          <input
            className="input num"
            type="number"
            min={0}
            max={50}
            step={0.1}
            value={v === null ? '' : v}
            placeholder={UNSET}
            onChange={(e) => x.set('employerCostRatePercent', e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      </div>
      <Hint>社会保険料・労働保険料などの会社負担分を総支給額に対する割合で概算する仮定値です。実際の保険料計算ではありません。{v === null && '未設定の場合、会社負担分は人件費に含めません。'}</Hint>
    </Section>
  );
}

function SecuritySection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['idleTimeoutSec', 'pinMaxAttempts', 'pinLockMinutes'] as const, onSaved);
  const d = x.draft;
  const num = (k: 'idleTimeoutSec' | 'pinMaxAttempts' | 'pinLockMinutes', min: number, max: number) => (
    <input className="input num" type="number" min={min} max={max} step={1} value={Number.isFinite(d[k]) ? d[k] : ''} onChange={(e) => x.set(k, e.target.value === '' ? NaN : Math.trunc(Number(e.target.value)))} />
  );
  return (
    <Section id="st-security" title="店舗端末のセキュリティ" desc="共用 iPad でのスタッフのログインに関する設定です。" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset}>
      <div className="form-grid">
        <Field label="無操作タイムアウト（秒）" hint="20〜600">{num('idleTimeoutSec', 20, 600)}</Field>
        <Field label="PIN の失敗許容回数" hint="3〜10回">{num('pinMaxAttempts', 3, 10)}</Field>
        <Field label="ロック時間（分）" hint="5〜1440分">{num('pinLockMinutes', 5, 1440)}</Field>
      </div>
      <Hint>給与・勤怠などの個人情報を表示したまま操作がない場合、設定した秒数で自動的にログアウトします。PIN を続けて間違えると、そのスタッフはロック時間が経過するまで（または店長が解除するまで）ログインできません。</Hint>
    </Section>
  );
}

function PayslipSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['payslipDelivery'] as const, onSaved);
  return (
    <Section id="st-payslip" title="給与明細の交付方法" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset}>
      <Field label="交付方法">
        <select className="input" value={x.draft.payslipDelivery} onChange={(e) => x.set('payslipDelivery', e.target.value as StoreSettings['payslipDelivery'])}>
          <option value="paper">書面（印刷して手渡し）</option>
          <option value="electronic_with_consent">電子交付（本人の承諾を得たスタッフ）</option>
        </select>
      </Field>
      {x.draft.payslipDelivery === 'electronic_with_consent' ? (
        <div className="callout small">給与明細を電子で交付するには、スタッフ本人の承諾が必要です。承諾していないスタッフには書面で交付してください。</div>
      ) : (
        <Hint>給与明細は支払のたびに交付が必要です（所得税法）。</Hint>
      )}
    </Section>
  );
}

function RetentionSection({ s, onSaved }: SecProps) {
  const x = useSection(s, ['retentionYears', 'dailyBackupGenerations', 'monthlyBackupGenerations'] as const, onSaved);
  const d = x.draft;
  const num = (k: 'retentionYears' | 'dailyBackupGenerations' | 'monthlyBackupGenerations', min: number, max: number) => (
    <input className="input num" type="number" min={min} max={max} step={1} value={Number.isFinite(d[k]) ? d[k] : ''} onChange={(e) => x.set(k, e.target.value === '' ? NaN : Math.trunc(Number(e.target.value)))} />
  );
  return (
    <Section id="st-retention" title="保存期間・バックアップ" dirty={x.changed.length > 0} busy={x.busy} onSave={x.save} onReset={x.reset}>
      <div className="form-grid">
        <Field label="記録の保存期間（年）" hint="5〜20年・初期値5年">{num('retentionYears', 5, 20)}</Field>
        <Field label="日次バックアップの世代数" hint="7〜120・初期値30">{num('dailyBackupGenerations', 7, 120)}</Field>
        <Field label="月次バックアップの世代数" hint="12〜120・初期値12">{num('monthlyBackupGenerations', 12, 120)}</Field>
      </div>
      {Number.isFinite(d.retentionYears) && d.retentionYears < 5 && <div className="callout callout-bull small">労働基準法により、賃金台帳・出勤簿等は5年間保存する必要があるため、5年未満には設定できません。</div>}
      <Hint>賃金台帳・出勤簿（タイムカード等）などの記録は、労働基準法により5年間（経過措置により当分の間は3年間）の保存が必要です。Shiftly では5年未満には設定できません。バックアップの世代数を超えた古いバックアップは自動で削除されます（記録そのものはデータベースに保持されます）。</Hint>
    </Section>
  );
}
