import { createRoot } from 'react-dom/client';
import '../styles/base.css';
import { SetupApp } from '../setup/SetupApp';

createRoot(document.getElementById('root')!).render(<SetupApp />);
