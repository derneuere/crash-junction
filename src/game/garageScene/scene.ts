import * as THREE from 'three';
import {
  getVehicleModel, setPlayerCar, PLAYER_CARS, type PlayerCarId, type VehicleModel,
} from '../models';
import {
  GARAGE_LINEUP_COLORS, BAY_SPACING, CAR_YAW, CAM_AZIMUTH, CAM_RADIUS, CAM_HEIGHT,
  TARGET_Y, FRAME_SHIFT, SWAY_SPEED, SWAY_AMOUNT, GLIDE_RATE,
} from './constants';
import { buildCar, buildMirror } from './car';
import { buildShowroom } from './showroom';
import { buildLights } from './lights';
import { buildEnv } from './env';

/** One parked roster car: its bay, template, current paint and GL resources. */
interface Bay {
  id: PlayerCarId;
  model: VehicleModel;
  color: number;
  group: THREE.Group;
  mirror: THREE.Group;
  disposables: { dispose(): void }[];
}

export class GarageScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  // shell resources (floor/walls/env) — live for the scene's whole life
  private readonly disposables: { dispose(): void }[] = [];
  // the parked roster, one entry per PLAYER_CARS def, built lazily on the
  // first setCar once the vehicle library is baked
  private readonly bays: Bay[] = [];
  private selected = 0;

  // eased camera state — glides bay-to-bay instead of cutting (the B3 move)
  private readonly camPos = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private camSnapped = false;

  private t = 0; // idle-sway clock (seconds, scene-local, presentation only)
  private raf = 0;
  private last = 0;
  private running = false;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.sizeRendererToCanvas();

    this.scene.background = new THREE.Color(0x0a0c10);
    this.scene.fog = new THREE.Fog(0x0a0c10, 13, 30);

    this.camera = new THREE.PerspectiveCamera(40, this.aspect(), 0.1, 100);

    buildShowroom(this.scene, (...items) => this.track(...items), PLAYER_CARS.length);
    buildLights(this.scene, PLAYER_CARS.length);
    buildEnv(this.renderer, this.scene, (...items) => this.track(...items));
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Focus the camera on `carId`'s bay (a smooth glide) and, if `color` is
   *  given, repaint that car. Cheap on every left/right cycle — the whole
   *  roster is parked once; cycling only moves the camera. Returns false only
   *  if loadVehicleModels never ran (caller can leave the screen up; the next
   *  call retries the lazy build). */
  setCar(carId: PlayerCarId, color?: number): boolean {
    if (!this.buildRoster()) return false;
    const idx = this.bays.findIndex((b) => b.id === carId);
    if (idx < 0) return false;
    this.selected = idx;
    // keep the module-level pin on the browsed car (presentation-only read;
    // App re-pins setPlayerCar before any Game constructs)
    setPlayerCar(carId);
    const bay = this.bays[idx];
    if (color !== undefined && color !== bay.color) this.repaint(bay, color);
    if (!this.running) this.renderOnce();
    return true;
  }

  /** Repaint the focused car without changing the selection. */
  setColor(color: number): void {
    const bay = this.bays[this.selected];
    if (bay) this.setCar(bay.id, color);
  }

  /** Start the rAF loop (idempotent) — eases the camera and sways idly. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      this.updateCamera(dt);
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

  /** Render a single frame with the sway clock pinned to `phase` and the
   *  camera snapped onto the selected bay (no glide). Used by the headless
   *  screenshot harness (tools/garageshot) for stable, comparable captures;
   *  production uses start()'s rAF loop instead. */
  renderPose(phase: number): void {
    if (this.disposed) return;
    this.t = phase;
    this.camSnapped = false; // force a snap to the exact framing
    this.updateCamera(0);
    this.renderer.render(this.scene, this.camera);
  }

  /** Re-fit the renderer + camera to the canvas's current box. */
  resize(): void {
    if (this.disposed) return;
    this.sizeRendererToCanvas();
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    if (!this.running) this.renderOnce();
  }

  /** Free every GL resource and drop the context. The codebase leaks WebGL
   *  contexts when a renderer is dropped without forceContextLoss(), so this
   *  is load-bearing — the menu mounts/unmounts the garage repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const bay of this.bays) this.teardownBay(bay);
    this.bays.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ── camera ────────────────────────────────────────────────────────────────

  /** Desired pos/target for the selected bay at the current sway phase, then
   *  exp-damped toward it (`dt` = 0 or an unsnapped camera → hard snap). */
  private updateCamera(dt: number): void {
    const cx = this.selected * BAY_SPACING;
    const az = CAM_AZIMUTH + SWAY_AMOUNT * Math.sin(this.t * SWAY_SPEED);
    const h = CAM_HEIGHT + 0.05 * Math.sin(this.t * SWAY_SPEED * 0.77);
    // screen-left in world space (dir × up shorthand) — shifting BOTH the
    // camera and its target left pushes the car right of screen centre,
    // clearing room for the bottom name/stat band (B3 framing)
    const lx = -Math.cos(az) * FRAME_SHIFT;
    const lz = Math.sin(az) * FRAME_SHIFT;
    const pos = new THREE.Vector3(cx + lx + Math.sin(az) * CAM_RADIUS, h, lz + Math.cos(az) * CAM_RADIUS);
    const target = new THREE.Vector3(cx + lx, TARGET_Y, lz);

    if (!this.camSnapped || dt <= 0) {
      this.camPos.copy(pos);
      this.camTarget.copy(target);
      this.camSnapped = true;
    } else {
      const k = 1 - Math.exp(-GLIDE_RATE * dt);
      this.camPos.lerp(pos, k);
      this.camTarget.lerp(target, k);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  // ── roster build / repaint ───────────────────────────────────────────────

  /** Park every roster car in its bay (once). False while the vehicle
   *  library is still unbaked — nothing is half-built in that case. */
  private buildRoster(): boolean {
    if (this.bays.length) return true;
    for (const [i, def] of PLAYER_CARS.entries()) {
      setPlayerCar(def.id);
      const model = getVehicleModel('sedan', true);
      if (!model) return false; // library missing — first lookup fails before anything builds
      const bay: Bay = {
        id: def.id,
        model,
        color: GARAGE_LINEUP_COLORS[def.id],
        group: new THREE.Group(), // placeholder, replaced by buildBayCar
        mirror: new THREE.Group(),
        disposables: [],
      };
      this.buildBayCar(bay, i);
      this.bays.push(bay);
    }
    return true;
  }

  /** (Re)build one bay's car + floor reflection at its parking spot. */
  private buildBayCar(bay: Bay, index: number): void {
    const car = buildCar(bay.model, bay.color, (...items) => bay.disposables.push(...items));
    car.position.x = index * BAY_SPACING;
    car.rotation.y = CAR_YAW; // angle-parked, nose toward the viewer's left (B3 stance)
    const mirror = buildMirror(car, (...items) => bay.disposables.push(...items));
    mirror.position.x = car.position.x;
    mirror.rotation.y = car.rotation.y;
    bay.group = car;
    bay.mirror = mirror;
    this.scene.add(car, mirror);
  }

  private repaint(bay: Bay, color: number): void {
    const index = this.bays.indexOf(bay);
    this.teardownBay(bay);
    bay.color = color;
    this.buildBayCar(bay, index);
  }

  private teardownBay(bay: Bay): void {
    this.scene.remove(bay.group, bay.mirror);
    for (const d of bay.disposables) d.dispose();
    bay.disposables.length = 0;
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private renderOnce(): void {
    this.updateCamera(0);
    this.renderer.render(this.scene, this.camera);
  }

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
