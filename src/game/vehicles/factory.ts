import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GRAVITY, SUSP_MAX_COMP, SUSP_SAG, SUSP_ZETA } from '../constants';
import type { Actor, CollideEvent, DeformablePart, SuspensionCorner, VehicleSpec } from '../types';
import { glassMat, headlightMat, hullMat, taillightMat, wheelGeometry, wheelMat } from '../geometry';
import type { VehicleModel } from '../models';

export function registerDeformable(
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
export const VIRGIN_GLASS = 0.92;

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
export function makeModelHull(model: VehicleModel, color: number): THREE.Mesh {
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

/** Model wheels carry tire/rim paint as vertex colors. Smooth-shaded: the
 *  wheel templates bring their own normals (round tyre, hard rim edges). */
const modelWheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 });

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

export function makeVehicleLights(spec: VehicleSpec, group: THREE.Group): { head: THREE.SpotLight; brake: THREE.PointLight } {
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

export function buildWheels(spec: VehicleSpec, group: THREE.Group, model?: VehicleModel | null): THREE.Mesh[] {
  const wheels: THREE.Mesh[] = [];
  const ax = model ? model.arch.x : spec.wheelX;
  const zf = model ? model.arch.zFront : spec.wheelZFront;
  const zr = model ? model.arch.zRear : spec.wheelZRear;
  const corners: [number, number][] = [
    [-ax, zf], [ax, zf],
    [-ax, zr], [ax, zr],
  ];
  for (const [wx, wz] of corners) {
    // no model: the shared generic wheel — steel rims on the heavy variants, alloys on cars
    const side = wx < 0 ? 'L' : 'R';
    const style = spec.variant === 'sedan' ? 'five-spoke' : 'steelie';
    const geo = model ? (wx < 0 ? model.wheelL : model.wheelR) : wheelGeometry(spec.wheelRadius, style, side);
    const wh = new THREE.Mesh(geo, model ? modelWheelMat : wheelMat);
    // the coarse twin carlod.ts swaps in on non-player cars past the near ring
    wh.userData.lodGeometry = model ? (wx < 0 ? model.wheelCoarseL : model.wheelCoarseR) : wheelGeometry(spec.wheelRadius, style, side, 'coarse');
    wh.position.set(wx, -(spec.rideHeight - spec.wheelRadius), wz);
    wh.castShadow = true;
    group.add(wh);
    wheels.push(wh);
  }
  return wheels;
}

/** Per-wheel spring rates derived from the car's own weight: preload holds
 *  the body exactly at rideHeight, k stiffens it around that point. */
export function buildSuspension(spec: VehicleSpec, wheels: THREE.Mesh[], mass: number): SuspensionCorner[] {
  const mw = mass / 4;
  const preload = mw * Math.abs(GRAVITY);
  const k = preload / SUSP_SAG;
  const c = 2 * SUSP_ZETA * Math.sqrt(k * mw);
  return wheels.map((w) => ({
    ax: w.position.x, az: w.position.z, preload, k, c,
    fmax: (preload + k * SUSP_MAX_COMP) * 1.5, dist: spec.rideHeight, grounded: false, sag: 1,
    load: preload, // seed at static load so the tire model has grip from frame 1
  }));
}

export function makeActor(
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
