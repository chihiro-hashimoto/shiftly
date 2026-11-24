import { createRoot } from 'react-dom/client';
import '../styles/base.css';
import { KioskApp } from '../kiosk/KioskApp';
import { GasTransport } from '../api/transport';

createRoot(document.getElementById('root')!).render(<KioskApp transport={new GasTransport('kiosk')} />);
