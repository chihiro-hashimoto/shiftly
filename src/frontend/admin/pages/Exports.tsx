/** データ出力（F24: 勤怠・給与・シフトの CSV / Excel、賃金台帳） */
import { useState } from 'react';
import { ErrorBox, Field, Loading, Panel, downloadBase64, shiftDate, todayJst, useAction, useClient, useLoad, useToast } from '../../components/ui';
import type { PayrollPeriod } from '../../../shared/types';
import { STATUS } from './Dashboard';

/** ページのルート（表の最小幅で管理画面のグリッド列が広がり、スマホ幅で横スクロールが出るのを防ぐ） */
const PAGE_ROOT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

type Format = 'csv' | 'xlsx';
interface ExportResult {
  savedToDrive: boolean;
  fileName: string;
  mimeType?: string;
  base64?: string;
}
interface HistoryRow {
  at: string;
  fileName: string;
  downloaded: boolean;
}

const MAX_DAYS = 62;
const LOCAL_CSS = `
.ex-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:18px;align-items:start}
.ex-range{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ex-desc{margin:0 0 12px;color:var(--ink-2);font-size:.88rem}
.ex-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
`;

function monthStart(d: string) {
  return `${d.slice(0, 7)}-01`;
}
function prevMonthRange(d: string): { from: string; to: string } {
  const first = monthStart(d);
  const lastPrev = shiftDate(first, -1);
  return { from: monthStart(lastPrev), to: lastPrev };
}
function rangeError(from: string, to: string): string | null {
  if (!from || !to) return '期間を指定してください';
  if (from > to) return '開始日が終了日より後になっています';
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
  if (days > MAX_DAYS) return `一度に出力できるのは${MAX_DAYS}日までです`;
  return null;
}

export function ExportsPage() {
  const client = useClient();
  const isSharedDevice = client.transport.mode === 'staff';
  const toast = useToast();
  const { busy, run } = useAction();
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [running, setRunning] = useState<string | null>(null);

  const exec = async (id: string, op: string, args: Record<string, unknown>) => {
    setRunning(id);
    const r = await run(() => client.call<ExportResult>(op, args));
    setRunning(null);
    if (!r) return;
    let downloaded = false;
    if (r.base64 && r.mimeType) {
      downloadBase64(r.base64, r.fileName, r.mimeType);
      downloaded = true;
      toast('ok', `${r.fileName} をダウンロードしました（管理者の Google Drive の 03_Exports にも保存しました）`);
    } else if (r.savedToDrive) {
      toast('ok', `管理者の Google Drive の 03_Exports に保存しました（${r.fileName}）`);
    }
    setHistory((h) => [{ at: new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }), fileName: r.fileName, downloaded }, ...h].slice(0, 10));
  };

  const today = todayJst();

  return (
    <div style={PAGE_ROOT}>
      <style>{LOCAL_CSS}</style>
      <div className="callout">
        {isSharedDevice ? (
          <>
            この端末（店舗の共用端末）にはファイルをダウンロードしません。出力したファイルは<strong>Google 所有者の Google Drive の「03_Exports」フォルダ</strong>に保存されます。Drive のファイルは管理者の PC で開いてください。共用端末で画面を印刷・保存しないでください（アプリは端末に保存されたファイルを削除できません）。
          </>
        ) : (
          <>
            出力したファイルはこの端末にダウンロードされ、同じものが<strong>Google Drive の「03_Exports」フォルダ</strong>にも保存されます。出力は監査ログに記録されます。
          </>
        )}
      </div>
      <div className="ex-grid">
        <RangeCard
          id="attendance"
          title="勤怠"
          desc="スタッフごとの出勤・退勤・休憩・実働時間と、打刻漏れなどの注意事項。修正後の勤怠で出力します。"
          initial={{ from: monthStart(today), to: today }}
          busy={busy}
          running={running}
          onRun={(f, range) => exec('attendance', 'export.attendance', { ...range, format: f })}
        />
        <PayrollCard busy={busy} running={running} onRun={(f, periodId) => exec('payroll', 'export.payroll', { periodId, format: f })} />
        <RangeCard
          id="shifts"
          title="シフト"
          desc="期間内のシフト（公開・下書き）。取消したシフトは含みません。"
          initial={{ from: today, to: shiftDate(today, 13) }}
          busy={busy}
          running={running}
          onRun={(f, range) => exec('shifts', 'export.shifts', { ...range, format: f })}
        />
        <LedgerCard busy={busy} running={running} onRun={(f, year) => exec('ledger', 'export.wageLedger', { year, format: f })} />
      </div>
      <Panel title="この画面で出力したファイル">
        {history.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>まだ出力していません。（履歴はこの画面を開いている間だけ表示します。過去の出力は監査ログで確認できます）</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {history.map((h, i) => (
              <li key={`${h.at}-${i}`} className="small">
                <span className="num">{h.at}</span>　{h.fileName}　<span className="muted">{h.downloaded ? 'ダウンロード済み・Drive 保存済み' : 'Drive 保存済み'}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          CSV は UTF-8（BOM 付き）で、Excel でそのまま開けます。数式として実行されるのを防ぐため、「=」「+」「-」「@」で始まる文字列には先頭に「'」を付けています。
        </p>
      </Panel>
    </div>
  );
}

function FormatButtons({ id, busy, running, disabled, onRun, xlsxLabel = 'Excel で出力' }: { id: string; busy: boolean; running: string | null; disabled?: boolean; onRun: (f: Format) => void; xlsxLabel?: string }) {
  const isRunning = running === id;
  return (
    <div className="ex-actions">
      <button className="btn btn-primary" disabled={busy || disabled} onClick={() => onRun('xlsx')}>
        {isRunning ? '出力中…' : xlsxLabel}
      </button>
      <button className="btn" disabled={busy || disabled} onClick={() => onRun('csv')}>
        CSV で出力
      </button>
    </div>
  );
}

function RangeCard({
  id,
  title,
  desc,
  initial,
  busy,
  running,
  onRun,
}: {
  id: string;
  title: string;
  desc: string;
  initial: { from: string; to: string };
  busy: boolean;
  running: string | null;
  onRun: (f: Format, range: { from: string; to: string }) => void;
}) {
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const err = rangeError(from, to);
  const today = todayJst();
  const presets: Array<[string, { from: string; to: string }]> = [
    ['今月', { from: monthStart(today), to: shiftDate(monthStart(shiftDate(monthStart(today), 32)), -1) }],
    ['前月', prevMonthRange(today)],
  ];
  return (
    <Panel
      title={title}
      actions={presets.map(([label, r]) => (
        <button key={label} className={`btn btn-sm ${from === r.from && to === r.to ? 'btn-primary' : ''}`} onClick={() => { setFrom(r.from); setTo(r.to); }}>
          {label}
        </button>
      ))}
    >
      <p className="ex-desc">{desc}</p>
      <div className="ex-range">
        <Field label="開始日">
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="終了日">
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>
      {err ? <p className="small" style={{ color: 'var(--bull)', margin: '6px 0 0' }}>{err}</p> : <p className="small muted" style={{ margin: '6px 0 0' }}>最長{MAX_DAYS}日まで</p>}
      <FormatButtons id={id} busy={busy} running={running} disabled={!!err} onRun={(f) => onRun(f, { from, to })} />
    </Panel>
  );
}

function PayrollCard({ busy, running, onRun }: { busy: boolean; running: string | null; onRun: (f: Format, periodId: string) => void }) {
  const client = useClient();
  const periods = useLoad(() => client.call<{ periods: PayrollPeriod[] }>('payroll.periods'), []);
  const [sel, setSel] = useState<string | null>(null);
  const list = periods.data?.periods ?? [];
  const p = list.find((x) => x.id === sel) ?? list.find((x) => x.status === 'confirmed' || x.status === 'issued') ?? list[0] ?? null;
  const confirmed = p && (p.status === 'confirmed' || p.status === 'issued');
  return (
    <Panel title="給与">
      <p className="ex-desc">スタッフ別の勤務時間・支給項目・控除・差引支給額。<strong>確定済みの給与のみ</strong>出力します（仮計算の値は含みません）。</p>
      {periods.loading && !periods.data && <Loading />}
      {periods.error && <ErrorBox message={periods.error} onRetry={periods.reload} />}
      {periods.data && list.length === 0 && <p className="small muted">給与計算期間がありません。給与計算ページで期間を作成・確定してください。</p>}
      {p && (
        <>
          <Field label="対象月">
            <select className="input" value={p.id} onChange={(e) => setSel(e.target.value)}>
              {list.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.periodKey}（{STATUS[x.status] ?? x.status}・支払日 {x.payDate}）
                </option>
              ))}
            </select>
          </Field>
          {!confirmed && <p className="small" style={{ color: 'var(--warn)', margin: '6px 0 0' }}>この期間はまだ全員の給与が確定していません。確定済みのスタッフ分だけが出力されます。</p>}
          <FormatButtons id="payroll" busy={busy} running={running} onRun={(f) => onRun(f, p.id)} />
        </>
      )}
    </Panel>
  );
}

function LedgerCard({ busy, running, onRun }: { busy: boolean; running: string | null; onRun: (f: Format, year: number) => void }) {
  const thisYear = Number(todayJst().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i).filter((y) => y >= 2020);
  return (
    <Panel title="賃金台帳">
      <p className="ex-desc">
        1年分の確定済み給与から、法定の記載事項（氏名・賃金計算期間・労働日数・労働時間数・時間外等の時間数・賃金の内訳・控除）を出力します。Excel は<strong>スタッフ別のシート</strong>、CSV は全員を1つの表にまとめます。
      </p>
      <Field label="対象年">
        <select className="input" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}年（{y}-01〜{y}-12 支給分）
            </option>
          ))}
        </select>
      </Field>
      <p className="small" style={{ color: 'var(--warn)', margin: '6px 0 0' }}>性別は本システムで保持していないため、出力後に「性別（別途記入）」列へ記入してください。</p>
      <FormatButtons id="ledger" busy={busy} running={running} onRun={(f) => onRun(f, year)} xlsxLabel="Excel で出力（スタッフ別シート）" />
    </Panel>
  );
}
