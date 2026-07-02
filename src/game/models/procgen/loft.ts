import * as THREE from 'three';
import type { CarRecipe, Station } from './recipe';
import { withStationsAt } from './recipe';
import { Soup, type V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// The body-in-white loft. Every station (recipe.ts) becomes a closed cross-
// section ring; consecutive rings are skinned into bands of quads. The ring
// has FIXED point semantics — where a station has no greenhouse the
// greenhouse points collapse onto the shoulder and their bands drop out via
// the soup's degenerate-triangle check. Wheel-well openings are made by
// SKIPPING the lower side-wall quads in the bands between the arch-edge
// stations (withStationsAt guarantees band boundaries land exactly there);
// a dark liner half-tube dresses each hole from inside.
//
// Quad roles: greenhouse side-wall quads become GLASS where the band is
// full-height and not a pillar; roof-band quads become GLASS on steep
// windshield/backlight slopes. Everything else is PAINT. Glass/paint go to
// separate soups so the assembler gets contiguous vertex ranges for free.
// ────────────────────────────────────────────────────────────────────────────

const SHOULDER_BEVEL = 0.06; // shoulder edge sits this far inboard of the side
const ROCKER_TUCK = 0.88; // floor width as a fraction of the side width
const KNUCKLE_RISE = 0.09; // rocker knuckle height above the floor line
const SIDE_TOP_DROP = 0.07; // side wall ends this far below the shoulder
const GH_TAPER = 0.82; // greenhouse top width over its base width
const GLASS_MIN_RISE = 0.3; // band needs this much greenhouse to be a window
const STEEP_GLASS = 0.1; // roof drop across a band that reads as a screen
const PILLAR_HALF = 0.09; // half-width of a pillar's painted band

/** Ring point layout, floor centre → roof centre up the +x side. */
const R_FLOOR_C = 0, R_FLOOR_E = 1, R_KNUCKLE = 2, R_SIDE_TOP = 3,
  R_SHOULDER = 4, R_GH_BASE = 5, R_GH_TOP = 6, R_ROOF_C = 7;
const HALF_PTS = 8;

function ringPoints(s: Station, floorY: number, tumblehome: number): V3[] {
  const w = s.halfW;
  const shW = w - SHOULDER_BEVEL;
  const hasGh = s.roofY > s.bodyY + 0.03;
  const gW = hasGh ? shW - tumblehome : shW;
  const gTopW = hasGh ? gW * GH_TAPER : shW;
  const half: V3[] = [];
  half[R_FLOOR_C] = [0, floorY, s.z];
  half[R_FLOOR_E] = [w * ROCKER_TUCK, floorY, s.z];
  half[R_KNUCKLE] = [w, floorY + KNUCKLE_RISE, s.z];
  half[R_SIDE_TOP] = [w, s.bodyY - SIDE_TOP_DROP, s.z];
  half[R_SHOULDER] = [shW, s.bodyY, s.z];
  half[R_GH_BASE] = hasGh ? [gW, s.bodyY + 0.01, s.z] : [shW, s.bodyY, s.z];
  half[R_GH_TOP] = hasGh ? [gTopW, s.roofY, s.z] : [shW, s.bodyY, s.z];
  half[R_ROOF_C] = [0, hasGh ? s.roofY : s.bodyY, s.z];
  return half;
}

/** Which soup a band segment's quads belong to. */
function segmentRole(
  seg: number, a: Station, b: Station, recipe: CarRecipe,
): 'paint' | 'glass' {
  const { cabin } = recipe;
  const midZ = (a.z + b.z) / 2;
  if (seg === R_GH_BASE) {
    // greenhouse side wall — glass when the band is full-height cabin and
    // not a pillar (A/C pillars fail the full-height test automatically,
    // the B pillar comes from the explicit list)
    const fullHeight =
      a.roofY - a.bodyY > GLASS_MIN_RISE && b.roofY - b.bodyY > GLASS_MIN_RISE;
    const inCabin = midZ > cabin.z0 && midZ < cabin.z1;
    const onPillar = cabin.pillars.some((p) => Math.abs(midZ - p) < PILLAR_HALF);
    return fullHeight && inCabin && !onPillar ? 'glass' : 'paint';
  }
  if (seg === R_GH_TOP) {
    // roof band — a steep rise/drop over the cabin is the windshield or
    // backlight surface
    const steep = Math.abs(b.roofY - a.roofY) > STEEP_GLASS;
    const overCabin = midZ > cabin.z0 - 0.05 && midZ < cabin.z1 + 0.05;
    return steep && overCabin ? 'glass' : 'paint';
  }
  return 'paint';
}

/** True when this band sits inside a wheel-well opening for `seg`. */
function inArchHole(seg: number, a: Station, b: Station, recipe: CarRecipe): boolean {
  if (seg !== R_FLOOR_C && seg !== R_FLOOR_E && seg !== R_KNUCKLE) return false;
  const midZ = (a.z + b.z) / 2;
  const r = recipe.archR;
  return (
    Math.abs(midZ - recipe.wheels.zFront) < r - 1e-3 ||
    Math.abs(midZ - recipe.wheels.zRear) < r - 1e-3
  );
}

export function buildLoft(
  recipe: CarRecipe,
  wheelY: number, // rest height of wheel centres, group space (spec-derived)
  soups: { paint: Soup; glass: Soup; trim: Soup },
  colors: { paint: THREE.Color; glass: THREE.Color; well: THREE.Color },
): void {
  const stations = withStationsAt(recipe.stations, [
    recipe.wheels.zFront - recipe.archR, recipe.wheels.zFront + recipe.archR,
    recipe.wheels.zRear - recipe.archR, recipe.wheels.zRear + recipe.archR,
    recipe.cabin.z0, recipe.cabin.z1,
    ...recipe.cabin.pillars.flatMap((p) => [p - PILLAR_HALF, p + PILLAR_HALF]),
  ]);
  const rings = stations.map((s) => ringPoints(s, recipe.floorY, recipe.tumblehome));

  // ── skin the bands ──
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    const ra = rings[i], rb = rings[i + 1];
    const ctr: V3 = [0, (recipe.floorY + Math.max(a.roofY, b.roofY)) / 2, (a.z + b.z) / 2];
    for (let seg = 0; seg < HALF_PTS - 1; seg++) {
      if (inArchHole(seg, a, b, recipe)) continue;
      const role = segmentRole(seg, a, b, recipe);
      const soup = role === 'glass' ? soups.glass : soups.paint;
      const color = role === 'glass' ? colors.glass : colors.paint;
      for (const m of [1, -1]) {
        const p = (v: V3): V3 => [v[0] * m, v[1], v[2]];
        soup.quad(p(ra[seg]), p(ra[seg + 1]), p(rb[seg + 1]), p(rb[seg]), color, ctr);
      }
    }
  }

  // ── nose / tail caps: fan-fill the end rings ──
  for (const [ring, s, dir] of [
    [rings[0], stations[0], -1],
    [rings[rings.length - 1], stations[stations.length - 1], 1],
  ] as [V3[], Station, number][]) {
    const midY = (recipe.floorY + s.bodyY) / 2;
    const behind: V3 = [0, midY, s.z - dir]; // normals face out the end
    const loop: V3[] = [
      ...ring.map((v): V3 => [v[0], v[1], v[2]]),
      ...ring.slice(1, HALF_PTS - 1).reverse().map((v): V3 => [-v[0], v[1], v[2]]),
    ];
    const c: V3 = [0, (recipe.floorY + s.bodyY) / 2, s.z];
    for (let k = 0; k < loop.length; k++) {
      soups.paint.tri(c, loop[k], loop[(k + 1) % loop.length], colors.paint, behind);
    }
  }

  // ── wheel-well liners: a dark half-tube behind each arch opening ──
  const outerX = Math.max(...stations.map((s) => s.halfW));
  for (const zc of [recipe.wheels.zFront, recipe.wheels.zRear]) {
    for (const m of [1, -1]) {
      buildWell(soups.trim, colors.well, m * (outerX + 0.005), m * (recipe.wheels.archX - 0.2),
        wheelY, zc, recipe.archR);
    }
  }
}

/** Half-tube from the body side (xOut) to an inner wall (xIn) around the
 *  wheel centre — the visible inside of the wheel arch. */
function buildWell(soup: Soup, color: THREE.Color, xOut: number, xIn: number,
  wheelY: number, zc: number, r: number): void {
  const SEGS = 6;
  const arc = (k: number): [number, number] => {
    const ang = Math.PI * (k / SEGS); // rear-bottom → top → front-bottom
    return [wheelY + Math.sin(ang) * r, zc + Math.cos(ang) * r];
  };
  for (let k = 0; k < SEGS; k++) {
    const [y0, z0] = arc(k);
    const [y1, z1] = arc(k + 1);
    // tube wall — normals face the wheel (away from a point beyond the wall)
    const midY = (y0 + y1) / 2, midZ = (z0 + z1) / 2;
    const beyond: V3 = [(xOut + xIn) / 2, midY + (midY - wheelY), midZ + (midZ - zc)];
    soup.quad([xOut, y0, z0], [xOut, y1, z1], [xIn, y1, z1], [xIn, y0, z0], color, beyond);
    // inner wall cap — faces outboard, toward the viewer (away from centre)
    soup.tri([xIn, wheelY, zc], [xIn, y0, z0], [xIn, y1, z1], color, [0, wheelY, zc]);
  }
}
