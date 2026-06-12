import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CRUSH_SCALE } from './constants';
import type { Actor, DeformablePart, PanelKind, PanelState, Variant, VehicleSpec } from './types';
import type { PanelCut, PanelFace, VehicleModel } from './models';
import { simRand } from './rng';
import { hullMat, makeColoredBox, registerCarMaterial } from './geometry';

// Detachable body panels, modeled on Burnout Paradise's DeformationSpec
// (0x1001C — see steward/src/lib/core/deformationSpec.ts and the
// VEH_CARBRWDS_AT.BIN fixture):
//  - BP splits a car into jointed IK body parts (doors, bonnet, boot,
//    bumpers…) with hinge joints (60° max for doors/bonnet/boot, ~5° for
//    bumpers) and per-joint detach thresholds, ordered
//    bumpers/boot (easiest) → doors → bonnet (hardest); chassis and the
//    truck petrol tank never detach.
//  - We mirror that as one "sensor" per panel: every impact accumulates
//    crumple-displacement (same falloff family as the vertex deformer);
//    past 40 % of the threshold the panel flaps loose on its hinge, past
//    100 % it tears off and becomes a physics body. Exact thresholds in
//    metres and the detach impulse are invented; the ordering, hinge
//    angles and two-stage loose→detach behavior are from the spec data.

export interface PanelDef {
  kind: PanelKind;
  size: [number, number, number];
  center: [number, number, number];
  hingeOffset: [number, number, number]; // from panel center to hinge line
  axis: [number, number, number];
  flapDir: number;
  outward: [number, number, number];
  maxAngle: number;
  threshold: number;
  /** Rest rotation about the hinge axis — lays a lid box on the hood slope.
   *  Hull cutouts carry the slope in their geometry and ignore this. */
  tilt?: number;
}

const DOOR_ANGLE = 1.047; // 60° — BP mfMaxJointAngle for doors/bonnet/boot
const BUMPER_ANGLE = 0.09; // ~5° — bumpers barely flap before tearing

function sedanPanels(): PanelDef[] {
  return [
    { kind: 'door', size: [0.05, 0.55, 1.4], center: [-0.95, -0.04, 0.18], hingeOffset: [0, 0, -0.7], axis: [0, 1, 0], flapDir: -1, outward: [-1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 },
    { kind: 'door', size: [0.05, 0.55, 1.4], center: [0.95, -0.04, 0.18], hingeOffset: [0, 0, -0.7], axis: [0, 1, 0], flapDir: 1, outward: [1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 },
    { kind: 'bonnet', size: [1.25, 0.05, 1.05], center: [0, 0.16, -1.55], hingeOffset: [0, 0, 0.525], axis: [1, 0, 0], flapDir: 1, outward: [0, 1, 0], maxAngle: DOOR_ANGLE, threshold: 0.3 },
    { kind: 'boot', size: [1.25, 0.05, 0.75], center: [0, -0.02, 1.62], hingeOffset: [0, 0, -0.375], axis: [1, 0, 0], flapDir: -1, outward: [0, 1, 0], maxAngle: DOOR_ANGLE, threshold: 0.2 },
    { kind: 'bumper', size: [1.55, 0.17, 0.12], center: [0, -0.31, -2.33], hingeOffset: [0, 0.085, 0], axis: [1, 0, 0], flapDir: 1, outward: [0, 0, -1], maxAngle: BUMPER_ANGLE, threshold: 0.16 },
    { kind: 'bumper', size: [1.55, 0.17, 0.12], center: [0, -0.31, 2.33], hingeOffset: [0, 0.085, 0], axis: [1, 0, 0], flapDir: -1, outward: [0, 0, 1], maxAngle: BUMPER_ANGLE, threshold: 0.16 },
  ];
}

// trucks are stiffer than the sedan crumple zones (BP cabin sensors)
const TRUCK = 1.5;

function busPanels(): PanelDef[] {
  return [
    { kind: 'door', size: [0.05, 1.3, 0.85], center: [1.16, -0.35, -3.2], hingeOffset: [0, 0, -0.425], axis: [0, 1, 0], flapDir: 1, outward: [1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 * TRUCK },
    { kind: 'bumper', size: [2.1, 0.2, 0.14], center: [0, -0.75, -4.42], hingeOffset: [0, 0.1, 0], axis: [1, 0, 0], flapDir: 1, outward: [0, 0, -1], maxAngle: BUMPER_ANGLE, threshold: 0.16 * TRUCK },
    { kind: 'bumper', size: [2.1, 0.2, 0.14], center: [0, -0.75, 4.42], hingeOffset: [0, 0.1, 0], axis: [1, 0, 0], flapDir: -1, outward: [0, 0, 1], maxAngle: BUMPER_ANGLE, threshold: 0.16 * TRUCK },
  ];
}

function tankerPanels(): PanelDef[] {
  return [
    { kind: 'door', size: [0.05, 0.95, 0.85], center: [-1.13, 0, -3.3], hingeOffset: [0, 0, -0.425], axis: [0, 1, 0], flapDir: -1, outward: [-1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 * TRUCK },
    { kind: 'door', size: [0.05, 0.95, 0.85], center: [1.13, 0, -3.3], hingeOffset: [0, 0, -0.425], axis: [0, 1, 0], flapDir: 1, outward: [1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 * TRUCK },
    { kind: 'bumper', size: [1.7, 0.2, 0.14], center: [0, -0.55, -4.45], hingeOffset: [0, 0.1, 0], axis: [1, 0, 0], flapDir: 1, outward: [0, 0, -1], maxAngle: BUMPER_ANGLE, threshold: 0.16 * TRUCK },
  ];
}

const LAYOUTS: Record<Variant, () => PanelDef[]> = {
  sedan: sedanPanels,
  bus: busPanels,
  tanker: tankerPanels,
};

// ---------- model-fitted layouts ----------
// Same panel sets and BP-derived hinge/threshold behavior as the tables
// above, but the boxes are rigged to the baked model's measured landmarks
// (models.ts PanelMetrics) so they hug each model's actual bodywork — the
// five sedan-pool models, the player's SportsCar2 and the transport bus all
// have different proportions. The tables remain the procedural-hull fallback.

const PANEL_T = 0.05; // door/lid skin thickness
const BUMPER_D = 0.12;
const EDGE = 0.08; // breathing room between a panel edge and its neighbors

function fittedBumper(face: PanelFace, z: number, sign: -1 | 1, threshold: number): PanelDef {
  // wrap the measured face, hugging its lower edge (tall faces — the bus
  // front — keep a bumper-sized strip rather than armoring the whole slab)
  const h = Math.min(Math.max(face.y1 - face.y0, 0.14), 0.24);
  return {
    kind: 'bumper',
    size: [face.halfW * 2 * 0.9, h, BUMPER_D],
    center: [0, face.y0 + h / 2 + 0.04, z],
    hingeOffset: [0, h / 2, 0],
    axis: [1, 0, 0],
    flapDir: -sign,
    outward: [0, 0, sign],
    maxAngle: BUMPER_ANGLE,
    threshold,
  };
}

function fittedSedanPanels(model: VehicleModel, spec: VehicleSpec): PanelDef[] {
  const m = model.panelMetrics;
  const r = spec.wheelRadius;

  // doors: the side shell between the arches, hung from the window line
  const dz0 = m.door.z0 + EDGE;
  const dz1 = m.door.z1 - EDGE;
  const doorLen = dz1 - dz0;
  const doorH = Math.min(m.door.waistY - m.door.sillY, 0.62 * (m.maxY - m.minY));
  const doorY = m.door.waistY - doorH / 2;

  // bonnet: bumper face → windshield base (≈ over the front arch); boot:
  // rear arch → bumper face. Both lie on their probed surface lines.
  const bz1 = model.arch.zFront + r;
  const bonnetLen = bz1 - (m.noseZ + BUMPER_D + EDGE);
  const tz0 = model.arch.zRear;
  const bootLen = m.tailZ - BUMPER_D - EDGE - tz0;
  const lidW = m.door.x * 2 * 0.66; // bonnet/boot stop short of the fenders

  return [
    { kind: 'door', size: [PANEL_T, doorH, doorLen], center: [-m.door.x, doorY, (dz0 + dz1) / 2], hingeOffset: [0, 0, -doorLen / 2], axis: [0, 1, 0], flapDir: -1, outward: [-1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 },
    { kind: 'door', size: [PANEL_T, doorH, doorLen], center: [m.door.x, doorY, (dz0 + dz1) / 2], hingeOffset: [0, 0, -doorLen / 2], axis: [0, 1, 0], flapDir: 1, outward: [1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 },
    { kind: 'bonnet', size: [lidW, PANEL_T, bonnetLen], center: [0, m.bonnet.y, bz1 - bonnetLen / 2], hingeOffset: [0, 0, bonnetLen / 2], axis: [1, 0, 0], flapDir: 1, outward: [0, 1, 0], maxAngle: DOOR_ANGLE, threshold: 0.3, tilt: -Math.atan(m.bonnet.slope) },
    { kind: 'boot', size: [lidW, PANEL_T, bootLen], center: [0, m.boot.y, tz0 + bootLen / 2], hingeOffset: [0, 0, -bootLen / 2], axis: [1, 0, 0], flapDir: -1, outward: [0, 1, 0], maxAngle: DOOR_ANGLE, threshold: 0.2, tilt: -Math.atan(m.boot.slope) },
    fittedBumper(m.nose, m.noseZ, -1, 0.16),
    fittedBumper(m.tail, m.tailZ, 1, 0.16),
  ];
}

function fittedBusPanels(model: VehicleModel): PanelDef[] {
  const m = model.panelMetrics;
  // single curbside door — the measured band runs nose → front arch
  const dz0 = m.door.z0 + EDGE;
  const dz1 = m.door.z1 - EDGE;
  const len = Math.max(dz1 - dz0, 0.6);
  const doorH = Math.min(m.door.waistY - m.door.sillY, 0.62 * (m.maxY - m.minY));
  return [
    { kind: 'door', size: [PANEL_T, doorH, len], center: [m.door.x, m.door.waistY - doorH / 2, dz0 + len / 2], hingeOffset: [0, 0, -len / 2], axis: [0, 1, 0], flapDir: 1, outward: [1, 0, 0], maxAngle: DOOR_ANGLE, threshold: 0.22 * TRUCK },
    fittedBumper(m.nose, m.noseZ, -1, 0.16 * TRUCK),
    fittedBumper(m.tail, m.tailZ, 1, 0.16 * TRUCK),
  ];
}

/** The panel layout a vehicle gets — model-fitted when dressed, table
 *  otherwise. Pure, so bake-time hull cutting (models.ts) and per-vehicle
 *  assembly below derive the same defs. */
export function panelDefs(spec: VehicleSpec, model: VehicleModel | null): PanelDef[] {
  if (model && spec.variant === 'sedan') return fittedSedanPanels(model, spec);
  if (model && spec.variant === 'bus') return fittedBusPanels(model);
  return LAYOUTS[spec.variant]();
}

/** Torn bodywork tumbles — show its inside too (the hull is a one-sided
 *  shell, so a FrontSide door would vanish seen from behind). */
const panelMat = hullMat.clone();
panelMat.side = THREE.DoubleSide;
registerCarMaterial(panelMat, 0.5); // same gloss as the hull paint

/** Clone a cutout template and repaint its paint verts in the spawn color
 *  (the cutout keeps its baked trim/handle colors elsewhere). */
function paintCut(cut: PanelCut, color: number): THREE.BufferGeometry {
  const geo = cut.geo.clone();
  const col = geo.attributes.color as THREE.BufferAttribute;
  const c = new THREE.Color(color);
  for (let i = 0; i < cut.paint.length; i++) {
    if (cut.paint[i]) col.setXYZ(i, c.r, c.g, c.b);
  }
  return geo;
}

export function buildPanels(
  group: THREE.Group,
  spec: VehicleSpec,
  color: number,
  deformables: DeformablePart[],
  model: VehicleModel | null,
): PanelState[] {
  const out: PanelState[] = [];
  panelDefs(spec, model).forEach((def, i) => {
    // dressed vehicles hang real bodywork cut from their hull; the colored
    // box is the fallback (procedural hulls, regions that cut to slivers)
    const cut = model?.panelCuts[i] ?? null;
    const mesh = cut
      ? new THREE.Mesh(paintCut(cut, color), panelMat)
      : new THREE.Mesh(makeColoredBox(...def.size, color), hullMat);
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    pivot.position.set(
      def.center[0] + def.hingeOffset[0],
      def.center[1] + def.hingeOffset[1],
      def.center[2] + def.hingeOffset[2],
    );
    mesh.position.set(-def.hingeOffset[0], -def.hingeOffset[1], -def.hingeOffset[2]);
    // a box lid leans onto the hood slope; a cutout has the slope baked in
    if (!cut && def.tilt) mesh.quaternion.setFromAxisAngle(new THREE.Vector3(...def.axis), def.tilt);
    pivot.add(mesh);
    group.add(pivot);
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const col = mesh.geometry.attributes.color as THREE.BufferAttribute;
    deformables.push({
      mesh,
      base: Float32Array.from(pos.array as Float32Array),
      baseCol: Float32Array.from(col.array as Float32Array),
    });
    out.push({
      kind: def.kind,
      mesh,
      pivot,
      size: cut ? cut.size : { x: def.size[0], y: def.size[1], z: def.size[2] },
      hingeAxis: new THREE.Vector3(...def.axis),
      flapDir: def.flapDir,
      maxAngle: def.maxAngle,
      outward: new THREE.Vector3(...def.outward),
      threshold: def.threshold,
      home: mesh.position.clone(),
      homeQ: mesh.quaternion.clone(),
      damage: 0,
      angle: 0,
      detached: false,
    });
  });
  return out;
}

const _pw = new THREE.Vector3();

/** Feed an impact into nearby panels. Calls onDetach the moment one tears. */
export function accumulatePanelDamage(
  actor: Actor,
  worldPoint: THREE.Vector3,
  strength: number,
  onDetach: (actor: Actor, panel: PanelState) => void,
): void {
  if (!actor.panels.length) return;
  actor.group.updateMatrixWorld(true);
  const R = 0.9 + strength * 0.16; // same falloff family as deformActor
  for (const p of actor.panels) {
    if (p.detached) continue;
    p.mesh.getWorldPosition(_pw);
    const d = _pw.distanceTo(worldPoint);
    if (d > R) continue;
    const f = 1 - d / R;
    p.damage += strength * CRUSH_SCALE * f * f;
    if (p.damage > p.threshold) {
      p.detached = true;
      onDetach(actor, p);
    }
  }
}

/** Loose panels swing toward their hinge limit as damage accrues. */
export function updatePanelFlap(actors: Actor[], dt: number): void {
  for (const a of actors) {
    for (const p of a.panels) {
      if (p.detached) continue;
      const t = Math.max(0, Math.min(1, (p.damage - 0.4 * p.threshold) / (0.6 * p.threshold)));
      const target = p.maxAngle * t;
      if (target <= 0 && p.angle <= 0) continue;
      p.angle += (target - p.angle) * Math.min(1, dt * 7);
      p.pivot.quaternion.setFromAxisAngle(p.hingeAxis, p.angle * p.flapDir);
    }
  }
}

const _out = new THREE.Vector3();
const _wq = new THREE.Quaternion();

/** Turn a torn-off panel into a free rigid body. Returns the new body. */
export function makePanelBody(actor: Actor, p: PanelState, matCar: CANNON.Material): CANNON.Body {
  const mass = p.kind === 'door' ? 16 : p.kind === 'bumper' ? 8 : 12;
  const body = new CANNON.Body({ mass, material: matCar });
  body.addShape(
    new CANNON.Box(
      new CANNON.Vec3(Math.max(p.size.x, 0.08) / 2, Math.max(p.size.y, 0.08) / 2, Math.max(p.size.z, 0.08) / 2),
    ),
  );
  p.mesh.getWorldPosition(_pw);
  p.mesh.getWorldQuaternion(_wq);
  body.position.set(_pw.x, _pw.y, _pw.z);
  body.quaternion.set(_wq.x, _wq.y, _wq.z, _wq.w);
  _out.copy(p.outward).applyQuaternion(actor.group.quaternion);
  const v = actor.body.velocity;
  body.velocity.set(
    v.x + _out.x * (3 + simRand() * 3) + (simRand() - 0.5) * 2,
    Math.abs(v.y) * 0.3 + 2.5 + simRand() * 3 + _out.y * 3,
    v.z + _out.z * (3 + simRand() * 3) + (simRand() - 0.5) * 2,
  );
  body.angularVelocity.set((simRand() - 0.5) * 14, (simRand() - 0.5) * 14, (simRand() - 0.5) * 14);
  body.linearDamping = 0.12;
  body.angularDamping = 0.12;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.4;
  body.sleepTimeLimit = 0.6;
  return body;
}
