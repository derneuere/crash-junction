import * as THREE from 'three';
import type { VehicleSpec } from '../types';
import type { LidFit, PanelFace, PanelMetrics } from './metrics-types';

export const FACE_DEPTH = 0.2; // how deep a slice of the nose/tail is "the bumper face"
const LID_RAYS = 8; // probes along a lid band's centerline
const SILL_STEPS = 14; // vertical resolution of the door-sill probe

/** Survey the normalized body for the panel-fit landmarks (PanelMetrics).
 *  Pure geometry work — deterministic, run once per template at bake.
 *  Two tricks carry it: the glass ranges are the waistline landmark (the
 *  bottom of the side windows is where doors end, and a probe ray whose
 *  first hit is glass is over the greenhouse, not over a lid), and surfaces
 *  are measured with rays, not vertices — a low-poly lid or door skin has
 *  vertices only at its corners, so vertex slices read garbage between. */
export function measurePanelMetrics(
  geo: THREE.BufferGeometry,
  arch: { x: number; zFront: number; zRear: number },
  spec: VehicleSpec,
  glassRanges: [number, number][],
): PanelMetrics {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const halfW = Math.max(bb.max.x, -bb.min.x);
  const r = spec.wheelRadius;
  // the bus door rides ahead of the front arch; car doors between the arches
  const doorZ0 = spec.variant === 'bus' ? bb.min.z + FACE_DEPTH : arch.zFront + r;
  const doorZ1 = spec.variant === 'bus' ? arch.zFront - r : arch.zRear - r;
  const isGlass = new Uint8Array(pos.count);
  for (const [s, e] of glassRanges) isGlass.fill(1, s, e);
  const mesh = new THREE.Mesh(geo);
  const ray = new THREE.Raycaster();

  // waist: the side windows' bottom edge — where doors end
  let waistY = bb.max.y;
  for (let i = 0; i < pos.count; i++) {
    if (!isGlass[i]) continue;
    const z = pos.getZ(i);
    if (z > doorZ0 && z < doorZ1) waistY = Math.min(waistY, pos.getY(i));
  }
  if (waistY === bb.max.y) waistY = bb.min.y + (bb.max.y - bb.min.y) * 0.55;

  // door plane: widest body point in the band below the waist
  let sideX = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z > doorZ0 && z < doorZ1 && pos.getY(i) < waistY) {
      sideX = Math.max(sideX, Math.abs(pos.getX(i)));
    }
  }
  if (sideX === 0) sideX = halfW; // degenerate band — use the bbox

  // sill: walk down the side surface at the door's z until the shell steps
  // away from the door plane (the bus skirt tucks inside its window band,
  // so a vertex scan near the plane would stop at the window trim)
  const doorZc = (doorZ0 + doorZ1) / 2;
  const sideProbe = new THREE.Vector3(-1, 0, 0);
  let sillY = waistY;
  for (let j = 1; j <= SILL_STEPS; j++) {
    const y = waistY - ((waistY - bb.min.y - 0.02) * j) / SILL_STEPS;
    ray.set(new THREE.Vector3(halfW + 1, y, doorZc), sideProbe);
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit || hit.point.x < sideX - 0.2) break;
    sillY = y;
  }
  if (sillY > waistY - 0.2) sillY = waistY - 0.35;

  // hood / rear deck: downward centerline probes
  const probe = (z: number): number | null => {
    ray.set(new THREE.Vector3(0, bb.max.y + 1, z), _down);
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit?.face) return null;
    const f = hit.face;
    return isGlass[f.a] || isGlass[f.b] || isGlass[f.c] ? null : hit.point.y;
  };
  const fallbackY = waistY + 0.05;
  const bonnet = probeLid(probe, bb.min.z + FACE_DEPTH, arch.zFront + r, fallbackY);
  const boot = probeLid(probe, arch.zRear, bb.max.z - FACE_DEPTH, fallbackY);

  // nose/tail faces (bumper regions)
  const nose: PanelFace = { halfW: 0, y0: bb.max.y, y1: bb.min.y };
  const tail: PanelFace = { halfW: 0, y0: bb.max.y, y1: bb.min.y };
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const face = z < bb.min.z + FACE_DEPTH ? nose : z > bb.max.z - FACE_DEPTH ? tail : null;
    if (!face) continue;
    const y = pos.getY(i);
    face.halfW = Math.max(face.halfW, Math.abs(pos.getX(i)));
    face.y0 = Math.min(face.y0, y);
    face.y1 = Math.max(face.y1, y);
  }
  return {
    minY: bb.min.y,
    maxY: bb.max.y,
    noseZ: bb.min.z,
    tailZ: bb.max.z,
    door: { x: sideX, z0: doorZ0, z1: doorZ1, sillY, waistY },
    bonnet,
    boot,
    nose,
    tail,
  };
}

const _down = new THREE.Vector3(0, -1, 0);

/** Fit a resting line to a lid band: probe along it, line through the first
 *  and last surface hits. Rays over glass drop out, so a band that overlaps
 *  the windshield shrinks to the real hood. */
function probeLid(
  probe: (z: number) => number | null,
  z0: number,
  z1: number,
  fallbackY: number,
): LidFit {
  const hits: { z: number; y: number }[] = [];
  for (let i = 0; i < LID_RAYS; i++) {
    const z = z0 + ((i + 0.5) / LID_RAYS) * (z1 - z0);
    const y = probe(z);
    if (y !== null) hits.push({ z, y });
  }
  if (!hits.length) return { y: fallbackY, slope: 0 };
  const a = hits[0];
  const b = hits[hits.length - 1];
  const slope = b.z - a.z > 0.01 ? (b.y - a.y) / (b.z - a.z) : 0;
  return { y: a.y + slope * ((z0 + z1) / 2 - a.z), slope };
}
