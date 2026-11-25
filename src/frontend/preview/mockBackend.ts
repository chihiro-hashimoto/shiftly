/**
 * プレビュー用: ブラウザ内で Core API をメモリ上に起動し、サンプルデータを投入する
 * - 実在スタッフの情報は使用しない（氏名・金額はすべて架空のサンプル）
 * - データはメモリ上のみ。再読み込みで初期状態に戻る（端末へ保存しない）
 */
import { handleRequest } from '../../backend/index';
import { createMockEnv, type MockEnv } from '../../backend/mock';
import type { ApiResult, Transport } from '../api/transport';
import { addDays, localDateTime, toIsoJst, toLocalDate } from '../../shared/time';

export interface PreviewBackend {
  env: MockEnv;
  owner: Transport;
  staff: Transport;
  deviceToken: string;
  staffPins: Array<{ name: string; pin: string }>;
  adminPassword: string;
}

/** プレビュー専用の架空の管理者パスワード（本番には存在しない。本番では Google 所有者が設定する） */
const DEMO_ADMIN_PASSWORD = 'Demo#Manager2026';

function delay<T>(v: T): Promise<T> {
  // 実環境の通信待ちを模した短い遅延（UI のローディング確認用）
  return new Promise((r) => setTimeout(() => r(v), 120));
}

export function startPreviewBackend(): PreviewBackend {
  const env = createMockEnv({ autoClock: true, kind: 'mock' });
  const be = { p: env.platform, adapter: () => env.adapter };
  const owner: Transport = { mode: 'admin', call: (req) => delay(handleRequest(be, { op: req.op, args: req.args, requestId: req.requestId }, 'owner') as ApiResult) };
  const staffT: Transport = { mode: 'staff', call: (req) => delay(handleRequest(be, req) as ApiResult) };
  const o = <T = unknown>(op: string, args?: unknown): T => {
    const r = handleRequest(be, { op, args, requestId: `seed${Math.random().toString(16).slice(2, 12)}` }, 'owner');
    if (!r.ok) throw new Error(`${op}: ${r.error.message}`);
    return r.data as T;
  };
  o('system.initialize', { storeName: 'サンプル店舗（デモ）', envId: 'env_preview' });
  o('settings.update', {
    storeAddress: '（サンプル）東京都〇〇区',
    businessHours: [0, 1, 2, 3, 4, 5, 6].map((w) => (w === 1 ? { closed: true } : { closed: false, open: '18:00', close: w === 5 || w === 6 ? '29:00' : '26:00' })),
    workingTimeSystem: 'standard',
    weekStartDay: 0,
    statutoryHolidayWeekday: 1,
    payrollClosingDay: 0,
    payMonthOffset: 1,
    payDay: 25,
    agreement36: 'concluded',
    minimumWages: [{ effectiveFrom: '2025-10-01', hourly: 1000, label: 'サンプル（架空の値）', sourceNote: 'プレビュー用の架空の値。本番では公式資料を確認して入力' }],
    paidLeaveWageMethod: 'normal',
  });
  o('adminAuth.setPassword', { password: DEMO_ADMIN_PASSWORD });
  const en = o<{ code: string }>('devices.createEnrollment', { deviceName: '店舗iPad（デモ）' });
  const dev = handleRequest(be, { op: 'staff.enroll', args: { code: en.code, userAgent: 'preview' }, requestId: 'seed_enroll_01' });
  if (!dev.ok) throw new Error(dev.error.message);
  const deviceToken = (dev.data as { deviceToken: string }).deviceToken;

  const staff = [
    { name: 'サンプル 一郎', kana: 'さんぷる いちろう', pin: '482913', rate: 1150, type: 'hourly' as const },
    { name: 'サンプル 花子', kana: 'さんぷる はなこ', pin: '573024', rate: 1200, type: 'hourly' as const },
    { name: 'デモ 次郎', kana: 'でも じろう', pin: '604135', rate: 1100, type: 'hourly' as const },
    { name: 'デモ 管理者代理', kana: 'でも かんりしゃだいり', pin: '715246', rate: 0, type: 'monthly' as const },
    // PIN 未設定のスタッフ（名前の選択だけで出退勤。本人未確認）
    { name: 'デモ 三郎', kana: 'でも さぶろう', pin: '', rate: 1100, type: 'hourly' as const },
  ];
  const ids: string[] = [];
  for (const s of staff) {
    const e = o<{ id: string }>('employees.create', { displayName: s.name, kana: s.kana, payType: s.type, hireDate: '2025-04-01' });
    ids.push(e.id);
    if (s.pin) o('credentials.setPin', { employeeId: e.id, pin: s.pin });
    o('payconf.upsertTransport', { employeeId: e.id, method: 'per_day', amount: 500, monthlyCap: 15000, effectiveFrom: '2025-04-01' });
    o('employment.upsert', { employeeId: e.id, effectiveFrom: '2025-04-01', payType: s.type, weeklyScheduledDays: s.type === 'monthly' ? 5 : 3, weeklyScheduledMinutes: s.type === 'monthly' ? 2400 : 1200, dailyScheduledMinutes: s.type === 'monthly' ? 480 : 400 });
    if (s.type === 'hourly') {
      o('payconf.upsertWageRule', { employeeId: e.id, kind: 'base', hourlyRate: s.rate, effectiveFrom: '2025-04-01', priority: 0 });
      o('payconf.upsertWageRule', { employeeId: e.id, kind: 'weekday', hourlyRate: s.rate + 100, weekdays: [5, 6], effectiveFrom: '2025-04-01', priority: 10, note: '金土の時給（サンプル）' });
    } else {
      o('payconf.upsertSalaryRule', { employeeId: e.id, effectiveFrom: '2025-04-01', monthlySalary: 260000, monthlyScheduledMinutes: 10200, scheduledWeekdays: [0, 2, 3, 4, 5], scheduledDailyMinutes: 480, inLegalOvertimeRate: 100, confirmed: true });
    }
  }
  // 管理者代理にシフト管理・勤怠閲覧の委任（追加認証パスコード: Demo2026pass）
  o('permissions.set', { employeeId: ids[3], permissions: ['punch_self', 'attendance_view_self', 'payroll_view_self', 'payslip_view_self', 'shift_view_published', 'leave_view_self', 'notifications_view', 'attendance_view_all', 'shift_edit', 'shift_publish'] });
  o('credentials.setStepUp', { employeeId: ids[3], passcode: 'Demo2026pass' });

  // 直近 10 日の勤怠（打刻原本は紙からの登録扱いで作成）と、今週・来週のシフト
  const today = toLocalDate(Date.now());
  for (let d = -10; d <= -1; d++) {
    const date = addDays(today, d);
    ids.forEach((id, i) => {
      if ((d + i) % 3 === 0) return;
      const start = i === 3 ? '17:00' : i % 2 === 0 ? '18:00' : '19:00';
      const end = i === 3 ? '26:00' : '24:30';
      // '26:00' のような翌日表記も localDateTime で実時刻に変換
      const add = (type: string, t: string) => o('attendance.correct', { employeeId: id, action: 'add', type, at: toIsoJst(localDateTime(date, t)).slice(0, 16), reason: 'プレビュー用サンプル', source: 'paper_recovery' });
      add('clock_in', start);
      add('break_start', '21:00');
      add('break_end', '21:45');
      add('clock_out', end);
    });
  }
  // 過去分も含めてシフトを登録（シフト基準の給与計算・シフト外の勤務の確認をプレビューで確認できるように）
  for (let d = -10; d < 14; d++) {
    const date = addDays(today, d);
    ids.forEach((id, i) => {
      if ((d + i) % 3 === 0) return;
      o('shifts.upsert', { employeeId: id, date, start: i === 3 ? '17:00' : '18:00', end: i === 3 ? '26:00' : '24:00', breakMinutes: 45, fixedBreakStart: '21:00' });
    });
  }
  o('shifts.publish', { from: addDays(today, -10), to: addDays(today, 6) });
  // 早出・残業申請のサンプル（申請中）
  try {
    const d1 = addDays(today, -2);
    o('offshift.confirm', { comment: 'プレビュー用サンプル（閉店作業）', items: [{ employeeId: ids[0], start: `${addDays(d1, 1)}T00:00`, end: `${addDays(d1, 1)}T00:30`, result: 'work', category: 'late' }] });
  } catch {
    /* サンプルの勤務がない日は登録しない */
  }
  o('budgets.upsert', { month: today.slice(0, 7), monthlyAmount: 650000, laborCostAllocation: 'by_worked_minutes' });
  o('leave.grant', { employeeId: ids[0], grantDate: '2025-10-01', days: 6, kind: 'proportional', attendanceRateConfirmed: true, note: 'サンプル' });
  try {
    o('notifications.scan');
  } catch {
    /* noop */
  }
  return { env, owner, staff: staffT, deviceToken, staffPins: staff.filter((s) => s.pin).map((s) => ({ name: s.name, pin: s.pin })), adminPassword: DEMO_ADMIN_PASSWORD };
}
