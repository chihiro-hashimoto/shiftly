/** シフト（作成・編集・複製・公開・変更履歴） F10 */
import { useMemo, useState } from 'react';
import { Empty, ErrorBox, Field, Loading, Minutes, Modal, Panel, WEEKDAYS, shiftDate, todayJst, useAction, useClient, useLoad, useToast } from '../../components/ui';
import type { Shift, ShiftPattern } from '../../../shared/types';

interface EmpLite {
  id: string;
  displayName: string;
  status: string;
}

interface HistoryRow {
  id: string;
  shiftId: string;
  action: string;
  before: string;
  after: string;
  actorId: string;
  createdAt: string;
}

// ------------------------------------------------------------------ 日付・時刻ユーティリティ（ページ内）
function dow(d: string): number {
  return new Date(`${d}T00:00:00Z`).getUTCDay();
}
/** 月曜始まりの週の初日 */
function weekStartOf(d: string): string {
  return shiftDate(d, -((dow(d) + 6) % 7));
}
function monthStartOf(d: string): string {
  return `${d.slice(0, 7)}-01`;
}
function monthEndOf(d: string): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}
function addMonth(d: string, n: number): string {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}-01`;
}
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}
function md(d: string): string {
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}
function mdw(d: string): string {
  return `${md(d)}（${WEEKDAYS[dow(d)]}）`;
}
function toMin(t: string): number {
  const [h, m] = t.split(':');
  return Number(h) * 60 + Number(m);
}
/** '18:00' '1800' '9:5' 等を 'HH:MM' に正規化。不正なら null */
function normTime(raw: string, maxHour: number): string | null {
  const s = raw.trim().replace(/：/g, ':').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  let h: number;
  let m: number;
  const a = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  const b = /^(\d{3,4})$/.exec(s);
  if (a) {
    h = Number(a[1]);
    m = Number(a[2]);
  } else if (b) {
    const x = b[1]!.padStart(4, '0');
    h = Number(x.slice(0, 2));
    m = Number(x.slice(2));
  } else return null;
  if (m > 59 || h > maxHour) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function workMinutes(s: Pick<Shift, 'start' | 'end' | 'breakMinutes'>): number {
  return Math.max(0, toMin(s.end) - toMin(s.start) - s.breakMinutes);
}
function hm(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
}

const CSS = `
.shf-head{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line-2)}
.shf-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.shf-seg{display:inline-flex;border:1px solid var(--line);border-radius:var(--radius-s);overflow:hidden}
.shf-seg button{border:0;border-radius:0;min-height:40px}
.shf-seg button+button{border-left:1px solid var(--line)}
.shf-period{font-weight:700;font-size:1.02rem;min-width:12em}
.shf-grid{border-collapse:separate;border-spacing:0;width:100%;font-size:.88rem}
.shf-grid th,.shf-grid td{border-bottom:1px solid var(--line-2);border-right:1px solid var(--line-2);padding:4px;vertical-align:top;background:#fff}
.shf-grid thead th{background:#fafbfa;color:var(--ink-2);font-weight:600;text-align:center;position:sticky;top:0;z-index:2;padding:6px 4px;white-space:nowrap}
.shf-grid .shf-name{position:sticky;left:0;z-index:1;min-width:132px;max-width:180px;text-align:left;background:#fff;padding:6px 10px}
.shf-grid thead .shf-name{z-index:3;background:#fafbfa}
.shf-grid tfoot td,.shf-grid tfoot th{background:#f4f6f4;font-weight:600;text-align:center}
.shf-grid tfoot .shf-name{background:#f4f6f4}
.shf-grid th.sat{color:var(--info)}
.shf-grid th.sun{color:var(--bull)}
.shf-grid th.today{box-shadow:inset 0 -3px 0 var(--board);color:var(--board-deep)}
.shf-week td.shf-cell{min-width:118px}
.shf-month td.shf-cell{min-width:62px}
.shf-cell{cursor:pointer}
.shf-cell:hover{background:#f7faf8}
.shf-add{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;border:1px dashed transparent;border-radius:6px;background:transparent;color:var(--ink-3);cursor:pointer;font-size:1.1rem}
.shf-cell:hover .shf-add,.shf-add:focus-visible{border-color:var(--line);color:var(--board)}
.shf-chip{display:block;width:100%;text-align:left;border-radius:6px;padding:4px 6px;margin-bottom:3px;cursor:pointer;line-height:1.3;min-height:44px;font:inherit}
.shf-chip.pub{background:var(--board-soft);border:1px solid #b9d9cd;color:var(--board-deep)}
.shf-chip.draft{background:#fff;border:1px dashed var(--ink-3);color:var(--ink)}
.shf-chip .t{font-family:var(--font-num);font-variant-numeric:tabular-nums;font-weight:600;font-size:.95rem}
.shf-chip .s{font-size:.75rem;color:var(--ink-3)}
.shf-month .shf-chip{padding:3px 4px}
.shf-month .shf-chip .t{font-size:.82rem;display:block}
.shf-legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:.82rem;color:var(--ink-2)}
.shf-legend i{display:inline-block;width:22px;height:14px;border-radius:4px;vertical-align:-2px;margin-right:4px}
.shf-hist{display:grid;gap:8px}
.shf-hist>div{border:1px solid var(--line-2);border-radius:6px;padding:8px 10px}
.shf-pat{display:flex;flex-wrap:wrap;gap:6px}
`;

const ACTION_LABEL: Record<string, string> = { create: '作成', update: '変更', cancel: '取消', copy: '前週から複製', publish: '公開' };

// ------------------------------------------------------------------ ページ本体
export function ShiftsPage() {
  const client = useClient();
  const toast = useToast();
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => todayJst());
  const today = todayJst();
  const from = mode === 'week' ? weekStartOf(anchor) : monthStartOf(anchor);
  const to = mode === 'week' ? shiftDate(from, 6) : monthEndOf(anchor);
  const days = useMemo(() => datesBetween(from, to), [from, to]);

  const emps = useLoad(() => client.call<EmpLite[]>('employees.list'), []);
  const shifts = useLoad(() => client.call<Shift[]>('shifts.list', { from, to }), [from, to]);
  // 勤務パターンは shift_edit 権限が必要。取得できない場合は空として扱う
  const patterns = useLoad(() => client.call<ShiftPattern[]>('shiftPatterns.list').catch(() => [] as ShiftPattern[]), []);

  const [edit, setEdit] = useState<ShiftForm | null>(null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [patternOpen, setPatternOpen] = useState(false);

  const nameOf = useMemo(() => new Map((emps.data ?? []).map((e) => [e.id, e.displayName])), [emps.data]);
  const byCell = useMemo(() => {
    const m = new Map<string, Shift[]>();
    for (const s of shifts.data ?? []) {
      const k = `${s.employeeId}|${s.date}`;
      const arr = m.get(k) ?? [];
      arr.push(s);
      m.set(k, arr);
    }
    for (const arr of m.values()) arr.sort((a, b) => toMin(a.start) - toMin(b.start));
    return m;
  }, [shifts.data]);
  const drafts = (shifts.data ?? []).filter((s) => s.status === 'draft');
  // 退職済み等で一覧にないスタッフのシフトも表示漏れしないよう行を補う
  const rows: EmpLite[] = useMemo(() => {
    const base = emps.data ?? [];
    const extra = [...new Set((shifts.data ?? []).map((s) => s.employeeId))].filter((id) => !base.some((e) => e.id === id)).map((id) => ({ id, displayName: '（一覧外のスタッフ）', status: 'retired' }));
    return [...base, ...extra];
  }, [emps.data, shifts.data]);

  const move = (n: number) => setAnchor(mode === 'week' ? shiftDate(from, 7 * n) : addMonth(from, n));
  const openNew = (employeeId: string, date: string) => {
    const p = patterns.data?.[0];
    setEdit({ employeeId, date, start: p?.start ?? '', end: p?.end ?? '', breakMinutes: String(p?.breakMinutes ?? 0), applyFixedBreak: false, fixedBreakStart: '', note: '' });
  };
  const openEdit = (s: Shift) =>
    setEdit({ id: s.id, version: s.version, status: s.status, employeeId: s.employeeId, date: s.date, start: s.start, end: s.end, breakMinutes: String(s.breakMinutes), applyFixedBreak: s.applyFixedBreak, fixedBreakStart: s.fixedBreakStart ?? '', note: s.note ?? '' });

  const periodLabel = mode === 'week' ? `${from.slice(0, 4)}年 ${mdw(from)} 〜 ${mdw(to)}` : `${from.slice(0, 4)}年${Number(from.slice(5, 7))}月`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      <style>{CSS}</style>
      <Panel pad={false}>
        <div className="shf-head">
          <div className="shf-toolbar">
            <div className="shf-seg" role="group" aria-label="表示単位">
              <button className={`btn ${mode === 'week' ? 'btn-primary' : ''}`} aria-pressed={mode === 'week'} onClick={() => setMode('week')}>
                週
              </button>
              <button className={`btn ${mode === 'month' ? 'btn-primary' : ''}`} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
                月
              </button>
            </div>
            <button className="btn" onClick={() => move(-1)} aria-label={mode === 'week' ? '前の週' : '前の月'}>
              ‹ 前へ
            </button>
            <button className="btn" onClick={() => setAnchor(todayJst())}>
              今日
            </button>
            <button className="btn" onClick={() => move(1)} aria-label={mode === 'week' ? '次の週' : '次の月'}>
              次へ ›
            </button>
            <span className="shf-period">{periodLabel}</span>
          </div>
          <div className="shf-toolbar">
            <button className="btn" onClick={() => setPatternOpen(true)}>
              勤務パターン
            </button>
            {mode === 'week' && (
              <button className="btn" onClick={() => setCopyOpen(true)}>
                前週を複製
              </button>
            )}
            <button className="btn" onClick={() => setPublishOpen(true)}>
              期間を公開
            </button>
            <button className="btn btn-primary" disabled={!emps.data?.length} onClick={() => openNew(emps.data?.[0]?.id ?? '', from <= today && today <= to ? today : from)}>
              シフトを追加
            </button>
          </div>
        </div>
        <div className="panel-body stack" style={{ gap: 10 }}>
          <div className="shf-legend">
            <span>
              <i style={{ background: 'var(--board-soft)', border: '1px solid #b9d9cd' }} />
              公開済み（スタッフに表示）
            </span>
            <span>
              <i style={{ background: '#fff', border: '1px dashed var(--ink-3)' }} />
              下書き（未公開・スタッフには表示されません）
            </span>
            <span className="muted">マスをクリックして作成・編集。24時以降は 26:00 のように表記します。</span>
          </div>
          {drafts.length > 0 && (
            <div className="callout callout-warn row" style={{ justifyContent: 'space-between' }}>
              <span>この期間に未公開（下書き）のシフトが {drafts.length} 件あります。公開するまでスタッフには表示されません。</span>
              <button className="btn btn-sm" onClick={() => setPublishOpen(true)}>
                公開する
              </button>
            </div>
          )}
        </div>
        {(emps.loading || shifts.loading) && !shifts.data && <Loading />}
        {emps.error && <ErrorBox message={emps.error} onRetry={emps.reload} />}
        {shifts.error && <ErrorBox message={shifts.error} onRetry={shifts.reload} />}
        {emps.data && emps.data.length === 0 && <Empty>在籍中のスタッフがいません。「スタッフ・権限」で登録してください。</Empty>}
        {emps.data && emps.data.length > 0 && shifts.data && (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 220px)', overflow: 'auto', borderTop: '1px solid var(--line-2)' }}>
            <table className={`shf-grid ${mode === 'week' ? 'shf-week' : 'shf-month'}`}>
              <thead>
                <tr>
                  <th className="shf-name">スタッフ</th>
                  {days.map((d) => (
                    <th key={d} className={`${dow(d) === 6 ? 'sat' : dow(d) === 0 ? 'sun' : ''} ${d === today ? 'today' : ''}`} scope="col">
                      {mode === 'week' ? mdw(d) : (
                        <>
                          {Number(d.slice(8, 10))}
                          <div className="small">{WEEKDAYS[dow(d)]}</div>
                        </>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const total = days.reduce((a, d) => a + (byCell.get(`${e.id}|${d}`) ?? []).reduce((x, s) => x + workMinutes(s), 0), 0);
                  const cnt = days.reduce((a, d) => a + (byCell.get(`${e.id}|${d}`)?.length ?? 0), 0);
                  return (
                    <tr key={e.id}>
                      <th className="shf-name" scope="row">
                        <div style={{ fontWeight: 600 }}>{e.displayName}</div>
                        <div className="small muted">
                          {cnt}回・<Minutes v={total} />
                        </div>
                      </th>
                      {days.map((d) => {
                        const list = byCell.get(`${e.id}|${d}`) ?? [];
                        const canAdd = e.status === 'active';
                        return (
                          <td key={d} className="shf-cell">
                            {list.map((s) => (
                              <button
                                key={s.id}
                                className={`shf-chip ${s.status === 'published' ? 'pub' : 'draft'}`}
                                onClick={() => openEdit(s)}
                                title={`${e.displayName} ${mdw(d)} ${s.start}–${s.end}（休憩${s.breakMinutes}分）${s.status === 'draft' ? ' 下書き' : ' 公開済み'}${s.note ? ` メモ: ${s.note}` : ''}`}
                              >
                                {mode === 'week' ? (
                                  <>
                                    <span className="t">
                                      {s.start}–{s.end}
                                    </span>
                                    <div className="s">
                                      休憩{s.breakMinutes}分{s.applyFixedBreak ? '（固定）' : ''}
                                      {s.status === 'draft' ? '・下書き' : ''}
                                    </div>
                                    {s.note && <div className="s" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{s.note}</div>}
                                  </>
                                ) : (
                                  <>
                                    <span className="t">{s.start}</span>
                                    <span className="t">{s.end}</span>
                                    {s.status === 'draft' && <span className="s">下書き</span>}
                                  </>
                                )}
                              </button>
                            ))}
                            {list.length === 0 && canAdd && (
                              <button className="shf-add" onClick={() => openNew(e.id, d)} aria-label={`${e.displayName} ${mdw(d)} にシフトを追加`}>
                                ＋
                              </button>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th className="shf-name" scope="row">
                    予定人数
                  </th>
                  {days.map((d) => {
                    const n = new Set((shifts.data ?? []).filter((s) => s.date === d).map((s) => s.employeeId)).size;
                    return (
                      <td key={d} className="num">
                        {n}
                        <span className="small muted">人</span>
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <th className="shf-name" scope="row">
                    予定労働時間
                    <div className="small muted" style={{ fontWeight: 400 }}>
                      期間計 <Minutes v={(shifts.data ?? []).reduce((a, s) => a + workMinutes(s), 0)} />
                    </div>
                  </th>
                  {days.map((d) => (
                    <td key={d}>
                      <Minutes v={(shifts.data ?? []).filter((s) => s.date === d).reduce((a, s) => a + workMinutes(s), 0)} />
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p className="small muted" style={{ padding: '8px 18px 14px' }}>
          予定労働時間は「終了−開始−休憩」の合計です（下書きを含む）。日付は勤務開始日で、翌日にまたがる勤務も開始日に表示します。
        </p>
      </Panel>

      {edit && (
        <ShiftModal
          initial={edit}
          emps={(emps.data ?? []).filter((e) => e.status === 'active')}
          patterns={patterns.data ?? []}
          nameOf={nameOf}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            shifts.reload();
          }}
        />
      )}
      {copyOpen && (
        <CopyWeekModal
          weekStart={from}
          onClose={() => setCopyOpen(false)}
          onDone={(r) => {
            setCopyOpen(false);
            toast('ok', `前週のシフトを複製しました（作成 ${r.created} 件・重複のためスキップ ${r.skipped} 件）`);
            shifts.reload();
          }}
        />
      )}
      {publishOpen && (
        <PublishModal
          from={from}
          to={to}
          drafts={shifts.data ?? []}
          onClose={() => setPublishOpen(false)}
          onDone={(n) => {
            setPublishOpen(false);
            toast('ok', n > 0 ? `${n} 件のシフトを公開しました` : '公開する下書きはありませんでした');
            shifts.reload();
          }}
        />
      )}
      {patternOpen && <PatternModal patterns={patterns.data ?? []} onClose={() => setPatternOpen(false)} onChanged={patterns.reload} />}
    </div>
  );
}

// ------------------------------------------------------------------ 作成・編集
interface ShiftForm {
  id?: string;
  version?: number;
  status?: Shift['status'];
  employeeId: string;
  date: string;
  start: string;
  end: string;
  breakMinutes: string;
  applyFixedBreak: boolean;
  fixedBreakStart: string;
  note: string;
}

function validateShift(f: ShiftForm): { errors: string[]; start: string | null; end: string | null; fixed: string | null; brk: number } {
  const errors: string[] = [];
  const start = normTime(f.start, 23);
  const end = normTime(f.end, 47);
  const brk = Number(f.breakMinutes);
  if (!f.employeeId) errors.push('スタッフを選択してください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) errors.push('勤務日を入力してください');
  if (!start) errors.push('開始時刻を 0:00〜23:59 の HH:MM で入力してください');
  if (!end) errors.push('終了時刻を HH:MM で入力してください（翌日にまたがる場合は 26:00 のように 24 以上で表記）');
  if (start && end) {
    if (toMin(end) <= toMin(start)) errors.push('終了時刻は開始時刻より後にしてください（翌日にまたがる場合は 26:00 のように入力）');
    else if (toMin(end) - toMin(start) > 20 * 60) errors.push('1回のシフトは20時間以内で入力してください');
  }
  if (f.breakMinutes.trim() === '' || !Number.isInteger(brk) || brk < 0 || brk > 240) errors.push('休憩は0〜240分の整数で入力してください');
  let fixed: string | null = null;
  if (f.applyFixedBreak) {
    fixed = normTime(f.fixedBreakStart, 47);
    if (!fixed) errors.push('固定休憩の開始時刻を HH:MM で入力してください');
    else if (start && end && Number.isInteger(brk) && (toMin(fixed) < toMin(start) || toMin(fixed) + brk > toMin(end))) errors.push('固定休憩はシフト時間内に設定してください');
    if (Number.isInteger(brk) && brk <= 0) errors.push('固定休憩を適用する場合は休憩時間を入力してください');
  }
  return { errors, start, end, fixed, brk };
}

function ShiftModal({ initial, emps, patterns, nameOf, onClose, onSaved }: { initial: ShiftForm; emps: EmpLite[]; patterns: ShiftPattern[]; nameOf: Map<string, string>; onClose: () => void; onSaved: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState<ShiftForm>(initial);
  const [touched, setTouched] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const v = validateShift(f);
  const set = (p: Partial<ShiftForm>) => setF((x) => ({ ...x, ...p }));
  const isEdit = !!f.id;
  const planned = v.start && v.end && Number.isInteger(v.brk) && toMin(v.end) > toMin(v.start) ? Math.max(0, toMin(v.end) - toMin(v.start) - v.brk) : null;

  const save = async () => {
    setTouched(true);
    if (v.errors.length) return;
    const r = await run(
      () =>
        client.call<Shift>('shifts.upsert', {
          id: f.id,
          version: f.version,
          employeeId: f.employeeId,
          date: f.date,
          start: v.start,
          end: v.end,
          breakMinutes: v.brk,
          applyFixedBreak: f.applyFixedBreak,
          fixedBreakStart: f.applyFixedBreak ? v.fixed : null,
          note: f.note.trim(),
        }),
      isEdit ? 'シフトを更新しました' : 'シフトを作成しました（下書き）',
    );
    if (r) onSaved();
  };
  const del = async () => {
    const r = await run(() => client.call('shifts.delete', { id: f.id }), 'シフトを取り消しました');
    if (r) onSaved();
  };
  const empOptions = emps.some((e) => e.id === f.employeeId) ? emps : [...emps, { id: f.employeeId, displayName: nameOf.get(f.employeeId) ?? '（一覧外のスタッフ）', status: 'retired' }];

  return (
    <Modal
      title={isEdit ? 'シフトを編集' : 'シフトを作成'}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button className="btn" style={{ marginRight: 'auto', color: 'var(--bull)' }} disabled={busy} onClick={() => setConfirmDelete(true)}>
              取消
            </button>
          )}
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || (touched && v.errors.length > 0)} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        {isEdit && (
          <div className="row">
            {f.status === 'published' ? <span className="badge badge-board">公開済み</span> : <span className="badge">下書き</span>}
            {f.status === 'published' && <span className="small muted">変更内容はスタッフの公開シフトに反映されます（シフト公開権限がない場合は下書きに戻り、再公開が必要です）。</span>}
          </div>
        )}
        <div className="form-grid">
          <Field label="スタッフ">
            <select className="input" value={f.employeeId} onChange={(e) => set({ employeeId: e.target.value })}>
              {empOptions.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="勤務日" hint="勤務開始日">
            <input className="input" type="date" value={f.date} onChange={(e) => set({ date: e.target.value })} />
          </Field>
        </div>
        {patterns.length > 0 && (
          <div className="field">
            <span>勤務パターンから入力</span>
            <div className="shf-pat">
              {patterns.map((p) => (
                <button key={p.id} type="button" className="btn btn-sm" onClick={() => set({ start: p.start, end: p.end, breakMinutes: String(p.breakMinutes) })}>
                  {p.name}
                  <span className="num muted">
                    {p.start}–{p.end}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          <Field label="開始">
            <input className="input num" inputMode="numeric" placeholder="18:00" value={f.start} onChange={(e) => set({ start: e.target.value })} onBlur={() => v.start && set({ start: v.start })} />
          </Field>
          <Field label="終了" hint="翌日は26:00等">
            <input className="input num" inputMode="numeric" placeholder="26:00" value={f.end} onChange={(e) => set({ end: e.target.value })} onBlur={() => v.end && set({ end: v.end })} />
          </Field>
          <Field label="休憩（分）">
            <input className="input num" type="number" min={0} max={240} step={5} value={f.breakMinutes} onChange={(e) => set({ breakMinutes: e.target.value })} />
          </Field>
          <div className="field">
            <span>予定実働</span>
            <div className="input" style={{ background: 'var(--paper)', display: 'flex', alignItems: 'center' }}>
              {planned === null ? <span className="muted">—</span> : <Minutes v={planned} />}
            </div>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.applyFixedBreak} onChange={(e) => set({ applyFixedBreak: e.target.checked })} />
          <span>
            固定休憩を適用する
            <div className="small muted">休憩の打刻がない日に限り、ここで指定した時刻から上記の休憩時間を勤怠に適用します（勤怠には「固定休憩を適用」と表示）。実際に休憩を取れなかった日は勤怠で修正してください。</div>
          </span>
        </label>
        {f.applyFixedBreak && (
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}>
            <Field label="固定休憩の開始時刻">
              <input className="input num" inputMode="numeric" placeholder="21:00" value={f.fixedBreakStart} onChange={(e) => set({ fixedBreakStart: e.target.value })} onBlur={() => v.fixed && set({ fixedBreakStart: v.fixed })} />
            </Field>
          </div>
        )}
        <Field label="メモ" hint="任意・200文字以内">
          <input className="input" value={f.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        {touched && v.errors.length > 0 && (
          <div className="callout callout-bull" role="alert">
            {v.errors.map((x) => (
              <div key={x}>{x}</div>
            ))}
          </div>
        )}
        {isEdit && (
          <div>
            <button className="btn btn-sm btn-ghost" onClick={() => setShowHistory((x) => !x)} aria-expanded={showHistory}>
              {showHistory ? '変更履歴を閉じる' : '変更履歴を表示'}
            </button>
            {showHistory && f.id && <ShiftHistory shiftId={f.id} nameOf={nameOf} />}
          </div>
        )}
      </div>
      {confirmDelete && (
        <Modal
          title="シフトを取り消しますか"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                戻る
              </button>
              <button className="btn btn-danger" disabled={busy} onClick={del}>
                取り消す
              </button>
            </>
          }
        >
          <p>
            {nameOf.get(f.employeeId) ?? ''}さん {mdw(f.date)} {initial.start}–{initial.end} のシフトを取り消します。
          </p>
          <p className="small muted" style={{ marginTop: 8 }}>
            取り消したシフトは一覧から消えますが、変更履歴には残ります。公開済みシフトの取消にはシフト公開権限が必要です。
          </p>
        </Modal>
      )}
    </Modal>
  );
}

function describe(json: string): string {
  try {
    const s = JSON.parse(json) as Partial<Shift> | null;
    if (!s || !s.date) return '';
    return `${mdw(s.date)} ${s.start}–${s.end}・休憩${s.breakMinutes ?? 0}分${s.applyFixedBreak ? `（固定 ${s.fixedBreakStart ?? ''}〜）` : ''}${s.status === 'published' ? '・公開' : s.status === 'draft' ? '・下書き' : ''}`;
  } catch {
    return '';
  }
}

function ShiftHistory({ shiftId, nameOf }: { shiftId: string; nameOf: Map<string, string> }) {
  const client = useClient();
  const h = useLoad(() => client.call<HistoryRow[]>('shifts.history', { shiftId }), [shiftId]);
  if (h.loading) return <Loading />;
  if (h.error) return <ErrorBox message={h.error} onRetry={h.reload} />;
  if (!h.data?.length) return <p className="muted small">履歴はありません</p>;
  return (
    <div className="shf-hist" style={{ marginTop: 8 }}>
      {h.data.map((r) => {
        const before = describe(r.before);
        const after = describe(r.after);
        return (
          <div key={r.id}>
            <div className="row small">
              <strong>{ACTION_LABEL[r.action] ?? r.action}</strong>
              <span className="num muted">{r.createdAt.slice(0, 16).replace('T', ' ')}</span>
              <span className="muted">{r.actorId === 'owner' ? '店長' : `${nameOf.get(r.actorId) ?? 'スタッフ'}（委任）`}</span>
            </div>
            {r.action === 'update' && before && <div className="small muted">変更前: {before}</div>}
            {after && <div className="small">{r.action === 'update' ? '変更後: ' : ''}{after}</div>}
            {r.action === 'cancel' && before && <div className="small muted">取り消したシフト: {before}</div>}
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ 前週の複製
function CopyWeekModal({ weekStart, onClose, onDone }: { weekStart: string; onClose: () => void; onDone: (r: { created: number; skipped: number }) => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const src = shiftDate(weekStart, -7);
  return (
    <Modal
      title="前週のシフトを複製"
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
              const r = await run(() => client.call<{ created: number; skipped: number }>('shifts.copyWeek', { fromWeekStart: src, toWeekStart: weekStart }));
              if (r) onDone(r);
            }}
          >
            複製する
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <p>
          <strong>
            {mdw(src)}〜{mdw(shiftDate(src, 6))}
          </strong>{' '}
          のシフトを、
          <strong>
            {mdw(weekStart)}〜{mdw(shiftDate(weekStart, 6))}
          </strong>{' '}
          に複製します。
        </p>
        <ul className="small" style={{ margin: 0, paddingLeft: '1.2em' }}>
          <li>複製したシフトはすべて下書きになります。内容を確認してから公開してください。</li>
          <li>複製先に同じスタッフの時間が重なるシフトがある場合、その分は複製しません。</li>
          <li>退職したスタッフのシフトも複製されるため、不要なものは取り消してください。</li>
        </ul>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 公開
function PublishModal({ from, to, drafts, onClose, onDone }: { from: string; to: string; drafts: Shift[]; onClose: () => void; onDone: (n: number) => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const inLoaded = f >= from && t <= to;
  const n = drafts.filter((s) => s.status === 'draft' && s.date >= f && s.date <= t).length;
  const err = !f || !t ? '期間を入力してください' : t < f ? '終了日は開始日以降にしてください' : (Date.parse(t) - Date.parse(f)) / 86400000 > 62 ? '期間は62日以内で指定してください' : null;
  return (
    <Modal
      title="シフトを公開"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !!err}
            onClick={async () => {
              const r = await run(() => client.call<{ published: number }>('shifts.publish', { from: f, to: t }));
              if (r) onDone(r.published);
            }}
          >
            公開する
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <div className="form-grid">
          <Field label="開始日">
            <input className="input" type="date" value={f} onChange={(e) => setF(e.target.value)} />
          </Field>
          <Field label="終了日">
            <input className="input" type="date" value={t} onChange={(e) => setT(e.target.value)} />
          </Field>
        </div>
        {err ? (
          <div className="callout callout-bull">{err}</div>
        ) : (
          <p>{inLoaded ? <>この期間の下書き <strong className="num">{n}</strong> 件を公開します。</> : 'この期間の下書きをすべて公開します。'}</p>
        )}
        <p className="small muted">公開したシフトは店舗端末でスタッフ全員が閲覧できるようになります。公開後に変更した場合も変更履歴に記録されます。公開にはシフト公開の権限が必要です。</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 勤務パターン
function PatternModal({ patterns, onClose, onChanged }: { patterns: ShiftPattern[]; onClose: () => void; onChanged: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [form, setForm] = useState<null | { id?: string; name: string; start: string; end: string; breakMinutes: string }>(null);
  const start = form ? normTime(form.start, 23) : null;
  const end = form ? normTime(form.end, 47) : null;
  const brk = form ? Number(form.breakMinutes) : 0;
  const err = !form
    ? null
    : !form.name.trim()
      ? 'パターン名を入力してください'
      : !start || !end
        ? '開始・終了を HH:MM で入力してください（終了は 26:00 のような翌日表記可）'
        : toMin(end) <= toMin(start)
          ? '終了は開始より後にしてください'
          : form.breakMinutes.trim() === '' || !Number.isInteger(brk) || brk < 0 || brk > 240
            ? '休憩は0〜240分で入力してください'
            : null;
  return (
    <Modal title="勤務パターン" onClose={onClose} footer={<button className="btn" onClick={onClose}>閉じる</button>}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="small muted">よく使う勤務時間を登録しておくと、シフト作成時にワンタップで入力できます。</p>
        {patterns.length === 0 ? (
          <Empty>勤務パターンはまだありません</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>時間</th>
                  <th className="r">休憩</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {patterns.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="num">
                      {p.start}–{p.end}
                    </td>
                    <td className="r num">{p.breakMinutes}分</td>
                    <td className="r">
                      <button className="btn btn-sm" onClick={() => setForm({ id: p.id, name: p.name, start: p.start, end: p.end, breakMinutes: String(p.breakMinutes) })}>
                        編集
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!form && (
          <div>
            <button className="btn btn-primary" onClick={() => setForm({ name: '', start: '18:00', end: '24:00', breakMinutes: '45' })}>
              パターンを追加
            </button>
          </div>
        )}
        {form && (
          <div className="panel">
            <div className="panel-body stack" style={{ gap: 10 }}>
              <h3>{form.id ? 'パターンを編集' : '新しいパターン'}</h3>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
                <Field label="名前">
                  <input className="input" maxLength={30} value={form.name} placeholder="例: 遅番" onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </Field>
                <Field label="開始">
                  <input className="input num" inputMode="numeric" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
                </Field>
                <Field label="終了">
                  <input className="input num" inputMode="numeric" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
                </Field>
                <Field label="休憩（分）">
                  <input className="input num" type="number" min={0} max={240} value={form.breakMinutes} onChange={(e) => setForm({ ...form, breakMinutes: e.target.value })} />
                </Field>
              </div>
              {err && <div className="small" style={{ color: 'var(--bull)' }}>{err}</div>}
              {start && end && !err && <div className="small muted">予定実働 {hm(Math.max(0, toMin(end) - toMin(start) - brk))}</div>}
              <div className="row">
                <button className="btn" onClick={() => setForm(null)}>
                  キャンセル
                </button>
                <button
                  className="btn btn-primary"
                  disabled={busy || !!err}
                  onClick={async () => {
                    const r = await run(() => client.call('shiftPatterns.upsert', { id: form.id, name: form.name.trim(), start, end, breakMinutes: brk }), '勤務パターンを保存しました');
                    if (r) {
                      setForm(null);
                      onChanged();
                    }
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
