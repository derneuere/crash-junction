import * as THREE from 'three';
import type { CarRecipe, Station } from './recipe';
import type { Soup, V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Front clip + mirrors — Astra-H style. The bumper is a faceted body-colour
// wrap (columns across the nose, corners pulled back) carrying a dark lower
// intake slot, fog-lamp recesses on the corner facets and a light plate pad;
// the grille is a chrome moustache over a dark slot high between the lights;
// the headlights are teardrop wedges: a chunky lens prism on the nose face
// that sweeps back and up over the fender corner to a tip along the hood
// edge. Mirrors are five-face teardrop housings on short stalks at the
// A-pillar/beltline junction. Everything sits a few mm proud of the loft so
// nothing z-fights, and buried edges let the body close the gaps.
// The bumper mass stays inside the front-bumper carve region (z within
// ~±0.15 of the nose face, y −0.60…−0.30) so it tears off with the fascia;
// lights and grille stay ABOVE that band.
// ────────────────────────────────────────────────────────────────────────────

const CHROME = new THREE.Color(0x7f868e); // grille moustache bar (reads on light paint)
const PLATE = new THREE.Color(0xcdd0d4); // number-plate pad

interface ClipSoups {
  paint: Soup;
  trim: Soup;
  head: Soup;
  tail: Soup;
}

interface ClipColors {
  paint: THREE.Color;
  trim: THREE.Color;
  head: THREE.Color;
  tail: THREE.Color;
}

/** Extrude a 4-corner front face straight BACK (+z, into the body) by
 *  `depth`, closing all six sides. Corners wind bottom-in → bottom-out →
 *  top-out → top-in; the soup's awayFrom reference fixes each face outward. */
function prism(soup: Soup, front: [V3, V3, V3, V3], depth: number, color: THREE.Color): void {
  const back = front.map(([x, y, z]) => [x, y, z + depth] as V3) as [V3, V3, V3, V3];
  const ctr: V3 = [
    (front[0][0] + front[1][0] + front[2][0] + front[3][0]) / 4,
    (front[0][1] + front[1][1] + front[2][1] + front[3][1]) / 4,
    (front[0][2] + front[1][2] + front[2][2] + front[3][2]) / 4 + depth / 2,
  ];
  soup.quad(front[0], front[1], front[2], front[3], color, ctr);
  soup.quad(back[0], back[1], back[2], back[3], color, ctr);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    soup.quad(front[i], front[j], back[j], back[i], color, ctr);
  }
}

export function buildFrontClip(recipe: CarRecipe, soups: ClipSoups, colors: ClipColors): void {
  const s0 = recipe.stations[0]; // nose face
  const s1 = recipe.stations[1]; // hood leading edge
  const s2 = recipe.stations[2]; // hood proper
  const z = s0.z;

  /** Hood/fender surface between the first three stations (piecewise linear). */
  const seg = (zq: number): [Station, Station] => (zq <= s1.z ? [s0, s1] : [s1, s2]);
  const topY = (zq: number): number => {
    const [a, b] = seg(zq);
    return a.bodyY + ((b.bodyY - a.bodyY) * (zq - a.z)) / (b.z - a.z);
  };
  const halfW = (zq: number): number => {
    const [a, b] = seg(zq);
    return a.halfW + ((b.halfW - a.halfW) * (zq - a.z)) / (b.z - a.z);
  };

  // ── bumper: faceted body-colour wrap (stays in the carve band) ───────────
  const bumperSoup = recipe.parts.bumpers === 'painted' ? soups.paint : soups.trim;
  const bumperColor = recipe.parts.bumpers === 'painted' ? colors.paint : colors.trim;
  // columns across the nose: [x, front z]; corners pulled back for the wrap
  const cols: [number, number][] = [
    [-0.7, z], [-0.46, z - 0.12], [0, z - 0.13], [0.46, z - 0.12], [0.7, z],
  ];
  // rows top→bottom at one column: shelf back, top edge, mid bulge, lip, under
  const rows = (x: number, zF: number): V3[] => [
    [x, -0.285, z + 0.05],
    [x, -0.295, zF + 0.045],
    [x, -0.435, zF],
    [x, -0.55, zF + 0.04],
    [x, -0.615, zF + 0.1],
  ];
  const away: V3 = [0, -0.43, z + 0.55]; // interior point behind the fascia
  for (let i = 0; i < cols.length - 1; i++) {
    const a = rows(cols[i][0], cols[i][1]);
    const b = rows(cols[i + 1][0], cols[i + 1][1]);
    for (let r = 0; r < 4; r++) bumperSoup.quad(a[r], a[r + 1], b[r + 1], b[r], bumperColor, away);
  }
  // corner side returns, tucking back into the widening loft
  for (const m of [-1, 1]) {
    const f = (y: number, zf: number): V3 => [m * 0.7, y, zf];
    const bk = (y: number): V3 => [m * 0.685, y, z + 0.15];
    bumperSoup.quad(f(-0.295, z + 0.045), bk(-0.3), bk(-0.44), f(-0.435, z), bumperColor, away);
    bumperSoup.quad(f(-0.435, z), bk(-0.44), bk(-0.545), f(-0.55, z + 0.04), bumperColor, away);
  }
  // dark lower intake slot, centred
  prism(soups.trim, [
    [-0.3, -0.545, z - 0.138], [0.3, -0.545, z - 0.138],
    [0.3, -0.465, z - 0.142], [-0.3, -0.465, z - 0.142],
  ], 0.06, colors.trim);
  // number-plate pad above the slot
  prism(soups.trim, [
    [-0.18, -0.415, z - 0.145], [0.18, -0.415, z - 0.145],
    [0.18, -0.315, z - 0.128], [-0.18, -0.315, z - 0.128],
  ], 0.05, PLATE);
  // fog-lamp recesses on the corner facets
  for (const m of [-1, 1]) {
    prism(soups.trim, [
      [m * 0.47, -0.525, z - 0.128], [m * 0.61, -0.525, z - 0.075],
      [m * 0.61, -0.445, z - 0.075], [m * 0.47, -0.445, z - 0.128],
    ], 0.06, colors.trim);
  }

  // ── grille: high between the lights, above the bumper band ───────────────
  if (recipe.parts.grille === 'bar') {
    // dark slot with the chrome moustache riding its top edge
    prism(soups.trim, [
      [-0.26, -0.212, z - 0.014], [0.26, -0.212, z - 0.014],
      [0.26, -0.15, z - 0.011], [-0.26, -0.15, z - 0.011],
    ], 0.05, colors.trim);
    prism(soups.trim, [
      [-0.28, -0.148, z - 0.02], [0.28, -0.148, z - 0.02],
      [0.24, -0.116, z - 0.014], [-0.24, -0.116, z - 0.014],
    ], 0.05, CHROME);
  } else if (recipe.parts.grille === 'chrome') {
    prism(soups.trim, [
      [-0.33, -0.22, z - 0.016], [0.33, -0.22, z - 0.016],
      [0.3, -0.12, z - 0.012], [-0.3, -0.12, z - 0.012],
    ], 0.05, CHROME);
  } // 'closed' = nothing, the body face is the grille (EV style)

  // ── headlights ────────────────────────────────────────────────────────────
  if (recipe.parts.headlights === 'strip') {
    soups.head.box(0, s0.bodyY - 0.07, z - 0.012, s0.halfW * 1.5, 0.05, 0.02, colors.head);
  } else if (recipe.parts.headlights === 'quad-round') {
    for (const m of [-1, 1]) {
      soups.head.box(m * s0.halfW * 0.62, s0.bodyY - 0.05, z - 0.012, 0.16, 0.14, 0.02, colors.head);
      soups.head.box(m * s0.halfW * 0.36, s0.bodyY - 0.05, z - 0.012, 0.13, 0.12, 0.02, colors.head);
    }
  } else {
    // 'pods' → teardrop units: wide lens prism at the bumper corner sweeping
    // back and up over the fender edge to a tip along the hood side
    const zE = s1.z;
    const zG = s1.z + 0.25;
    for (const m of [-1, 1]) {
      const A: V3 = [m * 0.27, s0.bodyY - 0.145, z - 0.015]; // front bottom inner
      const B: V3 = [m * 0.585, s0.bodyY - 0.145, z - 0.012]; // front bottom outer
      const C: V3 = [m * 0.27, s0.bodyY + 0.005, z - 0.012]; // front top inner
      const D: V3 = [m * 0.6, s0.bodyY + 0.005, z - 0.008]; // front top outer
      const E: V3 = [m * 0.52, topY(zE) + 0.02, zE]; // mid top inner (on hood)
      const F: V3 = [m * (halfW(zE) + 0.01), topY(zE) - 0.045, zE]; // mid outer (fender)
      const G: V3 = [m * (halfW(zG) + 0.008), topY(zG) + 0.012, zG]; // teardrop tip
      const inner: V3 = [m * 0.4, -0.3, s1.z]; // inside the nose, for winding
      prism(soups.head, [A, B, D, C], 0.07, colors.head); // chunky front unit
      soups.head.quad(C, D, F, E, colors.head, inner); // sweep up the corner
      soups.head.tri(B, D, F, colors.head, inner); // outer corner skirt
      soups.head.tri(E, F, G, colors.head, inner); // tip along the hood edge
    }
  }
}

export function buildMirrors(recipe: CarRecipe, paint: Soup, color: THREE.Color): void {
  // teardrop housings on short stalks at the A-pillar/beltline junction
  const dark = color.clone().multiplyScalar(0.25); // stalk + glass read as trim
  const zA = recipe.cabin.z0 + 0.08;
  const s = recipe.stations.reduce((a, b) => (Math.abs(b.z - zA) < Math.abs(a.z - zA) ? b : a));
  const w = s.halfW;
  const belt = recipe.cabin.beltY;
  for (const m of [-1, 1]) {
    // stalk anchors INTO the shoulder at belt height (above it the glass is
    // inset by tumblehome, so anything higher would float beside the glass)
    paint.box(m * (w + 0.04), belt - 0.005, zA + 0.04, 0.1, 0.045, 0.08, dark);
    // housing: flat glass face aft, tapering forward to a horizontal edge
    const r1: V3 = [m * (w + 0.065), belt - 0.04, zA + 0.1];
    const r2: V3 = [m * (w + 0.195), belt - 0.04, zA + 0.1];
    const r3: V3 = [m * (w + 0.195), belt + 0.075, zA + 0.1];
    const r4: V3 = [m * (w + 0.065), belt + 0.075, zA + 0.1];
    const f1: V3 = [m * (w + 0.075), belt + 0.03, zA - 0.03];
    const f2: V3 = [m * (w + 0.175), belt + 0.03, zA - 0.03];
    const ctr: V3 = [m * (w + 0.12), belt + 0.02, zA + 0.05];
    paint.quad(r1, r2, r3, r4, dark, ctr); // mirror glass (faces rearward)
    paint.quad(r4, r3, f2, f1, color, ctr); // top
    paint.quad(r1, r2, f2, f1, color, ctr); // bottom
    paint.tri(r2, r3, f2, color, ctr); // outer cheek
    paint.tri(r1, r4, f1, color, ctr); // inner cheek
  }
}
