import { createRoot } from 'react-dom/client';
import '../styles/base.css';
import '../setup/setup.css';
import { AdminApp } from '../admin/AdminApp';
import { GasTransport } from '../api/transport';
import { WebInitGate } from '../components/webInit';

// Setup から「Google の権限を承認して接続」で開いた場合（URL に #shiftly-init=admin）だけ接続の画面を表示する（A案・D-029）
createRoot(document.getElementById('root')!).render(
  <WebInitGate role="admin">
    <AdminApp transport={new GasTransport('admin')} />
  </WebInitGate>,
);
