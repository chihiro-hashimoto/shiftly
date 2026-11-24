/**
 * 共通 UI 部品（業務データはメモリ上の state のみで扱う）
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, type Client } from '../api/transport';

// ------------------------------------------------------------------ API コンテキスト
export const ClientContext = createContext<Client | null>(null);
export function useClient(): Client {
  const c = useContext(ClientContext);
  if (!c) throw new Error('Client が未設定です');
  return c;
}

/** 読み込み（loading / error / data / reload） */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : '読み込みに失敗しました'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ------------------------------------------------------------------ トースト
interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
}
const ToastContext = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'toast-error' : t.kind === 'ok' ? 'toast-ok' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export function useToast() {
  return useContext(ToastContext);
}

/** 更新操作の実行（二重送信防止・結果通知） */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      try {
        const r = await fn();
        if (ok) toast('ok', ok);
        return r;
      } catch (e) {
        toast('error', e instanceof ApiError || e instanceof Error ? e.message : '処理に失敗しました');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy, toast],
  );
  return { busy, run };
}

// ------------------------------------------------------------------ 表示部品
export function Loading({ text = '読み込み中…' }: { text?: string }) {
  return (
    <div className="loading-block" role="status">
      <div className="spinner" aria-hidden="true" />
      {text}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="callout callout-bull" role="alert">
      <div>{message}</div>
      {onRetry && (
        <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={onRetry}>
          再読み込み
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Panel({ title, actions, children, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <div className="panel-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'panel-body' : ''}>{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>
        {label}
        {hint && <span className="hint">　{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function Modal({ title, children, onClose, footer, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Yen({ v, className = '' }: { v: number | null | undefined; className?: string }) {
  if (v === null || v === undefined) return <span className={`num ${className}`}>—</span>;
  return <span className={`num ${className}`}>{`${v < 0 ? '-' : ''}¥${Math.abs(Math.round(v)).toLocaleString('ja-JP')}`}</span>;
}

export function Minutes({ v }: { v: number }) {
  const m = Math.round(v);
  return <span className="num">{`${Math.floor(m / 60)}:${String(Math.abs(m % 60)).padStart(2, '0')}`}</span>;
}

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

export const ANOMALY_LABEL: Record<string, string> = {
  missing_clock_out: '退勤打刻漏れ',
  break_not_ended: '休憩終了漏れ',
  insufficient_break: '休憩不足',
  abnormal_hours: '長時間勤務',
  fixed_break_applied: '固定休憩を適用',
  clock_out_during_break: '休憩中に退勤',
  duplicate_clock_in: '二重出勤',
  overlapping_breaks: '休憩の重複',
  fixed_break_outside_work: '固定休憩が勤務外',
  duplicate_break_start: '二重の休憩開始',
  break_end_without_start: '休憩開始なし',
};

export function AnomalyBadges({ list }: { list: string[] }) {
  const shown = list.filter((x) => x !== 'fixed_break_applied');
  return (
    <span className="row" style={{ gap: 4 }}>
      {list.includes('fixed_break_applied') && <span className="badge badge-info">固定休憩</span>}
      {shown.map((a) => (
        <span key={a} className={`badge ${a === 'missing_clock_out' || a === 'break_not_ended' ? 'badge-bull' : 'badge-warn'}`}>
          {ANOMALY_LABEL[a] ?? a}
        </span>
      ))}
    </span>
  );
}

export function todayJst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}
export function shiftDate(d: string, n: number): string {
  const t = Date.parse(`${d}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
export function timeOf(iso: string | null): string {
  return iso ? iso.slice(11, 16) : '—';
}

/** ブラウザでのファイル保存（店長端末のみ使用） */
export function downloadBase64(base64: string, fileName: string, mime: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
