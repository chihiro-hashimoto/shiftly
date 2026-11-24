/** スタッフ・権限（登録・編集・退職・個別権限・PIN／管理用パスコード） F04/F05 */
import { useMemo, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Modal, Panel, todayJst, useAction, useClient, useLoad } from '../../components/ui';
import type { Employee, PermissionKey } from '../../../shared/types';
import type { PermissionDef } from '../../../shared/permissions';
import { validatePinFormat, validateStepUpSecret } from '../../../shared/crypto';

/** employees.list の行（staff_manage があれば Employee 全項目。店長のときのみ認証・権限情報が付く） */
type EmpRow = Pick<Employee, 'id' | 'displayName' | 'kana' | 'status' | 'payType' | 'sortOrder'> &
  Partial<Employee> & {
    permissions?: PermissionKey[];
    hasPin?: boolean;
    hasStepUp?: boolean;
    locked?: boolean;
  };
interface Catalog {
  permissions: PermissionDef[];
  defaults: PermissionKey[];
}

const PAY_LABEL: Record<string, string> = { hourly: '時給制', monthly: '月給制' };
const CSS = `.st-page table.data th,.st-page table.data td{white-space:nowrap}.st-page table.data td.wrap{white-space:normal;min-width:14em}
.st-head{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line-2)}
.st-actions{display:inline-grid;grid-template-columns:auto auto;gap:6px;justify-content:end}
.st-actions .btn{min-height:36px}`;

export function StaffPage() {
  const client = useClient();
  const [includeRetired, setIncludeRetired] = useState(false);
  const list = useLoad(() => client.call<EmpRow[]>('employees.list', { includeRetired }), [includeRetired]);
  // employees.list に permissions が含まれるのは店長のときだけ
  const isOwner = !!list.data?.some((e) => Array.isArray(e.permissions));
  const catalog = useLoad(() => (isOwner ? client.call<Catalog>('permissions.catalog') : Promise.resolve(null)), [isOwner]);
  const defaults = useMemo(() => new Set<string>(catalog.data?.defaults ?? []), [catalog.data]);
  const labelOf = useMemo(() => new Map((catalog.data?.permissions ?? []).map((p) => [p.key, p.label])), [catalog.data]);

  const [edit, setEdit] = useState<EmpRow | 'new' | null>(null);
  const [retire, setRetire] = useState<EmpRow | null>(null);
  const [perm, setPerm] = useState<EmpRow | null>(null);
  const [cred, setCred] = useState<EmpRow | null>(null);
  const [reactivate, setReactivate] = useState<EmpRow | null>(null);

  const rows = list.data ?? [];
  const active = rows.filter((r) => r.status === 'active').length;

  return (
    <div className="st-page" style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <style>{CSS}</style>
      <Panel pad={false}>
        <div className="st-head">
          <div>
            <h2>スタッフ一覧</h2>
            {list.data && <div className="small muted">在籍 {active} 名{includeRetired ? `・退職 ${rows.length - active} 名` : ''}</div>}
          </div>
          <div className="row">
            <label className="check small" style={{ alignItems: 'center', minHeight: 40 }}>
              <input type="checkbox" checked={includeRetired} onChange={(e) => setIncludeRetired(e.target.checked)} style={{ marginTop: 0 }} />
              <span>退職者も表示</span>
            </label>
            <button className="btn btn-primary" onClick={() => setEdit('new')}>
              スタッフを登録
            </button>
          </div>
        </div>
        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
        {list.data && rows.length === 0 && <Empty>スタッフが登録されていません。「スタッフを登録」から追加してください。</Empty>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="r">表示順</th>
                  <th>スタッフ</th>
                  <th>給与形態・入社日</th>
                  <th>状態・電子明細</th>
                  {isOwner && <th>店舗端末の認証</th>}
                  {isOwner && <th>委任している管理権限</th>}
                  <th className="r">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const mgmt = (e.permissions ?? []).filter((p) => !defaults.has(p));
                  return (
                    <tr key={e.id} style={e.status === 'retired' ? { color: 'var(--ink-3)' } : undefined}>
                      <td className="r num">{e.sortOrder}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{e.displayName}</div>
                        {e.kana && <div className="small muted">{e.kana}</div>}
                        {e.employeeCode && <div className="small muted num">社員番号 {e.employeeCode}</div>}
                      </td>
                      <td>
                        <div>{PAY_LABEL[e.payType] ?? e.payType}</div>
                        <div className="small num">{e.hireDate ? `入社 ${e.hireDate}` : <span className="badge badge-warn">入社日 未設定</span>}</div>
                      </td>
                      <td>
                        <div>{e.status === 'active' ? <span className="badge badge-board">在籍</span> : <span className="badge">退職{e.retireDate ? `（${e.retireDate}）` : ''}</span>}</div>
                        <div className="small" style={{ marginTop: 4 }}>{e.electronicPayslipConsent ? <span className="badge badge-info">電子明細 承諾あり</span> : <span className="muted">明細は書面交付</span>}</div>
                      </td>
                      {isOwner && (
                        <td className="wrap" style={{ minWidth: '10em' }}>
                          <div className="row" style={{ gap: 4 }}>
                            {e.hasPin ? <span className="badge badge-board">PIN 設定済み</span> : <span className="badge badge-warn">PIN 未設定</span>}
                            {e.hasStepUp && <span className="badge badge-info">管理用パスコードあり</span>}
                            {e.locked && <span className="badge badge-bull">ロック中</span>}
                          </div>
                        </td>
                      )}
                      {isOwner && (
                        <td className="small wrap">
                          {mgmt.length === 0 ? <span className="muted">なし（初期権限のみ）</span> : mgmt.map((p) => labelOf.get(p) ?? p).join('、')}
                        </td>
                      )}
                      <td className="r">
                        <div className="st-actions">
                          <button className="btn btn-sm" onClick={() => setEdit(e)}>
                            編集
                          </button>
                          {isOwner && e.status === 'active' && (
                            <>
                              <button className="btn btn-sm" onClick={() => setPerm(e)}>
                                権限
                              </button>
                              <button className="btn btn-sm" onClick={() => setCred(e)}>
                                PIN・パスコード
                              </button>
                            </>
                          )}
                          {e.status === 'active' ? (
                            <button className="btn btn-sm" onClick={() => setRetire(e)}>
                              退職処理
                            </button>
                          ) : (
                            isOwner && (
                              <button className="btn btn-sm" onClick={() => setReactivate(e)}>
                                再有効化
                              </button>
                            )
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted" style={{ padding: '10px 18px 14px' }}>
          新しく登録したスタッフの初期権限は、自分の打刻・勤怠・給与明細・有給・公開シフトの閲覧のみです。{isOwner ? '店舗端末で打刻するには PIN の設定が必要です。' : '権限・PIN の設定は店長のみが行えます。'}
        </p>
      </Panel>

      {edit && (
        <EditModal
          emp={edit === 'new' ? null : edit}
          nextOrder={rows.reduce((a, r) => Math.max(a, r.sortOrder + 1), 0)}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            list.reload();
          }}
        />
      )}
      {retire && (
        <RetireModal
          emp={retire}
          onClose={() => setRetire(null)}
          onDone={() => {
            setRetire(null);
            list.reload();
          }}
        />
      )}
      {reactivate && (
        <ReactivateModal
          emp={reactivate}
          onClose={() => setReactivate(null)}
          onDone={() => {
            setReactivate(null);
            list.reload();
          }}
        />
      )}
      {perm && (
        <PermissionModal
          emp={perm}
          catalog={catalog.data}
          catalogError={catalog.error}
          onClose={() => setPerm(null)}
          onSaved={() => {
            setPerm(null);
            list.reload();
          }}
        />
      )}
      {cred && (
        <CredentialModal
          emp={cred}
          onClose={() => {
            setCred(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 登録・編集
interface EmpForm {
  displayName: string;
  kana: string;
  employeeCode: string;
  hireDate: string;
  payType: 'hourly' | 'monthly';
  sortOrder: string;
  electronicPayslipConsent: boolean;
  note: string;
}

function EditModal({ emp, nextOrder, onClose, onSaved }: { emp: EmpRow | null; nextOrder: number; onClose: () => void; onSaved: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState<EmpForm>(() => ({
    displayName: emp?.displayName ?? '',
    kana: emp?.kana ?? '',
    employeeCode: emp?.employeeCode ?? '',
    hireDate: emp?.hireDate ?? '',
    payType: emp?.payType ?? 'hourly',
    sortOrder: String(emp?.sortOrder ?? nextOrder),
    electronicPayslipConsent: emp?.electronicPayslipConsent ?? false,
    note: emp?.note ?? '',
  }));
  const set = (p: Partial<EmpForm>) => setF((x) => ({ ...x, ...p }));
  const order = Number(f.sortOrder);
  const errors: string[] = [];
  if (!f.displayName.trim()) errors.push('表示名を入力してください');
  if (f.sortOrder.trim() !== '' && (!Number.isInteger(order) || order < 0 || order > 9999)) errors.push('表示順は0〜9999の整数で入力してください');
  const payChanged = !!emp && emp.payType !== f.payType;

  const save = async () => {
    const body = {
      displayName: f.displayName.trim(),
      kana: f.kana.trim(),
      employeeCode: f.employeeCode.trim(),
      hireDate: f.hireDate || null,
      payType: f.payType,
      sortOrder: f.sortOrder.trim() === '' ? 0 : order,
      electronicPayslipConsent: f.electronicPayslipConsent,
      note: f.note.trim(),
    };
    const r = emp
      ? await run(() => client.call('employees.update', { employeeId: emp.id, version: emp.version, ...body }), 'スタッフ情報を更新しました')
      : await run(() => client.call('employees.create', body), 'スタッフを登録しました');
    if (r) onSaved();
  };

  return (
    <Modal
      title={emp ? `${emp.displayName}さんの情報を編集` : 'スタッフを登録'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || errors.length > 0} onClick={save}>
            {emp ? '保存' : '登録'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="form-grid">
          <Field label="表示名（必須）" hint="店舗端末の氏名選択に表示">
            <input className="input" maxLength={40} value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="ふりがな">
            <input className="input" maxLength={60} value={f.kana} onChange={(e) => set({ kana: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="社員番号" hint="任意">
            <input className="input" maxLength={20} value={f.employeeCode} onChange={(e) => set({ employeeCode: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="入社日" hint="有給の付与日の算出に使用">
            <input className="input" type="date" value={f.hireDate} onChange={(e) => set({ hireDate: e.target.value })} />
          </Field>
          <Field label="給与形態">
            <select className="input" value={f.payType} onChange={(e) => set({ payType: e.target.value as 'hourly' | 'monthly' })}>
              <option value="hourly">時給制</option>
              <option value="monthly">月給制</option>
            </select>
          </Field>
          <Field label="表示順" hint="小さい順に表示">
            <input className="input num" type="number" min={0} max={9999} value={f.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} />
          </Field>
        </div>
        {payChanged && <div className="callout callout-warn">給与形態の変更には「給与条件編集」の権限が必要です。変更後は「給与条件」ページで時給ルールまたは月給条件、雇用条件を確認してください。</div>}
        {!emp && <p className="small muted">登録後、給与条件ページで時給（または月給）・交通費・雇用条件を設定するまで、そのスタッフの給与は確定できません。</p>}
        <label className="check">
          <input type="checkbox" checked={f.electronicPayslipConsent} onChange={(e) => set({ electronicPayslipConsent: e.target.checked })} />
          <span>
            給与明細の電子交付について本人の承諾を得ている
            <div className="small muted">承諾は本人から書面または電子的な方法で得てください。承諾がない場合は書面で交付します。</div>
          </span>
        </label>
        <Field label="メモ" hint="任意・500文字以内（個人情報の記入は最小限に）">
          <textarea className="input" rows={2} maxLength={500} value={f.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        {errors.length > 0 && (
          <ul className="small" style={{ margin: 0, paddingLeft: '1.2em', color: 'var(--warn)' }}>
            {errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 退職・再有効化
function RetireModal({ emp, onClose, onDone }: { emp: EmpRow; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [date, setDate] = useState(todayJst());
  return (
    <Modal
      title={`${emp.displayName}さんの退職処理`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-danger"
            disabled={busy || !date}
            onClick={async () => {
              const r = await run(() => client.call('employees.retire', { employeeId: emp.id, retireDate: date }), `${emp.displayName}さんを退職扱いにしました`);
              if (r) onDone();
            }}
          >
            退職処理を行う
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="callout">
          退職処理はアカウントの<strong>無効化のみ</strong>です。勤怠・給与・給与明細・有給・監査ログなどのデータは削除されず、そのまま保持されます（法定の保存期間の管理のため）。
        </div>
        <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
          <li>店舗端末の氏名一覧に表示されなくなり、ログイン中のセッションは無効になります。</li>
          <li>退職月の給与計算・明細発行は、退職後も給与計算ページから行えます。</li>
          <li>誤って処理した場合は、店長が再有効化できます。</li>
        </ul>
        <Field label="退職日">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ReactivateModal({ emp, onClose, onDone }: { emp: EmpRow; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  return (
    <Modal
      title={`${emp.displayName}さんを再有効化`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              const r = await run(() => client.call('employees.reactivate', { employeeId: emp.id }), '再有効化しました');
              if (r) onDone();
            }}
          >
            再有効化する
          </button>
        </>
      }
    >
      <p>在籍に戻し、店舗端末の氏名一覧に再び表示します。権限と PIN は退職前の設定のままです。必要に応じて見直してください。</p>
    </Modal>
  );
}

// ------------------------------------------------------------------ 個別権限（店長専用）
function PermissionModal({ emp, catalog, catalogError, onClose, onSaved }: { emp: EmpRow; catalog: Catalog | null; catalogError: string | null; onClose: () => void; onSaved: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [sel, setSel] = useState<Set<string>>(() => new Set(emp.permissions ?? []));
  const groups = useMemo(() => {
    const m = new Map<string, PermissionDef[]>();
    for (const p of catalog?.permissions ?? []) m.set(p.group, [...(m.get(p.group) ?? []), p]);
    return [...m.entries()];
  }, [catalog]);
  const toggle = (k: string, on: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  const sensitiveSelected = (catalog?.permissions ?? []).filter((p) => p.sensitive && sel.has(p.key));

  return (
    <Modal
      title={`${emp.displayName}さんの権限`}
      onClose={onClose}
      wide
      footer={
        <>
          {catalog && (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => setSel(new Set(catalog.defaults))}>
              初期権限に戻す
            </button>
          )}
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !catalog}
            onClick={async () => {
              const r = await run(() => client.call('permissions.set', { employeeId: emp.id, permissions: [...sel] }), '権限を更新しました');
              if (r) onSaved();
            }}
          >
            保存
          </button>
        </>
      }
    >
      {!catalog && !catalogError && <Loading />}
      {catalogError && <ErrorBox message={catalogError} />}
      {catalog && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="callout">
            権限の管理・店舗端末の登録・バックアップからの復元・システム更新（店舗設定を含む）は<strong>店長専用</strong>で、スタッフには付与できません。
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {groups.map(([g, ps]) => (
              <fieldset key={g} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-m)', padding: '8px 14px 12px', margin: 0 }}>
                <legend style={{ fontWeight: 700, padding: '0 6px' }}>{g}</legend>
                <div className="stack" style={{ gap: 4 }}>
                  {ps.map((p) => (
                    <label key={p.key} className="check" style={{ minHeight: 36, alignItems: 'center' }}>
                      <input type="checkbox" checked={sel.has(p.key)} onChange={(e) => toggle(p.key, e.target.checked)} style={{ marginTop: 0 }} />
                      <span>
                        {p.label}
                        {p.sensitive && (
                          <span className="badge badge-warn" style={{ marginLeft: 6 }}>
                            追加認証が必要
                          </span>
                        )}
                        {p.defaultForStaff && <span className="small muted">（初期権限）</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <p className="small muted">「追加認証が必要」の権限は機密操作です。スタッフが店舗端末で実行するときは、PIN に加えて管理用パスコードの入力を求めます。権限の変更は監査ログに記録されます。</p>
          {sensitiveSelected.length > 0 && !emp.hasStepUp && (
            <div className="callout callout-warn">
              追加認証が必要な権限（{sensitiveSelected.map((p) => p.label).join('、')}）を付与する場合は、「PIN・パスコード」から管理用パスコードを設定してください。未設定のままでは、これらの操作を実行できません。
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ PIN・管理用パスコード（店長専用）
function CredentialModal({ emp, onClose }: { emp: EmpRow; onClose: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  // 入力値は送信直後に state から消去する（画面にもメモリにも残さない）
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [done, setDone] = useState<{ pin?: boolean; pass?: boolean; unlock?: boolean }>({});
  const pinErr = pin ? validatePinFormat(pin) : null;
  const passErr = pass ? validateStepUpSecret(pass) : null;
  const close = () => {
    setPin('');
    setPin2('');
    setPass('');
    setPass2('');
    onClose();
  };

  const submitPin = async () => {
    const v = pin;
    setPin('');
    setPin2('');
    const r = await run(() => client.call('credentials.setPin', { employeeId: emp.id, pin: v }), 'PIN を設定しました');
    if (r) setDone((d) => ({ ...d, pin: true }));
  };
  const submitPass = async () => {
    const v = pass;
    setPass('');
    setPass2('');
    const r = await run(() => client.call('credentials.setStepUp', { employeeId: emp.id, passcode: v }), '管理用パスコードを設定しました');
    if (r) setDone((d) => ({ ...d, pass: true }));
  };

  return (
    <Modal title={`${emp.displayName}さんの PIN・管理用パスコード`} onClose={close} wide footer={<button className="btn" onClick={close}>閉じる</button>}>
      <div className="stack" style={{ gap: 18 }}>
        <section className="stack" style={{ gap: 10 }}>
          <div className="row">
            <h3>PIN（店舗端末のログイン用）</h3>
            {emp.hasPin || done.pin ? <span className="badge badge-board">設定済み</span> : <span className="badge badge-warn">未設定</span>}
          </div>
          <form
            className="stack"
            style={{ gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!pinErr && pin && pin === pin2) void submitPin();
            }}
          >
            <div className="form-grid">
              <Field label="新しい PIN（6桁の数字）">
                <input className="input num" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
              </Field>
              <Field label="確認のためもう一度">
                <input className="input num" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} />
              </Field>
            </div>
            {pinErr && <span className="small" style={{ color: 'var(--bull)' }}>{pinErr}</span>}
            {!pinErr && pin2 && pin !== pin2 && <span className="small" style={{ color: 'var(--bull)' }}>確認用の PIN が一致しません</span>}
            <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
              <li>同じ数字の繰り返し（例: 111111）や連続した数字（例: 123456、654321）は使用できません。</li>
              <li>設定すると、このスタッフのログイン中のセッションは無効になります。</li>
              <li>PIN は本人に直接伝え、紙やメッセージに残さないでください。</li>
            </ul>
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy || !pin || !!pinErr || pin !== pin2}>
                PIN を設定
              </button>
            </div>
          </form>
        </section>

        <section className="stack" style={{ gap: 10, borderTop: '1px solid var(--line-2)', paddingTop: 16 }}>
          <div className="row">
            <h3>管理用パスコード（追加認証用）</h3>
            {emp.hasStepUp || done.pass ? <span className="badge badge-info">設定済み</span> : <span className="badge">未設定</span>}
          </div>
          <p className="small muted">給与・有給・スタッフ管理などの機密権限を委任したスタッフが、店舗端末で機密操作を行うときに PIN に加えて入力します。</p>
          <form
            className="stack"
            style={{ gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!passErr && pass && pass === pass2) void submitPass();
            }}
          >
            <div className="form-grid">
              <Field label="新しい管理用パスコード">
                <input className="input" type="password" autoComplete="new-password" maxLength={64} value={pass} onChange={(e) => setPass(e.target.value)} />
              </Field>
              <Field label="確認のためもう一度">
                <input className="input" type="password" autoComplete="new-password" maxLength={64} value={pass2} onChange={(e) => setPass2(e.target.value)} />
              </Field>
            </div>
            {passErr && <span className="small" style={{ color: 'var(--bull)' }}>{passErr}</span>}
            {!passErr && pass2 && pass !== pass2 && <span className="small" style={{ color: 'var(--bull)' }}>確認用のパスコードが一致しません</span>}
            <p className="small muted">10文字以上（64文字まで）で、英字と数字を両方含めてください。</p>
            <div>
              <button type="submit" className="btn btn-primary" disabled={busy || !pass || !!passErr || pass !== pass2}>
                パスコードを設定
              </button>
            </div>
          </form>
        </section>

        <section className="stack" style={{ gap: 10, borderTop: '1px solid var(--line-2)', paddingTop: 16 }}>
          <div className="row">
            <h3>ロック解除</h3>
            {emp.locked && !done.unlock ? <span className="badge badge-bull">ロック中</span> : <span className="badge">ロックなし</span>}
          </div>
          <p className="small muted">PIN やパスコードの入力を規定回数以上間違えると一定時間ロックされます。本人確認のうえ解除してください。</p>
          <div>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                const r = await run(() => client.call('credentials.unlock', { employeeId: emp.id }), 'ロックを解除しました');
                if (r) setDone((d) => ({ ...d, unlock: true }));
              }}
            >
              ロックを解除
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
