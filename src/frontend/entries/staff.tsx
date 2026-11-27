import { createRoot } from 'react-dom/client';
import '../styles/base.css';
import '../setup/setup.css';
import { StaffApp } from '../staff/StaffApp';
import { GasTransport } from '../api/transport';
import { WebInitGate } from '../components/webInit';

// Setup から「Google の権限を承認して初期化」で開いた場合（URL に #shiftly-init=…）だけ初期化の画面を表示する（A案・D-029）
createRoot(document.getElementById('root')!).render(
  <WebInitGate role="staff">
    <StaffApp transport={new GasTransport('staff')} />
  </WebInitGate>,
);
