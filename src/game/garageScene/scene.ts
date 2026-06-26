import * as THREE from 'three';
import { getVehicleModel, type PlayerCarId, type VehicleModel, setPlayerCar } from '../models';
import {
  GARAGE_DEFAULT_COLOR, FLOOR_Y, ORBIT_RADIUS, ORBIT_HEIGHT, ORBIT_SPEED, TARGET_Y,
} from './constants';
import { buildCar, buildMirror } from './car';
import { buildShowroom } from './showroom';
import { buildLights } from './lights';
import { buildEnv } from './env';

export class GarageScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  // the turntable holds the car + its mirrored copy; we rotate the camera, not
  // the table, but keeping a group makes setCar() teardown a single removal.
  private readonly turntable = new THREE.Group();
  private carGroup: THREE.Group | null = null;
  private mirrorGroup: THREE.Group | null = null;

  // everything we must dispose: geometries + materials we created (the baked
  // template geometry is owned by models.ts and only cloned, so we dispose our
  // clones but never the source).
  private readonly disposables: { dispose(): void }[] = [];
  private readonly carDisposables: { dispose(): void }[] = []; // swapped per car

  private orbit = Math.PI * 0.22; // start angle — three-quarter front view
  private raf = 0;
  private last = 0;
  private running = false;
  private disposed = false;

  private carId: PlayerCarId | null = null;
  private color = GARAGE_DEFAULT_COLOR;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.sizeRendererToCanvas();

    this.scene.background = new THREE.Color(0x0a0c10);
    this.scene.fog = new THREE.Fog(0x0a0c10, 11, 26);

    this.camera = new THREE.PerspectiveCamera(42, this.aspect(), 0.1, 100);
    this.scene.add(this.turntable);

    buildShowroom(this.scene, (...items) => this.track(...items));
    buildLights(this.scene);
    buildEnv(this.renderer, this.scene, (...items) => this.track(...items));
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Show `carId` painted in `color` (defaults to the spawn red). Cheap to
   *  call on every left/right cycle — swaps just the car meshes, the showroom
   *  and lights persist. Returns true if the model was available (false only
   *  if loadVehicleModels never ran — caller can leave the previous car up). */
  setCar(carId: PlayerCarId, color: number = this.color): boolean {
    this.carId = carId;
    this.color = color;
    // getVehicleModel reads the module-level player-car pointer; pin it so the
    // requested body's template comes back (and restore is unnecessary — this
    // is a presentation-only read; App re-pins setPlayerCar before any Game).
    setPlayerCar(carId);
    const model = getVehicleModel('sedan', true);
    if (!model) return false;
    this.swapCar(model, color);
    return true;
  }

  /** Repaint the current car without rebuilding it. */
  setColor(color: number): void {
    this.color = color;
    if (this.carId) this.setCar(this.carId, color);
  }

  /** Start the rAF orbit loop (idempotent). */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.orbit += ORBIT_SPEED * dt;
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Pause the loop (the GL context + scene stay alive — call start() again). */
  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Render a single frame at a fixed orbit angle. Used by the headless
   *  screenshot harness (tools/garageshot) for stable, comparable captures;
   *  production uses start()'s rAF loop instead. */
  renderPose(orbit: number): void {
    if (this.disposed) return;
    this.orbit = orbit;
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /** Re-fit the renderer + camera to the canvas's current box. */
  resize(): void {
    if (this.disposed) return;
    this.sizeRendererToCanvas();
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    if (!this.running) this.renderer.render(this.scene, this.camera);
  }

  /** Free every GL resource and drop the context. The codebase leaks WebGL
   *  contexts when a renderer is dropped without forceContextLoss(), so this
   *  is load-bearing — the menu mounts/unmounts the garage repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.teardownCar();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── camera orbit ───────────────────────────────────────────────────────────

  private updateCamera(): void {
    const x = Math.sin(this.orbit) * ORBIT_RADIUS;
    const z = Math.cos(this.orbit) * ORBIT_RADIUS;
    this.camera.position.set(x, ORBIT_HEIGHT, z);
    this.camera.lookAt(0, TARGET_Y, 0);
  }

  // ── car swap ────────────────────────────────────────────────────────────────

  private swapCar(model: VehicleModel, color: number): void {
    this.teardownCar();
    const car = buildCar(model, color, (...items) => this.carDisposables.push(...items));
    this.carGroup = car;
    this.turntable.add(car);

    // faked floor reflection: a mirrored (scaleY = -1) copy of the car sitting
    // under the floor, dimmed by the translucent floor pane over it. Cheaper
    // than a Reflector render-target and reads as a wet-concrete sheen.
    const mirror = buildMirror(car, (...items) => this.carDisposables.push(...items));
    this.mirrorGroup = mirror;
    this.turntable.add(mirror);
    this.updateCamera();
  }

  private teardownCar(): void {
    if (this.carGroup) this.turntable.remove(this.carGroup);
    if (this.mirrorGroup) this.turntable.remove(this.mirrorGroup);
    this.carGroup = null;
    this.mirrorGroup = null;
    for (const d of this.carDisposables) d.dispose();
    this.carDisposables.length = 0;
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private track(...items: { dispose(): void }[]): void {
    for (const it of items) this.disposables.push(it);
  }

  private aspect(): number {
    return Math.max(0.1, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
  }

  private sizeRendererToCanvas(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // false → don't let three resize the canvas's CSS box (the layout owns it)
    this.renderer.setSize(w, h, false);
  }
}
