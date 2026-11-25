/**
 * 店舗共用 iPad（スタッフ用）
 * - 端末認証トークンのみ localStorage に保存（業務データは保存しない）
 * - 氏名選択 → 個別 PIN → 打刻 → 完了表示後に自動ログアウト
 * - 無操作・タブ非表示・ページ復元（bfcache）で個人セッションを終了し、表示中の個人情報を破棄
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, Client, newRequestId, type Transport } from '../api/transport';
import { ClientContext, useClient, Empty, ErrorBox, Loading, Minutes, Modal, ToastProvider, Yen, useLoad, AnomalyBadges, todayJst, shiftDate, timeOf, WEEKDAYS } from '../components/ui';
import { LogoMark, Wordmark } from '../components/brand';
import { PayslipView } from '../components/payslip';
import type { PayslipData } from '../../shared/payslip';
import { PAGES } from '../admin/registry';
import './kiosk.css';

const DEVICE_KEY = 'shiftly.device.v1';

function readDeviceToken(): string {
  try {
    const v = localStorage.getItem(DEVICE_KEY) ?? '';
    return /^[0-9a-f]{64}$/.test(v) ? v : '';
  } catch {
    return '';
  }
}
function writeDeviceToken(v: string | null) {
  try {
    if (v) localStorage.setItem(DEVICE_KEY, v);
    else localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* 保存不可（プライベートモード等）の場合は再登録が必要 */
  }
}

type PunchType = 'clock_in' | 'clock_out' | 'break_start' | 'break_end';
interface Me {
  employee: { id: string; displayName: string; payType: string };
  permissions: string[];
  state: string;
  stateLabel: string;
  allowedPunches: PunchType[];
  staleOpenSince?: number | null;
}

/** 追加認証（STEP_UP_REQUIRED）を受けたらパスコードを求めて再試行するクライアント */
class KioskClient extends Client {
  stepUpPrompt: (() => Promise<boolean>) | null = null;
  override async call<T>(op: string, args?: unknown, opts: { requestId?: string } = {}): Promise<T> {
    try {
      return await super.call<T>(op, args, opts);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED' && this.stepUpPrompt) {
        if (await this.stepUpPrompt()) return super.call<T>(op, args, opts);
      }
      throw e;
    }
  }
}

export function KioskApp({ transport, injectedDeviceToken, sampleNotice }: { transport: Transport; injectedDeviceToken?: string; sampleNotice?: string }) {
  const client = useMemo(() => new KioskClient(transport), [transport]);
  const [device, setDevice] = useState<string>(() => injectedDeviceToken ?? readDeviceToken());
  client.device = device;
  return (
    <ToastProvider>
      <ClientContext.Provider value={client}>
        <div className="kiosk">
          {sampleNotice && <div className="sample-banner">{sampleNotice}</div>}
          {device ? (
            <KioskHome
              client={client}
              onDeviceRevoked={() => {
                writeDeviceToken(null);
                setDevice('');
              }}
            />
          ) : (
            <Enroll
              client={client}
              onEnrolled={(t) => {
                writeDeviceToken(t);
                setDevice(t);
              }}
            />
          )}
        </div>
      </ClientContext.Provider>
    </ToastProvider>
  );
}

function Enroll({ client, onEnrolled }: { client: Client; onEnrolled: (t: string) => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await client.call<{ deviceToken: string }>('staff.enroll', { code, userAgent: navigator.userAgent.slice(0, 200) });
      onEnrolled(r.deviceToken);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登録に失敗しました');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'grid', placeItems: 'center', flex: 1, padding: 24 }}>
      <div style={{ maxWidth: 440, width: '100%', display: 'grid', gap: 16 }}>
        <Wordmark size={40} />
        <h1>この iPad を店舗端末として登録</h1>
        <p style={{ color: 'var(--k-ink-2)' }}>店長の管理画面「店舗端末」で発行した登録コード（10文字・15分間有効）を入力してください。</p>
        <input className="input" style={{ fontSize: '1.6rem', letterSpacing: '0.15em', textAlign: 'center', color: 'var(--ink)' }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={14} autoComplete="off" autoCorrect="off" spellCheck={false} aria-label="登録コード" />
        {err && <ErrorBox message={err} />}
        <button className="btn btn-primary btn-lg" disabled={busy || code.replace(/[^A-Z0-9]/g, '').length < 10} onClick={submit}>
          {busy ? '登録中…' : '端末を登録'}
        </button>
      </div>
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function jstParts(t: number) {
  const d = new Date(t + 9 * 3600_000);
  return { hh: String(d.getUTCHours()).padStart(2, '0'), mm: String(d.getUTCMinutes()).padStart(2, '0'), ss: String(d.getUTCSeconds()).padStart(2, '0'), date: `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEKDAYS[d.getUTCDay()]}）` };
}

function KioskHome({ client, onDeviceRevoked }: { client: KioskClient; onDeviceRevoked: () => void }) {
  const [boot, setBoot] = useState<{ storeName: string; idleTimeoutSec: number; staff: Array<{ id: string; displayName: string; kana: string }> } | null>(null);
  const [bootErr, setBootErr] = useState('');
  const [online, setOnline] = useState(true);
  const [picked, setPicked] = useState<{ id: string; displayName: string } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const now = useClock();

  const loadBoot = useCallback(async () => {
    const r = await client.raw<typeof boot>('staff.bootstrap');
    if (r.ok) {
      setBoot(r.data);
      setOnline(true);
      setBootErr('');
    } else if (r.error.code === 'DEVICE_NOT_REGISTERED') onDeviceRevoked();
    else {
      setOnline(r.error.code !== 'NETWORK');
      setBootErr(r.error.message);
    }
  }, [client, onDeviceRevoked]);

  useEffect(() => {
    void loadBoot();
    const t = setInterval(() => void loadBoot(), 10 * 60_000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [loadBoot]);

  const logout = useCallback(() => {
    if (client.session) void client.raw('auth.logout');
    client.session = '';
    setMe(null);
    setPicked(null);
  }, [client]);

  // タブ非表示・ページ復元時は個人セッションを終了
  useEffect(() => {
    const vis = () => document.visibilityState === 'hidden' && logout();
    const show = (e: PageTransitionEvent) => e.persisted && logout();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pageshow', show);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pageshow', show);
    };
  }, [logout]);

  const t = jstParts(now);
  if (me) return <PersonScreen client={client} me={me} setMe={setMe} idleSec={boot?.idleTimeoutSec ?? 60} onLogout={logout} />;

  return (
    <>
      <div className="k-top">
        <LogoMark size={30} />
        <strong style={{ fontSize: '1.05rem' }}>{boot?.storeName ?? 'Shiftly'}</strong>
        <span className="spacer" />
        <span className={`k-online ${online ? '' : 'off'}`}>
          <i aria-hidden="true" />
          {online ? 'オンライン' : 'オフライン（打刻できません）'}
        </span>
      </div>
      <main className="k-main">
        <div className="k-clock" aria-live="off">
          <div className="time">
            {t.hh}:{t.mm}
            <small>{t.ss}</small>
          </div>
          <div className="date">{t.date}</div>
          <div className="store">{online ? '名前をタップして PIN を入力してください' : '通信が回復するまで紙のタイムカードに記録してください'}</div>
        </div>
        <section className="k-staff" aria-label="スタッフ選択">
          <h2>スタッフを選択</h2>
          {bootErr && <ErrorBox message={bootErr} onRetry={() => void loadBoot()} />}
          {!boot && !bootErr && <Loading />}
          {boot && boot.staff.length === 0 && <Empty>スタッフが登録されていません。店長の管理画面で登録してください。</Empty>}
          <div className="k-tiles">
            {boot?.staff.map((s) => (
              <button key={s.id} className="k-tile" onClick={() => setPicked(s)}>
                <span>{s.displayName}</span>
                <small>{s.kana}</small>
              </button>
            ))}
          </div>
        </section>
      </main>
      {picked && <PinDialog client={client} staff={picked} onCancel={() => setPicked(null)} onLoggedIn={(m) => { setPicked(null); setMe(m); }} />}
    </>
  );
}

function PinDialog({ client, staff, onCancel, onLoggedIn }: { client: Client; staff: { id: string; displayName: string }; onCancel: () => void; onLoggedIn: (m: Me) => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = useCallback(
    async (p: string) => {
      setBusy(true);
      setErr('');
      try {
        const r = await client.call<Me & { sessionToken: string }>('auth.login', { employeeId: staff.id, pin: p });
        client.session = r.sessionToken;
        onLoggedIn({ employee: r.employee, permissions: r.permissions, state: r.state, stateLabel: r.stateLabel, allowedPunches: r.allowedPunches, staleOpenSince: r.staleOpenSince });
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'ログインに失敗しました');
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [client, staff.id, onLoggedIn],
  );
  const press = (d: string) => {
    if (busy) return;
    const next = (pin + d).slice(0, 6);
    setPin(next);
    if (next.length === 6) void submit(next);
  };
  return (
    <div className="modal-backdrop" style={{ background: 'rgba(8,16,12,0.85)' }}>
      <div className="k-pin" role="dialog" aria-modal="true" aria-label={`${staff.displayName}さんの PIN 入力`}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{staff.displayName}さん</div>
          <div style={{ color: 'var(--k-ink-2)' }}>6桁の PIN を入力</div>
        </div>
        <div className="k-dots" aria-label={`${pin.length}桁入力済み`}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <i key={i} className={i < pin.length ? 'on' : ''} />
          ))}
        </div>
        {err && <div className="callout callout-bull" role="alert" style={{ color: 'var(--ink)' }}>{err}</div>}
        {busy && <div style={{ textAlign: 'center', color: 'var(--k-ink-2)' }}>確認中…</div>}
        <div className="k-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} className="k-key" onClick={() => press(d)} disabled={busy}>
              {d}
            </button>
          ))}
          <button className="k-key sub" onClick={onCancel}>
            キャンセル
          </button>
          <button className="k-key" onClick={() => press('0')} disabled={busy}>
            0
          </button>
          <button className="k-key sub" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy} aria-label="1文字削除">
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

const PUNCH_UI: Array<{ type: PunchType; label: string; cls: string; reason: (st: string) => string }> = [
  { type: 'clock_in', label: '出勤', cls: 'in', reason: () => 'すでに出勤中です' },
  { type: 'break_start', label: '休憩開始', cls: 'brk', reason: (st) => (st === 'on_break' ? '休憩中です' : '勤務中のみ') },
  { type: 'break_end', label: '休憩終了', cls: 'brk', reason: () => '休憩中のみ' },
  { type: 'clock_out', label: '退勤', cls: 'out', reason: () => '勤務中のみ' },
];

type Tab = 'punch' | 'attendance' | 'shifts' | 'pay' | 'payslips' | 'leave' | 'notifications' | 'manage';

function PersonScreen({ client, me, setMe, idleSec, onLogout }: { client: KioskClient; me: Me; setMe: (m: Me) => void; idleSec: number; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('punch');
  const [sending, setSending] = useState<PunchType | null>(null);
  const [done, setDone] = useState<{ label: string; at: string } | null>(null);
  const [err, setErr] = useState('');
  const [confirmBreakOut, setConfirmBreakOut] = useState(false);
  // 保存結果を確認できなかった打刻（同じ requestId で再送するためメモリにのみ保持。端末には保存しない）
  const [unknown, setUnknown] = useState<{ type: PunchType; requestId: string; endBreakConfirmed: boolean } | null>(null);
  const [stepUp, setStepUp] = useState<null | ((ok: boolean) => void)>(null);
  const [remain, setRemain] = useState(idleSec);
  const last = useRef(Date.now());

  // 無操作タイムアウト
  useEffect(() => {
    const bump = () => (last.current = Date.now());
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      const left = idleSec - Math.floor((Date.now() - last.current) / 1000);
      setRemain(left);
      if (left <= 0) onLogout();
    }, 1000);
    return () => {
      clearInterval(t);
      evs.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [idleSec, onLogout]);

  useEffect(() => {
    client.stepUpPrompt = () => new Promise<boolean>((resolve) => setStepUp(() => resolve));
    return () => {
      client.stepUpPrompt = null;
    };
  }, [client]);

  const has = (p: string) => me.permissions.includes(p);

  const punch = async (type: PunchType, endBreakConfirmed = false, retryOf?: { requestId: string }) => {
    if (sending) return;
    setSending(type);
    setErr('');
    // 結果不明の打刻を再送する場合は同じ requestId を使う（サーバー側で未完了の書き込みを回収し、保存済みなら同じ結果を返す＝二重登録しない）
    const requestId = retryOf?.requestId ?? newRequestId();
    const finish = (label: string, at: string) => {
      setDone({ label, at });
      setTimeout(onLogout, 2500);
    };
    try {
      const r = await client.raw<{ label: string; at: string }>('attendance.punch', { type, endBreakConfirmed }, { requestId });
      if (r.ok) {
        setUnknown(null);
        return finish(r.data.label, r.data.at);
      }
      if (r.error.code === 'BREAK_END_CONFIRM_REQUIRED') {
        setConfirmBreakOut(true);
        return;
      }
      if (r.error.code === 'NETWORK' || r.error.code === 'BAD_RESPONSE' || r.error.code === 'INTERNAL') {
        // 保存結果が不明: サーバー上の記録を確認（同じ requestId）。見つからなくても「未保存」とは断定しない
        const chk = await client.raw<{ saved: boolean; at?: string }>('attendance.lookup', { requestId });
        if (chk.ok && chk.data.saved) {
          setUnknown(null);
          return finish(PUNCH_UI.find((p) => p.type === type)!.label, chk.data.at ?? '');
        }
        setUnknown({ type, requestId, endBreakConfirmed });
        setErr('打刻が保存できたか確認できませんでした。下の「同じ打刻をもう一度送信」を押してください（同じ打刻として扱うため二重には記録されません）。つながらない場合は紙のタイムカードに記録し、店長に伝えてください');
        return;
      }
      if (retryOf) setUnknown(null);
      setErr(r.error.message);
      const m = await client.raw<Me>('auth.me');
      if (m.ok) setMe({ ...me, ...m.data });
    } finally {
      setSending(null);
    }
  };

  if (done)
    return (
      <div className="k-done" role="status" aria-live="assertive">
        <div>
          <div className="what">{me.employee.displayName}さん　{done.label}しました</div>
          <div className="at">{done.at.slice(11, 16)}</div>
          <div style={{ color: 'var(--k-ink-2)' }}>保存を確認しました。自動でログアウトします</div>
        </div>
      </div>
    );

  const tabs: Array<[Tab, string, boolean]> = [
    ['punch', '打刻', has('punch_self')],
    ['attendance', '自分の勤怠', has('attendance_view_self')],
    ['shifts', 'シフト', has('shift_view_published')],
    ['pay', '給与', has('payroll_view_self')],
    ['payslips', '給与明細', has('payslip_view_self')],
    ['leave', '有給', has('leave_view_self')],
    ['notifications', 'お知らせ', has('notifications_view')],
    ['manage', '管理メニュー', PAGES.some((p) => p.perms && p.perms.some((x) => has(x)))],
  ];

  return (
    <>
      <div className="k-top">
        <LogoMark size={30} />
        <span className="spacer" />
        <span className="k-idle" aria-live="off">
          {remain}秒操作がないと自動でログアウトします
        </span>
        <button className="btn" onClick={onLogout}>
          ログアウト
        </button>
      </div>
      <main className="k-person">
        <div className="k-state">
          <span className="name">{me.employee.displayName}さん</span>
          <span className="st">{me.stateLabel}</span>
          {me.staleOpenSince ? <span className="badge badge-warn">前回の退勤打刻がありません（店長に修正を依頼してください）</span> : null}
        </div>
        <div className="k-tabs" role="tablist">
          {tabs
            .filter((x) => x[2])
            .map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
        </div>
        {tab === 'punch' && (
          <>
            {err && <div className="callout callout-bull" role="alert" style={{ color: 'var(--ink)' }}>{err}</div>}
            {unknown && (
              <div style={{ margin: '8px 0' }}>
                <button className="btn btn-primary" disabled={!!sending} onClick={() => void punch(unknown.type, unknown.endBreakConfirmed, unknown)}>
                  {sending ? '送信中…' : `同じ打刻（${PUNCH_UI.find((p) => p.type === unknown.type)!.label}）をもう一度送信`}
                </button>
              </div>
            )}
            <div className="k-actions">
              {PUNCH_UI.map((p) => {
                const allowed = me.allowedPunches.includes(p.type) || (p.type === 'clock_out' && me.state === 'on_break');
                return (
                  <button key={p.type} className={`k-act ${p.cls}`} disabled={!allowed || !!sending} onClick={() => void punch(p.type)}>
                    {sending === p.type ? '送信中…' : p.label}
                    {!allowed && <small>{p.reason(me.state)}</small>}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {tab !== 'punch' && (
          <div className="k-sheet">
            <ClientContext.Provider value={client}>
              {tab === 'attendance' && <MyAttendance />}
              {tab === 'shifts' && <MyShifts />}
              {tab === 'pay' && <MyPay />}
              {tab === 'payslips' && <MyPayslips />}
              {tab === 'leave' && <MyLeave />}
              {tab === 'notifications' && <MyNotifications />}
              {tab === 'manage' && <ManageMenu perms={me.permissions} />}
            </ClientContext.Provider>
          </div>
        )}
      </main>
      {confirmBreakOut && (
        <Modal
          title="休憩中です"
          onClose={() => setConfirmBreakOut(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmBreakOut(false)}>
                戻る
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setConfirmBreakOut(false);
                  void punch('clock_out', true);
                }}
              >
                休憩を終了して退勤
              </button>
            </>
          }
        >
          <p>休憩を終了してから退勤として記録します。よろしいですか？</p>
        </Modal>
      )}
      {stepUp && <StepUpDialog client={client} onDone={(ok) => { stepUp(ok); setStepUp(null); }} />}
    </>
  );
}

function StepUpDialog({ client, onDone }: { client: Client; onDone: (ok: boolean) => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="追加認証"
      onClose={() => onDone(false)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(false)}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || v.length < 10}
            onClick={async () => {
              setBusy(true);
              const r = await client.raw('auth.stepUp', { passcode: v });
              setBusy(false);
              if (r.ok) onDone(true);
              else setErr(r.error.message);
            }}
          >
            認証
          </button>
        </>
      }
    >
      <p className="small" style={{ marginBottom: 8 }}>
        給与や個人情報を扱う操作には、管理用パスコード（PIN とは別）が必要です。認証は5分間有効です。
      </p>
      <input className="input" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} aria-label="管理用パスコード" />
      {err && <p style={{ color: 'var(--bull)', marginTop: 8 }}>{err}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ 本人用画面
function MyAttendance() {
  const client = useClient();
  const to = todayJst();
  const from = shiftDate(to, -30);
  const { data, error, loading, reload } = useLoad(() => client.call<{ sessions: Array<{ laborDate: string; start: string; end: string | null; breakMinutes: number; workMinutes: number; anomalies: string[] }> }>('attendance.mine', { from, to }), [from, to]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const ss = data!.sessions;
  if (!ss.length) return <Empty>直近30日の勤務記録はありません</Empty>;
  const total = ss.reduce((a, s) => a + s.workMinutes, 0);
  return (
    <div className="stack">
      <p>
        直近30日の実働 <strong><Minutes v={total} /></strong>（{ss.length}回）
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>日付</th>
              <th>出勤</th>
              <th>退勤</th>
              <th className="r">休憩</th>
              <th className="r">実働</th>
              <th>注意</th>
            </tr>
          </thead>
          <tbody>
            {[...ss].reverse().map((s) => (
              <tr key={s.start}>
                <td>{s.laborDate}</td>
                <td className="num">{timeOf(s.start)}</td>
                <td className="num">{timeOf(s.end)}</td>
                <td className="r"><Minutes v={s.breakMinutes} /></td>
                <td className="r"><Minutes v={s.workMinutes} /></td>
                <td><AnomalyBadges list={s.anomalies} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MyShifts() {
  const client = useClient();
  const from = todayJst();
  const to = shiftDate(from, 13);
  const { data, error, loading, reload } = useLoad(() => client.call<Array<{ id: string; employeeId: string; displayName: string; date: string; start: string; end: string; breakMinutes: number }>>('shifts.published', { from, to }), [from]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data!.length) return <Empty>公開されているシフトはまだありません</Empty>;
  const dates = [...new Set(data!.map((s) => s.date))].sort();
  return (
    <div className="stack">
      {dates.map((d) => (
        <div key={d}>
          <h3>
            {d}（{WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]}）
          </h3>
          <div className="row" style={{ marginTop: 6 }}>
            {data!
              .filter((s) => s.date === d)
              .map((s) => (
                <span key={s.id} className="badge badge-board" style={{ fontSize: '0.9rem', padding: '4px 10px' }}>
                  {s.displayName} <span className="num">{s.start}–{s.end}</span>
                </span>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MyPay() {
  const client = useClient();
  const { data, error, loading, reload } = useLoad(() => client.call<{ confirmed: Array<{ periodKey: string; payDate: string; revision: number; totals: { grossPay: number; netPay: number; workMinutes: number } }>; estimate: null | { periodKey: string; from: string; to: string; incomplete: boolean; workMinutes: number; grossPay: number } }>('payroll.mine'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const d = data!;
  return (
    <div className="stack">
      {d.estimate && (
        <div className="callout callout-board">
          <div>
            今期（{d.estimate.from}〜{d.estimate.to}）の見込額（未確定）: <strong><Yen v={d.estimate.grossPay} /></strong>　実働 <Minutes v={d.estimate.workMinutes} />
          </div>
          <div className="small muted">見込額は勤務実績からの概算で、控除前の金額です。{d.estimate.incomplete ? '給与条件の確認中のため金額は変わる可能性があります。' : ''}</div>
        </div>
      )}
      <h3>確定済みの給与</h3>
      {d.confirmed.length === 0 ? (
        <Empty>確定済みの給与はまだありません</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>対象月</th>
              <th>支払日</th>
              <th className="r">総支給</th>
              <th className="r">差引支給</th>
            </tr>
          </thead>
          <tbody>
            {d.confirmed.map((c) => (
              <tr key={c.periodKey}>
                <td>{c.periodKey}{c.revision > 1 && <span className="badge badge-warn" style={{ marginLeft: 6 }}>訂正</span>}</td>
                <td>{c.payDate}</td>
                <td className="r"><Yen v={c.totals.grossPay} /></td>
                <td className="r"><Yen v={c.totals.netPay} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MyPayslips() {
  const client = useClient();
  const { data, error, loading, reload } = useLoad(() => client.call<Array<{ id: string; periodKey: string; payDate: string; revision: number }>>('payslips.mine'), []);
  const [open, setOpen] = useState<PayslipData | null>(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (open)
    return (
      <div className="stack">
        <button className="btn" onClick={() => setOpen(null)}>
          一覧に戻る
        </button>
        <PayslipView d={open} />
        <p className="small muted">共用端末のため、明細のダウンロードはできません。紙の明細が必要な場合は店長に依頼してください。</p>
      </div>
    );
  if (!data!.length) return <Empty>発行済みの給与明細はありません</Empty>;
  return (
    <div className="stack">
      {data!.map((s) => (
        <button key={s.id} className="btn" style={{ justifyContent: 'space-between' }} onClick={async () => setOpen(await client.call<PayslipData>('payslips.view', { payslipId: s.id }))}>
          <span>{s.periodKey.replace('-', '年')}月分</span>
          <span className="muted small">支払日 {s.payDate}</span>
        </button>
      ))}
    </div>
  );
}

function MyLeave() {
  const client = useClient();
  const { data, error, loading, reload } = useLoad(() => client.call<{ balance: number; scheduled: number; grants: Array<{ id: string; grantDate: string; days: number; remaining: number; expiresOn: string; expired: boolean }>; fiveDay: Array<{ grantDate: string; deadline: string; taken: number; shortfall: number }> }>('leave.mine'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const d = data!;
  return (
    <div className="stack">
      <p style={{ fontSize: '1.2rem' }}>
        有給残日数 <strong className="num" style={{ fontSize: '2rem' }}>{d.balance}</strong> 日{d.scheduled > 0 && <span className="muted small">（取得予定 {d.scheduled}日 を差し引き済み）</span>}
      </p>
      {d.fiveDay.filter((f) => f.shortfall > 0).map((f) => (
        <div key={f.grantDate} className="callout callout-warn">
          {f.deadline} までに、あと {f.shortfall} 日の取得が必要です（年5日の取得義務）
        </div>
      ))}
      <table className="data">
        <thead>
          <tr>
            <th>付与日</th>
            <th className="r">付与</th>
            <th className="r">残り</th>
            <th>時効</th>
          </tr>
        </thead>
        <tbody>
          {d.grants.map((g) => (
            <tr key={g.id}>
              <td>{g.grantDate}</td>
              <td className="r num">{g.days}</td>
              <td className="r num">{g.expired ? '失効' : g.remaining}</td>
              <td>{g.expiresOn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MyNotifications() {
  const client = useClient();
  const { data, error, loading, reload } = useLoad(() => client.call<Array<{ id: string; title: string; body: string; createdAt: string; status: string }>>('notifications.list'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data!.length) return <Empty>新しいお知らせはありません</Empty>;
  return (
    <div className="stack">
      {data!.map((n) => (
        <div key={n.id} className="callout">
          <strong>{n.title}</strong>
          <div>{n.body}</div>
        </div>
      ))}
    </div>
  );
}

function ManageMenu({ perms }: { perms: string[] }) {
  const pages = PAGES.filter((p) => p.perms && p.perms.some((x) => perms.includes(x)));
  const [cur, setCur] = useState(pages[0]?.id ?? '');
  const Page = pages.find((p) => p.id === cur)?.component;
  return (
    <div className="stack">
      <div className="row">
        {pages.map((p) => (
          <button key={p.id} className={`btn btn-sm ${cur === p.id ? 'btn-primary' : ''}`} onClick={() => setCur(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="small muted">店長から委任された権限の範囲で操作できます。給与等の機密操作には追加認証が必要です。</p>
      {Page ? <Page /> : <Empty>利用できる管理メニューはありません</Empty>}
    </div>
  );
}
