/**
 * 給与条件（時給ルール・月給・交通費・手当・控除・調整）
 * F12 時給管理 / F13 月給制 / F15 交通費 / F16 手当 / F17 控除
 * 自分自身の給与条件はスタッフ権限では変更できない（自己昇給の防止）。
 */
import { defineOps } from '../api';
import { audit, isOwner, staff, type Ctx } from '../context';
import { E } from '../errors';
import * as v from '../validate';
import type { Allowance, DeductionEntry, Employee, PayrollAdjustment, PayrollPeriod, PremiumBaseCategory, SalaryRule, TransportRule, WageRule } from '../../shared/types';
import { findConflicts, validateWageRule } from '../../shared/wage';

function target(ctx: Ctx, a: v.Args): Employee {
  const employeeId = v.id(a, 'employeeId');
  const e = ctx.uow.get<Employee>('employees', employeeId);
  if (!e) throw E.notFound('スタッフ');
  if (!isOwner(ctx) && staff(ctx).employeeId === employeeId) throw E.forbidden('自分自身の給与条件の変更');
  return e;
}

function upsertRow<T extends { id: string; version: number; employeeId: string }>(ctx: Ctx, table: Parameters<Ctx['uow']['list']>[0], a: v.Args, data: Omit<T, 'id' | 'version' | 'createdAt' | 'updatedAt'>, prefix: string): T {
  const id = typeof a.id === 'string' && a.id ? v.id(a, 'id') : null;
  if (id) {
    const cur = ctx.uow.get<T>(table, id);
    if (!cur || cur.employeeId !== data.employeeId) throw E.notFound('対象データ');
    return ctx.uow.update(table, { ...cur, ...data, version: typeof a.version === 'number' ? a.version : cur.version } as never) as T;
  }
  return ctx.uow.insert(table, data as never, prefix) as unknown as T;
}

const PREMIUM_CATS: PremiumBaseCategory[] = ['include', 'exclude_family', 'exclude_commute', 'exclude_separation', 'exclude_education', 'exclude_housing', 'exclude_temporary', 'exclude_over_month'];

function readPeriodAmounts(a: v.Args, k: string): Record<string, number> {
  const x = a[k];
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw E.invalid(`${k}の形式が不正です`);
  const out: Record<string, number> = {};
  for (const [pk, val] of Object.entries(x as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(pk) || typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) throw E.invalid(`${k}の金額が不正です`);
    out[pk] = val;
  }
  return out;
}

defineOps([
  {
    name: 'payconf.get',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const employeeId = v.id(v.obj(raw), 'employeeId');
      const by = <T extends { employeeId: string }>(xs: T[]) => xs.filter((x) => x.employeeId === employeeId);
      const wageRules = by(ctx.uow.list<WageRule>('wage_rules'));
      return {
        wageRules,
        wageConflicts: findConflicts(wageRules).map(([x, y]) => [x.id, y.id]),
        salaryRules: by(ctx.uow.list<SalaryRule>('salary_rules')),
        transportRules: by(ctx.uow.list<TransportRule>('transport_rules')),
        allowances: by(ctx.uow.list<Allowance>('allowances')),
      };
    },
  },
  {
    name: 'payconf.upsertWageRule',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = target(ctx, a);
      const kind = v.oneOf(a, 'kind', ['base', 'weekday', 'timeband', 'holiday', 'special_date'] as const, 'ルール種別');
      const data: Omit<WageRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
        employeeId: e.id,
        kind,
        hourlyRate: v.int(a, 'hourlyRate', { min: 1, max: 100000, label: '時給' }),
        effectiveFrom: v.date(a, 'effectiveFrom', { label: '適用開始日' }),
        effectiveTo: v.dateOrNull(a, 'effectiveTo', '適用終了日'),
        weekdays: v.intArray(a, 'weekdays', { min: 0, max: 6 }),
        timeFrom: kind === 'timeband' ? v.time(a, 'timeFrom', { allowNextDay: true, label: '開始時刻' }) : null,
        timeTo: kind === 'timeband' ? v.time(a, 'timeTo', { allowNextDay: true, label: '終了時刻' }) : null,
        specialDates: kind === 'special_date' ? v.dateArray(a, 'specialDates') : [],
        priority: v.int(a, 'priority', { min: 0, max: 1000, label: '優先度' }),
        includesNightPremium: v.bool(a, 'includesNightPremium'),
        premiumBaseRate: v.intOrNull(a, 'premiumBaseRate', { min: 1, max: 100000, label: '割増算定基礎の時給' }),
        note: v.optStr(a, 'note', 200),
      };
      const errs = validateWageRule(data);
      if (errs.length) throw E.invalid(errs.join(' / '));
      const saved = upsertRow<WageRule>(ctx, 'wage_rules', a, data, 'wgr');
      const all = ctx.uow.list<WageRule>('wage_rules').filter((w) => w.employeeId === e.id);
      audit(ctx, 'payconf.wage_rule', 'employee', e.id, `時給ルール ${kind} ${data.effectiveFrom}〜`);
      return { rule: saved, conflicts: findConflicts(all).map(([x, y]) => [x.id, y.id]) };
    },
  },
  {
    name: 'payconf.upsertSalaryRule',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = target(ctx, a);
      const fo = a.fixedOvertime === null || a.fixedOvertime === undefined ? null : v.obj(a.fixedOvertime);
      const ad = a.absenceDeduction === null || a.absenceDeduction === undefined ? null : v.obj(a.absenceDeduction);
      const le = a.lateEarlyDeduction === null || a.lateEarlyDeduction === undefined ? null : v.obj(a.lateEarlyDeduction);
      const rate = v.intOrNull(a, 'inLegalOvertimeRate', { min: 100, max: 125 });
      if (rate !== null && rate !== 100 && rate !== 125) throw E.invalid('法定内残業の支払率は100%または125%を選択してください');
      const data: Omit<SalaryRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
        employeeId: e.id,
        effectiveFrom: v.date(a, 'effectiveFrom', { label: '適用開始日' }),
        effectiveTo: v.dateOrNull(a, 'effectiveTo'),
        monthlySalary: v.int(a, 'monthlySalary', { min: 1, max: 10_000_000, label: '月額基本給' }),
        monthlyScheduledMinutes: v.intOrNull(a, 'monthlyScheduledMinutes', { min: 60, max: 31 * 24 * 60, label: '1か月平均所定労働時間' }),
        scheduledWeekdays: v.intArray(a, 'scheduledWeekdays', { min: 0, max: 6 }),
        scheduledDailyMinutes: v.intOrNull(a, 'scheduledDailyMinutes', { min: 0, max: 1440, label: '1日所定労働時間' }),
        inLegalOvertimeRate: rate as 100 | 125 | null,
        fixedOvertime: fo ? { enabled: v.bool(fo, 'enabled'), amount: v.int(fo, 'amount', { min: 0, max: 10_000_000, label: '固定残業代' }), coveredMinutes: v.int(fo, 'coveredMinutes', { min: 0, max: 100 * 60, label: '固定残業の対象時間' }) } : null,
        absenceDeduction: ad ? { enabled: v.bool(ad, 'enabled'), divisorDays: v.intOrNull(ad, 'divisorDays', { min: 1, max: 31, label: '欠勤控除の除数（日）' }) } : null,
        lateEarlyDeduction: le ? { enabled: v.bool(le, 'enabled') } : null,
        confirmed: v.bool(a, 'confirmed'),
        note: v.optStr(a, 'note', 300),
      };
      const saved = upsertRow<SalaryRule>(ctx, 'salary_rules', a, data, 'slr');
      audit(ctx, 'payconf.salary_rule', 'employee', e.id, `月給条件 ${data.effectiveFrom}〜 確認=${data.confirmed}`);
      return saved;
    },
  },
  {
    name: 'payconf.upsertTransport',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = target(ctx, a);
      const method = v.oneOf(a, 'method', ['unset', 'none', 'per_day', 'monthly', 'actual'] as const, '支給方式');
      const data: Omit<TransportRule, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
        employeeId: e.id,
        effectiveFrom: v.date(a, 'effectiveFrom', { label: '適用開始日' }),
        effectiveTo: v.dateOrNull(a, 'effectiveTo'),
        method,
        amount: method === 'per_day' || method === 'monthly' ? v.int(a, 'amount', { min: 0, max: 1_000_000, label: '金額' }) : 0,
        monthlyCap: v.intOrNull(a, 'monthlyCap', { min: 0, max: 1_000_000, label: '支給上限' }),
        actualAmounts: readPeriodAmounts(a, 'actualAmounts'),
        note: v.optStr(a, 'note', 200),
      };
      const saved = upsertRow<TransportRule>(ctx, 'transport_rules', a, data, 'trn');
      audit(ctx, 'payconf.transport', 'employee', e.id, `交通費 ${method}`);
      return saved;
    },
  },
  {
    name: 'payconf.upsertAllowance',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = target(ctx, a);
      const data: Omit<Allowance, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
        employeeId: e.id,
        name: v.str(a, 'name', { max: 30, label: '手当名' }),
        kind: v.oneOf(a, 'kind', ['fixed_monthly', 'per_workday', 'per_hour', 'variable'] as const, '支給頻度'),
        amount: v.int(a, 'amount', { min: 0, max: 10_000_000, label: '金額' }),
        effectiveFrom: v.date(a, 'effectiveFrom', { label: '適用開始日' }),
        effectiveTo: v.dateOrNull(a, 'effectiveTo'),
        premiumBaseCategory: v.oneOf(a, 'premiumBaseCategory', PREMIUM_CATS, '割増算定基礎への算入区分'),
        includeInMinimumWage: v.bool(a, 'includeInMinimumWage'),
        periodAmounts: readPeriodAmounts(a, 'periodAmounts'),
        note: v.optStr(a, 'note', 200),
      };
      const saved = upsertRow<Allowance>(ctx, 'allowances', a, data, 'alw');
      audit(ctx, 'payconf.allowance', 'employee', e.id, `手当 ${data.name}`);
      return saved;
    },
  },
  {
    name: 'deductions.get',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit', 'payroll_confirm'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const periodId = v.id(v.obj(raw), 'periodId');
      return ctx.uow.list<DeductionEntry>('deductions').filter((d) => d.periodId === periodId);
    },
  },
  {
    name: 'deductions.upsert',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = target(ctx, a);
      const periodId = v.id(a, 'periodId');
      if (!ctx.uow.get<PayrollPeriod>('payroll_periods', periodId)) throw E.notFound('給与期間');
      const status = v.oneOf(a, 'status', ['unentered', 'entered', 'explicit_none'] as const, '入力状態');
      const yen = (k: string, label: string) => (status === 'entered' ? v.int(a, k, { min: 0, max: 10_000_000, label }) : 0);
      const others = status === 'entered' && Array.isArray(a.others)
        ? (a.others as unknown[]).slice(0, 10).map((x) => {
            const o = v.obj(x);
            return { name: v.str(o, 'name', { max: 30, label: '控除名' }), amount: v.int(o, 'amount', { min: 0, max: 10_000_000, label: '控除額' }), basis: v.oneOf(o, 'basis', ['statutory', 'labor_agreement'] as const, '控除の根拠') };
          })
        : [];
      const data = {
        employeeId: e.id,
        periodId,
        status,
        incomeTax: yen('incomeTax', '所得税'),
        residentTax: yen('residentTax', '住民税'),
        healthInsurance: yen('healthInsurance', '健康保険料'),
        pension: yen('pension', '厚生年金保険料'),
        employmentInsurance: yen('employmentInsurance', '雇用保険料'),
        nursingInsurance: yen('nursingInsurance', '介護保険料'),
        others,
        note: v.optStr(a, 'note', 200),
      };
      const cur = ctx.uow.list<DeductionEntry>('deductions').find((d) => d.employeeId === e.id && d.periodId === periodId);
      const saved = cur ? ctx.uow.update('deductions', { ...cur, ...data }) : ctx.uow.insert<DeductionEntry>('deductions', data, 'ded');
      audit(ctx, 'deduction.upsert', 'employee', e.id, `控除 ${status} 期間=${periodId}`);
      return saved;
    },
  },
  {
    name: 'adjustments.list',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit', 'payroll_confirm'],
    sensitive: true,
    mutating: false,
    handler: (ctx, raw) => {
      const periodId = v.id(v.obj(raw), 'periodId');
      return ctx.uow.list<PayrollAdjustment>('payroll_adjustments').filter((x) => x.periodId === periodId);
    },
  },
  {
    name: 'adjustments.add',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const e = target(ctx, a);
      const kind = v.oneOf(a, 'kind', ['absence_days', 'late_early_minutes', 'manual_addition', 'manual_subtraction'] as const, '調整種別');
      const adj = ctx.uow.insert<PayrollAdjustment>(
        'payroll_adjustments',
        {
          employeeId: e.id,
          periodId: v.id(a, 'periodId'),
          kind,
          quantity: kind === 'absence_days' ? v.num(a, 'quantity', { min: 0.5, max: 31, label: '欠勤日数' }) : kind === 'late_early_minutes' ? v.int(a, 'quantity', { min: 1, max: 10000, label: '遅刻早退（分）' }) : 0,
          amount: kind.startsWith('manual') ? v.int(a, 'amount', { min: 1, max: 10_000_000, label: '金額' }) : null,
          label: v.str(a, 'label', { optional: true, max: 30 }),
          reason: v.str(a, 'reason', { min: 2, max: 300, label: '理由' }),
          approvedBy: isOwner(ctx) ? 'owner' : staff(ctx).employeeId,
        },
        'adj',
      );
      audit(ctx, 'adjustment.add', 'employee', e.id, `${kind}`);
      return adj;
    },
  },
  {
    name: 'adjustments.remove',
    auth: 'staff_or_owner',
    perms: ['pay_conditions_edit'],
    sensitive: true,
    mutating: true,
    handler: (ctx, raw) => {
      const a = v.obj(raw);
      const cur = ctx.uow.get<PayrollAdjustment>('payroll_adjustments', v.id(a, 'id'));
      if (!cur) throw E.notFound('調整');
      target(ctx, { employeeId: cur.employeeId });
      // 取消は数量・金額を0にして理由を残す（履歴保持）
      ctx.uow.update('payroll_adjustments', { ...cur, quantity: 0, amount: cur.amount === null ? null : 0, reason: `[取消] ${cur.reason}`.slice(0, 300) });
      audit(ctx, 'adjustment.remove', 'employee', cur.employeeId, '調整の取消');
      return { ok: true };
    },
  },
]);
