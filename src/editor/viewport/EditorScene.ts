// The editor's 3D view — a lightweight raw-three.js scene (no physics, no
// game engine) that draws a LevelDef as simplified stand-ins: the same
// footprints the game builds (environment/build.ts numbers) without the
// streaming/instancing machinery. Steward's overlay contract, one class:
// entities carry a NodePath in userData; clicking picks, dragging moves on
// the ground plane, and the selection box tracks the shared NodePath.
//
// Two ways to move things, both funneling through the same gesture flow
// (onDragStart → onTransientMove stream → onDragEnd = one undo step):
//  - grab the body and drag it on the ground plane (shift = 0.5 m snap)
//  - the steward-style gizmo (TransformControls): MOVE arrows / ROTATE ring,
//    W/E toggled. Rotation is yaw-locked; only headed things rotate
//    (vehicles' dir, props' & roads' yaw). Pickups alone get the Y arrow.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { LevelDef, PickupDef, PropDef, RampDef, RoadDef, VehicleSpawn } from '../../game/types';
import { SPECS } from '../../game/vehicles/specs';
import type { NodePath } from '../schema/types';

export type GizmoMode = 'translate' | 'rotate';

export interface EditorSceneCallbacks {
  onSelect: (path: NodePath | null) => void;
  /** Stream a transient patch during a drag — flat fields (x/z/zStart/yaw)
   *  or structured ones (dir). The Viewport routes each to the walker. */
  onTransientMove: (itemPath: NodePath, patch: Record<string, unknown>) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

const pathKey = (p: NodePath) => JSON.stringify(p);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The entity a (possibly leaf) selection path belongs to, or null when the
 *  path isn't a placeable (level root, mode record, …). */
function entityPathFor(path: NodePath): NodePath | null {
  if (!path.length) return null;
  if (path[0] === 'player') return ['player'];
  if (path[0] === 'mode') {
    if (path[1] === 'race' && path[2] === 'waypoints' && path.length >= 4) return path.slice(0, 4);
    return null;
  }
  if (path.length >= 2 && typeof path[1] === 'number') return path.slice(0, 2);
  return null;
}

/** What the gizmo may do for an entity: yaw only exists on headed things. */
const canRotate = (root: string | number) =>
  root === 'player' || root === 'traffic' || root === 'props' || root === 'roads';

export class EditorScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private transform: TransformControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private resizeObs: ResizeObserver;
  private raf = 0;

  /** Everything rebuilt per level change. */
  private world = new THREE.Group();
  /** Pickable entity roots, keyed by NodePath. */
  private entities = new Map<string, THREE.Object3D>();
  private selHelper: THREE.BoxHelper | null = null;
  private selectedEntity: NodePath | null = null;
  private gizmoMode: GizmoMode = 'translate';
  /** The race ribbon line — swapped in place so a waypoint drag can restyle
   *  it live without a full rebuild (rebuilds are OFF mid-drag). */
  private ribbon: THREE.Line | null = null;

  // body-drag state
  private pick: { object: THREE.Object3D; path: NodePath; downX: number; downY: number } | null = null;
  private emptyDown: { x: number; y: number } | null = null;
  private dragging = false;
  private gizmoDragging = false;
  private dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragOffset = new THREE.Vector3();
  private hit = new THREE.Vector3();

  constructor(private container: HTMLElement, private cb: EditorSceneCallbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x8fb2d4);
    this.scene.fog = new THREE.Fog(0x8fb2d4, 260, 520);

    this.camera = new THREE.PerspectiveCamera(
      55, container.clientWidth / Math.max(1, container.clientHeight), 0.1, 1000,
    );
    this.camera.position.set(46, 58, -74);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.maxDistance = 400;
    this.controls.target.set(0, 0, 0);

    // ---- the gizmo ----
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.9);
    this.scene.add(this.transform.getHelper());
    this.transform.addEventListener('dragging-changed', (e: { value?: unknown }) => {
      const active = !!e.value;
      this.controls.enabled = !active;
      if (active) {
        this.gizmoDragging = true;
        this.cb.onDragStart();
      } else if (this.gizmoDragging) {
        this.gizmoDragging = false;
        this.cb.onDragEnd();
      }
    });
    this.transform.addEventListener('objectChange', () => this.onGizmoChange());
    // shift = snap, both modes (steward's snap toggle, held not latched)
    addEventListener('keydown', this.onSnapKey);
    addEventListener('keyup', this.onSnapKey);

    const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x50584a, 1.05);
    const sun = new THREE.DirectionalLight(0xfff2df, 1.6);
    sun.position.set(60, 90, -40);
    this.scene.add(hemi, sun);
    this.scene.add(this.world);

    const grid = new THREE.GridHelper(400, 40, 0xffffff, 0xffffff);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.08;
    grid.position.y = 0.02;
    this.scene.add(grid);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.style.touchAction = 'none';

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);

    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerup', this.onPointerUp);
    removeEventListener('keydown', this.onSnapKey);
    removeEventListener('keyup', this.onSnapKey);
    this.transform.detach();
    this.transform.dispose();
    this.controls.dispose();
    this.disposeGroup(this.scene);
    this.renderer.dispose();
    el.remove();
  }

  isDragging(): boolean {
    return this.dragging || this.gizmoDragging;
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmoMode = mode;
    this.configureGizmo();
  }

  private onSnapKey = (e: KeyboardEvent): void => {
    const snap = e.shiftKey;
    this.transform.setTranslationSnap(snap ? 0.5 : null);
    this.transform.setRotationSnap(snap ? THREE.MathUtils.degToRad(15) : null);
  };

  private resize(): void {
    const w = this.container.clientWidth;
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private disposeGroup(root: THREE.Object3D): void {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
  }

  // ---------- level → scene ----------

  setLevel(level: LevelDef): void {
    this.transform.detach(); // never let the gizmo outlive its object
    this.scene.remove(this.world);
    this.disposeGroup(this.world);
    this.world = new THREE.Group();
    this.entities.clear();
    this.ribbon = null;

    this.buildGround(level);

    const add = (path: NodePath, obj: THREE.Object3D) => {
      obj.userData.path = path;
      this.entities.set(pathKey(path), obj);
      this.world.add(obj);
    };

    (level.roads ?? []).forEach((r, i) => add(['roads', i], this.buildRoad(r)));
    add(['player'], this.buildVehicle(level.player, true));
    level.traffic.forEach((t, i) => add(['traffic', i], this.buildVehicle(t, false)));
    level.poles.forEach((p, i) => add(['poles', i], this.buildPole(p.x, p.z)));
    level.barrels.forEach((b, i) => add(['barrels', i], this.buildBarrel(b.x, b.z)));
    level.ramps.forEach((r, i) => add(['ramps', i], this.buildRamp(r)));
    level.buildings.forEach((b, i) => add(['buildings', i], this.buildBuilding(b.x, b.z, b.h, b.color)));
    level.pickups.forEach((p, i) => add(['pickups', i], this.buildPickup(p)));
    (level.props ?? []).forEach((p, i) => add(['props', i], this.buildProp(p)));

    if (level.mode.kind === 'race') {
      this.updateRaceRibbon(level);
      (level.mode.race.waypoints ?? []).forEach(([x, z], i) => {
        add(['mode', 'race', 'waypoints', i], this.buildWaypoint(x, z, i === 0));
      });
    }

    this.scene.add(this.world);
    this.refreshSelection();
  }

  setSelection(path: NodePath | null): void {
    this.selectedEntity = path ? entityPathFor(path) : null;
    this.refreshSelection();
  }

  /** Restyle just the ribbon from the current sections — called during a
   *  waypoint drag, when full rebuilds are suppressed. */
  updateRaceRibbon(level: LevelDef): void {
    if (level.mode.kind !== 'race') return;
    const race = level.mode.race;
    const pts = race.sections.map((s) => new THREE.Vector3(s.x, s.y + 0.15, s.z));
    if (pts.length) pts.push(pts[0].clone());
    if (this.ribbon) {
      this.ribbon.geometry.dispose();
      this.ribbon.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      return;
    }
    this.ribbon = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );
    this.world.add(this.ribbon);
  }

  private refreshSelection(): void {
    const obj = this.selectedEntity ? this.entities.get(pathKey(this.selectedEntity)) : null;
    if (!obj) {
      this.transform.detach();
      if (this.selHelper) {
        this.scene.remove(this.selHelper);
        this.selHelper.dispose();
        this.selHelper = null;
      }
      return;
    }
    if (!this.selHelper) {
      this.selHelper = new THREE.BoxHelper(obj, 0xffe14a);
      this.scene.add(this.selHelper);
    } else {
      this.selHelper.setFromObject(obj);
    }
    this.transform.attach(obj);
    this.configureGizmo();
  }

  /** Axis/mode policy for the current selection: yaw-locked rotation, XZ
   *  translation (pickups add Y), rotate falls back to move for unheaded
   *  things. */
  private configureGizmo(): void {
    const path = this.selectedEntity;
    if (!path) return;
    const root = path[0];
    const rotatable = canRotate(root);
    const mode: GizmoMode = this.gizmoMode === 'rotate' && rotatable ? 'rotate' : 'translate';
    this.transform.setMode(mode);
    if (mode === 'rotate') {
      this.transform.showX = false;
      this.transform.showZ = false;
      this.transform.showY = true; // the yaw ring
    } else {
      this.transform.showX = true;
      this.transform.showZ = true;
      this.transform.showY = root === 'pickups'; // only rings float
    }
  }

  /** Gizmo drag → the same transient patch stream as a body drag. */
  private onGizmoChange(): void {
    if (!this.gizmoDragging) return;
    const obj = this.transform.object as THREE.Object3D | undefined;
    const path = obj?.userData.path as NodePath | undefined;
    if (!obj || !path) return;
    this.selHelper?.setFromObject(obj);
    const root = path[0];
    if (this.transform.mode === 'rotate') {
      const yaw = Math.atan2(Math.sin(obj.rotation.y), Math.cos(obj.rotation.y));
      if (root === 'player' || root === 'traffic') {
        this.cb.onTransientMove(path, {
          dir: { x: Math.round(Math.sin(yaw) * 1000) / 1000, z: Math.round(Math.cos(yaw) * 1000) / 1000 },
        });
      } else {
        this.cb.onTransientMove(path, { yaw: round2(yaw) });
      }
      return;
    }
    const x = round2(obj.position.x);
    const z = round2(obj.position.z);
    if (root === 'ramps') {
      this.cb.onTransientMove(path, { x, zStart: z });
    } else if (root === 'pickups') {
      this.cb.onTransientMove(path, { x, y: Math.max(0.5, round2(obj.position.y)), z });
    } else if (root === 'mode') {
      this.cb.onTransientMove(path, { x, z }); // waypoint — Viewport re-tuples
    } else {
      this.cb.onTransientMove(path, { x, z });
    }
  }

  // ---------- builders (game-matched footprints, editor-simple looks) ----------

  private mat(color: number, opacity = 1): THREE.MeshLambertMaterial {
    return new THREE.MeshLambertMaterial({
      color, transparent: opacity < 1, opacity,
    });
  }

  private buildGround(level: LevelDef): void {
    const ground = level.ground ?? 'junction';
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(560, 560), this.mat(0x5d7a4a));
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.01;
    this.world.add(grass);

    const roadMat = this.mat(0x2e3138);
    if (ground === 'junction') {
      const ns = new THREE.Mesh(new THREE.PlaneGeometry(14, 280), roadMat);
      ns.rotation.x = -Math.PI / 2;
      ns.position.y = 0.005;
      const ew = new THREE.Mesh(new THREE.PlaneGeometry(280, 14), roadMat.clone());
      ew.rotation.x = -Math.PI / 2;
      ew.position.y = 0.004;
      this.world.add(ns, ew);
    } else if (ground === 'pad') {
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(170, 170), roadMat);
      pad.rotation.x = -Math.PI / 2;
      pad.position.y = 0.005;
      this.world.add(pad);
    }
  }

  private buildRoad(r: RoadDef): THREE.Object3D {
    const g = new THREE.Group();
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(r.width, r.length), this.mat(0x33373f));
    strip.rotation.x = -Math.PI / 2;
    strip.position.y = 0.006;
    g.add(strip);
    if (r.dashes !== false) {
      // one long thin centre stripe reads as the dash line at editor scale
      const stripe = new THREE.Mesh(
        new THREE.PlaneGeometry(0.25, Math.max(0, r.length - 4)),
        this.mat(0xd9dde2, 0.55),
      );
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.y = 0.012;
      g.add(stripe);
    }
    g.position.set(r.x, 0, r.z);
    g.rotation.y = r.yaw;
    return g;
  }

  private buildVehicle(spawn: VehicleSpawn, isPlayer: boolean): THREE.Object3D {
    const spec = SPECS[spawn.variant] ?? SPECS.sedan;
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(spec.width, spec.height, spec.length),
      this.mat(spawn.color),
    );
    body.position.y = spec.height / 2 + 0.15;
    g.add(body);
    // heading arrow — reads at a glance which way a car will drive
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 1.2, 4),
      this.mat(isPlayer ? 0xffffff : 0x111111, 0.9),
    );
    arrow.rotation.x = Math.PI / 2;
    arrow.position.set(0, spec.height + 0.5, spec.length / 2 + 0.4);
    g.add(arrow);
    if (isPlayer) {
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(spec.length * 0.55, spec.length * 0.55 + 0.3, 32),
        this.mat(0xffe14a, 0.8),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.05;
      g.add(halo);
    }
    g.position.set(spawn.x, 0, spawn.z);
    g.rotation.y = Math.atan2(spawn.dir.x, spawn.dir.z);
    return g;
  }

  private buildPole(x: number, z: number): THREE.Object3D {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 4.4, 8), this.mat(0x9aa3ad));
    m.position.set(x, 2.2, z);
    return m;
  }

  private buildBarrel(x: number, z: number): THREE.Object3D {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.95, 12), this.mat(0xd9552e));
    m.position.set(x, 0.48, z);
    return m;
  }

  private buildRamp(r: RampDef): THREE.Object3D {
    const slopeLen = Math.hypot(r.length, r.height);
    const theta = Math.atan2(r.height, r.length);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.width, 0.3, slopeLen), this.mat(0x4ec3e0));
    mesh.rotation.x = -theta;
    const g = new THREE.Group();
    mesh.position.set(0, r.height / 2, r.length / 2);
    g.add(mesh);
    g.position.set(r.x, 0, r.zStart);
    return g;
  }

  private buildBuilding(x: number, z: number, h: number, color: number): THREE.Object3D {
    const g = new THREE.Group();
    const walk = new THREE.Mesh(new THREE.BoxGeometry(14, 0.16, 14), this.mat(0x8d949e));
    walk.position.y = 0.08;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(11, h, 11), this.mat(color));
    tower.position.y = 0.16 + h / 2;
    g.add(walk, tower);
    g.position.set(x, 0, z);
    return g;
  }

  private buildPickup(p: PickupDef): THREE.Object3D {
    const m = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.12, 10, 28), this.mat(0xffd24a));
    m.position.set(p.x, p.y, p.z);
    return m;
  }

  private buildProp(p: PropDef): THREE.Object3D {
    const solid = p.collider && p.collider !== 'none';
    const hx = solid ? (p.collider as { hx: number }).hx : 0.6;
    const hy = solid ? (p.collider as { hy: number }).hy : 0.8;
    const hz = solid ? (p.collider as { hz: number }).hz : 0.6;
    const g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      this.mat(p.tint ?? 0x7fd08a, solid ? 1 : 0.55),
    );
    box.position.y = hy + (p.y ?? 0);
    g.add(box);
    g.position.set(p.x, 0, p.z);
    g.rotation.y = p.yaw;
    return g;
  }

  private buildWaypoint(x: number, z: number, isStart: boolean): THREE.Object3D {
    const g = new THREE.Group();
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(isStart ? 1.5 : 1.1, 16, 12),
      this.mat(isStart ? 0x59d97a : 0xc75fd9),
    );
    orb.position.y = 1.2;
    g.add(orb);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2, 6), this.mat(0xffffff, 0.5));
    stem.position.y = 0.6;
    g.add(stem);
    g.position.set(x, 0, z);
    return g;
  }

  // ---------- picking + body drag ----------

  private setPointerFrom(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private pickEntity(e: PointerEvent): { object: THREE.Object3D; path: NodePath } | null {
    this.setPointerFrom(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.entities.values()], true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o && !o.userData.path) o = o.parent;
      if (o?.userData.path) return { object: o, path: o.userData.path as NodePath };
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    // pointer over a gizmo handle — TransformControls owns this gesture
    if (this.transform.axis || this.gizmoDragging) return;
    const picked = this.pickEntity(e);
    if (!picked) {
      // empty ground — OrbitControls owns the gesture; a motionless click
      // (checked at pointerup) clears the selection
      this.emptyDown = { x: e.clientX, y: e.clientY };
      return;
    }
    this.pick = { ...picked, downX: e.clientX, downY: e.clientY };
    this.controls.enabled = false;
    this.renderer.domElement.setPointerCapture(e.pointerId);
    // drag on the horizontal plane at the object's height (pickups float)
    const planeY = picked.path[0] === 'pickups' ? picked.object.position.y : 0;
    this.dragPlane.set(new THREE.Vector3(0, 1, 0), -planeY);
    this.setPointerFrom(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) {
      this.dragOffset.copy(picked.object.position).sub(this.hit);
    } else {
      this.dragOffset.set(0, 0, 0);
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pick) return;
    if (!this.dragging) {
      const moved = Math.hypot(e.clientX - this.pick.downX, e.clientY - this.pick.downY);
      if (moved < 4) return; // click slop
      this.dragging = true;
      this.cb.onDragStart();
      this.cb.onSelect(this.pick.path);
    }
    this.setPointerFrom(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, this.hit)) return;
    const obj = this.pick.object;
    let x = this.hit.x + this.dragOffset.x;
    let z = this.hit.z + this.dragOffset.z;
    if (e.shiftKey) {
      x = Math.round(x * 2) / 2; // snap to 0.5 m
      z = Math.round(z * 2) / 2;
    }
    x = round2(x);
    z = round2(z);
    obj.position.x = x;
    obj.position.z = z;
    this.selHelper?.setFromObject(obj);
    // ramps store their anchor as zStart; everything else is x/z
    const patch: Record<string, number> = this.pick.path[0] === 'ramps' ? { x, zStart: z } : { x, z };
    this.cb.onTransientMove(this.pick.path, patch);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (this.pick) {
      this.renderer.domElement.releasePointerCapture(e.pointerId);
      if (this.dragging) {
        this.dragging = false;
        this.cb.onDragEnd();
      } else {
        this.cb.onSelect(this.pick.path);
      }
      this.pick = null;
      this.controls.enabled = true;
    } else if (this.emptyDown) {
      const moved = Math.hypot(e.clientX - this.emptyDown.x, e.clientY - this.emptyDown.y);
      if (moved < 4) this.cb.onSelect(null);
      this.emptyDown = null;
    }
  };
}
