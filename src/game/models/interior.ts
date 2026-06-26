import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleSpec } from '../types';
import { applyUniformColor } from '../geometry';
import type { PanelMetrics } from './metrics-types';
import { FACE_DEPTH } from './metrics';
import { stripToPosNormal } from './mesh-utils';

// ---------- interior ----------
// The hull is a one-sided shell, so every wound — torn bonnet, missing
// bumper, blown-out window — used to show daylight straight through the
// car. Bake a stripped-chassis interior instead, like a car with its
// bodywork pulled: a bare-metal floor platform, engine bay and trunk
// masses (metal group → metalMat), and dash, seats and a steering wheel
// (cabin group → cabinMat). Everything rides the deformable list, so it
// crumples and chars with the body.

const FLOOR_TINT = 0x969ca4; // bare aluminum platform
const ENGINE_TINT = 0x4a4e54;
const TRUNK_TINT = 0x55585e;
const DASH_TINT = 0x16181c;
const SEAT_TINT = 0x2b2f37;
const WHEEL_TINT = 0x101214;

type BlockOrNull = THREE.BufferGeometry | null;

export function buildInterior(
  m: PanelMetrics,
  arch: { x: number; zFront: number; zRear: number },
  spec: VehicleSpec,
  hull: THREE.BufferGeometry,
): THREE.BufferGeometry | null {
  // boxes vs curved bodywork: any guessed width pokes through SOME model,
  // so the wide pieces measure their safe half-width with inward rays
  // against the hull over their (y, z) face
  const mesh = new THREE.Mesh(hull);
  const ray = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const inward = new THREE.Vector3(-1, 0, 0);
  const safeHalfW = (y0: number, y1: number, z0: number, z1: number): number => {
    let w = Infinity;
    for (let iy = 0; iy < 4; iy++) {
      for (let iz = 0; iz < 7; iz++) {
        const y = y0 + ((iy + 0.5) / 4) * (y1 - y0);
        const z = z0 + ((iz + 0.5) / 7) * (z1 - z0);
        ray.set(origin.set(3, y, z), inward);
        const hit = ray.intersectObject(mesh, false)[0];
        // a miss or a far-side hit means the ray flew through an opening
        // (wheel arch) — that sample can't bound the width
        if (!hit || hit.point.x < 0.05) continue;
        w = Math.min(w, hit.point.x - 0.07);
      }
    }
    return w;
  };
  const boxAt = (x: number, w: number, y0: number, y1: number, z0: number, z1: number, tint: number): BlockOrNull => {
    if (w < 0.04 || y1 - y0 < 0.04 || z1 - z0 < 0.04) return null;
    const g = stripToPosNormal(new THREE.BoxGeometry(w, y1 - y0, z1 - z0));
    applyUniformColor(g, tint);
    g.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
    return g;
  };
  const metal: BlockOrNull[] = [];
  const cabin: BlockOrNull[] = [];

  const sill = m.door.sillY + 0.04;
  const waist = m.door.waistY;
  const gh = m.maxY - waist; // greenhouse height
  const dz0 = m.door.z0;
  const dz1 = m.door.z1;
  const floorHalfW = Math.min(safeHalfW(sill, waist - 0.05, dz0 + 0.05, dz1 - 0.05) - 0.02, m.door.x - 0.06);
  if (!isFinite(floorHalfW) || floorHalfW < 0.2) return null; // unmeasurable side — skip dressing

  const seats = (x: number, w: number, zFront: number, zBack: number) => {
    const top = sill + 0.07;
    cabin.push(boxAt(x, w, top, top + 0.17, zFront, zBack - 0.1, SEAT_TINT)); // cushion
    cabin.push(boxAt(x, w, top, waist + 0.3 * gh, zBack - 0.1, zBack, SEAT_TINT)); // backrest
  };
  const steeringWheel = (x: number, y: number, z: number, tilt: number) => {
    const g = stripToPosNormal(new THREE.TorusGeometry(0.155, 0.026, 6, 14));
    applyUniformColor(g, WHEEL_TINT);
    g.rotateX(tilt);
    g.translate(x, y, z);
    cabin.push(g);
    cabin.push(boxAt(x, 0.05, y - 0.12, y - 0.02, z - 0.2, z, DASH_TINT)); // column
  };

  if (spec.variant === 'bus') {
    metal.push(boxAt(0, floorHalfW * 2, sill, sill + 0.08, m.noseZ + 0.55, m.tailZ - 0.55, FLOOR_TINT));
    // rear-engine bus: a metal mass behind the last row plugs the tail wound
    metal.push(boxAt(0, floorHalfW * 2 * 0.9, sill, waist - 0.1, m.tailZ - 1.2, m.tailZ - 0.4, ENGINE_TINT));
    cabin.push(boxAt(0, floorHalfW * 2 * 0.94, waist - 0.3, waist, m.noseZ + 0.55, m.noseZ + 0.9, DASH_TINT));
    const driverX = -floorHalfW * 0.5;
    steeringWheel(driverX, waist - 0.02, m.noseZ + 1.0, -0.9); // bus wheels lie flatter
    seats(driverX, 0.5, m.noseZ + 1.15, m.noseZ + 1.75);
    for (let z = m.noseZ + 2.2; z + 0.55 < m.tailZ - 1.3; z += 1.15) {
      seats(0, floorHalfW * 2 * 0.85, z, z + 0.55);
    }
  } else {
    const r = spec.wheelRadius;
    // engine/trunk tops stay under the LOW end of each sloped lid line —
    // and the lines are chords, so the rounded nose/tail dip below them
    const bonnetZ1 = arch.zFront + r;
    const bonnetLow = m.bonnet.y - (Math.abs(m.bonnet.slope) * (bonnetZ1 - m.noseZ - FACE_DEPTH)) / 2;
    const bootZ1 = m.tailZ - FACE_DEPTH;
    const bootLow = m.boot.y - (Math.abs(m.boot.slope) * (bootZ1 - arch.zRear)) / 2;
    const engineHalfW = Math.min(safeHalfW(sill, bonnetLow - 0.09, m.noseZ + 0.18, bonnetZ1 - 0.05), m.nose.halfW) - 0.02;
    const trunkHalfW = Math.min(safeHalfW(sill, bootLow - 0.09, arch.zRear + 0.1, m.tailZ - 0.18), m.tail.halfW) - 0.02;
    if (isFinite(engineHalfW)) metal.push(boxAt(0, engineHalfW * 2, sill, bonnetLow - 0.09, m.noseZ + 0.18, bonnetZ1 - 0.05, ENGINE_TINT));
    if (isFinite(trunkHalfW)) metal.push(boxAt(0, trunkHalfW * 2, sill, bootLow - 0.09, arch.zRear + 0.1, m.tailZ - 0.18, TRUNK_TINT));
    metal.push(boxAt(0, floorHalfW * 2, sill, sill + 0.07, dz0 + 0.04, dz1 - 0.04, FLOOR_TINT));

    cabin.push(boxAt(0, floorHalfW * 2 * 0.94, waist - 0.26, waist + 0.02, dz0 + 0.04, dz0 + 0.34, DASH_TINT));
    const driverX = -floorHalfW * 0.5;
    steeringWheel(driverX, waist + 0.02, dz0 + 0.52, -0.5);
    const cabMid = (dz0 + dz1) / 2;
    const seatW = Math.min(0.46, floorHalfW * 0.85);
    seats(driverX, seatW, cabMid - 0.32, cabMid + 0.2);
    seats(floorHalfW * 0.5, seatW, cabMid - 0.32, cabMid + 0.2);
    if (dz1 - 0.1 - (cabMid + 0.42) > 0.25) seats(0, floorHalfW * 2 * 0.88, cabMid + 0.42, dz1 - 0.1); // rear bench
  }

  const metalReal = metal.filter((b): b is THREE.BufferGeometry => b !== null);
  const cabinReal = cabin.filter((b): b is THREE.BufferGeometry => b !== null);
  const metalGeo = metalReal.length ? mergeGeometries(metalReal, false) : null;
  const cabinGeo = cabinReal.length ? mergeGeometries(cabinReal, false) : null;
  for (const b of [...metalReal, ...cabinReal]) b.dispose();
  // two material groups: 0 = metalMat, 1 = cabinMat (vehicles.ts)
  if (metalGeo && cabinGeo) {
    const out = mergeGeometries([metalGeo, cabinGeo], true);
    metalGeo.dispose();
    cabinGeo.dispose();
    return out;
  }
  const single = metalGeo ?? cabinGeo;
  if (single) single.addGroup(0, single.index ? single.index.count : (single.attributes.position as THREE.BufferAttribute).count, metalGeo ? 0 : 1);
  return single;
}
