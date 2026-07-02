// Studio-render page for PROCEDURAL cars (tools/procshot.mjs drives it).
//
// Builds a recipe's VehicleModel directly — no game boot, no GLB fetches, no
// vehicle library — and mounts it in a bright neutral studio so part work is
// judged on SHAPE, not mood lighting. The car is assembled exactly like the
// garage assembles it (garageScene buildCar: panel cutouts re-attached at
// rest, showroom materials), so what procshot shows is what ships.
//
// window.__proc contract (the harness's API):
//   ready: true once the scene is up
//   cars:  recipe ids
//   poses: pose names
//   setCar(id, colorHex?) → boolean
//   shoot(pose) → dataURL of one rendered frame

import * as THREE from 'three';
import { SPECS } from '../src/game/vehicles';
import { buildProceduralModel, PROC_RECIPES } from '../src/game/models/procgen';
import { buildCar } from '../src/game/garageScene/car';
import { FLOOR_Y } from '../src/game/garageScene/constants';

const SILVER = 0xc9ccd2; // judge shape in the references' own silver

declare global {
  interface Window {
    __proc?: {
      ready: boolean;
      cars: string[];
      poses: string[];
      setCar: (id: string, color?: number) => boolean;
      shoot: (pose: string) => string;
    };
  }
}

// ── poses: [camera offset from target, target, vertical fov] ──
// Long lenses (small fov) keep proportions comparable to product photos.
// The car's nose faces -z; "left side" poses match the reference shots.
// `ortho` (half-height in metres) switches to a TRUE ORTHOGRAPHIC camera —
// the *-o elevations are for measuring proportions, free of perspective.
interface Pose {
  off: [number, number, number];
  tgt: [number, number, number];
  fov: number;
  ortho?: number;
}
const POSES: Record<string, Pose> = {
  side: { off: [-11.5, 0.25, 0], tgt: [0, 0.55, 0], fov: 16 }, // pure left profile, nose left
  front: { off: [0, 0.25, -10.5], tgt: [0, 0.5, 0], fov: 15 },
  rear: { off: [0, 0.25, 10.5], tgt: [0, 0.5, 0], fov: 15 },
  front34: { off: [-6.4, 0.9, -7.2], tgt: [0, 0.45, 0], fov: 18 }, // front-left, like astra-front.jpg
  rear34: { off: [6.2, 1.0, 7.0], tgt: [0, 0.45, 0], fov: 18 }, // rear-right, like astra-rear.jpg
  top: { off: [0, 12, 0.01], tgt: [0, 0, 0], fov: 16 },
  nose: { off: [-2.6, 0.2, -4.4], tgt: [0, 0.35, -1.7], fov: 16 }, // front-clip close-up
  tail: { off: [2.5, 0.35, 4.3], tgt: [0, 0.45, 1.7], fov: 16 }, // rear-clip close-up
  wheel: { off: [-2.9, 0.0, 0], tgt: [-0.8, 0.32, -1.32], fov: 13 }, // front-left wheel
  'side-o': { off: [-12, 0, 0], tgt: [0, 0.15, 0], fov: 16, ortho: 1.45 }, // measured elevation
  'front-o': { off: [0, 0, -12], tgt: [0, 0.15, 0], fov: 16, ortho: 1.45 },
  'rear-o': { off: [0, 0, 12], tgt: [0, 0.15, 0], fov: 16, ortho: 1.45 },
  'top-o': { off: [0, 12, 0.001], tgt: [0, 0, 0], fov: 16, ortho: 2.4 }, // measured plan
};

const canvas = document.getElementById('cv') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(1280, 800, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x33373d);

// bright, even studio: strong hemi + soft key/fill/rim, a light grey floor
scene.add(new THREE.HemisphereLight(0xdfe4ea, 0x3d4046, 1.0));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(-6, 8, -7);
scene.add(key);
const fill = new THREE.DirectionalLight(0xdfe8f5, 0.8);
fill.position.set(7, 4, 3);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.0);
rim.position.set(2, 6, 9);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(30, 48),
  new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
scene.add(floor);

// a simple bright env so the clearcoat paint has something to reflect
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new THREE.Scene(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(18, 1280 / 800, 0.1, 100);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);

let carGroup: THREE.Group | null = null;
let disposables: { dispose(): void }[] = [];

function setCar(id: string, color: number = SILVER): boolean {
  const recipe = PROC_RECIPES[id];
  if (!recipe) return false;
  if (carGroup) scene.remove(carGroup);
  for (const d of disposables) d.dispose();
  disposables = [];
  const model = buildProceduralModel(recipe, SPECS.sedan);
  carGroup = buildCar(model, color, (...items) => disposables.push(...items));
  // buildCar tracks only what it creates; the model's own geometry is ours
  disposables.push(model.body, model.wheelL, model.wheelR);
  if (model.interior) disposables.push(model.interior);
  for (const cut of model.panelCuts) if (cut) disposables.push(cut.geo);
  scene.add(carGroup);
  return true;
}

function shoot(pose: string): string {
  const p = POSES[pose];
  if (!p) return '';
  const cam = p.ortho ? orthoCam : camera;
  if (p.ortho) {
    const aspect = 1280 / 800;
    orthoCam.top = p.ortho;
    orthoCam.bottom = -p.ortho;
    orthoCam.left = -p.ortho * aspect;
    orthoCam.right = p.ortho * aspect;
  } else {
    camera.fov = p.fov;
  }
  cam.position.set(p.tgt[0] + p.off[0], p.tgt[1] + p.off[1], p.tgt[2] + p.off[2]);
  cam.updateProjectionMatrix();
  cam.lookAt(p.tgt[0], p.tgt[1], p.tgt[2]);
  renderer.render(scene, cam);
  return canvas.toDataURL('image/png');
}

setCar(Object.keys(PROC_RECIPES)[0] ?? 'metro');
window.__proc = {
  ready: true,
  cars: Object.keys(PROC_RECIPES),
  poses: Object.keys(POSES),
  setCar,
  shoot,
};
