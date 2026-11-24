/** 監査ログ（月別・操作種別フィルタ・検索） F25 */
import { useMemo, useState } from 'react';
import { Empty, ErrorBox, Loading, Panel, todayJst, useClient, useLoad } from '../../components/ui';
import type { AuditLog } from '../../../shared/types';

/** 管理画面のグリッド内で横幅を超えないようにする（表は .table-wrap 内でスクロール） */
const PAGE_STYLE = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18, minWidth: 0 } as const;

const ACTION_LABEL: Record<string, string> = {
  'adjustment.add': '手当・控除の調整を追加',
  'adjustment.remove': '手当・控除の調整を削除',
  'attendance.add_break': '休憩を登録',
  'attendance.correct': '勤怠を修正',
  'attendance.punch': '打刻',
  'auth.login': 'ログイン',
  'auth.logout': 'ログアウト',
  'auth.stepup': '管理用パスコードの追加認証',
  'authz.denied': '権限のない操作を拒否',
  'backup.failed': 'バックアップ失敗',
  'backup.restore': 'バックアップから復元',
  'backup.run': 'バックアップ作成',
  'budget.upsert': '人件費予算を設定',
  'credential.change_pin': 'PIN を変更（本人）',
  'credential.set_pin': 'PIN を設定',
  'credential.set_stepup': '管理用パスコードを設定',
  'credential.unlock': 'PIN ロックを解除',
  'deduction.upsert': '控除を設定',
  'device.enroll': '店舗端末を登録',
  'device.enrollment_create': '端末登録コードを発行',
  'device.revoke': '店舗端末を失効',
  'employee.create': 'スタッフを登録',
  'employee.reactivate': 'スタッフを再雇用',
  'employee.retire': 'スタッフを退職処理',
  'employee.update': 'スタッフ情報を変更',
  'employment.upsert': '雇用条件を設定',
  export: 'データ出力',
  'leave.adjust': '有給休暇を調整',
  'leave.grant': '有給休暇を付与',
  'leave.take': '有給休暇を取得',
  'payconf.allowance': '手当を設定',
  'payconf.salary_rule': '月給を設定',
  'payconf.transport': '交通費を設定',
  'payconf.wage_rule': '時給を設定',
  'payroll.compute': '給与を計算',
  'payroll.review': '給与を確認・確定',
  'payslip.issue': '給与明細を発行',
  'payslip.view_others': '他のスタッフの明細を閲覧',
  'permission.change': '権限を変更',
  'settings.confirm_payroll_rules': '給与規定を確認',
  'settings.update': '店舗設定を変更',
  'shift.cancel': 'シフトを取消',
  'shift.copy_week': 'シフトを週単位で複製',
  'shift.create': 'シフトを作成',
  'shift.publish': 'シフトを公開',
  'shift.update': 'シフトを変更',
  'system.initialize': '初期設定',
  'system.maintenance': 'メンテナンス切替',
  'update.finish': 'アップデート完了',
  'update.migrate': 'DB 構造の更新',
  'update.prepare': 'アップデート準備',
};

const CATEGORY: Record<string, string> = {
  attendance: '勤怠',
  auth: 'ログイン・認証',
  authz: '権限',
  backup: 'バックアップ',
  budget: '予算',
  credential: 'PIN・パスコード',
  device: '店舗端末',
  employee: 'スタッフ',
  employment: 'スタッフ',
  export: 'データ出力',
  leave: '有給休暇',
  payconf: '給与条件',
  adjustment: '給与条件',
  deduction: '給与条件',
  payroll: '給与計算',
  payslip: '給与明細',
  permission: '権限',
  settings: '店舗設定',
  shift: 'シフト',
  system: 'システム',
  update: 'システム',
};

const TARGET_LABEL: Record<string, string> = {
  employee: 'スタッフ',
  device: '端末',
  backup: 'バックアップ',
  store_settings: '店舗設定',
  system: 'システム',
};

function categoryOf(action: string): string {
  return CATEGORY[action.split('.')[0] ?? ''] ?? 'その他';
}

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const idx = y * 12 + (mo - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

const PAGE_SIZE = 200;

export function AuditPage() {
  const client = useClient();
  const thisMonth = todayJst().slice(0, 7);
  const [month, setMonth] = useState(thisMonth);
  const [category, setCategory] = useState('');
  const [action, setAction] = useState('');
  const [actor, setActor] = useState<'' | AuditLog['actorKind']>('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const validMonth = /^\d{4}-\d{2}$/.test(month);
  const logs = useLoad(() => (validMonth ? client.call<AuditLog[]>('audit.list', { month }) : Promise.resolve([] as AuditLog[])), [month]);
  const emps = useLoad(() => client.call<Array<{ id: string; displayName: string }>>('employees.list').catch(() => []), []);
  const names = useMemo(() => new Map((emps.data ?? []).map((e) => [e.id, e.displayName])), [emps.data]);

  const rows = useMemo(() => logs.data ?? [], [logs.data]);
  const categories = useMemo(() => [...new Set(rows.map((r) => categoryOf(r.action)))].sort(), [rows]);
  const actions = useMemo(() => [...new Set(rows.filter((r) => !category || categoryOf(r.action) === category).map((r) => r.action))].sort(), [rows, category]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (category && categoryOf(r.action) !== category) return false;
      if (action && r.action !== action) return false;
      if (actor && r.actorKind !== actor) return false;
      if (!needle) return true;
      const hay = [r.action, ACTION_LABEL[r.action] ?? '', r.targetType, r.targetId ?? '', r.summary, r.actorId ?? '', r.actorId ? names.get(r.actorId) ?? '' : '', r.requestId ?? '', r.at].join(' ').toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, category, action, actor, q, names]);

  const resetPaging = () => setLimit(PAGE_SIZE);

  return (
    <div style={PAGE_STYLE}>
      <Panel
        title="監査ログ"
        actions={
          <div className="row">
            <button className="btn btn-sm" onClick={() => { setMonth(shiftMonth(validMonth ? month : thisMonth, -1)); resetPaging(); }} aria-label="前の月">
              ◀ 前月
            </button>
            <input className="input" type="month" value={month} onChange={(e) => { setMonth(e.target.value); resetPaging(); }} style={{ width: 170 }} aria-label="対象月" />
            <button className="btn btn-sm" onClick={() => { setMonth(shiftMonth(validMonth ? month : thisMonth, 1)); resetPaging(); }} disabled={month >= thisMonth} aria-label="次の月">
              次月 ▶
            </button>
          </div>
        }
        pad={false}
      >
        <div className="row" style={{ padding: '12px 18px', borderBottom: '1px solid var(--line-2)', gap: 12, alignItems: 'flex-end' }}>
          <label className="field" style={{ minWidth: 150 }}>
            <span>分類</span>
            <select className="input" value={category} onChange={(e) => { setCategory(e.target.value); setAction(''); resetPaging(); }}>
              <option value="">すべて</option>
              {categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 200 }}>
            <span>操作</span>
            <select className="input" value={action} onChange={(e) => { setAction(e.target.value); resetPaging(); }}>
              <option value="">すべて</option>
              {actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 130 }}>
            <span>実行者</span>
            <select className="input" value={actor} onChange={(e) => { setActor(e.target.value as '' | AuditLog['actorKind']); resetPaging(); }}>
              <option value="">すべて</option>
              <option value="owner">店長</option>
              <option value="staff">スタッフ</option>
              <option value="system">システム</option>
            </select>
          </label>
          <label className="field" style={{ flex: '1 1 220px' }}>
            <span>検索</span>
            <input className="input" type="search" value={q} placeholder="概要・対象ID・requestId など" onChange={(e) => { setQ(e.target.value); resetPaging(); }} />
          </label>
          <span className="small muted" style={{ paddingBottom: 8 }}>
            {logs.data ? `${filtered.length.toLocaleString('ja-JP')} 件 / 全 ${rows.length.toLocaleString('ja-JP')} 件` : ''}
          </span>
        </div>
        {!validMonth && <div className="panel-body"><ErrorBox message="対象月を YYYY-MM 形式で指定してください" /></div>}
        {logs.loading && <Loading />}
        {logs.error && <div className="panel-body"><ErrorBox message={logs.error} onRetry={logs.reload} /></div>}
        {logs.data && !logs.loading && validMonth && rows.length === 0 && <Empty>{month} の監査ログはありません</Empty>}
        {logs.data && !logs.loading && rows.length > 0 && filtered.length === 0 && <Empty>条件に一致するログはありません</Empty>}
        {logs.data && !logs.loading && filtered.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ whiteSpace: 'nowrap' }}>日時</th>
                  <th>実行者</th>
                  <th>操作</th>
                  <th>対象</th>
                  <th>概要</th>
                  <th>requestId</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.at.slice(0, 19).replace('T', ' ')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}><Actor r={r} names={names} /></td>
                    <td>
                      <div style={{ whiteSpace: 'nowrap' }}>{ACTION_LABEL[r.action] ?? r.action}</div>
                      <div className="small muted" style={{ fontFamily: 'ui-monospace, monospace' }}>{r.action}</div>
                    </td>
                    <td>
                      <div style={{ whiteSpace: 'nowrap' }}>{TARGET_LABEL[r.targetType] ?? r.targetType}</div>
                      {r.targetId && <div className="small muted" style={{ fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' }}>{r.targetId}</div>}
                    </td>
                    <td style={{ minWidth: 200, overflowWrap: 'anywhere' }}>{r.summary || <span className="muted">—</span>}</td>
                    <td className="small muted" style={{ fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere', minWidth: 120 }}>{r.requestId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > limit && (
              <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
                <button className="btn btn-sm" onClick={() => setLimit((l) => l + PAGE_SIZE)}>
                  さらに表示（残り {(filtered.length - limit).toLocaleString('ja-JP')} 件）
                </button>
              </div>
            )}
          </div>
        )}
      </Panel>
      <div className="callout small">
        監査ログは追記のみで、変更・削除はできません（復元した場合も、復元元のバックアップ以降のログは保持されます）。PIN・管理用パスコード・端末トークン・セッショントークンなどの秘密情報や、給与額などの個人情報はログに記録されません。
        requestId は操作ごとの識別子で、同じ操作の重複実行の確認や問い合わせ時の照合に使います。
      </div>
    </div>
  );
}

function Actor({ r, names }: { r: AuditLog; names: Map<string, string> }) {
  if (r.actorKind === 'owner') return <span className="badge badge-board">店長</span>;
  if (r.actorKind === 'system') return <span className="badge">システム</span>;
  const name = r.actorId ? names.get(r.actorId) : undefined;
  return (
    <div>
      <span className="badge badge-info">スタッフ</span>
      <div className="small" style={{ marginTop: 2 }}>{name ?? ''}</div>
      {r.actorId && <div className="small muted" style={{ fontFamily: 'ui-monospace, monospace' }}>{r.actorId}</div>}
    </div>
  );
}
