import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CRUSH_MAX, CRUSH_SCALE, GRAVITY, SUSP_MAX_COMP, SUSP_SAG, SUSP_ZETA } from './constants';
import type { Actor, CollideEvent, DeformablePart, SuspensionCorner, VehicleSpawn, VehicleSpec, Variant } from './types';
import { GROUP_DECOR, type PhysicsContext } from './physics';
import { GLASS, hullMat, makeBoxHullGeometry, makeSedanGeometry, makeTankGeometry, wheelGeometry, wheelMat } from './geometry';
import { buildPanels } from './panels';
import { makeBarrelTexture } from './textures';

export const SPECS: Record<Variant, VehicleSpec> = {
  sedan: {
    variant: 'sedan', mass: 1450, width: 1.9, height: 1.35, length: 4.6, halfY: 0.72,
    rideHeight: 0.8, hullY: 0.14, wheelRadius: 0.34, wheelX: 0.82, wheelZFront: -1.5, wheelZRear: 1.45,
    valueMult: 1, cashCap: 12000,
  },
  bus: {
    variant: 'bus', mass: 11500, width: 2.3, height: 2.4, length: 8.8, halfY: 1.05,
    rideHeight: 1.13, hullY: 0.15, wheelRadius: 0.42, wheelX: 0.95, wheelZFront: -2.9, wheelZRear: 2.9,
    valueMult: 1.6, cashCap: 22000,
  },
  tanker: {
    variant: 'tanker', mass: 15000, width: 2.35, height: 2.5, length: 9.2, halfY: 1.0,
    rideHeight: 1.06, hullY: 0, wheelRadius: 0.45, wheelX: 0.95, wheelZFront: -3.2, wheelZRear: 3.0,
    valueMult: 2, cashCap: 30000,
    explosive: { power: 2.4, fuseDamage: 16 },
  },
};

function registerDeformable(mesh: THREE.Mesh, deformables: DeformablePart[]): void {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const col = mesh.geometry.attributes.color as THREE.BufferAttribute;
  deformables.push({
    mesh,
    base: Float32Array.from(pos.array as Float32Array),
    baseCol: Float32Array.from(col.array as Float32Array),
  });
}

export type CollideHandler = (actor: Actor, e: CollideEvent) => void;

function buildWheels(spec: VehicleSpec, group: THREE.Group): THREE.Mesh[] {
  const wheels: THREE.Mesh[] = [];
  const corners: [number, number][] = [
    [-spec.wheelX, spec.wheelZFront], [spec.wheelX, spec.wheelZFront],
    [-spec.wheelX, spec.wheelZRear], [spec.wheelX, spec.wheelZRear],
  ];
  for (const [wx, wz] of corners) {
    const wh = new THREE.Mesh(wheelGeometry(spec.wheelRadius), wheelMat);
    wh.position.set(wx, -(spec.rideHeight - spec.wheelRadius), wz);
    wh.castShadow = true;
    group.add(wh);
    wheels.push(wh);
  }
  return wheels;
}

/** Per-wheel spring rates derived from the car's own weight: preload holds
 *  the body exactly at rideHeight, k stiffens it around that point. */
function buildSuspension(spec: VehicleSpec, wheels: THREE.Mesh[], mass: number): SuspensionCorner[] {
  const mw = mass / 4;
  const preload = mw * Math.abs(GRAVITY);
  const k = preload / SUSP_SAG;
  const c = 2 * SUSP_ZETA * Math.sqrt(k * mw);
  return wheels.map((w) => ({
    ax: w.position.x, az: w.position.z, preload, k, c,
    fmax: (preload + k * SUSP_MAX_COMP) * 1.5, dist: spec.rideHeight, grounded: false,
  }));
}

function makeActor(
  kind: Actor['kind'], body: CANNON.Body, group: THREE.Group, valueMult: number, cashLeft: number,
): Actor {
  return {
    kind, body, group, spec: null, wheels: [], susp: [], deformables: [], panels: [],
    q0: body.quaternion.clone(), scripted: null, started: false, curSpeed: 0,
    isPlayer: false, crashed: false, destabilized: 0, destabilizedByPlayer: false,
    popped: 0, damageLvl: 0, smokeT: 0,
    exploded: false, fuse: null, valueMult, cashLeft,
  };
}

export function createVehicle(
  scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler,
  spawn: VehicleSpawn, isPlayer: boolean,
): Actor {
  const spec = SPECS[spawn.variant];
  const group = new THREE.Group();
  const deformables: DeformablePart[] = [];

  if (spawn.variant === 'sedan') {
    const hull = new THREE.Mesh(makeSedanGeometry(spec.width, spec.height, spec.length, spawn.color, GLASS), hullMat);
    hull.position.y = spec.hullY;
    hull.castShadow = hull.receiveShadow = true;
    group.add(hull);
    registerDeformable(hull, deformables);
  } else if (spawn.variant === 'bus') {
    const hull = new THREE.Mesh(makeBoxHullGeometry(spec.width, spec.height, spec.length, spawn.color, GLASS), hullMat);
    hull.position.y = spec.hullY;
    hull.castShadow = hull.receiveShadow = true;
    group.add(hull);
    registerDeformable(hull, deformables);
  } else {
    // tanker: cab up front, fuel tank behind (the tank never detaches —
    // it's the explosive payload, like BP's eAncillaries_PetrolTank_Truck)
    const cab = new THREE.Mesh(makeBoxHullGeometry(2.2, 2.0, 2.2, spawn.color, GLASS, 0.45, 0.88), hullMat);
    cab.position.set(0, 0.05, -3.3);
    cab.castShadow = cab.receiveShadow = true;
    group.add(cab);
    registerDeformable(cab, deformables);
    const tank = new THREE.Mesh(makeTankGeometry(1.0, 6.2, 0xd8dde2), hullMat);
    tank.position.set(0, 0.3, 0.9);
    tank.castShadow = tank.receiveShadow = true;
    group.add(tank);
    registerDeformable(tank, deformables);
  }

  const panels = buildPanels(group, spawn.variant, spawn.color, deformables);

  if (isPlayer) {
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.07, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x551612, roughness: 0.5, flatShading: true }),
    );
    wing.position.set(0, 0.78, 2.0);
    wing.castShadow = true;
    group.add(wing);
  }

  const wheels = buildWheels(spec, group);
  scene.add(group);

  const body = new CANNON.Body({ mass: isPlayer ? spec.mass + 130 : spec.mass, material: phys.matCar });
  body.addShape(new CANNON.Box(new CANNON.Vec3(spec.width / 2, spec.halfY, spec.length / 2)));
  // ground clearance is tiny — the chassis box must never hard-clip ramp
  // kinks or plinth edges, the suspension height field drives over those.
  // Wrecks get the full mask back (Game.markCrashed) and tumble on décor.
  body.collisionFilterMask = ~GROUP_DECOR;
  body.position.set(spawn.x, spec.rideHeight, spawn.z);
  const yaw = Math.atan2(spawn.dir.x, spawn.dir.z) + Math.PI; // hull forward is -z
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  body.linearDamping = 0.05;
  body.angularDamping = 0.3;
  // traffic sleeps until its wave starts; the player must never doze off
  // while waiting at the line (velocity writes don't wake a sleeping body)
  body.allowSleep = !isPlayer;
  phys.world.addBody(body);
  if (!isPlayer) body.sleep();

  const susp = buildSuspension(spec, wheels, body.mass);

  const actor = makeActor('vehicle', body, group, spec.valueMult, spec.cashCap);
  actor.spec = spec;
  actor.wheels = wheels;
  actor.susp = susp;
  actor.deformables = deformables;
  actor.panels = panels;
  actor.scripted = { dir: { x: spawn.dir.x, z: spawn.dir.z }, speed: spawn.speed, delay: spawn.delay ?? 0 };
  actor.curSpeed = isPlayer ? 0 : spawn.speed;
  actor.isPlayer = isPlayer;
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

const poleMat = new THREE.MeshStandardMaterial({ color: 0x3d434b, roughness: 0.6, metalness: 0.4 });
const poleHeadMat = new THREE.MeshStandardMaterial({ color: 0x22262c, emissive: 0xff9a2a, emissiveIntensity: 0.9 });
const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 4.8, 8);
const poleHeadGeo = new THREE.BoxGeometry(0.34, 0.8, 0.3);

export function createPole(scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler, x: number, z: number): Actor {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.castShadow = true;
  group.add(pole);
  const head = new THREE.Mesh(poleHeadGeo, poleHeadMat);
  head.position.set(0, 2.0, 0.22);
  head.castShadow = true;
  group.add(head);
  scene.add(group);

  const body = new CANNON.Body({ mass: 90, material: phys.matCar });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.13, 2.4, 0.13)));
  body.position.set(x, 2.4, z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(-x, -z)); // signal faces the junction
  body.linearDamping = 0.05;
  body.angularDamping = 0.2;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.4;
  body.sleepTimeLimit = 0.3;
  phys.world.addBody(body);
  body.sleep();

  const actor = makeActor('pole', body, group, 0.5, 900);
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

let barrelTex: THREE.CanvasTexture | null = null;
const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.85, 12);

export function createBarrel(scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler, x: number, z: number): Actor {
  if (!barrelTex) barrelTex = makeBarrelTexture();
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(barrelGeo, new THREE.MeshStandardMaterial({ map: barrelTex, roughness: 0.55, metalness: 0.25 }));
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  scene.add(group);

  const body = new CANNON.Body({ mass: 55, material: phys.matCar });
  body.addShape(new CANNON.Cylinder(0.32, 0.32, 0.85, 10));
  body.position.set(x, 0.425, z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.random() * Math.PI);
  body.linearDamping = 0.1;
  body.angularDamping = 0.2;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.3;
  body.sleepTimeLimit = 0.4;
  phys.world.addBody(body);
  body.sleep();

  const actor = makeActor('barrel', body, group, 0.4, 2200);
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

// ---------- crumple deformation ----------
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lp = new THREE.Vector3();

export function deformActor(actor: Actor, worldPoint: THREE.Vector3, strength: number): void {
  if (!actor.deformables.length) return;
  actor.group.updateMatrixWorld(true);
  const R = 0.9 + strength * 0.16;

  for (const part of actor.deformables) {
    _lp.copy(worldPoint);
    part.mesh.worldToLocal(_lp);
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const base = part.base;
    let touched = false;

    for (let i = 0; i < pos.count; i++) {
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const d = _v.distanceTo(_lp);
      if (d > R) continue;
      touched = true;
      let f = 1 - d / R;
      f *= f;

      _dir.set(_v.x, _v.y * 0.35, _v.z);
      if (_dir.lengthSq() < 0.001) _dir.set(0, -1, 0);
      _dir.normalize().negate(); // push toward hull core
      const amt = strength * CRUSH_SCALE * f * (0.75 + Math.random() * 0.5);
      _v.addScaledVector(_dir, amt);
      _v.x += (Math.random() - 0.5) * 0.06 * f; // crumple jitter
      _v.y += (Math.random() - 0.5) * 0.06 * f;
      _v.z += (Math.random() - 0.5) * 0.06 * f;

      const bx = base[i * 3];
      const by = base[i * 3 + 1];
      const bz = base[i * 3 + 2];
      const dx = _v.x - bx;
      const dy = _v.y - by;
      const dz = _v.z - bz;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dl > CRUSH_MAX) {
        const s = CRUSH_MAX / dl;
        _v.set(bx + dx * s, by + dy * s, bz + dz * s);
      }
      pos.setXYZ(i, _v.x, _v.y, _v.z);

      const k = Math.max(0.35, 1 - 0.45 * f); // scuffed paint
      col.setXYZ(i, col.getX(i) * k + 0.05 * f, col.getY(i) * k + 0.045 * f, col.getZ(i) * k + 0.04 * f);
    }
    if (touched) {
      pos.needsUpdate = true;
      col.needsUpdate = true;
      geo.computeVertexNormals();
    }
  }
}

/** Full body-shop pass: un-crumple every panel, restore the paint, re-hang
 *  detached panels at their hinges and refit any popped wheels. Loose-part
 *  physics bodies for torn panels must be reclaimed by the caller (they
 *  share the panel meshes). */
export function repairVehicle(actor: Actor): void {
  for (const part of actor.deformables) {
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    (pos.array as Float32Array).set(part.base);
    pos.needsUpdate = true;
    const col = geo.attributes.color as THREE.BufferAttribute;
    (col.array as Float32Array).set(part.baseCol);
    col.needsUpdate = true;
    geo.computeVertexNormals();
  }
  for (const p of actor.panels) {
    if (p.detached) {
      p.pivot.add(p.mesh); // re-parent from the scene back onto the hinge
      p.mesh.position.copy(p.home);
      p.mesh.quaternion.set(0, 0, 0, 1);
    }
    p.detached = false;
    p.damage = 0;
    p.angle = 0;
    p.pivot.quaternion.set(0, 0, 0, 1);
  }
  if (actor.spec && actor.wheels.length < 4) {
    for (const w of actor.wheels) actor.group.remove(w); // geometry is cached/shared — don't dispose
    actor.wheels = buildWheels(actor.spec, actor.group);
    actor.susp = buildSuspension(actor.spec, actor.wheels, actor.body.mass);
  }
  actor.popped = 0;
  actor.damageLvl = 0;
  actor.smokeT = 0;
}

/** Darken the paint after a vehicle burns/detonates. */
export function charActor(actor: Actor): void {
  for (const part of actor.deformables) {
    const col = part.mesh.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < col.count; i++) {
      col.setXYZ(i, col.getX(i) * 0.42, col.getY(i) * 0.4, col.getZ(i) * 0.38);
    }
    col.needsUpdate = true;
  }
}

export interface LoosePart {
  mesh: THREE.Mesh;
  body: CANNON.Body;
}

const _wp = new THREE.Vector3();

/** Detach the wheel nearest the impact and hand it to physics. */
export function popWheel(actor: Actor, worldPoint: THREE.Vector3, scene: THREE.Scene, world: CANNON.World, matCar: CANNON.Material): LoosePart | null {
  if (!actor.wheels.length || !actor.spec) return null;
  actor.popped++;
  let best = 0;
  let bestD = Infinity;
  actor.wheels.forEach((w, i) => {
    w.getWorldPosition(_wp);
    const d = _wp.distanceToSquared(worldPoint);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const wheel = actor.wheels.splice(best, 1)[0];
  actor.susp.splice(best, 1); // that corner loses its spring
  scene.attach(wheel); // keep world transform

  const b = new CANNON.Body({ mass: 14, material: matCar });
  b.addShape(new CANNON.Sphere(actor.spec.wheelRadius - 0.01));
  b.position.set(wheel.position.x, wheel.position.y, wheel.position.z);
  const v = actor.body.velocity;
  b.velocity.set(
    v.x + (Math.random() - 0.5) * 6,
    Math.abs(v.y) * 0.4 + 3 + Math.random() * 4,
    v.z + (Math.random() - 0.5) * 6,
  );
  b.angularVelocity.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
  b.linearDamping = 0.15;
  b.angularDamping = 0.15;
  world.addBody(b);
  return { mesh: wheel, body: b };
}
