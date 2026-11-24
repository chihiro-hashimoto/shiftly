/**
 * 給与計算・確定・訂正・明細
 * F14 給与計算 / F18 給与締め・確定・訂正 / F19 給与明細PDF発行・本人閲覧
 */
import { defineOps } from '../api';
import { audit, isOwner, nowIso, settings, staff, today, type Ctx } from '../context';
import { ApiError, E } from '../errors';
import * as v from '../validate';
import type { Employee, PayrollPeriod, PayrollResult, PayrollStatus, PaySlip } from '../../shared/types';
import { issueKey, unacknowledged, type PayrollIssue, type PayrollOutput, type PayrollInput } from '../../shared/payroll';
import { employeesInPeriod, getOrCreatePeriod, latestResult, overlappingPeriod, periodClosedAt, periodConfig, runPayroll } from '../services';
import { periodForDate } from '../../shared/period';
import { buildPayslip, payslipHtml, type PayslipData } from '../../shared/payslip';
/** スナップショットの上限（1 行がジャーナルの 1 チャンクに収まる大きさ） */
const SNAPSHOT_LIMIT = 30000;
import { toBase64 } from '../../shared/xlsx';

function period(ctx: Ctx, id: string): PayrollPeriod {
  const p = ctx.uow.get<PayrollPeriod>('payroll_periods', id);
  if (!p) throw E.notFound('給与期間');
  return p;
}

/** 確定時スナップショット（入力一式・内訳・根拠）。セル上限を超える場合は勤務明細を要約 */
function snapshotOf(input: PayrollInput, out: PayrollOutput): string {
  const full = { input, daily: out.daily, basis: out.basis, issues: out.issues, calcVersion: out.calcVersion, rulesetId: out.rulesetId };
  let s = JSON.stringify(full);
  if (s.length > SNAPSHOT_LIMIT) {
    const compact = { ...full, input: { ...input, sessions: input.sessions.map((x) => ({ l: x.laborDate, s: x.start, e: x.end, b: x.breaks.map((b) => [b.start, b.end]) })) } };
    s = JSON.stringify(compact);
  }
  if (s.length > SNAPSHOT_LIMIT) s = JSON.stringify({ truncated: true, daily: out.daily, basis: out.basis, calcVersion: out.calcVersion, rulesetId: out.rulesetId });
  return s;
}

function resultView(r: PayrollResult, includeSnapshot: boolean) {
  const { snapshot, issues, ...rest } = r;
  return { ...rest, issues: JSON.parse(issues || '[]') as PayrollIssue[], ...(includeSnapshot ? { snapshot: JSON.parse(snapshot || '{}') } : {}) };
}

function updatePeriodStatus(ctx: Ctx, p: PayrollPeriod) {
  const emps = employeesInPeriod(ctx, p.from, p.to);
  const results = emps.map((e) => latestResult(ctx, p.id, e.id));
  let st: PayrollStatus = 'uncomputed';
  if (results.length && results.every((r) => r && r.status === 'issued')) st = 'issued';
  else if (results.length && results.every((r) => r && (r.status === 'confirmed' || r.status === 'issued'))) st = 'confirmed';
  else if (p.status === 'review') st = 'review';
  else if (results.some((r) => r)) st = 'draft';
  if (st !== p.status) ctx.uow.update('payroll_periods', { ...p, status: st });
}

function confirmOne(ctx: Ctx, p: PayrollPeriod, e: Employee, acks: string[], reason: string, isCorrection: boolean): PayrollResult {
  const prev = latestResult(ctx, p.id, e.id);
  const isConfirmed = prev && (prev.status === 'confirmed' || prev.status === 'issued');
  if (isConfirmed && !isCorrection) throw E.conflict(`${e.displayName}さんの給与はすでに確定しています（訂正を使用してください）`);
  if (!isConfirmed && isCorrection) throw E.invalid('確定済みの給与がないため訂正できません');
  if (ctx.now < periodClosedAt(ctx, p)) {
    throw new ApiError('PAYROLL_BLOCKED', `${p.periodKey} の給与期間（〜${p.to}）がまだ終了していないため確定できません（締め日の翌日の営業日切替時刻以降に確定できます）`, 409);
  }
  const ov = overlappingPeriod(ctx, p);
  if (ov) throw new ApiError('PAYROLL_BLOCKED', `給与期間 ${p.periodKey} が ${ov.periodKey} と重なっているため確定できません（二重計上の防止）`, 409);
  const { input, output } = runPayroll(ctx, e, p);
  if (!output.canConfirm) {
    const msgs = output.issues.filter((i) => i.severity === 'blocking').map((i) => (i.date ? `${i.message}（${i.date}）` : i.message));
    throw new ApiError('PAYROLL_BLOCKED', `${e.displayName}さん: 確定できません — ${msgs.slice(0, 5).join(' / ')}`, 409);
  }
  // 確認（acknowledge）はスタッフごと（他のスタッフの同じ項目の確認は流用しない）
  const un = unacknowledged(output.issues, acks.filter((k) => k.startsWith(`${e.id}|`)).map((k) => k.slice(e.id.length + 1)));
  if (un.length) throw new ApiError('ACK_REQUIRED', `${e.displayName}さん: 確認が必要な項目があります — ${un.map((i) => i.message).slice(0, 5).join(' / ')}`, 409);
  const revision = isCorrection && prev ? prev.revision + 1 : 1;
  if (prev) ctx.uow.update('payroll_results', { ...prev, status: 'superseded' });
  if (isCorrection) {
    for (const s of ctx.uow.list<PaySlip>('pay_slips').filter((x) => x.periodId === p.id && x.employeeId === e.id && x.status === 'issued')) ctx.uow.update('pay_slips', { ...s, status: 'superseded' });
  }
  const r = ctx.uow.insert<PayrollResult>(
    'payroll_results',
    {
      periodId: p.id,
      employeeId: e.id,
      revision,
      status: 'confirmed',
      computedAt: nowIso(ctx),
      confirmedAt: nowIso(ctx),
      confirmedBy: isOwner(ctx) ? 'owner' : staff(ctx).employeeId,
      calcVersion: output.calcVersion,
      totals: output.totals,
      snapshot: snapshotOf(input, output),
      issues: JSON.stringify(output.issues),
      correctionReason: reason,
    },
    'pay',
  );
  audit(ctx, isCorrection ? 'payroll.correct' : 'payroll.confirm', 'payroll_result', r.id, `期間=${p.periodKey} 対象=${e.id} rev=${revision}`);
  return r;
}

/** 確認項目のキー（スタッフID | 課題コード@日付） */
export function ackKey(employeeId: string, i: PayrollIssue): string {
  return `${employeeId}|${issueKey(i)}`;
}

function payslipData(ctx: Ctx, slip: PaySlip): PayslipData {
  const r = ctx.uow.get<PayrollResult>('payroll_results', slip.payrollResultId);
  const p = ctx.uow.get<PayrollPeriod>('payroll_periods', slip.periodId);
  const e = ctx.uow.get<Employee>('employees', slip.employeeId);
  if (!r || !p || !e) throw E.notFound('給与明細');
  const s = settings(ctx);
  return buildPayslip({ storeName: s.storeName, storeAddress: s.storeAddress, employeeName: e.displayName, employeeCode: e.employeeCode, periodKey: p.periodKey, from: p.from, to: p.to, payDate: p.payDate, revision: r.revision, confirmedAt: r.confirmedAt, totals: r.totals });
}

defineOps([
  {
    name: 'payroll.periods',
    auth: 'staff_or_owner',
    perms: ['payroll_view_all', 'payroll_confirm', 'pay_conditions_edit', 'payslip_view_others', 'export_payroll'],
    sensitive: true,
    mutating: false,
    handler: (ctx) => {
      let suggested: string | null;
      try {
        suggested = periodForDate(today(ctx), periodConfig(settings(ctx))).periodKey;
      } catch {
        suggested = null;
      }
      return { periods: ctx.uow.list<PayrollPeriod>('payroll_periods').sort((a, b) => (a.periodKey < b.periodKey ? 1 : -1)), suggestedPeriodKey: suggested };
    },
  },
  {
    name: 'payroll.openPeriod',
    auth: 'staff_or_owner',
    perms: ['payroll_confirm', 'pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const key = v.str(v.obj(raw), 'periodKey', { pattern: /^\d{4}-\d{2}$/, label: '対象月' });
      return getOrCreatePeriod(ctx, key, true);
    },
  },
  {
    name: 'payroll.compute',
    auth: 'staff_or_owner',
    perms: ['payroll_view_all', 'payroll_confirm'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const p = period(ctx, v.id(v.obj(raw), 'periodId'));
      const out = [];
      for (const e of employeesInPeriod(ctx, p.from, p.to)) {
        const prev = latestResult(ctx, p.id, e.id);
        const { output } = runPayroll(ctx, e, p);
        if (!prev || prev.status === 'draft' || prev.status === 'review') {
          const data = { periodId: p.id, employeeId: e.id, revision: 0, status: 'draft' as const, computedAt: nowIso(ctx), confirmedAt: null, confirmedBy: null, calcVersion: output.calcVersion, totals: output.totals, snapshot: '{}', issues: JSON.stringify(output.issues), correctionReason: '' };
          if (prev) ctx.uow.update('payroll_results', { ...prev, ...data });
          else ctx.uow.insert<PayrollResult>('payroll_results', data, 'pay');
        }
        out.push({
          employeeId: e.id,
          displayName: e.displayName,
          payType: e.payType,
          savedStatus: prev?.status ?? 'uncomputed',
          revision: prev?.revision ?? 0,
          totals: output.totals,
          issues: output.issues.map((i) => ({ ...i, key: ackKey(e.id, i) })),
          canConfirm: output.canConfirm,
          basis: output.basis,
          daily: output.daily,
          confirmedTotals: prev && (prev.status === 'confirmed' || prev.status === 'issued') ? prev.totals : null,
        });
      }
      updatePeriodStatus(ctx, p);
      audit(ctx, 'payroll.compute', 'payroll_period', p.id, `仮計算 ${p.periodKey}`);
      return { period: ctx.uow.get<PayrollPeriod>('payroll_periods', p.id), employees: out };
    },
  },
  {
    name: 'payroll.submitReview',
    auth: 'staff_or_owner',
    perms: ['payroll_confirm'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const p = period(ctx, v.id(v.obj(raw), 'periodId'));
      if (p.status === 'confirmed' || p.status === 'issued') throw E.invalid('確定済みの期間です');
      const saved = ctx.uow.update('payroll_periods', { ...p, status: 'review' });
      audit(ctx, 'payroll.review', 'payroll_period', p.id, `確認待ち ${p.periodKey}`);
      return saved;
    },
  },
  {
    name: 'payroll.confirm',
    auth: 'staff_or_owner',
    perms: ['payroll_confirm'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const p = period(ctx, v.id(a, 'periodId'));
      const acks = Array.isArray(a.acknowledgements) ? (a.acknowledgements as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
      const ids = Array.isArray(a.employeeIds) ? (a.employeeIds as unknown[]).filter((x): x is string => typeof x === 'string') : null;
      const emps = employeesInPeriod(ctx, p.from, p.to).filter((e) => !ids || ids.includes(e.id));
      if (!emps.length) throw E.invalid('対象スタッフがいません');
      // 自分自身の給与をスタッフ権限で確定することは禁止
      if (!isOwner(ctx) && emps.some((e) => e.id === staff(ctx).employeeId)) throw E.forbidden('自分自身の給与確定');
      const done = emps.map((e) => confirmOne(ctx, p, e, acks, '', false));
      updatePeriodStatus(ctx, p);
      return { confirmed: done.map((r) => ({ id: r.id, employeeId: r.employeeId, revision: r.revision, netPay: r.totals.netPay })) };
    },
  },
  {
    name: 'payroll.correct',
    auth: 'staff_or_owner',
    perms: ['payroll_confirm'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const p = period(ctx, v.id(a, 'periodId'));
      const e = ctx.uow.get<Employee>('employees', v.id(a, 'employeeId'));
      if (!e) throw E.notFound('スタッフ');
      if (!isOwner(ctx) && e.id === staff(ctx).employeeId) throw E.forbidden('自分自身の給与訂正');
      const reason = v.str(a, 'reason', { min: 2, max: 300, label: '訂正理由' });
      const acks = Array.isArray(a.acknowledgements) ? (a.acknowledgements as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const r = confirmOne(ctx, p, e, acks, reason, true);
      updatePeriodStatus(ctx, p);
      return { id: r.id, revision: r.revision, netPay: r.totals.netPay };
    },
  },
  {
    name: 'payroll.results',
    auth: 'staff_or_owner',
    perms: ['payroll_view_all', 'payroll_confirm'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const p = period(ctx, v.id(v.obj(raw), 'periodId'));
      const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e.displayName]));
      return ctx.uow
        .list<PayrollResult>('payroll_results')
        .filter((r) => r.periodId === p.id)
        .sort((x, y) => (x.employeeId === y.employeeId ? y.revision - x.revision : x.employeeId < y.employeeId ? -1 : 1))
        .map((r) => ({ ...resultView(r, false), displayName: names.get(r.employeeId) ?? '' }));
    },
  },
  {
    name: 'payroll.resultDetail',
    auth: 'staff_or_owner',
    perms: ['payroll_view_all'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const r = ctx.uow.get<PayrollResult>('payroll_results', v.id(v.obj(raw), 'resultId'));
      if (!r) throw E.notFound('給与結果');
      return resultView(r, true);
    },
  },
  {
    name: 'payroll.mine',
    auth: 'session',
    perms: ['payroll_view_self'],
    mutating: false,
    handler: (ctx) => {
      const me = staff(ctx);
      const e = ctx.uow.get<Employee>('employees', me.employeeId)!;
      const periods = ctx.uow.list<PayrollPeriod>('payroll_periods').sort((a, b) => (a.periodKey < b.periodKey ? 1 : -1)).slice(0, 12);
      const confirmed = periods
        .map((p) => ({ p, r: latestResult(ctx, p.id, e.id) }))
        .filter((x) => x.r && (x.r.status === 'confirmed' || x.r.status === 'issued'))
        .map((x) => ({ periodKey: x.p.periodKey, from: x.p.from, to: x.p.to, payDate: x.p.payDate, status: x.r!.status, revision: x.r!.revision, totals: x.r!.totals }));
      // 今期の見込額（未確定・不完全の可能性あり）
      let estimate: unknown;
      try {
        const cfg = periodConfig(settings(ctx));
        const r = periodForDate(today(ctx), cfg);
        const tmp: PayrollPeriod = { id: `estimate-${r.periodKey}`, periodKey: r.periodKey, from: r.from, to: r.to, payDate: r.payDate, status: 'uncomputed', createdAt: '', updatedAt: '', version: 0 };
        const real = ctx.uow.list<PayrollPeriod>('payroll_periods').find((x) => x.periodKey === r.periodKey) ?? tmp;
        const { output } = runPayroll(ctx, e, real);
        estimate = { periodKey: r.periodKey, from: r.from, to: r.to, kind: 'estimate', incomplete: !output.canConfirm, workMinutes: output.totals.workMinutes, grossPay: output.totals.grossPay, totals: output.totals };
      } catch {
        estimate = null;
      }
      return { confirmed, estimate };
    },
  },
  // ------------------------------------------------------------ 明細
  {
    name: 'payslips.issue',
    auth: 'staff_or_owner',
    perms: ['payroll_confirm'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const p = period(ctx, v.id(v.obj(raw), 'periodId'));
      let issued = 0;
      const failedPdf: string[] = [];
      for (const r of ctx.uow.list<PayrollResult>('payroll_results').filter((x) => x.periodId === p.id && x.status === 'confirmed')) {
        const slip = ctx.uow.insert<PaySlip>('pay_slips', { periodId: p.id, employeeId: r.employeeId, payrollResultId: r.id, revision: r.revision, driveFileId: null, issuedAt: nowIso(ctx), status: 'issued' }, 'slp');
        const data = payslipData(ctx, slip);
        const pdf = ctx.p.files.htmlToPdf(payslipHtml(data));
        if (pdf) {
          const f = ctx.p.files.createFile('02_Payslips', `${p.periodKey}_${r.employeeId}_rev${r.revision}.pdf`, 'application/pdf', pdf);
          ctx.uow.update('pay_slips', { ...slip, driveFileId: f.fileId });
        } else failedPdf.push(r.employeeId);
        ctx.uow.update('payroll_results', { ...r, status: 'issued' });
        issued++;
      }
      updatePeriodStatus(ctx, p);
      audit(ctx, 'payslip.issue', 'payroll_period', p.id, `明細発行 ${issued}件`);
      return { issued, pdfUnavailable: failedPdf.length };
    },
  },
  {
    name: 'payslips.list',
    auth: 'staff_or_owner',
    perms: ['payslip_view_others'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const periodId = v.id(v.obj(raw), 'periodId');
      const names = new Map(ctx.uow.list<Employee>('employees').map((e) => [e.id, e.displayName]));
      return ctx.uow.list<PaySlip>('pay_slips').filter((s) => s.periodId === periodId).map((s) => ({ ...s, displayName: names.get(s.employeeId) ?? '' }));
    },
  },
  {
    name: 'payslips.mine',
    auth: 'session',
    perms: ['payslip_view_self'],
    mutating: false,
    handler: (ctx) => {
      const me = staff(ctx);
      const periods = new Map(ctx.uow.list<PayrollPeriod>('payroll_periods').map((p) => [p.id, p]));
      return ctx.uow
        .list<PaySlip>('pay_slips')
        .filter((s) => s.employeeId === me.employeeId && s.status === 'issued')
        .map((s) => ({ id: s.id, periodKey: periods.get(s.periodId)?.periodKey ?? '', payDate: periods.get(s.periodId)?.payDate ?? '', revision: s.revision }))
        .sort((a, b) => (a.periodKey < b.periodKey ? 1 : -1));
    },
  },
  {
    name: 'payslips.view',
    auth: 'staff_or_owner',
    perms: ['payslip_view_self', 'payslip_view_others'],
    mutating: false,
    handler: (ctx, raw) => {
      const slip = ctx.uow.get<PaySlip>('pay_slips', v.id(v.obj(raw), 'payslipId'));
      if (!slip) throw E.notFound('給与明細');
      if (!isOwner(ctx)) {
        const me = staff(ctx);
        if (slip.employeeId === me.employeeId) {
          if (!me.permissions.includes('payslip_view_self')) throw E.forbidden();
        } else {
          // 他人の明細: 明示的な個別権限＋追加認証が必須
          if (!me.permissions.includes('payslip_view_others')) throw E.forbidden();
          if (!me.stepUp) throw E.stepUpRequired();
          audit(ctx, 'payslip.view_others', 'pay_slip', slip.id, '他者の明細閲覧');
        }
      }
      return { ...payslipData(ctx, slip), status: slip.status };
    },
  },
  {
    name: 'payslips.pdf',
    auth: 'owner',
    mutating: false,
    handler: (ctx, raw) => {
      // 店長端末からの印刷・ダウンロード用（共用 iPad からは呼べない）
      const slip = ctx.uow.get<PaySlip>('pay_slips', v.id(v.obj(raw), 'payslipId'));
      if (!slip) throw E.notFound('給与明細');
      const data = payslipData(ctx, slip);
      const stored = slip.driveFileId ? ctx.p.files.readFile(slip.driveFileId) : null;
      const pdf = stored ?? ctx.p.files.htmlToPdf(payslipHtml(data));
      return { fileName: `給与明細_${data.periodLabel}_${data.employeeName}.pdf`, html: payslipHtml(data), pdfBase64: pdf ? toBase64(pdf) : null };
    },
  },
]);

