// The editor's 3D view — a lightweight raw-three.js scene (no physics, no
// game engine) that draws a LevelDef as simplified stand-ins: the same
// footprints the game builds (environment/build.ts numbers) without the
// streaming/instancing machinery. Steward's overlay contract, one class:
// entities carry a NodePath in userData; clicking picks, dragging moves on
// the ground plane, and the selection box tracks the shared NodePath.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { LevelDef, PickupDef, PropDef, RampDef, VehicleSpawn } from '../../game/types';
import { SPECS } from '../../game/vehicles/specs';
import type { NodePath } from '../schema/types';

export interface EditorSceneCallbacks {
  onSelect: (path: NodePath | null) => void;
  /** Stream a transient x/z (or ramp x/zStart) move during a drag. */
  onTransientMove: (itemPath: NodePath, patch: Record<string, number>) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

const pathKey = (p: NodePath) => JSON.stringify(p);

export class EditorScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private resizeObs: ResizeObserver;
  private raf = 0;

  /** Everything rebuilt per level change. */
  private world = new THREE.Group();
  /** Pickable entity roots, keyed by NodePath. */
  private entities = new Map<string, THREE.Object3D>();
  private selHelper: THREE.BoxHelper | null = null;
  private selectedKey: string | null = null;

  // drag state
  private pick: { object: THREE.Object3D; path: NodePath; downX: number; downY: number } | null = null;
  private emptyDown: { x: number; y: number } | null = null;
  private dragging = false;
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
    this.controls.dispose();
    this.disposeGroup(this.scene);
    this.renderer.dispose();
    el.remove();
  }

  isDragging(): boolean {
    return this.dragging;
  }

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
    this.scene.remove(this.world);
    this.disposeGroup(this.world);
    this.world = new THREE.Group();
    this.entities.clear();

    this.buildGround(level);

    const add = (path: NodePath, obj: THREE.Object3D) => {
      obj.userData.path = path;
      this.entities.set(pathKey(path), obj);
      this.world.add(obj);
    };

    add(['player'], this.buildVehicle(level.player, true));
    level.traffic.forEach((t, i) => add(['traffic', i], this.buildVehicle(t, false)));
    level.poles.forEach((p, i) => add(['poles', i], this.buildPole(p.x, p.z)));
    level.barrels.forEach((b, i) => add(['barrels', i], this.buildBarrel(b.x, b.z)));
    level.ramps.forEach((r, i) => add(['ramps', i], this.buildRamp(r)));
    level.buildings.forEach((b, i) => add(['buildings', i], this.buildBuilding(b.x, b.z, b.h, b.color)));
    level.pickups.forEach((p, i) => add(['pickups', i], this.buildPickup(p)));
    (level.props ?? []).forEach((p, i) => add(['props', i], this.buildProp(p)));

    if (level.mode.kind === 'race') this.world.add(this.buildRaceRibbon(level));

    this.scene.add(this.world);
    this.refreshSelection();
  }

  setSelection(path: NodePath | null): void {
    this.selectedKey = path ? pathKey(path.slice(0, 2)) : null;
    // a leaf path like ['barrels', 3, 'x'] still highlights barrel 3; single-
    // segment paths (player) key as-is
    if (path && path.length === 1) this.selectedKey = pathKey(path);
    this.refreshSelection();
  }

  private refreshSelection(): void {
    const obj = this.selectedKey ? this.entities.get(this.selectedKey) : null;
    if (!obj) {
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

  private buildRaceRibbon(level: LevelDef): THREE.Object3D {
    const g = new THREE.Group();
    if (level.mode.kind !== 'race') return g;
    const pts = level.mode.race.sections.map((s) => new THREE.Vector3(s.x, s.y + 0.15, s.z));
    if (pts.length) pts.push(pts[0].clone());
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffffff }),
    );
    g.add(line);
    return g;
  }

  // ---------- picking + drag ----------

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
    x = Math.round(x * 100) / 100;
    z = Math.round(z * 100) / 100;
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
