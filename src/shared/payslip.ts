/**
 * 給与明細のデータ構造（画面表示・PDF・印刷で共通）
 * 確定済みの給与結果からのみ作成する。
 */
import type { PayrollTotals } from './types';
import { formatMinutes } from './time';

export interface PayslipLine {
  label: string;
  value: string;
  amount?: number;
}

export interface PayslipData {
  storeName: string;
  storeAddress: string;
  employeeName: string;
  employeeCode: string;
  periodLabel: string;
  from: string;
  to: string;
  payDate: string;
  revision: number;
  confirmedAt: string | null;
  attendance: PayslipLine[];
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  gross: number;
  deductionTotal: number;
  net: number;
}

export function buildPayslip(args: {
  storeName: string;
  storeAddress: string;
  employeeName: string;
  employeeCode: string;
  periodKey: string;
  from: string;
  to: string;
  payDate: string;
  revision: number;
  confirmedAt: string | null;
  totals: PayrollTotals;
}): PayslipData {
  const t = args.totals;
  const earnings: PayslipLine[] = [];
  const push = (label: string, amount: number) => {
    if (amount !== 0) earnings.push({ label, value: yen(amount), amount });
  };
  push('基本給・基本賃金', t.basePay);
  push('所定時間外賃金', t.extraHoursBasePay);
  push('時間外割増', t.overtimePremium);
  push('時間外割増（月60時間超）', t.over60Premium);
  push('休日割増', t.holidayPremium);
  push('深夜割増', t.nightPremium);
  push('固定残業代', t.fixedOvertimePay);
  push('固定残業代超過分', t.fixedOvertimeExcess);
  push('有給休暇賃金', t.paidLeavePay);
  for (const a of t.allowances) push(a.name, a.amount);
  push('交通費', t.transport);
  if (t.absenceDeduction) earnings.push({ label: '欠勤・遅刻早退控除', value: `-${yen(t.absenceDeduction)}`, amount: -t.absenceDeduction });
  return {
    storeName: args.storeName,
    storeAddress: args.storeAddress,
    employeeName: args.employeeName,
    employeeCode: args.employeeCode,
    periodLabel: `${args.periodKey.slice(0, 4)}年${Number(args.periodKey.slice(5, 7))}月分`,
    from: args.from,
    to: args.to,
    payDate: args.payDate,
    revision: args.revision,
    confirmedAt: args.confirmedAt,
    attendance: [
      { label: '出勤日数', value: `${t.workDays}日` },
      { label: '実労働時間', value: formatMinutes(t.workMinutes) },
      { label: '時間外労働', value: formatMinutes(t.overtimeMinutes) },
      { label: 'うち月60時間超', value: formatMinutes(t.over60Minutes) },
      { label: '深夜労働', value: formatMinutes(t.nightMinutes) },
      { label: '法定休日労働', value: formatMinutes(t.holidayMinutes) },
      { label: '有給取得日数', value: `${t.paidLeaveDays}日` },
    ],
    earnings,
    deductions: t.deductions.map((d) => ({ label: d.name, value: yen(d.amount), amount: d.amount })),
    gross: t.grossPay,
    deductionTotal: t.deductionTotal,
    net: t.netPay,
  };
}

export function yen(n: number): string {
  return `${n < 0 ? '-' : ''}¥${Math.abs(n).toLocaleString('ja-JP')}`;
}

export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** PDF 変換・印刷用の HTML（全値をエスケープ） */
export function payslipHtml(d: PayslipData): string {
  const e = htmlEscape;
  const rows = (xs: PayslipLine[]) => xs.map((x) => `<tr><th>${e(x.label)}</th><td>${e(x.value)}</td></tr>`).join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>給与明細 ${e(d.periodLabel)}</title>
<style>
body{font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic",sans-serif;color:#1d2433;margin:24px;font-size:12px}
h1{font-size:18px;margin:0 0 4px}.meta{color:#556;margin-bottom:12px}
.grid{display:flex;gap:16px}.col{flex:1}
table{width:100%;border-collapse:collapse;margin-bottom:12px}th,td{border:1px solid #c9d1dc;padding:4px 8px}
th{background:#eef2f7;text-align:left;font-weight:normal;width:55%}td{text-align:right}
.sum td,.sum th{font-weight:bold}.net{font-size:16px}
</style></head><body>
<h1>給与明細書 ${e(d.periodLabel)}${d.revision > 1 ? `（訂正第${d.revision - 1}版）` : ''}</h1>
<div class="meta">${e(d.storeName)} ${e(d.storeAddress)}<br>氏名: ${e(d.employeeName)} ${d.employeeCode ? `社員番号: ${e(d.employeeCode)} ` : ''}対象期間: ${e(d.from)}〜${e(d.to)} 支払日: ${e(d.payDate)}</div>
<div class="grid"><div class="col"><table><caption>勤怠</caption>${rows(d.attendance)}</table></div>
<div class="col"><table><caption>支給</caption>${rows(d.earnings)}<tr class="sum"><th>総支給額</th><td>${e(yen(d.gross))}</td></tr></table></div>
<div class="col"><table><caption>控除</caption>${rows(d.deductions)}<tr class="sum"><th>控除合計</th><td>${e(yen(d.deductionTotal))}</td></tr></table>
<table><tr class="sum net"><th>差引支給額</th><td>${e(yen(d.net))}</td></tr></table></div></div>
</body></html>`;
}
