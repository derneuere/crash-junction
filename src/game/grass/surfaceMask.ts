// ============================================================================
// GRASS — the HARD grass-only placement mask, built from the level geometry.
// ============================================================================
//
// ── GRASS-ONLY PLACEMENT (the hard mask) ─────────────────────────────────────
//   We build a HARD mask from the LEVEL'S OWN surface geometry (read-only) and
//   REJECT every candidate that is not on real grass:
//     * outside the island OUTLINE polygon (inset a touch) -> over sea (reject)
//     * inside any 'sand' / 'gravel' / 'concrete' patch -> not grass (reject)
//     * seaward of the SW 'drygrass' dune lip -> sand (reject)
//     * within (half-width + margin) of the MAIN race ribbon or any SHORTCUT
//       ribbon centreline -> on/near road (reject)
//     * within a building plinth's footprint + margin -> under a building
//   drygrass patches are NOT rejected — they are drying-but-real grass (the
//   golden headland and cliff verges the player drifts along).
// ============================================================================

import type { LevelDef, GroundPatchDef } from '../types';

// ── ROAD/SURFACE MASK GEOMETRY (read from the level; never mutated) ─────────

/** Even-odd point-in-polygon test (ray cast). poly is a closed ring of
 *  [x, z] vertices (the level's GroundPatchDef.poly format). */
export function pointInPoly(x: number, z: number, poly: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i][0];
    const zi = poly[i][1];
    const xj = poly[j][0];
    const zj = poly[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Squared distance from (x,z) to the polyline `pts` (a road/ribbon
 *  centreline). Returns metres² so callers compare against a squared half-width
 *  without a sqrt. */
export function distToPolylineSq(x: number, z: number, pts: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0];
    const bz = pts[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best) best = d2;
  }
  return best;
}

/** A "road keep-out": a centreline polyline plus a clearance radius (m). */
interface RoadMask {
  pts: [number, number][];
  radiusSq: number;
}

/** A circular keep-out: a centre + squared radius (building plinths). */
interface CircleMask {
  x: number;
  z: number;
  radiusSq: number;
}

/** The grass-only mask, built once from the level's surface geometry. */
export interface SurfaceMask {
  outline: [number, number][];
  rejectPolys: GroundPatchDef['poly'][];
  lip: { seaward: [number, number][]; sandInsideSign: number } | null;
  roads: RoadMask[];
  buildings: CircleMask[];
}

/** Pull the SW-beach 'drygrass' band out of the level and split its thin loop
 *  into a seaward and an inland edge at its narrow ends. The seaward edge is the
 *  dune lip: clumps may reach it but not pass it. Mirrors environment.ts
 *  addDuneFringe's split so the blade lip and the painted fringe agree. */
function findDuneLip(patches: GroundPatchDef[]): SurfaceMask['lip'] {
  const band = patches.find(
    (p) => p.kind === 'drygrass' && p.poly.length >= 6 && p.poly.every(([x, z]) => x <= -78 && z <= -60),
  );
  if (!band) return null;
  const poly = band.poly;
  const M = poly.length;
  let iMin = 0;
  let iMax = 0;
  for (let i = 1; i < M; i++) {
    if (poly[i][0] < poly[iMin][0]) iMin = i;
    if (poly[i][0] > poly[iMax][0]) iMax = i;
  }
  const walk = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = from; ; i = (i + 1) % M) {
      out.push([poly[i][0], poly[i][1]]);
      if (i === to) break;
    }
    return out;
  };
  const edgeA = walk(iMin, iMax);
  const edgeB = walk(iMax, iMin);
  const meanZ = (e: [number, number][]): number => e.reduce((s, p) => s + p[1], 0) / e.length;
  const seaward = meanZ(edgeA) > meanZ(edgeB) ? edgeB : edgeA;
  if (seaward[0][0] > seaward[seaward.length - 1][0]) seaward.reverse();
  return { seaward, sandInsideSign: 0 };
}

/** Build the grass-only mask from the level's own surface geometry (read-only). */
export function buildSurfaceMask(level: LevelDef): SurfaceMask {
  const patches = level.patches ?? [];
  const rejectPolys: GroundPatchDef['poly'][] = patches
    .filter((p) => p.kind === 'sand' || p.kind === 'gravel' || p.kind === 'concrete')
    .map((p) => p.poly);

  const outline: [number, number][] = [];
  const o = level.coast?.outline ?? [];
  if (o.length >= 3) {
    let cx = 0;
    let cz = 0;
    for (const v of o) {
      cx += v.x;
      cz += v.z;
    }
    cx /= o.length;
    cz /= o.length;
    const INSET = 2.5; // m pulled inland off the rim
    for (const v of o) {
      const dx = v.x - cx;
      const dz = v.z - cz;
      const len = Math.hypot(dx, dz) || 1;
      outline.push([v.x - (dx / len) * INSET, v.z - (dz / len) * INSET]);
    }
  }

  const lip = findDuneLip(patches);

  const roads: RoadMask[] = [];
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  if (race) {
    const mainPts: [number, number][] = race.sections.map((s) => [s.x, s.z]);
    if (mainPts.length > 1) {
      mainPts.push([mainPts[0][0], mainPts[0][1]]); // close the loop
      const r = race.width / 2 + 2.5;
      roads.push({ pts: mainPts, radiusSq: r * r });
    }
    for (const sc of race.shortcuts ?? []) {
      const pts: [number, number][] = sc.waypoints.map((w) => [w[0], w[1]]);
      if (pts.length > 1) {
        const r = sc.width / 2 + 2.5;
        roads.push({ pts, radiusSq: r * r });
      }
    }
  }

  const buildings: CircleMask[] = (level.buildings ?? []).map((b) => {
    const r = 10.5; // ~half-diagonal of the 14x14 plinth + margin
    return { x: b.x, z: b.z, radiusSq: r * r };
  });

  return { outline, rejectPolys, lip, roads, buildings };
}

/** Signed seaward distance (m) of (x,z) from the dune-lip polyline. Negative =
 *  inland on the grass; positive = out onto the sand. */
export function seawardDist(x: number, z: number, lip: SurfaceMask['lip']): number {
  if (!lip) return -100;
  const pts = lip.seaward;
  let best = Infinity;
  let bestSigned = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0];
    const az = pts[i][1];
    const bx = pts[i + 1][0];
    const bz = pts[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      const nlen = Math.hypot(dz, dx) || 1;
      const nx = dz / nlen;
      const nz = -dx / nlen;
      bestSigned = (x - px) * nx + (z - pz) * nz;
    }
  }
  return bestSigned;
}

/** True iff (x,z) is on genuine grass. HARD mask. */
export function isGrass(x: number, z: number, mask: SurfaceMask): boolean {
  if (mask.outline.length >= 3 && !pointInPoly(x, z, mask.outline)) return false;
  for (const poly of mask.rejectPolys) if (pointInPoly(x, z, poly)) return false;
  if (mask.lip && seawardDist(x, z, mask.lip) > 0) return false;
  for (const road of mask.roads) if (distToPolylineSq(x, z, road.pts) < road.radiusSq) return false;
  for (const b of mask.buildings) {
    const dx = x - b.x;
    const dz = z - b.z;
    if (dx * dx + dz * dz < b.radiusSq) return false;
  }
  return true;
}
