/** 給与明細の画面表示（HTML 文字列を挿入せず、構造化データから描画する） */
import type { PayslipData } from '../../shared/payslip';
import { Yen } from './ui';

export function PayslipView({ d }: { d: PayslipData }) {
  return (
    <article className="payslip">
      <header className="row" style={{ alignItems: 'baseline' }}>
        <h2>給与明細　{d.periodLabel}</h2>
        {d.revision > 1 && <span className="badge badge-warn">訂正第{d.revision - 1}版</span>}
      </header>
      <p className="muted small" style={{ marginTop: 4 }}>
        {d.storeName}　／　{d.employeeName}　／　対象 {d.from}〜{d.to}　／　支払日 {d.payDate}
      </p>
      <div className="payslip-grid">
        <section>
          <h3>勤怠</h3>
          <dl>
            {d.attendance.map((x) => (
              <div key={x.label}>
                <dt>{x.label}</dt>
                <dd className="num">{x.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3>支給</h3>
          <dl>
            {d.earnings.map((x) => (
              <div key={x.label}>
                <dt>{x.label}</dt>
                <dd>
                  <Yen v={x.amount ?? 0} />
                </dd>
              </div>
            ))}
            <div className="sum">
              <dt>総支給額</dt>
              <dd>
                <Yen v={d.gross} />
              </dd>
            </div>
          </dl>
        </section>
        <section>
          <h3>控除</h3>
          <dl>
            {d.deductions.length === 0 && (
              <div>
                <dt className="muted">控除なし</dt>
                <dd />
              </div>
            )}
            {d.deductions.map((x) => (
              <div key={x.label}>
                <dt>{x.label}</dt>
                <dd>
                  <Yen v={x.amount ?? 0} />
                </dd>
              </div>
            ))}
            <div className="sum">
              <dt>控除合計</dt>
              <dd>
                <Yen v={d.deductionTotal} />
              </dd>
            </div>
          </dl>
          <div className="payslip-net">
            <span>差引支給額</span>
            <Yen v={d.net} />
          </div>
        </section>
      </div>
    </article>
  );
}
