import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CRUSH_MAX, CRUSH_VISUAL, GRAVITY, SUSP_MAX_COMP, SUSP_SAG, SUSP_ZETA } from './constants';
import type { Actor, CollideEvent, DeformablePart, SuspensionCorner, VehicleSpawn, VehicleSpec, Variant } from './types';
import { GROUP_DECOR, type PhysicsContext } from './physics';
import { simRand } from './rng';
import { GLASS, adoptPlayerMaterials, applyNormalSmoothing, buildNormalSmoothing, cabinMat, glassMat, glassParams, headlightMat, hullMat, makeBoxHullGeometry, makeSedanGeometry, makeTankGeometry, metalMat, taillightMat, wheelGeometry, wheelMat } from './geometry';
import { buildPanels } from './panels';
import { makeBarrelTexture } from './textures';
import { applyHullGroups, getVehicleModel, type VehicleModel } from './models';

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

function registerDeformable(
  mesh: THREE.Mesh,
  deformables: DeformablePart[],
  glass?: [number, number][],
  head?: [number, number][],
  tail?: [number, number][],
): void {
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const col = mesh.geometry.attributes.color as THREE.BufferAttribute;
  deformables.push({
    mesh,
    base: Float32Array.from(pos.array as Float32Array),
    baseCol: Float32Array.from(col.array as Float32Array),
    glass,
    head,
    tail,
  });
}

// Virgin (unbroken) window vertex tone. The baked GLBs paint glass near-black
// (rgba ≈ 0.03) — fine for the old mirror material, but the per-vertex colour
// multiplies the pane's ALBEDO, so a near-black pane crushes the clear glass to
// a dark surface no matter the tint knob. Round 2 moved the tint into the
// transmitted VOLUME (attenuationColor), so the albedo wants to stay near-white
// for a clear, see-through pane; lift virgin glass close to white and let the
// depth-tint do the colouring. The frost/crack stage paints these verts
// pale-bright (at/above this), reading as the pane going milky/opaque.
const VIRGIN_GLASS = 0.92;

/** Neutralise a hull's window verts to VIRGIN_GLASS so the transmission tint
 *  controls the look (clear ↔ privacy) rather than the near-black bake. */
function whitenGlass(col: THREE.BufferAttribute, glass: [number, number][]): void {
  for (const [s, e] of glass) {
    for (let i = s; i < e; i++) col.setXYZ(i, VIRGIN_GLASS, VIRGIN_GLASS, VIRGIN_GLASS);
  }
}

/** Hull mesh from a baked Quaternius model: clone the template geometry,
 *  repaint its body panels in the spawn color, and neutralise the window
 *  glass so the transmission material's tint reads (see VIRGIN_GLASS). The
 *  glass index group wears the see-through tinted glassMat. */
function makeModelHull(model: VehicleModel, color: number): THREE.Mesh {
  const geo = model.body.clone();
  const col = geo.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color(color);
  for (const [s, e] of model.paintRanges) {
    for (let i = s; i < e; i++) col.setXYZ(i, c.r, c.g, c.b);
  }
  whitenGlass(col, model.glassRanges);
  const mesh = new THREE.Mesh(geo, geo.groups.length ? [hullMat, glassMat, headlightMat, taillightMat] : hullMat);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

export type CollideHandler = (actor: Actor, e: CollideEvent) => void;

/** The two rear-exhaust anchors in the car group's LOCAL space, where the
 *  nitrous boost flame (effects/nitrous.ts) plants its twin jets. Derived from
 *  the spec — the baked hulls carry no tailpipe geometry — at the rear face
 *  (+z is the rear; hull forward is -z), low near the bumper, offset toward
 *  the rear corners. The group origin rides at COM height, so the low exhaust
 *  sits a little below it. Twin tips = the classic dual-pipe boost look. */
export function exhaustAnchors(spec: VehicleSpec): [THREE.Vector3, THREE.Vector3] {
  const z = spec.length / 2 - 0.08; // just inside the rear face
  const y = -spec.rideHeight + 0.34; // low, near the rear bumper height
  const x = Math.min(spec.width * 0.32, 0.55); // toward the corners, capped sane
  return [new THREE.Vector3(-x, y, z), new THREE.Vector3(x, y, z)];
}

/** Model wheels carry tire/rim paint as vertex colors. */
const modelWheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 });

// ---------- night vehicle lights ----------
// Real dynamic lights, three.js forward-renderer budget permitting: one
// shadowless headlight SpotLight painting the road ahead and one red brake
// PointLight per vehicle. Visibility follows time of day ONLY (the day/CI
// render path never pays for them); everything that changes during play —
// brake taps, wreck/explosion shutoff — drives INTENSITY, because the
// visible-light count keys every shader program: one light leaving the
// render list recompiles the whole scene.
export const HEADLIGHT_INTENSITY = 80; // candela (physical falloff)
export const BRAKE_INTENSITY = 22;

function makeVehicleLights(spec: VehicleSpec, group: THREE.Group): { head: THREE.SpotLight; brake: THREE.PointLight } {
  const lensY = -spec.rideHeight + 0.72; // group origin rides at COM height
  const head = new THREE.SpotLight(0xfff3d0, HEADLIGHT_INTENSITY, 30, 0.55, 0.5, 1.6);
  head.position.set(0, lensY, -spec.length / 2 + 0.4);
  head.target.position.set(0, -spec.rideHeight, -spec.length / 2 - 9);
  head.visible = false;
  group.add(head);
  group.add(head.target); // spot targets need a place in the scene graph
  const brake = new THREE.PointLight(0xff1a10, 0, 10, 2);
  brake.position.set(0, lensY, spec.length / 2 + 0.2);
  brake.visible = false;
  group.add(brake);
  return { head, brake };
}

function buildWheels(spec: VehicleSpec, group: THREE.Group, model?: VehicleModel | null): THREE.Mesh[] {
  const wheels: THREE.Mesh[] = [];
  const ax = model ? model.arch.x : spec.wheelX;
  const zf = model ? model.arch.zFront : spec.wheelZFront;
  const zr = model ? model.arch.zRear : spec.wheelZRear;
  const corners: [number, number][] = [
    [-ax, zf], [ax, zf],
    [-ax, zr], [ax, zr],
  ];
  for (const [wx, wz] of corners) {
    const geo = model ? (wx < 0 ? model.wheelL : model.wheelR) : wheelGeometry(spec.wheelRadius);
    const wh = new THREE.Mesh(geo, model ? modelWheelMat : wheelMat);
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
    fmax: (preload + k * SUSP_MAX_COMP) * 1.5, dist: spec.rideHeight, grounded: false, sag: 1,
  }));
}

function makeActor(
  kind: Actor['kind'], body: CANNON.Body, group: THREE.Group, valueMult: number, cashLeft: number,
): Actor {
  return {
    kind, body, group, spec: null, model: null, wheels: [], susp: [], deformables: [], panels: [],
    nightLights: null, lastSpeed: 0, brakeT: 0,
    q0: body.quaternion.clone(), scripted: null, started: false, curSpeed: 0,
    isPlayer: false, crashed: false, destabilized: 0, destabilizeWindow: 0, howCloseToWrecked: 0,
    destabilizedByPlayer: false, destabilizedBy: 0,
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
  const model = getVehicleModel(spawn.variant, isPlayer);

  if (model) {
    const hull = makeModelHull(model, spawn.color);
    group.add(hull);
    registerDeformable(hull, deformables, model.glassRanges, model.headRanges, model.tailRanges);
    if (model.interior) {
      // stripped-chassis innards — wounds show these, not daylight
      const inner = new THREE.Mesh(model.interior.clone(), [metalMat, cabinMat]);
      group.add(inner);
      registerDeformable(inner, deformables);
    }
  } else if (spawn.variant === 'sedan') {
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

  const panels = buildPanels(group, spec, spawn.color, deformables, model);

  if (isPlayer && !model) {
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.07, 0.42),
      new THREE.MeshStandardMaterial({ color: 0x551612, roughness: 0.5, flatShading: true }),
    );
    wing.position.set(0, 0.78, 2.0);
    wing.castShadow = true;
    group.add(wing);
  }

  const wheels = buildWheels(spec, group, model);
  const nightLights = makeVehicleLights(spec, group);
  // the player's paint/glass/lens/panel materials swap to the live
  // CubeCamera reflection set (one traversal — panels hang in the group)
  if (isPlayer) adoptPlayerMaterials(group);
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
  actor.model = model;
  actor.wheels = wheels;
  actor.susp = susp;
  actor.deformables = deformables;
  actor.panels = panels;
  actor.nightLights = nightLights;
  actor.scripted = { dir: { x: spawn.dir.x, z: spawn.dir.z }, speed: spawn.speed, delay: spawn.delay ?? 0 };
  actor.curSpeed = isPlayer ? 0 : spawn.speed;
  actor.isPlayer = isPlayer;
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

const poleMat = new THREE.MeshStandardMaterial({ color: 0x3d434b, roughness: 0.6, metalness: 0.4 });
const poleHeadMat = new THREE.MeshStandardMaterial({ color: 0x22262c, emissive: 0xff9a2a, emissiveIntensity: 0.9 });
poleHeadMat.userData.night = { intensity: 2.2, day: 0.9 };
const poleGeo = new THREE.CylinderGeometry(0.09, 0.12, 4.8, 8);
const poleHeadGeo = new THREE.BoxGeometry(0.34, 0.8, 0.3);

/** `baseY` is the road-grade elevation under the pole (elevation.md Phase 1:
 *  furniture learns a y). Flat levels pass the sampler's literal-0 base, so
 *  the spawn position stays bit-identical there — only furniture seated on
 *  the GANTRY POINT north arc actually lifts. */
export function createPole(scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler, x: number, z: number, baseY = 0): Actor {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.castShadow = true;
  group.add(pole);
  const head = new THREE.Mesh(poleHeadGeo, poleHeadMat);
  head.position.set(0, 2.0, 0.22);
  head.castShadow = true;
  group.add(head);
  // a real lamp at night — parented to the pole, so a toppled streetlight
  // drags its glow across the asphalt with it
  const lamp = new THREE.PointLight(0xffc97a, 50, 18, 1.8);
  lamp.position.set(0, 1.95, 0.28);
  lamp.visible = false;
  group.add(lamp);
  scene.add(group);

  const body = new CANNON.Body({ mass: 90, material: phys.matCar });
  body.addShape(new CANNON.Box(new CANNON.Vec3(0.13, 2.4, 0.13)));
  body.position.set(x, baseY + 2.4, z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.atan2(-x, -z)); // signal faces the junction
  body.linearDamping = 0.05;
  body.angularDamping = 0.2;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.4;
  body.sleepTimeLimit = 0.3;
  phys.world.addBody(body);
  body.sleep();

  const actor = makeActor('pole', body, group, 0.5, 900);
  actor.nightLights = { lamp };
  body.addEventListener('collide', (e: unknown) => onCollide(actor, e as CollideEvent));
  return actor;
}

let barrelTex: THREE.CanvasTexture | null = null;
const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.85, 12);

/** `baseY` as in createPole — barrels at the LOOKOUT LEDGE mouth sit on a
 *  +6 m embankment; without the lift they spawn buried inside it, inert. */
export function createBarrel(scene: THREE.Scene, phys: PhysicsContext, onCollide: CollideHandler, x: number, z: number, baseY = 0): Actor {
  if (!barrelTex) barrelTex = makeBarrelTexture();
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(barrelGeo, new THREE.MeshStandardMaterial({ map: barrelTex, roughness: 0.55, metalness: 0.25 }));
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  scene.add(group);

  const body = new CANNON.Body({ mass: 55, material: phys.matCar });
  body.addShape(new CANNON.Cylinder(0.32, 0.32, 0.85, 10));
  body.position.set(x, baseY + 0.425, z);
  body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), simRand() * Math.PI);
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
const _ldir = new THREE.Vector3();
const _wq = new THREE.Quaternion();

/** Map every vertex slot to the first slot sharing its base position (1 mm
 *  grid). The baked models are flat-shaded, so each corner exists as 2–7
 *  copies with split normals — the player hull has 2984 slots on 740
 *  positions. The crumple's per-vertex randomness must move those copies as
 *  one, or every shared edge tears and a hard wreck shreds into confetti.
 *  Glass and body never weld together: glass sits out the crumple, and a
 *  body corner with a glass representative would be frozen with it. */
function buildWeld(base: Float32Array, glassMask?: Uint8Array): Uint32Array {
  const n = base.length / 3;
  const weld = new Uint32Array(n);
  const seen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const g = glassMask ? glassMask[i] : 0;
    const key = `${g}|${Math.round(base[i * 3] * 1000)}|${Math.round(base[i * 3 + 1] * 1000)}|${Math.round(base[i * 3 + 2] * 1000)}`;
    const rep = seen.get(key);
    if (rep === undefined) {
      seen.set(key, i);
      weld[i] = i;
    } else {
      weld[i] = rep;
    }
  }
  return weld;
}

function buildGlassMask(part: DeformablePart): Uint8Array | undefined {
  if (!part.glass?.length) return undefined;
  const mask = new Uint8Array(part.base.length / 3);
  for (const [s, e] of part.glass) mask.fill(1, s, e);
  return mask;
}

/** Crumple the hull around a world-space impact point. `impactDir` is the
 *  world direction the hitting matter travels (relative velocity) — vertices
 *  near the hit fold mostly along it, BP-style, so a front-left wall hit
 *  reads as a caved front-left corner instead of a uniform shrink. Without
 *  it (explosion-adjacent calls pass none) the fold falls back to pushing
 *  toward the hull core. */
export function deformActor(actor: Actor, worldPoint: THREE.Vector3, strength: number, impactDir?: THREE.Vector3 | null): void {
  if (!actor.deformables.length) return;
  actor.group.updateMatrixWorld(true);
  const R = 0.9 + strength * 0.16;

  for (const part of actor.deformables) {
    _lp.copy(worldPoint);
    part.mesh.worldToLocal(_lp);
    let hasDir = false;
    if (impactDir && impactDir.lengthSq() > 0.5) {
      // direction into mesh space (meshes carry no scale — quaternion is enough)
      part.mesh.getWorldQuaternion(_wq).invert();
      _ldir.copy(impactDir).applyQuaternion(_wq).normalize();
      hasDir = true;
    }
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    const base = part.base;
    if (!part.weld) {
      part.glassMask = buildGlassMask(part);
      part.weld = buildWeld(base, part.glassMask);
      // first deform — normals are still pristine, the only safe moment
      // to derive the smoothing clusters
      part.smooth = buildNormalSmoothing(pos, geo.attributes.normal as THREE.BufferAttribute);
    }
    const weld = part.weld;
    const glassMask = part.glassMask;
    let touched = false;

    for (let i = 0; i < pos.count; i++) {
      if (glassMask && glassMask[i]) continue; // glass doesn't bend — it shatters
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const d = _v.distanceTo(_lp);
      if (d > R) continue;
      touched = true;
      let f = 1 - d / R;
      f *= f;

      const rep = weld[i];
      if (rep !== i) {
        // a flat-shading copy of an earlier corner (rep < i, so it has been
        // displaced this pass): take its position verbatim to keep shared
        // edges stitched. Paint scuffs per slot — copies can belong to
        // differently-colored prims.
        pos.setXYZ(i, pos.getX(rep), pos.getY(rep), pos.getZ(rep));
      } else {
        _dir.set(_v.x, _v.y * 0.35, _v.z);
        if (_dir.lengthSq() < 0.001) _dir.set(0, -1, 0);
        _dir.normalize().negate(); // push toward hull core
        if (hasDir) _dir.multiplyScalar(0.4).addScaledVector(_ldir, 0.85).normalize();
        const amt = strength * CRUSH_VISUAL * f * (0.75 + Math.random() * 0.5);
        _v.addScaledVector(_dir, amt);
        _v.x += (Math.random() - 0.5) * 0.03 * f; // crumple jitter
        _v.y += (Math.random() - 0.5) * 0.03 * f;
        _v.z += (Math.random() - 0.5) * 0.03 * f;

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
      }

      const k = Math.max(0.35, 1 - 0.45 * f); // scuffed paint
      col.setXYZ(i, col.getX(i) * k + 0.05 * f, col.getY(i) * k + 0.045 * f, col.getZ(i) * k + 0.04 * f);
    }
    if (touched) {
      pos.needsUpdate = true;
      col.needsUpdate = true;
      geo.computeVertexNormals();
      if (part.smooth) applyNormalSmoothing(geo.attributes.normal as THREE.BufferAttribute, part.smooth);
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
    if (part.baseIndex) {
      geo.setIndex(new THREE.BufferAttribute(part.baseIndex.slice(), 1)); // reglaze
      if (part.glass) applyHullGroups(geo, part.glass, part.head ?? [], part.tail ?? []);
    }
    part.glassStage?.fill(0); // panes are virgin again after a body-shop pass
    // never-deformed parts still carry pristine normals — derive the
    // smoothing clusters now or the recompute below would flatten them
    part.smooth ??= buildNormalSmoothing(pos, geo.attributes.normal as THREE.BufferAttribute);
    geo.computeVertexNormals();
    applyNormalSmoothing(geo.attributes.normal as THREE.BufferAttribute, part.smooth);
  }
  for (const p of actor.panels) {
    if (p.detached) {
      p.pivot.add(p.mesh); // re-parent from the scene back onto the hinge
      p.mesh.position.copy(p.home);
      p.mesh.quaternion.copy(p.homeQ);
    }
    p.detached = false;
    p.damage = 0;
    p.angle = 0;
    p.pivot.quaternion.set(0, 0, 0, 1);
  }
  if (actor.spec && actor.wheels.length < 4) {
    for (const w of actor.wheels) actor.group.remove(w); // geometry is cached/shared — don't dispose
    actor.wheels = buildWheels(actor.spec, actor.group, actor.model);
    actor.susp = buildSuspension(actor.spec, actor.wheels, actor.body.mass);
  }
  for (const s of actor.susp) s.sag = 1; // un-bend the axles too
  actor.popped = 0;
  actor.damageLvl = 0;
  actor.smokeT = 0;
}

// ---------- glass shatter (three stages) ----------
// BP-style progressive glass, now speed-aware so a gentle knock and a full
// T-bone read differently:
//   stage 0→1  CRACK   a spider-web of bright radial arms + a frosted halo
//                      blooms from the impact; the pane STAYS in the hull
//   stage 1→2  FROST   a second hit (or a hard first hit) whites the whole
//                      struck region — the spalled, about-to-go look
//   stage 2→3  BLOW    the frosted triangles leave the hull index (a hole
//                      onto the interior), and the shard burst flies
// `power` (impact speed proxy) lets one hard hit jump straight past CRACK to
// FROST/BLOW, while a soft tap only spider-webs. Visual only (the verts that
// leave the index are presentation; the chassis collider never changes), and
// the crack-arm angles use Math.random like the rest of the FX — the sim and
// replay hashes never read glass colour or the hull index.
//
// Spider-web painting (ROUND 2): the crack web is now the RAY + CONCENTRIC-RING
// model from CJT-Jackton/SmashTheGlass (_ref/SmashTheGlass; learn-only, no
// licence on the repo — TECHNIQUE adapted, no code ported). That project places
// Voronoi crack sites on a polar grid centred on the impact: a set of radial
// RAYS at evenly-spaced angles with a little Gaussian jitter, crossed by a few
// concentric RINGS whose spacing widens outward (RandomPoint.cs:
// base_radius[i] = base_radius[i-1] + 1 + i*centrifugation → densest near the
// hit). We can't re-mesh a window into Voronoi shards on the per-vertex-colour
// rail, but we CAN paint exactly that pattern: a struck vertex lights up bright
// where it sits near a radial ray OR near a shock ring, brightest at the centre.
// The result reads as real fracture propagation — sharp radial lines plus the
// concentric "shatter rings" a stone leaves — instead of round-1's five flat
// arms. SPEED-AWARE: a gentle tap gets a few short rays and one tight ring (a
// local star-crack); a hard hit gets many rays + several rings reaching the
// pane edge (a full craze before blowout). Still visual-only and Math.random
// like the rest of the FX — the sim/replay hashes never read glass colour or
// the hull index.

const _glassN = new THREE.Vector3();
const _glassT = new THREE.Vector3();
const _glassB = new THREE.Vector3();
const _glassRel = new THREE.Vector3();

/** A per-impact crack web: ray angles + ring radii, sized by hit power. Built
 *  once per shatterGlass call (per pane) so the whole web is coherent. */
interface CrackWeb {
  rays: number[]; // ray angles (radians)
  rayJitter: number[]; // small per-ray angular wobble so lines aren't laser-straight
  rings: number[]; // ring radii as a fraction of `radius` (0..1)
  centerGlow: number; // pulverised bloom radius fraction at the impact
}

/** Build the ray/ring web for one hit. `power` (impact speed proxy) drives how
 *  far the fracture propagates: soft → few rays, one near ring; hard → many
 *  rays, rings out to the edge. Mirrors SmashTheGlass RandomPoint's ring/ray
 *  counts and outward-widening ring spacing. */
function buildCrackWeb(power: number): CrackWeb {
  // SmashTheGlass uses ~9–11 rays; we scale with power for the speed-aware feel
  const rayCount = Math.max(4, Math.min(12, Math.round(4 + power * 1.1)));
  const ringCount = Math.max(1, Math.min(4, Math.round(1 + power * 0.45)));
  const phase = Math.random() * Math.PI * 2;
  const step = (Math.PI * 2) / rayCount;
  const rays: number[] = [];
  const rayJitter: number[] = [];
  for (let i = 0; i < rayCount; i++) {
    // even spacing + Gaussian-ish jitter (RandomPoint base_theta), so the star
    // isn't perfectly regular
    rays.push(phase + i * step + (Math.random() - 0.5) * step * 0.35);
    rayJitter.push((Math.random() - 0.5) * 0.18);
  }
  // rings widen outward (centrifugation), normalised into 0..1 of the radius
  const raw: number[] = [];
  let r = 0.35;
  for (let i = 0; i < ringCount; i++) {
    r += 0.25 + i * 0.3;
    raw.push(r);
  }
  const max = raw[raw.length - 1];
  const rings = raw.map((v) => Math.min(0.96, v / max * 0.96));
  // harder hits pulverise a wider patch at the very centre
  const centerGlow = Math.min(0.5, 0.12 + power * 0.03);
  return { rays, rayJitter, rings, centerGlow };
}

/** Spider-web crack tone for a glass vertex: max of its nearness to a radial
 *  ray, to a concentric shock ring, and a bright centre bloom — all faded by
 *  distance. Returns a 0..1 brightness boost; ~0 between the cracks (the pane
 *  stays clear there), ~1 right on a fracture line. */
function crackBoost(angle: number, dist: number, radius: number, web: CrackWeb): number {
  const f = dist / radius; // 0 at impact … 1 at the crack radius
  // nearest radial ray — the wobble makes the line waver as it runs outward
  let nearestRay = Math.PI;
  for (let a = 0; a < web.rays.length; a++) {
    const armAng = web.rays[a] + web.rayJitter[a] * f * 4;
    let d = Math.abs(angle - armAng);
    if (d > Math.PI) d = Math.PI * 2 - d;
    nearestRay = Math.min(nearestRay, d);
  }
  // ray lines thin out toward the tip (a real crack tapers)
  const rayWidth = 0.5 - f * 0.32;
  const ray = Math.max(0, 1 - nearestRay / Math.max(0.05, rayWidth));
  // nearest concentric ring (a thin bright band at each ring radius)
  let ring = 0;
  for (const rr of web.rings) {
    const band = Math.max(0, 1 - Math.abs(f - rr) / 0.09);
    ring = Math.max(ring, band);
  }
  // pulverised centre
  const center = Math.max(0, 1 - f / Math.max(0.05, web.centerGlow));
  const arms = ray * ray * 1.2 + ring * ring * 0.85 + center * center * 0.9;
  // overall fade so the web dims toward the crack radius
  return Math.min(1, arms * (1 - f * 0.4));
}

export function shatterGlass(actor: Actor, worldPoint: THREE.Vector3, radius: number, power = 1): number {
  let broken = 0;
  for (const part of actor.deformables) {
    if (!part.glass) continue;
    _lp.copy(worldPoint);
    part.mesh.worldToLocal(_lp);
    const geo = part.mesh.geometry;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const col = geo.attributes.color as THREE.BufferAttribute;
    part.glassStage ??= new Uint8Array(pos.count);
    const stage = part.glassStage;
    let touched = false;
    let blow: Set<number> | null = null;

    // a pane plane to project the crack web onto: use the local up/right of
    // the mesh (windows are roughly vertical/curved — close enough for the
    // angular web), with the impact's local normal-ish removed
    const web = buildCrackWeb(power);
    _glassN.set(_lp.x, 0, _lp.z); // outward-ish from hull centreline
    if (_glassN.lengthSq() < 1e-4) _glassN.set(0, 0, 1);
    _glassN.normalize();
    _glassT.set(0, 1, 0); // pane "up"
    _glassB.crossVectors(_glassN, _glassT).normalize(); // pane "right"

    // a hard hit pushes the starting stage up: soft tap cracks, big T-bone
    // frosts or blows on first contact
    const hardKick = power > 6 ? 2 : power > 3 ? 1 : 0;

    for (const [s, e] of part.glass) {
      for (let i = s; i < e; i++) {
        _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        const dist = _v.distanceTo(_lp);
        if (dist > radius) continue;
        const cur = stage[i];
        const next = cur === 3 ? 3 : Math.min(3, Math.max(cur + 1, hardKick + 1));
        if (cur === next) continue; // already at/past this damage
        stage[i] = next;
        broken++;
        touched = true;

        if (next === 1) {
          // CRACK: ray+ring spider-web recolour. Virgin glass is near-white
          // (clear), so a fracture line reads as a cool MILKY-WHITE craze that
          // pops against the see-through pane; verts off the web stay clear.
          _glassRel.set(_v.x - _lp.x, _v.y - _lp.y, _v.z - _lp.z);
          const angle = Math.atan2(_glassRel.dot(_glassT), _glassRel.dot(_glassB));
          const b = crackBoost(angle, dist, radius, web);
          // a hint of grain so the craze isn't a clean gradient (LiquidGlass
          // noise idea, carried onto the crack paint)
          const grain = (Math.random() - 0.5) * 0.06 * b;
          // off-web keeps the clear virgin tone; on-web goes bright milky-white
          const tone = VIRGIN_GLASS - 0.08 + (1.02 - (VIRGIN_GLASS - 0.08)) * b + grain;
          const c = Math.min(1, Math.max(0, tone));
          col.setXYZ(i, c, Math.min(1, c + 0.02 * b), Math.min(1, c + 0.04 * b));
        } else if (next === 2) {
          // FROST: spalled, about to let go — the tweakable FROST amount sets
          // how white it goes (privacy glass can stay a touch darker)
          const t = glassParams.frost + Math.random() * 0.12;
          col.setXYZ(i, t, t + 0.03, t + 0.06);
        } else if (next === 3) {
          (blow ??= new Set()).add(i); // BLOW: the pane lets go
        }
      }
    }
    if (touched) col.needsUpdate = true;
    if (blow && geo.index) {
      // stash the pristine index once — repairVehicle reglazes from it
      part.baseIndex ??= (geo.index.array as Uint16Array | Uint32Array).slice();
      const idx = geo.index;
      const keep: number[] = [];
      for (let t = 0; t < idx.count; t += 3) {
        const a = idx.getX(t);
        const b = idx.getX(t + 1);
        const c = idx.getX(t + 2);
        if (blow.has(a) || blow.has(b) || blow.has(c)) continue;
        keep.push(a, b, c);
      }
      geo.setIndex(keep);
      applyHullGroups(geo, part.glass, part.head ?? [], part.tail ?? []); // groups address the index
    }
  }
  return broken;
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
    v.x + (simRand() - 0.5) * 6,
    Math.abs(v.y) * 0.4 + 3 + simRand() * 4,
    v.z + (simRand() - 0.5) * 6,
  );
  b.angularVelocity.set((simRand() - 0.5) * 16, (simRand() - 0.5) * 16, (simRand() - 0.5) * 16);
  b.linearDamping = 0.15;
  b.angularDamping = 0.15;
  world.addBody(b);
  return { mesh: wheel, body: b };
}
