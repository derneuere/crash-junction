import * as THREE from 'three';
import { Soup, type V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Lamp kit — the parts a head/tail light unit is built from, in a LOCAL
// frame on the body wall: `a` runs across the lamp (outboard positive),
// `b` up it, `d` proud of the wall along its outward normal. Both the
// procedural clips (front.ts / rear.ts) and the baked-GLB lamp dressing
// (models/lampdress.ts) build from these, so every car's lamps share one
// vocabulary: a bevelled bezel rising off the wall, a dark housing floor,
// concave reflector bowls with a projector dome, ribbed lens plates and
// rimmed indicator / reverse segments.
//
// Everything sits PROUD of the wall (the loft skin is a closed shell — a
// true recess would be hidden behind it) and the shallowest face floats
// ≥ 12 mm off it: closer than that a face parallel to the faceted wall
// depth-fights into a dashed seam. The bezel bevel is steeper than the
// crease angle of the normal smoothing (~57°), so its edges stay hard while
// the bowls — whose facets meet at 30–36° — smooth into round dishes.
// ────────────────────────────────────────────────────────────────────────────

export type P2 = [number, number];

export interface LampFrame {
  o: V3; // origin on the wall
  u: V3; // across the lamp, unit
  v: V3; // up the lamp, unit
  n: V3; // outward wall normal, unit
}

/** Frame point: o + u·a + v·b + n·d. */
export function fpt(f: LampFrame, a: number, b: number, d: number): V3 {
  return [
    f.o[0] + f.u[0] * a + f.v[0] * b + f.n[0] * d,
    f.o[1] + f.u[1] * a + f.v[1] * b + f.n[1] * d,
    f.o[2] + f.u[2] * a + f.v[2] * b + f.n[2] * d,
  ];
}

export function centroid(poly: P2[]): P2 {
  let a = 0, b = 0;
  for (const p of poly) { a += p[0]; b += p[1]; }
  return [a / poly.length, b / poly.length];
}

export function bounds(poly: P2[]): { a0: number; a1: number; b0: number; b1: number } {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const [a, b] of poly) {
    a0 = Math.min(a0, a); a1 = Math.max(a1, a);
    b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  return { a0, a1, b0, b1 };
}

const signedArea = (poly: P2[]): number => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
};

/** Convex polygon shrunk by `inset` on every edge (edge lines shifted
 *  inward, consecutive lines re-intersected) — the bezel's inner outline. */
export function offsetPoly(poly: P2[], inset: number): P2[] {
  const n = poly.length;
  const s = signedArea(poly) > 0 ? 1 : -1;
  const lines = poly.map((p, i) => {
    const q = poly[(i + 1) % n];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * s, ny = (dx / len) * s; // inward normal
    return { p: [p[0] + nx * inset, p[1] + ny * inset] as P2, d: [dx, dy] as P2 };
  });
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i - 1 + n) % n], L2 = lines[i];
    const det = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
    if (Math.abs(det) < 1e-9) { out.push(L2.p); continue; }
    const t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / det;
    out.push([L1.p[0] + L1.d[0] * t, L1.p[1] + L1.d[1] * t]);
  }
  return out;
}

/** Convex polygon clipped to the slab a0 ≤ a ≤ a1 (Sutherland–Hodgman on
 *  two half-planes) — how a housing splits into cells across its width. */
export function clipA(poly: P2[], a0: number, a1: number): P2[] {
  const clip = (input: P2[], inside: (p: P2) => boolean, cross: (p: P2, q: P2) => P2): P2[] => {
    const out: P2[] = [];
    for (let i = 0; i < input.length; i++) {
      const p = input[i], q = input[(i + 1) % input.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cross(p, q));
    }
    return out;
  };
  const at = (p: P2, q: P2, a: number): P2 => {
    const t = (a - p[0]) / (q[0] - p[0]);
    return [a, p[1] + (q[1] - p[1]) * t];
  };
  let poly2 = clip(poly, (p) => p[0] >= a0 - 1e-9, (p, q) => at(p, q, a0));
  poly2 = clip(poly2, (p) => p[0] <= a1 + 1e-9, (p, q) => at(p, q, a1));
  return poly2;
}

/** Same, clipped to the band b0 ≤ b ≤ b1 (stacked cells on tall lamps). */
export function clipB(poly: P2[], b0: number, b1: number): P2[] {
  const swap = (p: P2): P2 => [p[1], p[0]];
  return clipA(poly.map(swap), b0, b1).map(swap);
}

/** Fan-triangulated flat face on the plane d, facing +n. */
export function face(soup: Soup, f: LampFrame, poly: P2[], d: number, col: THREE.Color): void {
  const c = centroid(poly);
  const back = fpt(f, c[0], c[1], d - 1);
  for (let i = 1; i + 1 < poly.length; i++) {
    soup.tri(fpt(f, poly[0][0], poly[0][1], d), fpt(f, poly[i][0], poly[i][1], d), fpt(f, poly[i + 1][0], poly[i + 1][1], d), col, back);
  }
}

/** Bevelled bezel: a lip wall rising `lip` off the wall around `outline`,
 *  then a bevel sloping in and down to the inset outline at `floorD`.
 *  Returns the inner outline (the housing opening). The floor itself is
 *  the caller's — cells with bowls need a flange, not a flat quad. */
export function bezel(
  trim: Soup, f: LampFrame, outline: P2[], lip: number, floorD: number, inset: number, col: THREE.Color,
): P2[] {
  const inner = offsetPoly(outline, inset);
  const c = centroid(outline);
  const back = fpt(f, c[0], c[1], -1);
  const bevelCol = col.clone().multiplyScalar(2.2); // catches light, reads as a chamfer
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const p = outline[i], q = outline[(i + 1) % n];
    const pi = inner[i], qi = inner[(i + 1) % n];
    // lip wall (radial, hard against the bevel)
    trim.quad(fpt(f, p[0], p[1], 0), fpt(f, q[0], q[1], 0), fpt(f, q[0], q[1], lip), fpt(f, p[0], p[1], lip), col, back);
    // bevel down into the opening
    trim.quad(fpt(f, p[0], p[1], lip), fpt(f, q[0], q[1], lip), fpt(f, qi[0], qi[1], floorD), fpt(f, pi[0], pi[1], floorD), bevelCol, back);
  }
  return inner;
}

/** Ray from c at angle θ to the convex outline's edge, as a 2D point. */
function rayHit(outline: P2[], c: P2, theta: number): P2 {
  const dx = Math.cos(theta), dy = Math.sin(theta);
  let best = Infinity;
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const p = outline[i], q = outline[(i + 1) % n];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const det = dx * ey - dy * ex;
    if (Math.abs(det) < 1e-12) continue;
    const t = ((p[0] - c[0]) * ey - (p[1] - c[1]) * ex) / det; // along the ray
    const s = ((p[0] - c[0]) * dy - (p[1] - c[1]) * dx) / det; // along the edge
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  if (!isFinite(best)) best = 0;
  return [c[0] + dx * best, c[1] + dy * best];
}

/** Flat flange from a convex outline in to the circle (c, R) on plane d —
 *  the housing floor around a bowl. Ring points are placed exactly where
 *  `bowl` places its rim, so the two weld. */
export function flange(
  soup: Soup, f: LampFrame, outline: P2[], c: P2, R: number, seg: number, d: number, col: THREE.Color,
): void {
  const back = fpt(f, c[0], c[1], d - 1);
  const TAU = Math.PI * 2;
  const step = TAU / seg;
  const corners = outline.map((p) => {
    let ang = Math.atan2(p[1] - c[1], p[0] - c[0]);
    if (ang < 0) ang += TAU;
    return { ang, p };
  });
  for (let k = 0; k < seg; k++) {
    const t0 = k * step, t1 = (k + 1) * step;
    const r0 = fpt(f, c[0] + Math.cos(t0) * R, c[1] + Math.sin(t0) * R, d);
    const r1 = fpt(f, c[0] + Math.cos(t1) * R, c[1] + Math.sin(t1) * R, d);
    const h0 = rayHit(outline, c, t0), h1 = rayHit(outline, c, t1);
    const b0 = fpt(f, h0[0], h0[1], d), b1 = fpt(f, h1[0], h1[1], d);
    // outline corners inside this sector break the chord into a fan
    const inSector = corners.filter((cn) => cn.ang > t0 + 1e-9 && cn.ang < t1 - 1e-9).sort((x, y) => x.ang - y.ang);
    const chain: V3[] = [b0, ...inSector.map((cn) => fpt(f, cn.p[0], cn.p[1], d)), b1];
    soup.tri(r0, r1, b1, col, back);
    for (let i = 0; i + 1 < chain.length; i++) soup.tri(r0, chain[i + 1], chain[i], col, back);
  }
}

/** Concave reflector dish: rim circle (c, R) on plane dRim, deepening
 *  `depth` toward the centre over two facet bands (rim tone → deep tone),
 *  with a convex projector dome rising back out of the middle. Smooth
 *  normals come from the crease pass; the dome base is offset a hair so
 *  its edge stays crisp against the dish. */
export function bowl(
  soup: Soup, f: LampFrame, c: P2, R: number, seg: number, dRim: number, depth: number,
  rim: THREE.Color, deep: THREE.Color, dome: { h: number; col: THREE.Color },
): void {
  const TAU = Math.PI * 2;
  const ring = (k: number, rf: number, d: number): V3 =>
    fpt(f, c[0] + Math.cos((k / seg) * TAU) * R * rf, c[1] + Math.sin((k / seg) * TAU) * R * rf, d);
  const bottom = dRim - depth;
  const away = fpt(f, c[0], c[1], bottom - 1);
  const mid = rim.clone().lerp(deep, 0.5);
  const bands: [number, number, number, number, THREE.Color][] = [
    [1, dRim, 0.62, dRim - depth * 0.55, mid],
    [0.62, dRim - depth * 0.55, 0.3, bottom, deep],
  ];
  for (const [ra, da, rb, db, col] of bands) {
    for (let k = 0; k < seg; k++) {
      soup.quad(ring(k, ra, da), ring(k + 1, ra, da), ring(k + 1, rb, db), ring(k, rb, db), col, away);
    }
  }
  // projector dome over the hole, base a touch wider and prouder than the
  // hole edge so it covers it without welding to the dish
  const base = bottom + 0.002;
  const apex = fpt(f, c[0], c[1], bottom + dome.h);
  for (let k = 0; k < seg; k++) soup.tri(apex, ring(k, 0.32, base), ring(k + 1, 0.32, base), dome.col, away);
}

/** Extruded plate over a convex outline, walls d0→d1 and a top at d1 —
 *  optionally with a bowl hole (the top becomes a flange). */
export function plate(
  soup: Soup, f: LampFrame, outline: P2[], d0: number, d1: number, col: THREE.Color,
  hole?: { c: P2; R: number; seg: number },
): void {
  const c = centroid(outline);
  const ctr = fpt(f, c[0], c[1], (d0 + d1) / 2);
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const p = outline[i], q = outline[(i + 1) % n];
    soup.quad(fpt(f, p[0], p[1], d0), fpt(f, q[0], q[1], d0), fpt(f, q[0], q[1], d1), fpt(f, p[0], p[1], d1), col, ctr);
  }
  if (hole) flange(soup, f, outline, hole.c, hole.R, hole.seg, d1, col);
  else face(soup, f, outline, d1, col);
}

/** Fresnel ribs: a sawtooth of `count` slanted bands across the a-range,
 *  each rising `h` off dBase with a lit slope and a shaded return. */
export function ribs(
  soup: Soup, f: LampFrame, a0: number, a1: number, b0: number, b1: number, count: number,
  dBase: number, h: number, lit: THREE.Color, shade: THREE.Color,
): void {
  const step = (b1 - b0) / count;
  const am = (a0 + a1) / 2;
  for (let k = 0; k < count; k++) {
    const y0 = b0 + k * step, y1 = y0 + step;
    soup.quad(
      fpt(f, a0, y0, dBase), fpt(f, a1, y0, dBase), fpt(f, a1, y1, dBase + h), fpt(f, a0, y1, dBase + h),
      lit, fpt(f, am, y1 + 0.05, dBase - 0.05),
    );
    soup.quad(
      fpt(f, a0, y1, dBase + h), fpt(f, a1, y1, dBase + h), fpt(f, a1, y1, dBase), fpt(f, a0, y1, dBase),
      shade, fpt(f, am, y1 - 0.05, dBase + h / 2),
    );
  }
}

/** Rimmed segment: a dark rim plate d0→dRim under a lens plate inset
 *  `inset` and rising to dTop — indicator and reverse elements. */
export function segment(
  rimSoup: Soup, lensSoup: Soup, f: LampFrame, outline: P2[], d0: number, dRim: number, dTop: number,
  inset: number, rimCol: THREE.Color, lensCol: THREE.Color,
): void {
  plate(rimSoup, f, outline, d0, dRim, rimCol);
  plate(lensSoup, f, offsetPoly(outline, inset), dRim, dTop, lensCol);
}

// ── shared unit tones ────────────────────────────────────────────────────
export const LAMP_HOUSING = new THREE.Color(0x141619); // bezel / housing
export const LAMP_FLOOR = new THREE.Color(0x0c0d10); // deep housing floor
export const AMBER = new THREE.Color(0xd98a1e); // indicator lens
export const REVERSE_LENS = new THREE.Color(0xd8dadd); // clear reverse lens
export const HEAD_RIM = new THREE.Color(0xe9e2cf); // reflector bowl, rim
export const HEAD_DEEP = new THREE.Color(0x7d7668); // reflector bowl, deep
export const HEAD_DOME = new THREE.Color(0xf2f5ff); // projector dome
export const TAIL_LENS = new THREE.Color(0x7e120c); // red lens plate
export const TAIL_RIB = new THREE.Color(0xa0221a); // rib slope, catches light
export const TAIL_RIB_SHADE = new THREE.Color(0x4a0b08); // rib return
export const TAIL_DEEP = new THREE.Color(0x3e0906); // red bowl, deep
export const TAIL_DOME = new THREE.Color(0xc03a30); // red bulb dome

/** Depths shared by every unit (metres, proud of the wall). */
export const LAMP_LIP = 0.036;
export const LAMP_FLOOR_D = 0.016;
export const LAMP_INSET = 0.012;

// ── generic units (the GLB dressing uses these; the metro lays its own) ──

export interface HeadSoups { head: Soup; trim: Soup }
export interface TailSoups { tail: Soup; reverse: Soup; trim: Soup }

/** Projector headlight in `outline`: bezel, dark flange floor, a low-beam
 *  bowl (plus a smaller high-beam bowl and an amber end strip when the
 *  housing is wide enough). Bowls glow at night through the head role. */
export function headlightUnit(s: HeadSoups, f: LampFrame, outline: P2[], seg = 10): void {
  const inner = bezel(s.trim, f, outline, LAMP_LIP, LAMP_FLOOR_D, LAMP_INSET, LAMP_HOUSING);
  const { a0, a1, b0, b1 } = bounds(inner);
  const w = a1 - a0, h = b1 - b0;
  const cells: { poly: P2[]; kind: 'low' | 'high' | 'amber' }[] = [];
  if (w > 2.1 * h) {
    const amberW = Math.min(0.045, w * 0.14);
    const highW = (w - amberW) * 0.4;
    cells.push({ poly: clipA(inner, a0, a0 + amberW), kind: 'amber' });
    cells.push({ poly: clipA(inner, a0 + amberW, a0 + amberW + highW), kind: 'high' });
    cells.push({ poly: clipA(inner, a0 + amberW + highW, a1), kind: 'low' });
  } else if (w > 1.4 * h) {
    const amberW = Math.min(0.04, w * 0.18);
    cells.push({ poly: clipA(inner, a0, a0 + amberW), kind: 'amber' });
    cells.push({ poly: clipA(inner, a0 + amberW, a1), kind: 'low' });
  } else {
    cells.push({ poly: inner, kind: 'low' });
  }
  for (const cell of cells) {
    if (cell.poly.length < 3) continue;
    const bb = bounds(cell.poly);
    const c: P2 = [(bb.a0 + bb.a1) / 2, (bb.b0 + bb.b1) / 2];
    if (cell.kind === 'amber') {
      face(s.trim, f, cell.poly, LAMP_FLOOR_D, LAMP_FLOOR);
      const pad = offsetPoly(cell.poly, 0.004);
      if (pad.length >= 3) plate(s.trim, f, pad, LAMP_FLOOR_D, LAMP_FLOOR_D + 0.01, AMBER);
      continue;
    }
    const R = (Math.min(bb.a1 - bb.a0, bb.b1 - bb.b0) / 2) * (cell.kind === 'low' ? 0.84 : 0.78);
    const sg = cell.kind === 'low' ? seg : Math.max(6, seg - 2);
    flange(s.trim, f, cell.poly, c, R, sg, LAMP_FLOOR_D, LAMP_FLOOR);
    bowl(s.head, f, c, R, sg, LAMP_FLOOR_D, 0.014, HEAD_RIM, HEAD_DEEP, { h: cell.kind === 'low' ? 0.02 : 0.016, col: HEAD_DOME });
  }
}

/** Layered taillight in `outline`: bezel, then across the width (or down
 *  it, on tall units) a clear reverse segment, an amber indicator and the
 *  red field — a ribbed lens plate with a red reflector bowl and bulb. */
export function taillightUnit(s: TailSoups, f: LampFrame, outline: P2[], seg = 10): void {
  const inner = bezel(s.trim, f, outline, LAMP_LIP, LAMP_FLOOR_D, LAMP_INSET, LAMP_HOUSING);
  const { a0, a1, b0, b1 } = bounds(inner);
  const w = a1 - a0, h = b1 - b0;
  const tall = h > 1.25 * w;
  const span = tall ? h : w;
  const revW = span * 0.24, ambW = span * 0.2;
  const cut = tall
    ? (x0: number, x1: number) => clipB(inner, b0 + x0, b0 + x1)
    : (x0: number, x1: number) => clipA(inner, a0 + x0, a0 + x1);
  const rev = cut(0, revW);
  const amb = cut(revW, revW + ambW);
  const red = cut(revW + ambW, span);
  face(s.trim, f, inner, LAMP_FLOOR_D, LAMP_FLOOR);
  const D0 = LAMP_FLOOR_D + 0.002; // segments sit on the floor, not in it
  if (rev.length >= 3) segment(s.trim, s.reverse, f, offsetPoly(rev, 0.003), D0, D0 + 0.006, D0 + 0.012, 0.004, LAMP_HOUSING, REVERSE_LENS);
  if (amb.length >= 3) segment(s.trim, s.trim, f, offsetPoly(amb, 0.003), D0, D0 + 0.006, D0 + 0.012, 0.004, LAMP_HOUSING, AMBER);
  if (red.length >= 3) {
    const rp = offsetPoly(red, 0.003);
    const bb = bounds(rp);
    const rw = bb.a1 - bb.a0, rh = bb.b1 - bb.b0;
    // the bowl takes a square cell at the outboard/top end; ribs fill the rest
    const side = Math.min(rw, rh);
    const bowlCell = tall ? clipB(rp, bb.b1 - side, bb.b1) : clipA(rp, bb.a1 - side, bb.a1);
    const ribCell = tall ? clipB(rp, bb.b0, bb.b1 - side) : clipA(rp, bb.a0, bb.a1 - side);
    const bc = bounds(bowlCell);
    const c: P2 = [(bc.a0 + bc.a1) / 2, (bc.b0 + bc.b1) / 2];
    const R = (side / 2) * 0.8;
    const top = D0 + 0.012;
    plate(s.tail, f, bowlCell, D0, top, TAIL_LENS, { c, R, seg });
    bowl(s.tail, f, c, R, seg, top, 0.012, TAIL_LENS, TAIL_DEEP, { h: 0.016, col: TAIL_DOME });
    if (ribCell.length >= 3 && (tall ? rh - side : rw - side) > 0.05) {
      plate(s.tail, f, ribCell, D0, D0 + 0.006, TAIL_LENS);
      const rb = bounds(ribCell);
      const inset = 0.004;
      const count = Math.max(2, Math.min(4, Math.round((rb.b1 - rb.b0) / 0.03)));
      ribs(s.tail, f, rb.a0 + inset, rb.a1 - inset, rb.b0 + inset, rb.b1 - inset, count, D0 + 0.006, 0.005, TAIL_RIB, TAIL_RIB_SHADE);
    }
  }
}
