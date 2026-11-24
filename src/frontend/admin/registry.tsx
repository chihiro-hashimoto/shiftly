/**
 * 管理画面のページ定義
 * perms: スタッフへ委任可能な権限（いずれかを持てば店舗 iPad の「管理メニュー」に表示）。
 *        undefined は店長専用（店長用管理画面のみ）。サーバー側でも同じ権限で検証される。
 */
import type { ComponentType } from 'react';
import { DashboardPage } from './pages/Dashboard';
import { AttendancePage } from './pages/Attendance';
import { ShiftsPage } from './pages/Shifts';
import { LeavePage } from './pages/Leave';
import { StaffPage } from './pages/Staff';
import { PayConditionsPage } from './pages/PayConditions';
import { PayrollPage } from './pages/Payroll';
import { PayslipsPage } from './pages/Payslips';
import { AnalyticsPage } from './pages/Analytics';
import { ExportsPage } from './pages/Exports';
import { NotificationsPage } from './pages/Notifications';
import { AuditPage } from './pages/Audit';
import { BackupPage } from './pages/Backup';
import { DevicesPage } from './pages/Devices';
import { SettingsPage } from './pages/Settings';
import { SystemPage } from './pages/System';

export interface PageDef {
  id: string;
  label: string;
  group: '日々の業務' | '給与' | '分析' | '管理';
  perms?: string[];
  component: ComponentType;
}

export const PAGES: PageDef[] = [
  { id: 'dashboard', label: 'ダッシュボード', group: '日々の業務', component: DashboardPage },
  { id: 'attendance', label: '勤怠', group: '日々の業務', perms: ['attendance_view_all', 'attendance_edit'], component: AttendancePage },
  { id: 'shifts', label: 'シフト', group: '日々の業務', perms: ['shift_edit', 'shift_publish'], component: ShiftsPage },
  { id: 'leave', label: '有給休暇', group: '日々の業務', perms: ['leave_manage'], component: LeavePage },
  { id: 'notifications', label: '通知', group: '日々の業務', component: NotificationsPage },
  { id: 'payroll', label: '給与計算', group: '給与', perms: ['payroll_view_all', 'payroll_confirm'], component: PayrollPage },
  { id: 'payslips', label: '給与明細', group: '給与', perms: ['payslip_view_others'], component: PayslipsPage },
  { id: 'payconf', label: '給与条件', group: '給与', perms: ['pay_conditions_edit'], component: PayConditionsPage },
  { id: 'analytics', label: '人件費・予算', group: '分析', perms: ['labor_cost_view', 'budget_manage'], component: AnalyticsPage },
  { id: 'exports', label: 'データ出力', group: '分析', perms: ['export_attendance', 'export_payroll'], component: ExportsPage },
  { id: 'staff', label: 'スタッフ・権限', group: '管理', perms: ['staff_manage'], component: StaffPage },
  { id: 'devices', label: '店舗端末', group: '管理', component: DevicesPage },
  { id: 'settings', label: '店舗設定', group: '管理', component: SettingsPage },
  { id: 'audit', label: '監査ログ', group: '管理', component: AuditPage },
  { id: 'backup', label: 'バックアップ', group: '管理', component: BackupPage },
  { id: 'system', label: 'システム・更新', group: '管理', component: SystemPage },
];
