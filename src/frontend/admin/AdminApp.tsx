/**
 * 店長用管理画面（PC・スマートフォン）
 * 店長は Google アカウントで認証済み（Shiftly-Admin の Web アプリはアクセス=自分のみ）。
 * 業務データは画面表示中のメモリ上のみで扱い、端末へ保存しない。
 */
import { useEffect, useMemo, useState } from 'react';
import { Client, type Transport } from '../api/transport';
import { ClientContext, ToastProvider } from '../components/ui';
import { Wordmark } from '../components/brand';
import { PAGES } from './registry';
import './admin.css';

export function AdminApp({ transport, sampleNotice }: { transport: Transport; sampleNotice?: string }) {
  const client = useMemo(() => new Client(transport), [transport]);
  const [page, setPage] = useState(() => {
    const h = location.hash.replace('#', '');
    return PAGES.some((p) => p.id === h) ? h : 'dashboard';
  });
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace('#', '');
      if (PAGES.some((p) => p.id === h)) setPage(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (id: string) => {
    setPage(id);
    setMenuOpen(false);
    try {
      history.replaceState(null, '', `#${id}`);
    } catch {
      /* GAS の iframe 内では履歴操作が制限される場合がある */
    }
  };
  const Current = PAGES.find((p) => p.id === page)!;
  const groups = [...new Set(PAGES.map((p) => p.group))];
  return (
    <ToastProvider>
      <ClientContext.Provider value={client}>
        {sampleNotice && <div className="sample-banner">{sampleNotice}</div>}
        <div className="admin">
          <aside className={`a-side ${menuOpen ? 'open' : ''}`}>
            <div className="a-brand">
              <Wordmark size={26} color="#fff" />
              <button className="a-menu-btn" aria-label="メニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
                メニュー
              </button>
            </div>
            <nav aria-label="管理メニュー">
              {groups.map((g) => (
                <div key={g} className="a-group">
                  <div className="a-group-label">{g}</div>
                  {PAGES.filter((p) => p.group === g).map((p) => (
                    <button key={p.id} className="a-nav" aria-current={p.id === page ? 'page' : undefined} onClick={() => go(p.id)}>
                      {p.label}
                    </button>
                  ))}
                </div>
              ))}
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
    </ToastProvider>
  );
}
