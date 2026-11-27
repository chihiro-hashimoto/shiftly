import { createRoot } from 'react-dom/client';
import '../styles/base.css';
import { StaffApp } from '../staff/StaffApp';
import { GasTransport } from '../api/transport';

createRoot(document.getElementById('root')!).render(<StaffApp transport={new GasTransport('staff')} />);
