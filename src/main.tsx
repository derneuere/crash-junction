import { createRoot } from 'react-dom/client';
import App from './App';
import { loadVehicleModels } from './game/models';
import { SPECS } from './game/vehicles';
import './styles.css';

// Vehicle models must be baked before the first Game constructs (createVehicle
// is synchronous). If they fail to load the game falls back to the procedural
// hulls — never block the page on an asset.
const boot = () => {
  // No StrictMode: its dev-mode double-mount would create and destroy a whole
  // WebGL context + physics world on every load for no benefit here.
  createRoot(document.getElementById('root')!).render(<App />);
};

loadVehicleModels(SPECS).then(boot, (err) => {
  console.warn('[crash-junction] vehicle models failed to load — procedural hulls', err);
  boot();
});
