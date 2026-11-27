/**
 * プレビュー（モックデータ・ブラウザ内のみで動作）
 * 実在スタッフの情報は使用しない。データはメモリ上のみで、再読み込みで初期化される。
 */
import { createRoot } from 'react-dom/client';
import { useMemo, useState } from 'react';
import '../styles/base.css';
import { StaffApp } from '../staff/StaffApp';
import { AdminApp } from '../admin/AdminApp';
import { startPreviewBackend } from '../preview/mockBackend';
import { SetupApp } from '../setup/SetupApp';
import { createDemoSetupTransport } from '../preview/demoSetup';
import { WebInitPanel } from '../components/webInit';
import '../setup/setup.css';

const NOTICE = 'プレビュー: 架空のサンプルデータで動作しています（Google には接続していません。再読み込みで初期状態に戻ります）';

function Preview() {
  const be = useMemo(() => startPreviewBackend(), []);
  const setupT = useMemo(() => createDemoSetupTransport({ apiOffOnce: new URLSearchParams(location.search).get('apiOff') === '1' }), []);
  const [mode, setMode] = useState<'staff' | 'admin' | 'setup' | 'webinit-staff' | 'webinit-admin'>(() => {
    const v = new URLSearchParams(location.search).get('view');
    return v === 'admin' || v === 'setup' || v === 'webinit-staff' || v === 'webinit-admin' ? v : 'staff';
  });
  return (
    <>
      <div className="row no-print" style={{ padding: '6px 12px', background: '#e9ece9', borderBottom: '1px solid #d9ded9', gap: 6 }}>
        <strong className="small">プレビュー切替:</strong>
        <button className={`btn btn-sm ${mode === 'staff' ? 'btn-primary' : ''}`} onClick={() => setMode('staff')}>
          店舗 iPad（スタッフ・管理者モード）
        </button>
        <button className={`btn btn-sm ${mode === 'admin' ? 'btn-primary' : ''}`} onClick={() => setMode('admin')}>
          Google 所有者の管理画面（PC）
        </button>
        <button className={`btn btn-sm ${mode === 'setup' ? 'btn-primary' : ''}`} onClick={() => setMode('setup')}>
          初期セットアップ（デモ）
        </button>
        <span className="small muted" data-testid="pins">
          サンプル PIN: {be.staffPins.map((s) => `${s.name}=${s.pin}`).join(' / ')}（デモ 三郎は PIN 未設定）／ 管理者パスワード: {be.adminPassword} ／ 管理者代理の管理用パスコード: Demo2026pass
        </span>
      </div>
      {mode === 'staff' && <StaffApp transport={be.staff} injectedDeviceToken={be.deviceToken} sampleNotice={NOTICE} />}
      {mode === 'admin' && <AdminApp transport={be.owner} sampleNotice={NOTICE} />}
      {/* ブラウザでの初期化・接続の画面（A案・D-029）のデモ: Google には接続しない */}
      {(mode === 'webinit-staff' || mode === 'webinit-admin') && (
        <WebInitPanel role={mode === 'webinit-staff' ? 'staff' : 'admin'} code="demo" run={() => new Promise((r) => setTimeout(() => r({ ok: true }), 300))} />
      )}
      {mode === 'setup' && <SetupApp transport={setupT} notice="デモ: Google には接続していません。権限承認の工程は「確認して続行」で承認済みとして扱います" />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
