import * as THREE from 'three';
import { getVehicleModel, type PlayerCarId, type VehicleModel, setPlayerCar } from './models';
import { panelDefs } from './panels';
import { SPECS } from './vehicles';

// ────────────────────────────────────────────────────────────────────────────
// GarageScene — a standalone, self-contained three.js showroom for the car
// SELECT screen (the menu's "garage"). It is DELIBERATELY decoupled from the
// game sim: its own Scene + PerspectiveCamera + WebGLRenderer + rAF loop, no
// physics world, no RNG, no replay. Nothing here can perturb a pin — it never
// imports the Game, never touches simRand, and only READS the baked vehicle
// templates (getVehicleModel) which are produced once at boot.
//
// The look: a moody concrete bunker. Dark polished floor with a faked planar
// reflection (a mirrored copy of the car under a translucent floor pane — far
// cheaper than a real reflector and no extra render target), a few columns and
// a back wall to give the space depth, and a three-point rig (warm key, cool
// rim, soft fill) plus a dramatic overhead spotlight cone on the turntable.
// The car sits on a low turntable and the CAMERA slowly ORBITS it (the car
// itself does not spin — orbiting the camera keeps the key light raking the
// same flank, which reads more cinematic). One soft blob ground-shadow under
// the car; no shadow maps, no post.
//
// CHEAP TO MOUNT: one car mesh (cloned from the bake), a handful of boxes, a
// PMREM-free env. dispose() frees every GL resource and forces a context loss
// (the codebase leaks WebGL contexts otherwise).
// ────────────────────────────────────────────────────────────────────────────

/** Default paint = the player's spawn red (level1/gantryPoint spawn colour),
 *  so an un-customised car shows the colour it will actually drive in. */
export const GARAGE_DEFAULT_COLOR = 0xe8352a;

const FLOOR_Y = -0.02; // a hair below the wheels' contact line
const ORBIT_RADIUS = 6.4;
const ORBIT_HEIGHT = 2.35;
const ORBIT_SPEED = 0.16; // rad/s — a slow cinematic sweep
const TARGET_Y = 0.55; // look a touch above the floor (at the car's waist)

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

    this.buildShowroom();
    this.buildLights();
    this.buildEnv();
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
    const car = this.buildCar(model, color);
    this.carGroup = car;
    this.turntable.add(car);

    // faked floor reflection: a mirrored (scaleY = -1) copy of the car sitting
    // under the floor, dimmed by the translucent floor pane over it. Cheaper
    // than a Reflector render-target and reads as a wet-concrete sheen.
    const mirror = car.clone(true);
    mirror.scale.y = -1;
    mirror.position.y = FLOOR_Y * 2; // reflect across the floor plane
    mirror.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const src = m.material as THREE.Material | THREE.Material[];
        const dim = (mat: THREE.Material) => {
          const c = mat.clone();
          c.transparent = true;
          (c as THREE.Material & { opacity: number }).opacity = 0.28;
          c.depthWrite = false;
          this.carDisposables.push(c);
          return c;
        };
        m.material = Array.isArray(src) ? src.map(dim) : dim(src);
        m.castShadow = false;
      }
    });
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

  /** Build a CLEAN, INTACT showroom car from a baked template.
   *
   *  The baked `model.body` is the crash rig's hull: its detachable panels
   *  (doors/bonnet/boot/bumpers) have been CARVED OUT of the index at bake time
   *  (models.ts cutPanelTemplates) and live separately in `model.panelCuts`, so
   *  the hull alone is full of holes and reveals the stripped-chassis interior.
   *  In-game that's correct — panels hang on hinges and tear off. The SHOWROOM
   *  car must be whole, so we re-attach every panel cut at its REST position
   *  (the spot it was carved from) to close the bodywork back up. No detach, no
   *  flap, no debris/cones — those are gameplay-only. We still draw the interior
   *  so the cabin reads through the glass, but no wound exposes it.
   *
   *  Mirrors vehicles.ts's makeModelHull + panels.ts's buildPanels rest pose,
   *  with garage-local, glossier materials and a single set of wheels. */
  private buildCar(model: VehicleModel, color: number): THREE.Group {
    const group = new THREE.Group();
    const c = new THREE.Color(color);

    // hull geometry — clone (the template is shared/read-only) and repaint
    const bodyGeo = model.body.clone();
    this.carDisposables.push(bodyGeo);
    const col = bodyGeo.attributes.color as THREE.BufferAttribute;
    for (const [s, e] of model.paintRanges) {
      for (let i = s; i < e; i++) col.setXYZ(i, c.r, c.g, c.b);
    }
    // lift the dark-baked glass toward a tinted-but-readable showroom tone
    for (const [s, e] of model.glassRanges) {
      for (let i = s; i < e; i++) col.setXYZ(i, 0.16, 0.2, 0.26);
    }
    col.needsUpdate = true;

    const carMats = this.carMats();
    const hull = new THREE.Mesh(bodyGeo, carMats);
    hull.castShadow = false;
    group.add(hull);

    // re-attach the carved bodywork (intact, at rest) so the hull's panel
    // holes close up. panelDefs() is pure and gives the same defs the bake
    // cut against; cut geometry is panel-local (origin at def.center), so a
    // mesh placed at def.center sits exactly back in its wound. Paint the cut's
    // paint verts in the body colour to match the hull; trim/handles keep their
    // baked colour. Reuse the hull's paint material — its index has no glass/
    // lens groups, so a single-material mesh is correct. */
    const panelPaint = (carMats[0] as THREE.Material); // [paint, glass, head, tail]
    for (const [i, def] of panelDefs(SPECS.sedan, model).entries()) {
      const cut = model.panelCuts[i];
      if (!cut) continue; // sliver region — nothing was carved, hull kept it
      const geo = cut.geo.clone();
      this.carDisposables.push(geo);
      const pcol = geo.attributes.color as THREE.BufferAttribute;
      for (let v = 0; v < cut.paint.length; v++) {
        if (cut.paint[v]) pcol.setXYZ(v, c.r, c.g, c.b);
      }
      pcol.needsUpdate = true;
      const panel = new THREE.Mesh(geo, panelPaint);
      panel.position.set(def.center[0], def.center[1], def.center[2]);
      group.add(panel);
    }

    if (model.interior) {
      const inner = new THREE.Mesh(model.interior.clone(), this.interiorMat());
      this.carDisposables.push(inner.geometry as THREE.BufferGeometry);
      group.add(inner);
    }

    // wheels at the arch corners (front/rear × left/right)
    const corners: [number, number, THREE.BufferGeometry][] = [
      [-model.arch.x, model.arch.zFront, model.wheelL],
      [model.arch.x, model.arch.zFront, model.wheelR],
      [-model.arch.x, model.arch.zRear, model.wheelL],
      [model.arch.x, model.arch.zRear, model.wheelR],
    ];
    const wheelMat = this.wheelMat();
    for (const [wx, wz, geo] of corners) {
      const wh = new THREE.Mesh(geo, wheelMat);
      wh.position.set(wx, model.wheelY, wz);
      group.add(wh);
    }

    // seat the car on the floor: the bake's group origin sits at COM height, so
    // the wheels rest at wheelY; drop the group so wheelY meets the floor.
    group.position.y = -model.wheelY + FLOOR_Y;
    return group;
  }

  /** Hull material set [paint, glass, headlight, taillight] to mirror the
   *  baked hull's four index groups (applyHullGroups). Glossy clearcoat over
   *  vertex colours = B3 paint; glass is a dark tinted pane (no transmission —
   *  the garage has no framebuffer interior pre-pass worth paying for). */
  private carMats(): THREE.Material[] {
    const paint = new THREE.MeshPhysicalMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.28, metalness: 0.05,
      clearcoat: 1, clearcoatRoughness: 0.06,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.08, metalness: 0,
      clearcoat: 1, clearcoatRoughness: 0.04, transparent: true, opacity: 0.62,
    });
    const head = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 0.35, roughness: 0.3,
    });
    const tail = new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff, emissive: 0xff2a16, emissiveIntensity: 0.4, roughness: 0.35,
    });
    this.carDisposables.push(paint, glass, head, tail);
    return [paint, glass, head, tail];
  }

  private interiorMat(): THREE.Material[] {
    const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
    const cabin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    this.carDisposables.push(metal, cabin);
    return [metal, cabin];
  }

  private wheelMat(): THREE.Material {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.78 });
    this.carDisposables.push(m);
    return m;
  }

  // ── showroom shell ───────────────────────────────────────────────────────

  private buildShowroom(): void {
    // floor — dark polished concrete; the translucent pane over the mirrored
    // car gives the wet sheen, this is the matte base under it
    const floorGeo = new THREE.CircleGeometry(40, 64);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.85, metalness: 0.1 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y - 0.001;
    this.scene.add(floor);
    this.track(floorGeo, floorMat);

    // the translucent reflection pane that dims the mirrored copy into a sheen
    const paneGeo = new THREE.CircleGeometry(40, 64);
    const paneMat = new THREE.MeshStandardMaterial({
      color: 0x0c0e12, roughness: 0.5, metalness: 0.4, transparent: true, opacity: 0.72, depthWrite: false,
    });
    const pane = new THREE.Mesh(paneGeo, paneMat);
    pane.rotation.x = -Math.PI / 2;
    pane.position.y = FLOOR_Y;
    this.scene.add(pane);
    this.track(paneGeo, paneMat);

    // turntable plinth — a low dark disc with a glowing orange rim ring, B3
    // garage flavour
    const discGeo = new THREE.CylinderGeometry(3.2, 3.4, 0.12, 56);
    const discMat = new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.7, metalness: 0.2 });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.y = FLOOR_Y - 0.06;
    this.scene.add(disc);
    this.track(discGeo, discMat);

    const ringGeo = new THREE.TorusGeometry(3.25, 0.045, 8, 80);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x3a2410, emissive: 0xff7a18, emissiveIntensity: 1.4 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = FLOOR_Y + 0.01;
    this.scene.add(ring);
    this.track(ringGeo, ringMat);

    // back wall + side columns for depth — kept dark so the car pops
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x101319, roughness: 0.95, metalness: 0.05 });
    this.track(wallMat);
    const wallGeo = new THREE.PlaneGeometry(46, 16);
    this.track(wallGeo);
    for (const ry of [0, Math.PI]) {
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(0, 8 + FLOOR_Y, ry === 0 ? -13 : 13);
      wall.rotation.y = ry;
      this.scene.add(wall);
    }

    // concrete columns flanking the car — gives the orbit something to sweep past
    const colGeo = new THREE.CylinderGeometry(0.55, 0.65, 16, 18);
    const colMat = new THREE.MeshStandardMaterial({ color: 0x191c22, roughness: 0.92, metalness: 0.05 });
    this.track(colGeo, colMat);
    for (const [cx, cz] of [[-9, -8], [9, -8], [-9, 8], [9, 8]] as const) {
      const pillar = new THREE.Mesh(colGeo, colMat);
      pillar.position.set(cx, 8 + FLOOR_Y, cz);
      this.scene.add(pillar);
    }

    // hazard-stripe floor markings (B3 garage cones-and-tape flavour) — thin
    // angled bars on the concrete, emissive so they catch the spotlight edge
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x2a2410, emissive: 0xffb046, emissiveIntensity: 0.25, roughness: 0.8 });
    this.track(stripeMat);
    const stripeGeo = new THREE.PlaneGeometry(0.34, 5);
    this.track(stripeGeo);
    for (let i = -3; i <= 3; i++) {
      const bar = new THREE.Mesh(stripeGeo, stripeMat);
      bar.rotation.x = -Math.PI / 2;
      bar.rotation.z = Math.PI / 4;
      bar.position.set(i * 0.6 - 6.2, FLOOR_Y + 0.005, -6.5);
      this.scene.add(bar);
    }

    // a couple of marker cones beside the plinth
    const coneGeo = new THREE.ConeGeometry(0.26, 0.7, 14);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6, emissive: 0x401200, emissiveIntensity: 0.4 });
    this.track(coneGeo, coneMat);
    for (const [cx, cz] of [[-3.9, 1.6], [3.9, -1.4]] as const) {
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.set(cx, FLOOR_Y + 0.29, cz);
      this.scene.add(cone);
    }
  }

  // ── lighting ────────────────────────────────────────────────────────────

  private buildLights(): void {
    // soft ambient so the dark shell isn't pure black
    const amb = new THREE.AmbientLight(0x2a3340, 0.6);
    this.scene.add(amb);

    // dramatic overhead spotlight on the turntable — a tight warm cone, the
    // signature "SELECT A CAR" pool of light
    const spot = new THREE.SpotLight(0xffe6c0, 90, 22, 0.5, 0.55, 1.4);
    spot.position.set(0.5, 9, 1.2);
    spot.target.position.set(0, 0, 0);
    this.scene.add(spot);
    this.scene.add(spot.target);

    // warm key from the front-left
    const key = new THREE.DirectionalLight(0xfff0dd, 1.7);
    key.position.set(-6, 6, 7);
    this.scene.add(key);

    // cool rim from behind-right — separates the car from the dark wall
    const rim = new THREE.DirectionalLight(0x7fb0ff, 2.2);
    rim.position.set(7, 4, -8);
    this.scene.add(rim);

    // dim blue fill from the left to keep the shadow side readable
    const fill = new THREE.DirectionalLight(0x4a6ea0, 0.5);
    fill.position.set(8, 3, 4);
    this.scene.add(fill);

    // a faint glow point under the rim ring so the plinth reads as lit
    const rimGlow = new THREE.PointLight(0xff7a18, 6, 7, 2);
    rimGlow.position.set(0, FLOOR_Y + 0.4, 0);
    this.scene.add(rimGlow);
  }

  /** A tiny procedural environment map so the clearcoat has something bright to
   *  reflect (B3 gloss needs streaks to sweep). Built from a gradient scene via
   *  PMREM, captured once, then the generator is freed. */
  private buildEnv(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    // a dark room with a few bright strip-light panels overhead and a warm
    // floor bounce — gives the paint horizontal showroom streaks
    envScene.background = new THREE.Color(0x05070a);
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 1.4),
      new THREE.MeshBasicMaterial({ color: 0xeaf2ff }),
    );
    for (const sx of [-3, 0, 3]) {
      const s = strip.clone();
      s.position.set(sx, 6, 0);
      s.rotation.x = Math.PI / 2;
      envScene.add(s);
    }
    const warmFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshBasicMaterial({ color: 0x2a1c10 }),
    );
    warmFloor.position.y = -4;
    warmFloor.rotation.x = -Math.PI / 2;
    envScene.add(warmFloor);
    const rimPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 6),
      new THREE.MeshBasicMaterial({ color: 0x14213a }),
    );
    rimPanel.position.set(0, 2, -8);
    envScene.add(rimPanel);

    const env = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = env;
    this.track(env);
    // free the throwaway env scene + the generator
    envScene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    strip.geometry.dispose();
    (strip.material as THREE.Material).dispose();
    pmrem.dispose();
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
