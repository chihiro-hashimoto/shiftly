/**
 * 管理画面
 * - Google 所有者用（Shiftly-Admin。アクセス=自分のみの Web アプリで Google が本人を認証）
 * - 店舗 iPad の管理者モード（v1.3。管理者パスワードで認証。embedded で StaffApp から表示）
 * 業務データは画面表示中のメモリ上のみで扱い、端末へ保存しない。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Client, type Transport } from '../api/transport';
import { ClientContext, ToastProvider } from '../components/ui';
import { StaleViewGuard } from '../components/stale';
import { Wordmark } from '../components/brand';
import { PAGES } from './registry';
import './admin.css';

type AdminAppProps = Parameters<typeof AdminAppInner>[0];

/**
 * 管理画面の外側（D-026）。復元より前に読み込んだ画面と分かったら案内を出し、「読み込み直す」で画面全体を作り直す
 * （ページの状態・入力中の内容・クライアントの固定した世代を破棄する）。店舗 iPad の管理者モード（embedded）では、
 * スタッフ画面の外側が同じ案内を出して全体を作り直すため、ここでは出さない
 */
export function AdminApp(props: AdminAppProps) {
  const [gen, setGen] = useState(0);
  return (
    <>
      {!props.embedded && <StaleViewGuard onReset={() => setGen((g) => g + 1)} />}
      <AdminAppInner key={gen} {...props} />
    </>
  );
}

function AdminAppInner({
  transport,
  sampleNotice,
  client: external,
  embedded,
  banner,
  brandExtra,
}: {
  transport: Transport;
  sampleNotice?: string;
  /** 管理者モード: 管理者セッションを持つクライアント（メモリ上のみ） */
  client?: Client;
  /** 店舗 iPad の管理者モードとして表示（URL の履歴を操作しない・Google 所有者限定のページを表示しない） */
  embedded?: boolean;
  /** 管理者モードの表示（スタッフ画面へ戻る・ログアウト） */
  banner?: ReactNode;
  /** サイドバー（スマホでは上部の固定ヘッダー）に常に表示する要素（管理者モードの表示・戻る） */
  brandExtra?: ReactNode;
}) {
  const own = useMemo(() => new Client(transport), [transport]);
  const client = external ?? own;
  const pages = useMemo(() => PAGES.filter((p) => !(embedded && p.googleOwnerOnly)), [embedded]);
  const [page, setPage] = useState(() => {
    if (embedded) return 'dashboard';
    const h = location.hash.replace('#', '');
    return pages.some((p) => p.id === h) ? h : 'dashboard';
  });
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (embedded) return;
    const onHash = () => {
      const h = location.hash.replace('#', '');
      if (pages.some((p) => p.id === h)) setPage(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [embedded, pages]);
  const go = (id: string) => {
    setPage(id);
    setMenuOpen(false);
    // 管理者モードでは履歴を残さない（戻る操作で管理画面に戻れないようにする）
    if (embedded) return;
    try {
      history.replaceState(null, '', `#${id}`);
    } catch {
      /* GAS の iframe 内では履歴操作が制限される場合がある */
    }
  };
  const Current = pages.find((p) => p.id === page) ?? pages[0]!;
  const groups = [...new Set(pages.map((p) => p.group))];
  const body = (
    <ClientContext.Provider value={client}>
      {sampleNotice && <div className="sample-banner">{sampleNotice}</div>}
      {banner}
      <div className="admin">
        <aside className={`a-side ${menuOpen ? 'open' : ''}`}>
          <div className="a-brand">
            <Wordmark size={26} color="#fff" />
            {brandExtra}
            <button className="a-menu-btn" aria-label="メニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              メニュー
            </button>
          </div>
          <nav aria-label="管理メニュー">
            {groups.map((g) => (
              <div key={g} className="a-group">
                <div className="a-group-label">{g}</div>
                {pages
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <button key={p.id} className="a-nav" aria-current={p.id === Current.id ? 'page' : undefined} onClick={() => go(p.id)}>
                      {p.label}
                    </button>
                  ))}
              </div>
            ))}
            {embedded && <p className="a-group-label" style={{ padding: '10px 14px', textTransform: 'none', lineHeight: 1.6 }}>システムの更新・復旧と管理者パスワードの再設定は、Google 所有者の管理画面から行います。</p>}
          </nav>
        </aside>
        <main className="a-main">
          <header className="a-head">
            <h1>{Current.label}</h1>
          </header>
          <div className="a-content">
            <Current.component key={Current.id} />
          </div>
        </main>
      </div>
    </ClientContext.Provider>
  );
  // 管理者モードでは StaffApp 側の ToastProvider を使う
  return embedded ? body : <ToastProvider>{body}</ToastProvider>;
}
