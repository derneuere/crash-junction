// Headless-screenshot harness page for the GARAGE showroom (CarSelect scene).
// Loaded by tools/garageshot.mjs through Vite so all TS imports resolve.
//
// It bakes the vehicle library (loadVehicleModels), mounts a single
// GarageScene on #cv, and exposes window.__garage so the puppeteer driver can
// cycle each PLAYER_CAR and screenshot the canvas. renderPose pins a fixed
// orbit angle and draws one frame for a stable, comparable three-quarter view.

import { SPECS } from '../src/game/vehicles';
import { loadVehicleModels, PLAYER_CARS, type PlayerCarId } from '../src/game/models';
import { GarageScene } from '../src/game/garageScene';

declare global {
  interface Window {
    __garage?: {
      ready: boolean;
      cars: { id: PlayerCarId; label: string }[];
      setCar: (id: PlayerCarId) => boolean;
      renderPose: (orbit: number) => void;
    };
  }
}

const canvas = document.getElementById('cv') as HTMLCanvasElement;

async function boot() {
  await loadVehicleModels(SPECS);
  const scene = new GarageScene(canvas);
  scene.resize();
  window.__garage = {
    ready: true,
    cars: PLAYER_CARS.map((c) => ({ id: c.id, label: c.label })),
    setCar: (id: PlayerCarId) => scene.setCar(id),
    renderPose: (orbit: number) => scene.renderPose(orbit),
  };
  scene.setCar(PLAYER_CARS[0].id);
  scene.renderPose(Math.PI * 0.22);
}

boot();
