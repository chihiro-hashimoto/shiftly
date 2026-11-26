/**
 * 店舗共用 iPad（Shiftly-Staff。v1.2 までの名称は Kiosk）
 * - 端末認証トークンのみ localStorage に保存（業務データ・セッショントークン・管理者トークンは保存しない）
 * - 氏名選択 →（PIN 設定済みなら PIN）→ 打刻 → 完了表示後に自動ログアウト
 *   PIN 未設定のスタッフは氏名選択のみでログインするが「本人未確認」として、給与・明細・勤怠の詳細は表示しない
 * - 右上の「管理者ページ」から管理者パスワードで管理者モードに入る（サーバー側で管理者セッションを検証）
 * - 無操作・タブ非表示・ページ復元（bfcache）・再読み込みで個人セッション・管理者モードを終了し、表示中の情報を破棄
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StaleViewGuard } from '../components/stale';
import { ApiError, Client, newRequestId, type Transport } from '../api/transport';
import { ClientContext, useClient, Empty, ErrorBox, Field, Loading, Minutes, Modal, ToastProvider, Yen, useLoad, useToast, AnomalyBadges, todayJst, shiftDate, timeOf, WEEKDAYS } from '../components/ui';
import { LogoMark, Wordmark } from '../components/brand';
import { PayslipView } from '../components/payslip';
import type { PayslipData } from '../../shared/payslip';
import { PAGES } from '../admin/registry';
import { AdminApp } from '../admin/AdminApp';
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH } from '../../shared/crypto';
import './staff.css';

const DEVICE_KEY = 'shiftly.device.v1';
const ADMIN_IDLE_SEC = 300;

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
  verified: boolean;
  breakMode: 'scheduled' | 'punch';
  state: string;
  stateLabel: string;
  allowedPunches: PunchType[];
  staleOpenSince?: number | null;
}

/** 追加認証（STEP_UP_REQUIRED）を受けたらパスコードを求めて再試行するクライアント（スタッフ用） */
class StaffClient extends Client {
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

/**
 * 管理者モード用クライアント（管理者トークンはこのオブジェクトのメモリ上のみ）
 * - REAUTH_REQUIRED: パスワードの再入力を求めて再試行
 * - ADMIN_UNAUTHENTICATED: 管理者モードを終了（無操作・失効・パスワード変更など）
 */
class AdminModeClient extends Client {
  reauthPrompt: (() => Promise<boolean>) | null = null;
  onExpired: (() => void) | null = null;
  override async call<T>(op: string, args?: unknown, opts: { requestId?: string } = {}): Promise<T> {
    try {
      return await super.call<T>(op, args, opts);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED' && this.reauthPrompt) {
        if (await this.reauthPrompt()) return super.call<T>(op, args, opts);
      }
      if (e instanceof ApiError && e.code === 'ADMIN_UNAUTHENTICATED') this.onExpired?.();
      throw e;
    }
  }
}

/**
 * スタッフ画面（店舗 iPad）の外側（D-026）。復元より前に読み込んだ画面と分かったら案内を出し、「読み込み直す」で
 * 画面全体（管理者モードを含む。ログイン中の状態・入力中の内容・クライアントの固定した世代）を作り直す
 */
export function StaffApp(props: { transport: Transport; injectedDeviceToken?: string; sampleNotice?: string }) {
  const [gen, setGen] = useState(0);
  return (
    <>
      <StaleViewGuard onReset={() => setGen((g) => g + 1)} />
      <StaffAppInner key={gen} {...props} />
    </>
  );
}

function StaffAppInner({ transport, injectedDeviceToken, sampleNotice }: { transport: Transport; injectedDeviceToken?: string; sampleNotice?: string }) {
  const client = useMemo(() => new StaffClient(transport), [transport]);
  const [device, setDevice] = useState<string>(() => injectedDeviceToken ?? readDeviceToken());
  client.device = device;
  return (
    <ToastProvider>
      <ClientContext.Provider value={client}>
        <StaffRoot
          client={client}
          transport={transport}
          device={device}
          sampleNotice={sampleNotice}
          onDeviceRevoked={() => {
            writeDeviceToken(null);
            setDevice('');
          }}
          onEnrolled={(t) => {
            writeDeviceToken(t);
            setDevice(t);
          }}
        />
      </ClientContext.Provider>
    </ToastProvider>
  );
}

function StaffRoot({ client, transport, device, sampleNotice, onDeviceRevoked, onEnrolled }: { client: StaffClient; transport: Transport; device: string; sampleNotice?: string; onDeviceRevoked: () => void; onEnrolled: (t: string) => void }) {
  const [adminClient, setAdminClient] = useState<AdminModeClient | null>(null);
  const adminRef = useRef<AdminModeClient | null>(null);
  const toast = useToast();
  const exitAdmin = useCallback(
    (reason?: string) => {
      const c = adminRef.current;
      if (!c) return;
      adminRef.current = null;
      // サーバー側で管理者セッションを失効（応答を待たずに画面は戻す）。トークンはメモリからも消す
      const token = c.adminSession;
      if (token) void c.raw('adminAuth.logout');
      c.adminSession = '';
      setAdminClient(null);
      if (reason) toast('info', reason);
    },
    [toast],
  );
  if (device && adminClient)
    return <AdminMode client={adminClient} transport={transport} sampleNotice={sampleNotice} onExit={exitAdmin} />;
  return (
    <div className="sf-app">
      {sampleNotice && <div className="sample-banner">{sampleNotice}</div>}
      {device ? (
        <StaffHome
          client={client}
          onDeviceRevoked={onDeviceRevoked}
          onAdmin={(token) => {
            const c = new AdminModeClient(transport);
            c.device = device;
            c.adminSession = token;
            adminRef.current = c;
            setAdminClient(c);
          }}
        />
      ) : (
        <Enroll client={client} onEnrolled={onEnrolled} />
      )}
    </div>
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
        <p style={{ color: 'var(--sf-ink-2)' }}>管理画面「店舗端末」で発行した登録コード（10文字・15分間有効）を入力してください。</p>
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

/** タブ非表示・bfcache からの復元で呼ぶ（共用端末に個人情報・管理情報を残さない） */
function useLeaveGuard(onLeave: () => void) {
  useEffect(() => {
    const vis = () => document.visibilityState === 'hidden' && onLeave();
    const show = (e: PageTransitionEvent) => e.persisted && onLeave();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pageshow', show);
    window.addEventListener('pagehide', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pageshow', show);
      window.removeEventListener('pagehide', onLeave);
    };
  }, [onLeave]);
}

function useIdle(idleSec: number, onIdle: () => void): number {
  const [remain, setRemain] = useState(idleSec);
  const last = useRef(Date.now());
  useEffect(() => {
    const bump = () => (last.current = Date.now());
    const evs = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      const left = idleSec - Math.floor((Date.now() - last.current) / 1000);
      setRemain(left);
      if (left <= 0) onIdle();
    }, 1000);
    return () => {
      clearInterval(t);
      evs.forEach((e) => window.removeEventListener(e, bump));
    };
  }, [idleSec, onIdle]);
  return remain;
}

function StaffHome({ client, onDeviceRevoked, onAdmin }: { client: StaffClient; onDeviceRevoked: () => void; onAdmin: (token: string) => void }) {
  const [boot, setBoot] = useState<{ storeName: string; idleTimeoutSec: number; breakMode: 'scheduled' | 'punch'; staff: Array<{ id: string; displayName: string; kana: string }> } | null>(null);
  const [bootErr, setBootErr] = useState('');
  const [online, setOnline] = useState(true);
  const [picked, setPicked] = useState<{ id: string; displayName: string } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [adminLogin, setAdminLogin] = useState(false);
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
    setAdminLogin(false);
  }, [client]);

  // タブ非表示・ページ復元時は個人セッションを終了
  useLeaveGuard(logout);

  const t = jstParts(now);
  if (me) return <PersonScreen client={client} me={me} setMe={setMe} idleSec={boot?.idleTimeoutSec ?? 60} onLogout={logout} />;

  return (
    <>
      <div className="sf-top">
        <LogoMark size={30} />
        <strong style={{ fontSize: '1.05rem' }}>{boot?.storeName ?? 'Shiftly'}</strong>
        <span className="spacer" />
        <span className={`sf-online ${online ? '' : 'off'}`}>
          <i aria-hidden="true" />
          {online ? 'オンライン' : 'オフライン（打刻できません）'}
        </span>
        <button className="btn sf-admin-entry" onClick={() => setAdminLogin(true)}>
          管理者ページ
        </button>
      </div>
      <main className="sf-main">
        <div className="sf-clock" aria-live="off">
          <div className="time">
            {t.hh}:{t.mm}
            <small>{t.ss}</small>
          </div>
          <div className="date">{t.date}</div>
          <div className="store">{online ? '名前をタップしてください（PIN を設定している場合は PIN を入力）' : '通信が回復するまで紙のタイムカードに記録してください'}</div>
        </div>
        <section className="sf-staff" aria-label="スタッフ選択">
          <h2>スタッフを選択</h2>
          {bootErr && <ErrorBox message={bootErr} onRetry={() => void loadBoot()} />}
          {!boot && !bootErr && <Loading />}
          {boot && boot.staff.length === 0 && <Empty>スタッフが登録されていません。管理者ページで登録してください。</Empty>}
          <div className="sf-tiles">
            {boot?.staff.map((s) => (
              <button key={s.id} className="sf-tile" onClick={() => setPicked(s)}>
                <span>{s.displayName}</span>
                <small>{s.kana}</small>
              </button>
            ))}
          </div>
        </section>
      </main>
      {picked && (
        <PinDialog
          client={client}
          staff={picked}
          onCancel={() => setPicked(null)}
          onLoggedIn={(m) => {
            setPicked(null);
            setMe(m);
          }}
        />
      )}
      {adminLogin && (
        <AdminLoginDialog
          client={client}
          onCancel={() => setAdminLogin(false)}
          onSuccess={(token) => {
            setAdminLogin(false);
            onAdmin(token);
          }}
        />
      )}
    </>
  );
}

type LoginResult = Me & { sessionToken: string };

/**
 * 氏名選択後: まず PIN なしでログインを試す（PIN 未設定のスタッフはそのまま本人未確認でログイン）。
 * サーバーが PIN_REQUIRED を返した場合だけ PIN を入力する（PIN の有無はサーバーが判定。空欄で回避できない）
 */
function PinDialog({ client, staff, onCancel, onLoggedIn }: { client: Client; staff: { id: string; displayName: string }; onCancel: () => void; onLoggedIn: (m: Me) => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [needPin, setNeedPin] = useState(false);
  // キャンセル・タブ非表示・画面の破棄の後に届いたログインの応答では本人画面を開かない（Codex 監査3 #5）
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const cancel = () => {
    alive.current = false;
    onCancel();
  };
  /** ログインの応答を採用するか。間に合わなかった場合は発行されたセッションをサーバー側で失効させる */
  const accept = useCallback(
    (r: LoginResult): boolean => {
      if (alive.current && document.visibilityState !== 'hidden') return true;
      const probe = new Client(client.transport);
      probe.device = client.device;
      probe.session = r.sessionToken;
      void probe.raw('auth.logout');
      return false;
    },
    [client],
  );
  const done = useCallback(
    (r: LoginResult) => {
      if (!accept(r)) return;
      client.session = r.sessionToken;
      onLoggedIn({ employee: r.employee, permissions: r.permissions, verified: r.verified, breakMode: r.breakMode, state: r.state, stateLabel: r.stateLabel, allowedPunches: r.allowedPunches, staleOpenSince: r.staleOpenSince });
    },
    [client, onLoggedIn, accept],
  );
  // スタッフのセッションは、ログインの応答で初めて設定する（試行中の送信には含めない）
  const login = useCallback(
    async (p: string | null) => {
      const probe = new Client(client.transport);
      probe.device = client.device;
      return probe.raw<LoginResult>('auth.login', { employeeId: staff.id, pin: p });
    },
    [client, staff.id],
  );
  useEffect(() => {
    void (async () => {
      const r = await login(null);
      if (r.ok) return done(r.data);
      if (!alive.current) return;
      if (r.error.code === 'PIN_REQUIRED') setNeedPin(true);
      else setErr(r.error.message);
      setBusy(false);
    })();
  }, [login, done]);
  const submit = async () => {
    if (pin.length < PIN_MIN_LENGTH) return;
    setBusy(true);
    setErr('');
    const p = pin;
    setPin('');
    const r = await login(p);
    if (r.ok) return done(r.data);
    if (!alive.current) return;
    setErr(r.error.message);
    setBusy(false);
  };
  const press = (d: string) => {
    if (busy) return;
    setPin((x) => (x + d).slice(0, PIN_MAX_LENGTH));
  };
  return (
    <div className="modal-backdrop" style={{ background: 'rgba(8,16,12,0.85)' }}>
      <div className="sf-pin" role="dialog" aria-modal="true" aria-label={`${staff.displayName}さんの PIN 入力`}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{staff.displayName}さん</div>
          <div style={{ color: 'var(--sf-ink-2)' }}>{needPin ? `PIN（${PIN_MIN_LENGTH}桁以上）を入力して「確定」` : '確認中…'}</div>
        </div>
        <div className="sf-dots" aria-label={`${pin.length}桁入力済み`}>
          {Array.from({ length: Math.max(PIN_MIN_LENGTH, pin.length) }, (_, i) => (
            <i key={i} className={i < pin.length ? 'on' : ''} />
          ))}
        </div>
        {err && <div className="callout callout-bull" role="alert" style={{ color: 'var(--ink)' }}>{err}</div>}
        <div className="sf-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} className="sf-key" onClick={() => press(d)} disabled={busy || !needPin}>
              {d}
            </button>
          ))}
          <button className="sf-key sub" onClick={cancel}>
            キャンセル
          </button>
          <button className="sf-key" onClick={() => press('0')} disabled={busy || !needPin}>
            0
          </button>
          <button className="sf-key sub" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy || !needPin} aria-label="1文字削除">
            削除
          </button>
        </div>
        <button className="btn btn-primary btn-lg sf-pin-ok" disabled={busy || !needPin || pin.length < PIN_MIN_LENGTH} onClick={() => void submit()}>
          {busy && needPin ? '確認中…' : '確定'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 管理者ページ
function AdminLoginDialog({ client, onCancel, onSuccess }: { client: Client; onCancel: () => void; onSuccess: (token: string) => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // キャンセル・タブ非表示・画面の破棄の後に届いた応答では管理者モードにしない（Codex 監査2 #9）
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const cancel = () => {
    alive.current = false;
    onCancel();
  };
  const submit = async () => {
    setBusy(true);
    setErr('');
    const v = pw;
    setPw('');
    // スタッフのセッションは送らない（管理者の認証はスタッフの認証と無関係）
    const probe = new Client(client.transport);
    probe.device = client.device;
    const r = await probe.raw<{ adminSessionToken: string }>('adminAuth.login', { password: v });
    if (!alive.current || document.visibilityState === 'hidden') {
      // 間に合わなかった応答で発行されたセッションは、使わずにサーバー側で失効させる
      if (r.ok) {
        probe.adminSession = r.data.adminSessionToken;
        void probe.raw('adminAuth.logout');
        probe.adminSession = '';
      }
      return;
    }
    setBusy(false);
    if (r.ok) onSuccess(r.data.adminSessionToken);
    else setErr(r.error.message);
  };
  return (
    <Modal
      title="管理者ページ"
      onClose={cancel}
      footer={
        <>
          <button className="btn" onClick={cancel}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || pw.length === 0} onClick={() => void submit()}>
            {busy ? '確認中…' : '管理者モードに入る'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pw) void submit();
        }}
        className="stack"
        style={{ gap: 10 }}
      >
        <Field label="管理者パスワード">
          <input className="input" type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="管理者パスワード" autoFocus />
        </Field>
        {err && (
          <div className="callout callout-bull" role="alert">
            {err}
          </div>
        )}
        <p className="small muted">スタッフの PIN とは別のパスワードです。5分間操作がないと自動でスタッフ画面に戻ります。</p>
      </form>
    </Modal>
  );
}

function AdminMode({ client, transport, sampleNotice, onExit }: { client: AdminModeClient; transport: Transport; sampleNotice?: string; onExit: (reason?: string) => void }) {
  const [reauth, setReauth] = useState<null | ((ok: boolean) => void)>(null);
  const [changePw, setChangePw] = useState(false);
  const exitIdle = useCallback(() => onExit('5分間操作がなかったため、管理者モードを終了しました'), [onExit]);
  const exitLeave = useCallback(() => onExit(), [onExit]);
  const remain = useIdle(ADMIN_IDLE_SEC, exitIdle);
  useLeaveGuard(exitLeave);
  useEffect(() => {
    client.reauthPrompt = () => new Promise<boolean>((resolve) => setReauth(() => resolve));
    client.onExpired = () => onExit('管理者モードが終了しました（有効期限切れ・無操作・パスワード変更のいずれか）');
    return () => {
      client.reauthPrompt = null;
      client.onExpired = null;
    };
  }, [client, onExit]);
  const banner = (
    <div className="sf-adminbar no-print" role="region" aria-label="管理者モード">
      <strong>管理者モード</strong>
      <span className="small">操作がないと {Math.max(0, Math.ceil(remain / 60))} 分以内にスタッフ画面へ戻ります</span>
      <span className="spacer" />
      <button className="btn btn-sm" onClick={() => setChangePw(true)}>
        パスワード変更
      </button>
      <button className="btn btn-sm" onClick={() => onExit()}>
        スタッフ画面へ戻る
      </button>
      <button className="btn btn-sm" onClick={() => onExit('ログアウトしました')}>
        ログアウト
      </button>
    </div>
  );
  return (
    <>
      <AdminApp
        transport={transport}
        client={client}
        embedded
        banner={banner}
        sampleNotice={sampleNotice}
        brandExtra={
          <span className="sf-admin-badge">
            <span className="tag">管理者モード</span>
            <button className="btn btn-sm" onClick={() => onExit()} aria-label="管理者モードを終了">
              戻る
            </button>
          </span>
        }
      />
      {reauth && (
        <AdminReauthDialog
          client={client}
          onDone={(ok) => {
            reauth(ok);
            setReauth(null);
          }}
        />
      )}
      {changePw && <AdminChangePasswordDialog client={client} onClose={() => setChangePw(false)} onChanged={() => onExit('パスワードを変更しました。新しいパスワードでもう一度ログインしてください')} />}
    </>
  );
}

function AdminReauthDialog({ client, onDone }: { client: Client; onDone: (ok: boolean) => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="管理者パスワードの再入力"
      onClose={() => onDone(false)}
      footer={
        <>
          <button className="btn" onClick={() => onDone(false)}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !v}
            onClick={async () => {
              setBusy(true);
              const p = v;
              setV('');
              const r = await client.raw('adminAuth.reauth', { password: p });
              setBusy(false);
              if (r.ok) onDone(true);
              else setErr(r.error.message);
            }}
          >
            確認
          </button>
        </>
      }
    >
      <p className="small" style={{ marginBottom: 8 }}>
        給与確定・権限変更・バックアップの復元・PIN の設定などの重要な操作の前に、管理者パスワードをもう一度入力してください（5分間有効）。
      </p>
      <input className="input" type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} aria-label="管理者パスワード" autoFocus />
      {err && <p style={{ color: 'var(--bull)', marginTop: 8 }}>{err}</p>}
    </Modal>
  );
}

function AdminChangePasswordDialog({ client, onClose, onChanged }: { client: Client; onClose: () => void; onChanged: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="管理者パスワードの変更"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !cur || next.length < 12 || next !== next2}
            onClick={async () => {
              setBusy(true);
              const r = await client.raw('adminAuth.changePassword', { currentPassword: cur, newPassword: next });
              setBusy(false);
              setCur('');
              setNext('');
              setNext2('');
              if (r.ok) onChanged();
              else setErr(r.error.message);
            }}
          >
            変更
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <Field label="現在のパスワード">
          <input className="input" type="password" autoComplete="off" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label="新しいパスワード（12文字以上・英大文字/英小文字/数字/記号のうち3種類以上）">
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="確認のためもう一度">
          <input className="input" type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} />
        </Field>
        {next2 && next !== next2 && <p className="small" style={{ color: 'var(--bull)' }}>確認用のパスワードが一致しません</p>}
        {err && <p style={{ color: 'var(--bull)' }}>{err}</p>}
        <p className="small muted">変更すると、すべての管理者モードが終了します。パスワードを忘れた場合は、Google 所有者の管理画面（Shiftly-Admin）で再設定します。</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ 本人の画面
const PUNCH_UI: Array<{ type: PunchType; label: string; cls: string; reason: (st: string) => string }> = [
  { type: 'clock_in', label: '出勤', cls: 'in', reason: () => 'すでに出勤中です' },
  { type: 'break_start', label: '休憩開始', cls: 'brk', reason: (st) => (st === 'on_break' ? '休憩中です' : '勤務中のみ') },
  { type: 'break_end', label: '休憩終了', cls: 'brk', reason: () => '休憩中のみ' },
  { type: 'clock_out', label: '退勤', cls: 'out', reason: () => '勤務中のみ' },
];

type Tab = 'punch' | 'attendance' | 'request' | 'overtime' | 'shifts' | 'pay' | 'payslips' | 'leave' | 'notifications' | 'manage';
interface BreakDecl {
  kind: 'as_scheduled' | 'not_taken' | 'custom';
  intervals?: Array<{ start: string; end: string }>;
  reason?: string;
  /** 「予定どおり」のとき、画面に表示した予定休憩（サーバーで現在の予定休憩と照合する） */
  expectedPlanned?: { start: string | null; end: string | null; minutes: number } | null;
}

/** 画面に表示した予定休憩（サーバーとの照合用。分単位） */
function plannedView(pb: { minutes: number; start: string | null; end: string | null } | null) {
  return pb ? { start: pb.start ? pb.start.slice(0, 16) : null, end: pb.end ? pb.end.slice(0, 16) : null, minutes: pb.minutes } : null;
}
interface ClockOutContext {
  breakMode: 'scheduled' | 'punch';
  open: boolean;
  plannedBreak: { minutes: number; start: string | null; end: string | null } | null;
  hasPunchedBreaks: boolean;
}

function PersonScreen({ client, me, setMe, idleSec, onLogout }: { client: StaffClient; me: Me; setMe: (m: Me) => void; idleSec: number; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('punch');
  const [sending, setSending] = useState<PunchType | null>(null);
  const [done, setDone] = useState<{ label: string; at: string } | null>(null);
  const [err, setErr] = useState('');
  const [confirmBreakOut, setConfirmBreakOut] = useState(false);
  const [breakAsk, setBreakAsk] = useState<ClockOutContext | null>(null);
  // 保存結果を確認できなかった打刻（同じ requestId で再送するためメモリにのみ保持。端末には保存しない）
  const [unknown, setUnknown] = useState<{ type: PunchType; requestId: string; endBreakConfirmed: boolean; breakDeclaration?: BreakDecl } | null>(null);
  const [stepUp, setStepUp] = useState<null | ((ok: boolean) => void)>(null);
  const remain = useIdle(idleSec, onLogout);

  useEffect(() => {
    client.stepUpPrompt = () => new Promise<boolean>((resolve) => setStepUp(() => resolve));
    return () => {
      client.stepUpPrompt = null;
    };
  }, [client]);

  const has = (p: string) => me.permissions.includes(p);

  const punch = async (type: PunchType, endBreakConfirmed = false, retryOf?: { requestId: string }, breakDeclaration?: BreakDecl) => {
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
      const r = await client.raw<{ label: string; at: string }>('attendance.punch', { type, endBreakConfirmed, ...(breakDeclaration ? { breakDeclaration } : {}) }, { requestId });
      if (r.ok) {
        setUnknown(null);
        return finish(r.data.label, r.data.at);
      }
      if (r.error.code === 'BREAK_END_CONFIRM_REQUIRED') {
        setConfirmBreakOut(true);
        return;
      }
      if (r.error.code === 'PLANNED_BREAK_CHANGED') {
        // 表示中にシフトの予定休憩が変わった: 最新の予定休憩で確認し直す（退勤は記録されていない）
        setErr(r.error.message);
        const c = await client.raw<ClockOutContext>('attendance.clockOutContext');
        if (c.ok && c.data.plannedBreak && !c.data.hasPunchedBreaks) setBreakAsk(c.data);
        return;
      }
      if (r.error.code === 'NETWORK' || r.error.code === 'BAD_RESPONSE' || r.error.code === 'INTERNAL') {
        // 保存結果が不明: サーバー上の記録を確認（同じ requestId）。見つからなくても「未保存」とは断定しない
        const chk = await client.raw<{ saved: boolean; at?: string }>('attendance.lookup', { requestId });
        if (chk.ok && chk.data.saved) {
          setUnknown(null);
          return finish(PUNCH_UI.find((p) => p.type === type)!.label, chk.data.at ?? '');
        }
        setUnknown({ type, requestId, endBreakConfirmed, breakDeclaration });
        setErr('打刻が保存できたか確認できませんでした。下の「同じ打刻をもう一度送信」を押してください（同じ打刻として扱うため二重には記録されません）。つながらない場合は紙のタイムカードに記録し、管理者に伝えてください');
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

  /** 退勤: 予定休憩がある勤務では、退勤操作の中で休憩の取得状況を確認する（通常は「予定どおり」を押すだけ） */
  const clockOut = async () => {
    if (me.breakMode === 'scheduled' && me.state !== 'on_break') {
      const c = await client.raw<ClockOutContext>('attendance.clockOutContext');
      if (c.ok && c.data.plannedBreak && !c.data.hasPunchedBreaks) {
        setBreakAsk(c.data);
        return;
      }
    }
    void punch('clock_out');
  };

  if (done)
    return (
      <div className="sf-done" role="status" aria-live="assertive">
        <div>
          <div className="what">
            {me.employee.displayName}さん　{done.label}しました
          </div>
          <div className="at">{done.at.slice(11, 16)}</div>
          <div style={{ color: 'var(--sf-ink-2)' }}>保存を確認しました。自動でログアウトします</div>
        </div>
      </div>
    );

  const tabs: Array<[Tab, string, boolean]> = me.verified
    ? [
        ['punch', '打刻', has('punch_self')],
        ['attendance', '自分の勤怠（確認・修正）', has('attendance_view_self')],
        ['overtime', '早出・残業申請', has('attendance_view_self')],
        ['shifts', 'シフト', has('shift_view_published')],
        ['pay', '給与', has('payroll_view_self')],
        ['payslips', '給与明細', has('payslip_view_self')],
        ['leave', '有給', has('leave_view_self')],
        ['notifications', 'お知らせ', has('notifications_view')],
        ['manage', '管理メニュー', PAGES.some((p) => p.perms && p.perms.some((x) => has(x)))],
      ]
    : [
        ['punch', '打刻', has('punch_self')],
        ['request', '勤怠の修正・申請', has('punch_self')],
        ['shifts', 'シフト', has('shift_view_published')],
      ];

  const showBreakButtons = me.breakMode === 'punch' || me.state === 'on_break';
  return (
    <>
      <div className="sf-top">
        <LogoMark size={30} />
        <span className="spacer" />
        <span className="sf-idle" aria-live="off">
          {remain}秒操作がないと自動でログアウトします
        </span>
        <button className="btn" onClick={onLogout}>
          ログアウト
        </button>
      </div>
      <main className="sf-person">
        <div className="sf-state">
          <span className="name">{me.employee.displayName}さん</span>
          <span className="st">{me.stateLabel}</span>
          {me.staleOpenSince ? <span className="badge badge-warn">前回の退勤打刻がありません（「自分の勤怠（確認・修正）」から申告してください）</span> : null}
        </div>
        {!me.verified && (
          <div className="callout callout-warn sf-unverified" style={{ color: 'var(--ink)' }}>
            PIN が設定されていないため、本人確認ができていません。打刻とシフトの確認はできますが、給与・給与明細・勤怠の詳細は表示されません。勤怠の修正や早出・残業の申請は、管理者の確認後に反映されます。
          </div>
        )}
        <div className="sf-tabs" role="tablist">
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
                <button className="btn btn-primary" disabled={!!sending} onClick={() => void punch(unknown.type, unknown.endBreakConfirmed, unknown, unknown.breakDeclaration)}>
                  {sending ? '送信中…' : `同じ打刻（${PUNCH_UI.find((p) => p.type === unknown.type)!.label}）をもう一度送信`}
                </button>
              </div>
            )}
            <div className="sf-actions">
              {PUNCH_UI.filter((p) => showBreakButtons || (p.type !== 'break_start' && p.type !== 'break_end')).map((p) => {
                const allowed = me.allowedPunches.includes(p.type) || (p.type === 'clock_out' && me.state === 'on_break');
                return (
                  <button key={p.type} className={`sf-act ${p.cls}`} disabled={!allowed || !!sending} onClick={() => void (p.type === 'clock_out' ? clockOut() : punch(p.type))}>
                    {sending === p.type ? '送信中…' : p.label}
                    {!allowed && <small>{p.reason(me.state)}</small>}
                  </button>
                );
              })}
            </div>
            {me.breakMode === 'scheduled' && <p className="small" style={{ color: 'var(--sf-ink-2)', marginTop: 10 }}>休憩はシフトの予定休憩で記録します。退勤のときに取得状況を確認します（休憩の時間が違った場合は、そのときに修正できます）。</p>}
          </>
        )}
        {tab !== 'punch' && (
          <div className="sf-sheet">
            <ClientContext.Provider value={client}>
              {tab === 'attendance' && <MyAttendance />}
              {tab === 'overtime' && <MyOvertime />}
              {tab === 'request' && <UnverifiedRequests />}
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
      {breakAsk && (
        <BreakAtClockOut
          ctx={breakAsk}
          onCancel={() => setBreakAsk(null)}
          onSubmit={(d) => {
            setBreakAsk(null);
            void punch('clock_out', false, undefined, d);
          }}
        />
      )}
      {stepUp && (
        <StepUpDialog
          client={client}
          onDone={(ok) => {
            stepUp(ok);
            setStepUp(null);
          }}
        />
      )}
    </>
  );
}

/** 'YYYY-MM-DDTHH:MM'（JST）: 今日の日付 + 時刻 */
function todayAt(hhmm: string): string {
  return `${todayJst()}T${hhmm}`;
}
const hm = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : '—');
/** 'YYYY-MM-DDTHH:MM:SS+09:00' の終了時刻を分単位に切り上げ（申請は分単位。秒の勤務を取りこぼさない） */
function ceilMinute(iso: string): string {
  if (iso.slice(17, 19) === '00' || iso.length < 19) return iso.slice(0, 16);
  const t = Date.parse(iso) + 60_000;
  const d = new Date(t + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function BreakRows({ rows, setRows }: { rows: Array<{ start: string; end: string }>; setRows: (r: Array<{ start: string; end: string }>) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ gap: 6 }}>
          <input className="input" type="datetime-local" value={r.start} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} aria-label={`休憩${i + 1}の開始`} style={{ width: 'auto' }} />
          <span>〜</span>
          <input className="input" type="datetime-local" value={r.end} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} aria-label={`休憩${i + 1}の終了`} style={{ width: 'auto' }} />
          {rows.length > 1 && (
            <button className="btn btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              削除
            </button>
          )}
        </div>
      ))}
      {rows.length < 6 && (
        <div>
          <button className="btn btn-sm" onClick={() => setRows([...rows, { start: rows[rows.length - 1]?.end ?? '', end: rows[rows.length - 1]?.end ?? '' }])}>
            休憩を追加
          </button>
        </div>
      )}
    </div>
  );
}

function BreakAtClockOut({ ctx, onCancel, onSubmit }: { ctx: ClockOutContext; onCancel: () => void; onSubmit: (d: BreakDecl) => void }) {
  const pb = ctx.plannedBreak!;
  const [mode, setMode] = useState<'ask' | 'not_taken' | 'custom'>('ask');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState([{ start: pb.start ? pb.start.slice(0, 16) : todayAt('12:00'), end: pb.end ? pb.end.slice(0, 16) : todayAt('13:00') }]);
  const label = pb.start ? `${hm(pb.start)}〜${hm(pb.end)}（${pb.minutes}分）` : `${pb.minutes}分`;
  return (
    <Modal
      title="退勤の前に: 休憩は予定どおり取れましたか？"
      onClose={onCancel}
      wide
      footer={
        mode === 'ask' ? (
          <>
            <button className="btn" onClick={onCancel}>
              戻る
            </button>
            <button className="btn" onClick={() => setMode('custom')}>
              休憩時間が違った
            </button>
            <button className="btn" onClick={() => setMode('not_taken')}>
              取れなかった
            </button>
            <button className="btn btn-primary btn-lg" onClick={() => onSubmit({ kind: 'as_scheduled', expectedPlanned: plannedView(pb) })}>
              予定どおり取得して退勤
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={() => setMode('ask')}>
              戻る
            </button>
            <button className="btn btn-primary" disabled={reason.trim().length < 2} onClick={() => onSubmit(mode === 'not_taken' ? { kind: 'not_taken', reason } : { kind: 'custom', intervals: rows, reason })}>
              この内容で退勤
            </button>
          </>
        )
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <p style={{ fontSize: '1.1rem' }}>
          シフトの予定休憩: <strong className="num">{label}</strong>
        </p>
        {mode === 'not_taken' && <p>休憩を取得できなかったとして記録します（休憩時間は給与から差し引きません）。</p>}
        {mode === 'custom' && (
          <>
            <p className="small">実際に取った休憩の時間を入力してください（短かった・長かった・時間帯が違った・追加の休憩があった場合）。</p>
            <BreakRows rows={rows} setRows={setRows} />
          </>
        )}
        {mode !== 'ask' && (
          <Field label="理由（必須）">
            <input className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
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

// ------------------------------------------------------------------ 勤怠確認・修正（本人確認済み）
interface DetailSession {
  sessionKey: string;
  laborDate: string;
  start: string;
  end: string | null;
  breakMinutes: number;
  workMinutes: number;
  anomalies: string[];
  breaks: Array<{ start: string; end: string | null; source: string }>;
  original: { clockIn: string | null; clockOut: string | null };
  corrected: boolean;
  corrections: Array<{ id: string; status: string; reviewStatus: string; reason: string; createdAt: string }>;
  plannedBreak: { minutes: number; start: string | null; end: string | null } | null;
  breakDeclaration: { kind: string; status: string } | null;
  timeBasis: null | {
    shifts: Array<{ start: string; end: string }>;
    payableMinutes: number;
    unresolvedMinutes: number;
    candidates: Array<{ category: string; start: string; end: string; minutes: number; segments: Array<{ start: string; end: string; minutes: number; resolution: string }> }>;
  };
  requests: Array<{ id: string; category: string; status: string; requestedStart: string; requestedEnd: string }>;
}
interface MyDetails {
  basis: 'shift' | 'actual';
  breakMode: 'scheduled' | 'punch';
  sessions: DetailSession[];
  shiftsWithoutAttendance: Array<{ shiftId: string; date: string; start: string; end: string }>;
}
const CAT: Record<string, string> = { early: '早出', late: '残業', between: 'シフト間', no_shift: 'シフト外', other: 'その他' };
const OT_STATUS: Record<string, string> = { pending: '申請中', approved: '承認済み', returned: '差戻し', rejected: '却下', cancelled: '取消', confirmed: '確認済み' };
const DECL: Record<string, string> = { as_scheduled: '予定どおり取得', not_taken: '取得なし', custom: '申告あり' };

type Editing =
  | { kind: 'correct'; s: DetailSession | null; date?: string; start?: string; end?: string }
  | { kind: 'break'; s: DetailSession }
  | { kind: 'overtime'; category: string; start: string; end: string };

function MyAttendance() {
  const client = useClient();
  const to = todayJst();
  const from = shiftDate(to, -30);
  const { data, error, loading, reload } = useLoad(() => client.call<MyDetails>('attendance.myDetails', { from, to }), [from, to]);
  const [editing, setEditing] = useState<Editing | null>(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const d = data!;
  const ss = [...d.sessions].reverse();
  const total = d.sessions.reduce((a, s) => a + s.workMinutes, 0);
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p>
          直近30日の実働 <strong><Minutes v={total} /></strong>（{d.sessions.length}回）
        </p>
        <button className="btn" onClick={() => setEditing({ kind: 'correct', s: null })}>
          打刻漏れを申告
        </button>
      </div>
      {d.shiftsWithoutAttendance.length > 0 && (
        <div className="callout callout-warn" style={{ color: 'var(--ink)' }}>
          出勤の記録がないシフトがあります:{' '}
          {d.shiftsWithoutAttendance.map((x) => (
            <button key={x.shiftId} className="btn btn-sm" style={{ margin: 2 }} onClick={() => setEditing({ kind: 'correct', s: null, date: x.date, start: x.start, end: x.end })}>
              {x.date} {x.start}〜{x.end} を申告
            </button>
          ))}
        </div>
      )}
      {!ss.length && <Empty>直近30日の勤務記録はありません</Empty>}
      <div className="sf-cards">
        {ss.map((s) => {
          const tb = s.timeBasis;
          const unresolved = tb?.candidates.flatMap((c) => c.segments.filter((g) => g.resolution === 'unresolved').map((g) => ({ ...g, category: c.category }))) ?? [];
          return (
            <div key={s.sessionKey} className="sf-card">
              <div className="top">
                <strong>
                  {s.laborDate}（{WEEKDAYS[new Date(`${s.laborDate}T00:00:00Z`).getUTCDay()]}）
                </strong>
                {s.corrected && <span className="badge badge-info">修正あり</span>}
                {s.corrections.some((c) => c.reviewStatus === 'pending') && <span className="badge badge-warn">修正の承認待ち</span>}
                <AnomalyBadges list={s.anomalies} />
              </div>
              <div className="sf-grid2 small">
                <span>登録シフト: {tb && tb.shifts.length ? tb.shifts.map((x) => `${hm(x.start)}〜${hm(x.end)}`).join('、') : 'なし'}</span>
                <span>
                  元の打刻: {hm(s.original.clockIn)}〜{hm(s.original.clockOut)}
                </span>
                <span>
                  修正後: {timeOf(s.start)}〜{timeOf(s.end)}
                </span>
                <span>
                  休憩: <Minutes v={s.breakMinutes} />
                  {s.plannedBreak ? `（予定 ${s.plannedBreak.minutes}分・${s.breakDeclaration ? DECL[s.breakDeclaration.kind] + (s.breakDeclaration.status === 'pending' ? '・承認待ち' : '') : '取得未確認'}）` : ''}
                </span>
                <span>
                  実働: <Minutes v={s.workMinutes} />
                </span>
                {d.basis === 'shift' && tb && (
                  <span>
                    給与の対象: <Minutes v={tb.payableMinutes} />
                    {tb.unresolvedMinutes > 0 && `（シフト外 ${tb.unresolvedMinutes}分 確認中）`}
                  </span>
                )}
              </div>
              {s.requests.length > 0 && (
                <div className="small">
                  申請:{' '}
                  {s.requests.map((r) => (
                    <span key={r.id} className="badge" style={{ marginRight: 4 }}>
                      {CAT[r.category]} {hm(r.requestedStart)}〜{hm(r.requestedEnd)} {OT_STATUS[r.status]}
                    </span>
                  ))}
                </div>
              )}
              <div className="acts">
                <button className="btn btn-sm" onClick={() => setEditing({ kind: 'correct', s })}>
                  出退勤を修正
                </button>
                {s.end && (
                  <button className="btn btn-sm" onClick={() => setEditing({ kind: 'break', s })}>
                    休憩を修正
                  </button>
                )}
                {d.basis === 'shift' &&
                  unresolved
                    .filter((g) => !s.requests.some((r) => r.status === 'pending' && r.requestedStart <= g.start && r.requestedEnd >= g.end))
                    .map((g) => (
                      <button key={g.start} className="btn btn-sm btn-primary" onClick={() => setEditing({ kind: 'overtime', category: g.category, start: g.start.slice(0, 16), end: ceilMinute(g.end) })}>
                        {CAT[g.category]} {hm(g.start)}〜{hm(ceilMinute(g.end))} を申請
                      </button>
                    ))}
              </div>
            </div>
          );
        })}
      </div>
      {editing?.kind === 'correct' && (
        <CorrectionForm
          session={editing.s}
          preset={editing.s ? undefined : { date: editing.date, start: editing.start, end: editing.end }}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {editing?.kind === 'break' && (
        <BreakForm
          session={editing.s}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {editing?.kind === 'overtime' && (
        <OvertimeForm
          preset={editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

/** 'HH:MM'（26:00 等の翌日表記を含む）→ 'YYYY-MM-DDTHH:MM' */
function dateTimeOf(date: string, t: string): string {
  const [h, m] = t.split(':').map(Number) as [number, number];
  const d = h >= 24 ? shiftDate(date, 1) : date;
  return `${d}T${String(h % 24).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function CorrectionForm({ session, preset, onClose, onDone }: { session: DetailSession | null; preset?: { date?: string; start?: string; end?: string }; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const baseDate = preset?.date ?? todayJst();
  const [clockIn, setClockIn] = useState(session ? session.start.slice(0, 16) : dateTimeOf(baseDate, preset?.start ?? '09:00'));
  const [clockOut, setClockOut] = useState(session?.end ? session.end.slice(0, 16) : preset?.end ? dateTimeOf(baseDate, preset.end) : '');
  const [reason, setReason] = useState('');
  const submit = async () => {
    setBusy(true);
    setErr('');
    const r = await client.raw<{ status: string; warning?: string | null }>('attendance.selfCorrect', { sessionKey: session?.sessionKey ?? null, clockIn, clockOut: clockOut || null, reason });
    setBusy(false);
    if (!r.ok) return setErr(r.error.message);
    toast('ok', r.data.status === 'pending' ? '修正を申告しました（管理者の確認後に反映されます）' : '修正しました（管理者に通知されます）');
    if (r.data.warning) toast('info', r.data.warning);
    onDone();
  };
  return (
    <Modal
      title={session ? `${session.laborDate} の出退勤を修正` : '打刻漏れを申告'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || reason.trim().length < 2 || !clockIn} onClick={() => void submit()}>
            {busy ? '送信中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        {session && (
          <p className="small">
            元の打刻: {hm(session.original.clockIn)}〜{hm(session.original.clockOut)}（打刻の原本は変更されず、修正の履歴として残ります）
          </p>
        )}
        <div className="form-grid">
          <Field label="出勤日時">
            <input className="input" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} />
          </Field>
          <Field label="退勤日時" hint="日付をまたぐ場合は翌日の日付を選択">
            <input className="input" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} />
          </Field>
        </div>
        <Field label="修正理由（必須）">
          <input className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {err && <div className="callout callout-bull" role="alert">{err}</div>}
        <p className="small muted">修正は管理者が確認します。給与が確定した期間の修正は、管理者の承認後に給与の訂正として処理されます。</p>
      </div>
    </Modal>
  );
}

function BreakForm({ session, onClose, onDone }: { session: DetailSession; onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const toast = useToast();
  const [kind, setKind] = useState<'as_scheduled' | 'not_taken' | 'custom'>(session.plannedBreak ? 'as_scheduled' : 'custom');
  const actual = session.breaks.filter((b) => b.end && b.source !== 'excluded').map((b) => ({ start: b.start.slice(0, 16), end: b.end!.slice(0, 16) }));
  const [rows, setRows] = useState(actual.length ? actual : [{ start: session.start.slice(0, 16), end: session.start.slice(0, 16) }]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await client.raw<{ status: string }>('breaks.declare', {
      workDate: session.laborDate,
      sessionKey: session.sessionKey,
      kind,
      intervals: kind === 'custom' ? rows : [],
      reason,
      ...(kind === 'as_scheduled' ? { expectedPlanned: plannedView(session.plannedBreak) } : {}),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.error.message);
    toast('ok', r.data.status === 'pending' ? '休憩を申告しました（管理者の確認後に反映されます）' : '休憩を修正しました');
    onDone();
  };
  return (
    <Modal
      title={`${session.laborDate} の休憩`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || (kind !== 'as_scheduled' && reason.trim().length < 2)} onClick={() => void submit()}>
            保存
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        {session.plannedBreak && (
          <p className="small">
            予定休憩: {session.plannedBreak.start ? `${hm(session.plannedBreak.start)}〜${hm(session.plannedBreak.end)}` : '時刻未設定'}（{session.plannedBreak.minutes}分）
          </p>
        )}
        <div className="row" role="radiogroup" aria-label="休憩の取得状況">
          {session.plannedBreak && (
            <label className="check" style={{ minHeight: 44, alignItems: 'center' }}>
              <input type="radio" checked={kind === 'as_scheduled'} onChange={() => setKind('as_scheduled')} style={{ marginTop: 0 }} />
              <span>予定どおり取得</span>
            </label>
          )}
          <label className="check" style={{ minHeight: 44, alignItems: 'center' }}>
            <input type="radio" checked={kind === 'not_taken'} onChange={() => setKind('not_taken')} style={{ marginTop: 0 }} />
            <span>取得できなかった</span>
          </label>
          <label className="check" style={{ minHeight: 44, alignItems: 'center' }}>
            <input type="radio" checked={kind === 'custom'} onChange={() => setKind('custom')} style={{ marginTop: 0 }} />
            <span>実際の休憩を入力</span>
          </label>
        </div>
        {kind === 'custom' && <BreakRows rows={rows} setRows={setRows} />}
        {kind !== 'as_scheduled' && (
          <Field label="理由（必須）">
            <input className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {err && <div className="callout callout-bull" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

function OvertimeForm({ preset, onClose, onDone, resubmitId }: { preset?: { category: string; start: string; end: string }; onClose: () => void; onDone: () => void; resubmitId?: string }) {
  const client = useClient();
  const toast = useToast();
  const [category, setCategory] = useState(preset?.category ?? 'late');
  const [start, setStart] = useState(preset?.start ?? todayAt('17:00'));
  const [end, setEnd] = useState(preset?.end ?? todayAt('17:30'));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await client.raw<{ status: string }>(resubmitId ? 'overtime.resubmit' : 'overtime.request', { ...(resubmitId ? { requestId: resubmitId } : {}), category, start, end, reason });
    setBusy(false);
    if (!r.ok) return setErr(r.error.message);
    toast('ok', '申請しました（管理者が確認します）');
    onDone();
  };
  return (
    <Modal
      title={resubmitId ? '早出・残業の再申請' : '早出・残業申請'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" disabled={busy || reason.trim().length < 2} onClick={() => void submit()}>
            {busy ? '送信中…' : '申請'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <Field label="区分">
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="early">早出（シフト開始より前）</option>
            <option value="late">残業（シフト終了より後）</option>
            <option value="between">シフトとシフトの間</option>
            <option value="no_shift">シフトのない日・時間の勤務</option>
            <option value="other">その他（打刻の誤り等）</option>
          </select>
        </Field>
        <div className="form-grid">
          <Field label="実際に働いた開始日時">
            <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="実際に働いた終了日時">
            <input className="input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="申請理由（必須）" hint="例: 開店準備、閉店作業、急な来客対応">
          <input className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {err && <div className="callout callout-bull" role="alert">{err}</div>}
        <p className="small muted">シフトの時間外に実際に働いた時間を申請してください。管理者の確認後、給与に反映されます。</p>
      </div>
    </Modal>
  );
}

function MyOvertime() {
  const client = useClient();
  const toast = useToast();
  const list = useLoad(() => client.call<Array<{ id: string; workDate: string; category: string; requestedStart: string; requestedEnd: string; requestedMinutes: number; status: string; workConfirmation: string; approvedMinutes: number; partial: boolean; reviewComment: string }>>('overtime.mine'), []);
  const [form, setForm] = useState<null | { resubmitId?: string; preset?: { category: string; start: string; end: string } }>(null);
  return (
    <div className="stack">
      <div>
        <button className="btn btn-primary" onClick={() => setForm({})}>
          新しく申請
        </button>
      </div>
      {list.loading && <Loading />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <Empty>申請はありません。シフト外の時間は「自分の勤怠（確認・修正）」から申請できます。</Empty>}
      <div className="sf-cards">
        {list.data?.map((r) => (
          <div key={r.id} className="sf-card">
            <div className="top">
              <strong>{r.workDate}</strong>
              <span className="badge">{CAT[r.category]}</span>
              <span className="num">
                {hm(r.requestedStart)}〜{hm(r.requestedEnd)}（{r.requestedMinutes}分）
              </span>
              <span className="badge badge-info">{OT_STATUS[r.status]}</span>
              {r.workConfirmation === 'work' && <span className="badge badge-board">実労働 {r.approvedMinutes}分{r.partial ? '（一部）' : ''}</span>}
            </div>
            {r.reviewComment && <div className="small">管理者より: {r.reviewComment}</div>}
            {(r.status === 'pending' || r.status === 'returned') && (
              <div className="acts">
                {r.status === 'returned' && (
                  <button className="btn btn-sm btn-primary" onClick={() => setForm({ resubmitId: r.id, preset: { category: r.category, start: r.requestedStart.slice(0, 16), end: r.requestedEnd.slice(0, 16) } })}>
                    修正して再申請
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    const x = await client.raw('overtime.cancel', { requestId: r.id });
                    if (x.ok) {
                      toast('ok', '申請を取り消しました');
                      list.reload();
                    } else toast('error', x.error.message);
                  }}
                >
                  取消
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {form && (
        <OvertimeForm
          preset={form.preset}
          resubmitId={form.resubmitId}
          onClose={() => setForm(null)}
          onDone={() => {
            setForm(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

/** 本人未確認（PIN 未設定）: 既存の勤怠を表示せず、申告だけを受け付ける */
function UnverifiedRequests() {
  const [form, setForm] = useState<null | 'correct' | 'overtime' | 'break'>(null);
  const [sent, setSent] = useState<string[]>([]);
  const done = (what: string) => {
    setForm(null);
    setSent((x) => [...x, what]);
  };
  return (
    <div className="stack">
      <p>勤怠の修正・休憩・早出残業を申告できます。本人確認（PIN）ができないため、申告は管理者の確認後に反映されます。</p>
      <div className="row">
        <button className="btn btn-primary" onClick={() => setForm('correct')}>
          出退勤の修正・打刻漏れ
        </button>
        <button className="btn btn-primary" onClick={() => setForm('break')}>
          休憩の申告
        </button>
        <button className="btn btn-primary" onClick={() => setForm('overtime')}>
          早出・残業申請
        </button>
      </div>
      {sent.length > 0 && (
        <div className="callout" role="status">
          送信しました: {sent.join('、')}（管理者の確認待ち）
        </div>
      )}
      {form === 'correct' && <CorrectionForm session={null} onClose={() => setForm(null)} onDone={() => done('出退勤の修正')} />}
      {form === 'overtime' && <OvertimeForm onClose={() => setForm(null)} onDone={() => done('早出・残業申請')} />}
      {form === 'break' && <UnverifiedBreakForm onClose={() => setForm(null)} onDone={() => done('休憩の申告')} />}
    </div>
  );
}

function UnverifiedBreakForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const client = useClient();
  const [date, setDate] = useState(todayJst());
  const [kind, setKind] = useState<'not_taken' | 'custom'>('not_taken');
  const [rows, setRows] = useState([{ start: todayAt('12:00'), end: todayAt('12:30') }]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal
      title="休憩の申告"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            disabled={reason.trim().length < 2}
            onClick={async () => {
              const r = await client.raw('breaks.declare', { workDate: date, kind, intervals: kind === 'custom' ? rows : [], reason });
              if (r.ok) onDone();
              else setErr(r.error.message);
            }}
          >
            申告
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        <Field label="勤務日">
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="row">
          <label className="check" style={{ minHeight: 44, alignItems: 'center' }}>
            <input type="radio" checked={kind === 'not_taken'} onChange={() => setKind('not_taken')} style={{ marginTop: 0 }} />
            <span>休憩を取れなかった</span>
          </label>
          <label className="check" style={{ minHeight: 44, alignItems: 'center' }}>
            <input type="radio" checked={kind === 'custom'} onChange={() => setKind('custom')} style={{ marginTop: 0 }} />
            <span>実際の休憩を入力</span>
          </label>
        </div>
        {kind === 'custom' && <BreakRows rows={rows} setRows={setRows} />}
        <Field label="理由（必須）">
          <input className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {err && <div className="callout callout-bull" role="alert">{err}</div>}
      </div>
    </Modal>
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
            今期（{d.estimate.from}〜{d.estimate.to}）の見込額（未確定）: <strong><Yen v={d.estimate.grossPay} /></strong>　給与の対象時間 <Minutes v={d.estimate.workMinutes} />
          </div>
          <div className="small muted">見込額はシフトと確認済みの勤務からの概算で、控除前の金額です。{d.estimate.incomplete ? '確認中の勤怠・給与条件があるため金額は変わる可能性があります。' : ''}</div>
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
                <td>
                  {c.periodKey}
                  {c.revision > 1 && <span className="badge badge-warn" style={{ marginLeft: 6 }}>訂正</span>}
                </td>
                <td>{c.payDate}</td>
                <td className="r">
                  <Yen v={c.totals.grossPay} />
                </td>
                <td className="r">
                  <Yen v={c.totals.netPay} />
                </td>
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
        <p className="small muted">共用端末のため、明細のダウンロードはできません。紙の明細が必要な場合は管理者に依頼してください。</p>
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
      {d.fiveDay
        .filter((f) => f.shortfall > 0)
        .map((f) => (
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
      <p className="small muted">管理者から委任された権限の範囲で操作できます。給与等の機密操作には追加認証が必要です。</p>
      {Page ? <Page /> : <Empty>利用できる管理メニューはありません</Empty>}
    </div>
  );
}
