/** 給与明細（F19: 発行・一覧・表示・印刷・PDF） */
import { useState } from 'react';
import { PayslipView } from '../../components/payslip';
import { Empty, ErrorBox, Loading, Panel, downloadBase64, useAction, useClient, useLoad, useToast } from '../../components/ui';
import type { PayrollPeriod } from '../../../shared/types';
import type { PayslipData } from '../../../shared/payslip';
import { STATUS } from './Dashboard';

/** ページのルート（表の最小幅で管理画面のグリッド列が広がり、スマホ幅で横スクロールが出るのを防ぐ） */
const PAGE_ROOT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

interface SlipRow {
  id: string;
  periodId: string;
  employeeId: string;
  displayName: string;
  payrollResultId: string;
  revision: number;
  driveFileId: string | null;
  issuedAt: string;
  status: 'issued' | 'superseded';
}
type SlipView = PayslipData & { status: 'issued' | 'superseded' };

const fmtDT = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** 印刷時は明細（.ps-print-area）以外を隠す。管理画面のサイドバー等にも効くよう visibility で制御 */
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .ps-print-area, .ps-print-area * { visibility: visible !important; }
  .ps-print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 0 8mm; border: 0 !important; }
  .toasts { display: none !important; }
}
.ps-print-area { border: 1px solid var(--line); border-radius: var(--radius-m); padding: 18px 20px; background: #fff; }
.ps-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 18px; align-items: start; }
.ps-list td, .ps-list th { white-space: nowrap; }
@media (max-width: 1100px) { .ps-layout { grid-template-columns: minmax(0, 1fr); } }
table.data tr.ps-sel td { background: var(--board-soft); }
`;

export function PayslipsPage() {
  const client = useClient();
  const isKiosk = client.transport.mode === 'kiosk';
  const toast = useToast();
  const periods = useLoad(() => client.call<{ periods: PayrollPeriod[] }>('payroll.periods'), []);
  const [selected, setSelected] = useState<string | null>(null);
  const list = periods.data?.periods ?? [];
  const period = list.find((p) => p.id === selected) ?? list.find((p) => p.status === 'confirmed' || p.status === 'issued') ?? list[0] ?? null;
  const slips = useLoad(() => (period ? client.call<SlipRow[]>('payslips.list', { periodId: period.id }) : Promise.resolve([] as SlipRow[])), [period?.id]);
  const [viewId, setViewId] = useState<string | null>(null);
  const view = useLoad(() => (viewId ? client.call<SlipView>('payslips.view', { payslipId: viewId }) : Promise.resolve(null)), [viewId]);
  const { busy, run } = useAction();
  const pdf = useAction();
  const settings = useLoad(() => (isKiosk ? Promise.resolve(null) : client.call<{ payslipDelivery: 'paper' | 'electronic_with_consent' }>('settings.get')), [isKiosk]);

  const issue = async () => {
    if (!period) return;
    const r = await run(() => client.call<{ issued: number; pdfUnavailable: number }>('payslips.issue', { periodId: period.id }));
    if (!r) return;
    if (r.issued === 0) toast('info', '新たに発行できる明細はありません（給与計算ページで確定した給与のみ発行できます）');
    else toast('ok', `${r.issued}件の明細を発行しました${r.pdfUnavailable ? `（PDF の保存は ${r.pdfUnavailable}件できませんでした。PDF 変換は Google 環境でのみ利用できます）` : '（PDF を Google Drive に保存しました）'}`);
    slips.reload();
    periods.reload();
  };
  const downloadPdf = async () => {
    if (!viewId) return;
    const r = await pdf.run(() => client.call<{ fileName: string; pdfBase64: string | null }>('payslips.pdf', { payslipId: viewId }));
    if (!r) return;
    if (r.pdfBase64) {
      downloadBase64(r.pdfBase64, r.fileName, 'application/pdf');
      toast('ok', 'PDF をダウンロードしました');
    } else toast('info', 'PDF 変換は Google 環境でのみ利用できます。この環境では「印刷」からブラウザの PDF 保存を使ってください');
  };

  const rows = (slips.data ?? []).slice().sort((a, b) => (a.status === b.status ? a.displayName.localeCompare(b.displayName, 'ja') || b.revision - a.revision : a.status === 'issued' ? -1 : 1));
  const canIssue = period && (period.status === 'confirmed' || period.status === 'issued' || period.status === 'review' || period.status === 'draft');

  return (
    <div style={PAGE_ROOT}>
      <style>{PRINT_CSS}</style>
      <div className="callout no-print">
        <strong>明細の渡し方</strong>
        <div className="small">
          画面・PDF による電子交付には、<strong>スタッフ本人の事前の承諾</strong>が必要です。承諾がないスタッフには、明細を印刷して紙で渡してください。
          {settings.data && <>（店舗設定の交付方法: {settings.data.payslipDelivery === 'paper' ? '紙で交付' : '承諾者には電子交付'}）</>}
        </div>
      </div>
      <Panel
        title="明細の発行"
        actions={
          period && (
            <button className="btn btn-sm btn-primary" disabled={busy || !canIssue} onClick={issue}>
              確定済みの給与から明細を発行
            </button>
          )
        }
      >
        {periods.loading && !periods.data && <Loading />}
        {periods.error && <ErrorBox message={periods.error} onRetry={periods.reload} />}
        {periods.data && list.length === 0 && <Empty>給与計算期間がありません。給与計算ページで期間を作成し、給与を確定してください。</Empty>}
        {period && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <label className="row">
              <span className="small muted">対象月</span>
              <select
                className="input"
                value={period.id}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setViewId(null);
                }}
                style={{ width: 'auto', minWidth: 220 }}
              >
                {list.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.periodKey}（{STATUS[p.status] ?? p.status}）
                  </option>
                ))}
              </select>
            </label>
            <span className="small muted">
              支払日 <span className="num">{period.payDate}</span>　確定済みでまだ明細のない給与だけを発行します。訂正した場合は新しい版を発行してください。
            </span>
          </div>
        )}
      </Panel>
      {period && (
        <div className="ps-layout">
          <Panel title={`${period.periodKey} の明細`} pad={false}>
            {slips.loading && !slips.data && <Loading />}
            {slips.error && <ErrorBox message={slips.error} onRetry={slips.reload} />}
            {slips.data && rows.length === 0 && <Empty>この期間に発行済みの明細はありません。給与を確定してから「明細を発行」を押してください。</Empty>}
            {rows.length > 0 && (
              <div className="table-wrap">
                <table className="data ps-list">
                  <thead>
                    <tr>
                      <th>スタッフ</th>
                      <th>版</th>
                      <th>発行日時</th>
                      <th>PDF</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr key={s.id} className={s.id === viewId ? 'ps-sel' : ''} style={s.status === 'superseded' ? { color: 'var(--ink-3)' } : undefined}>
                        <td>{s.displayName}</td>
                        <td>
                          <span className="num">第{s.revision}版</span> {s.status === 'superseded' ? <span className="badge">旧版</span> : <span className="badge badge-board">有効</span>}
                        </td>
                        <td className="num small">{fmtDT(s.issuedAt).slice(5)}</td>
                        <td className="small">{s.driveFileId ? 'Drive 保存済み' : <span className="muted">未作成</span>}</td>
                        <td className="r">
                          <button className="btn btn-sm" onClick={() => setViewId(s.id)}>
                            表示
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel
            title="明細の表示"
            actions={
              view.data && (
                <span className="no-print row">
                  {!isKiosk && (
                    <>
                      <button className="btn btn-sm" onClick={() => window.print()}>
                        印刷
                      </button>
                      <button className="btn btn-sm" disabled={pdf.busy} onClick={downloadPdf}>
                        PDF をダウンロード
                      </button>
                    </>
                  )}
                  <button className="btn btn-sm btn-ghost" onClick={() => setViewId(null)}>
                    閉じる
                  </button>
                </span>
              )
            }
          >
            {!viewId && <Empty>一覧の「表示」を押すと明細を表示します</Empty>}
            {viewId && view.loading && <Loading />}
            {viewId && view.error && <ErrorBox message={view.error} onRetry={view.reload} />}
            {viewId && view.data && !view.loading && (
              <div className="stack" style={{ gap: 10 }}>
                {view.data.status === 'superseded' && <div className="callout callout-warn small no-print">この明細は訂正により旧版になっています。最新の版を渡してください。</div>}
                <div className="ps-print-area">
                  <PayslipView d={view.data} />
                  <p className="small muted" style={{ margin: '12px 0 0' }}>
                    {view.data.storeName}
                    {view.data.storeAddress && `　${view.data.storeAddress}`}
                    {view.data.confirmedAt && `　確定日 ${view.data.confirmedAt.slice(0, 10)}`}
                  </p>
                </div>
                {isKiosk && <p className="small muted no-print" style={{ margin: 0 }}>印刷・PDF のダウンロードは店長の管理画面からのみ行えます（共用端末にはファイルを保存しません）。</p>}
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
