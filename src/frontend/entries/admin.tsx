import { createRoot } from 'react-dom/client';
import '../styles/base.css';
import { AdminApp } from '../admin/AdminApp';
import { GasTransport } from '../api/transport';

createRoot(document.getElementById('root')!).render(<AdminApp transport={new GasTransport('admin')} />);
