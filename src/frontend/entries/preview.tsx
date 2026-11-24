/**
 * プレビュー（モックデータ・ブラウザ内のみで動作）
 * 実在スタッフの情報は使用しない。データはメモリ上のみで、再読み込みで初期化される。
 */
import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';
import '../styles/base.css';
import { KioskApp } from '../kiosk/KioskApp';
import { AdminApp } from '../admin/AdminApp';
import { startPreviewBackend } from '../preview/mockBackend';

const NOTICE = 'プレビュー: 架空のサンプルデータで動作しています（Google には接続していません。再読み込みで初期状態に戻ります）';

function Preview() {
  const be = useMemo(() => startPreviewBackend(), []);
  const [mode, setMode] = useState<'kiosk' | 'admin'>(() => (new URLSearchParams(location.search).get('view') === 'admin' ? 'admin' : 'kiosk'));
  return (
    <>
      <div className="row no-print" style={{ padding: '6px 12px', background: '#e9ece9', borderBottom: '1px solid #d9ded9', gap: 6 }}>
        <strong className="small">プレビュー切替:</strong>
        <button className={`btn btn-sm ${mode === 'kiosk' ? 'btn-primary' : ''}`} onClick={() => setMode('kiosk')}>
          店舗 iPad（スタッフ）
        </button>
        <button className={`btn btn-sm ${mode === 'admin' ? 'btn-primary' : ''}`} onClick={() => setMode('admin')}>
          店長の管理画面
        </button>
        <span className="small muted" data-testid="pins">サンプル PIN: {be.staffPins.map((s) => `${s.name}=${s.pin}`).join(' / ')}（店長代理の管理用パスコード: Demo2026pass）</span>
      </div>
      {mode === 'kiosk' ? <KioskApp transport={be.kiosk} injectedDeviceToken={be.deviceToken} sampleNotice={NOTICE} /> : <AdminApp transport={be.owner} sampleNotice={NOTICE} />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
