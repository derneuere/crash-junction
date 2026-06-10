import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// No StrictMode: its dev-mode double-mount would create and destroy a whole
// WebGL context + physics world on every load for no benefit here.
createRoot(document.getElementById('root')!).render(<App />);
