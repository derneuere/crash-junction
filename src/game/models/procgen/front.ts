import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import { prism, type Soup, type V3 } from './soup';
import { surfaceOf } from './surface';

// ────────────────────────────────────────────────────────────────────────────
// Front clip + mirrors — Astra-H style. The bumper is a faceted body-colour
// wrap (columns across the nose, corners pulled back) carrying a dark lower
// intake slot, fog-lamp recesses on the corner facets and a light plate pad;
// the grille is a chrome moustache over a dark slot high between the lights;
// the headlights are clear-lens teardrop units with modelled internals: a
// dark housing tub, two proud corona cylinders (low/high beam) in the head
// role, an amber indicator at the inner corner, and a dark sweep up the
// fender carrying a narrow lens strip to the tip. Mirrors are five-face
// teardrop housings on short stalks at the A-pillar/beltline junction.
// The bumper mass stays inside the front-bumper carve region (z within
// ~±0.15 of the nose face, y −0.60…−0.30) so it tears off with the fascia;
// lights and grille stay ABOVE that band.
// ────────────────────────────────────────────────────────────────────────────

const CHROME = new THREE.Color(0x7f868e); // grille moustache bar (reads on light paint)
const PLATE = new THREE.Color(0xcdd0d4); // number-plate pad
const AMBER = new THREE.Color(0xd98a1e); // indicator element

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

/** Low-poly corona: forward-facing (−z) disc cap + side wall, the round
 *  projector element of a clear-lens headlight. `zF` is the proud front
 *  plane; the wall runs `depth` back so the rear buries in the housing. */
function corona(
  soup: Soup, cx: number, cy: number, zF: number,
  r: number, depth: number, seg: number, color: THREE.Color,
): void {
  const rim = (i: number, zq: number): V3 => {
    const a = (i / seg) * Math.PI * 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r, zq];
  };
  const behind: V3 = [cx, cy, zF + 1]; // cap faces forward, away from this
  const axis: V3 = [cx, cy, zF + depth / 2];
  for (let i = 0; i < seg; i++) {
    soup.tri([cx, cy, zF], rim(i, zF), rim(i + 1, zF), color, behind);
    soup.quad(rim(i, zF), rim(i + 1, zF), rim(i + 1, zF + depth), rim(i, zF + depth), color, axis);
  }
}

const lerp = (p: V3, q: V3, t: number): V3 =>
  [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];

export function buildFrontClip(recipe: CarRecipe, soups: ClipSoups, colors: ClipColors): void {
  const surf = surfaceOf(recipe);
  const s0 = recipe.stations[0]; // nose face
  const s1 = recipe.stations[1]; // hood leading edge
  const z = s0.z;

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
  ], [0, 0, 0.06], colors.trim);
  // number-plate pad above the slot
  prism(soups.trim, [
    [-0.18, -0.415, z - 0.145], [0.18, -0.415, z - 0.145],
    [0.18, -0.315, z - 0.128], [-0.18, -0.315, z - 0.128],
  ], [0, 0, 0.05], PLATE);
  // fog-lamp recesses on the corner facets
  for (const m of [-1, 1]) {
    prism(soups.trim, [
      [m * 0.47, -0.525, z - 0.128], [m * 0.61, -0.525, z - 0.075],
      [m * 0.61, -0.445, z - 0.075], [m * 0.47, -0.445, z - 0.128],
    ], [0, 0, 0.06], colors.trim);
  }

  // ── grille: high between the lights, above the bumper band ───────────────
  if (recipe.parts.grille === 'bar') {
    // dark slot with the chrome moustache riding its top edge
    prism(soups.trim, [
      [-0.26, -0.212, z - 0.014], [0.26, -0.212, z - 0.014],
      [0.26, -0.15, z - 0.011], [-0.26, -0.15, z - 0.011],
    ], [0, 0, 0.05], colors.trim);
    prism(soups.trim, [
      [-0.28, -0.148, z - 0.02], [0.28, -0.148, z - 0.02],
      [0.24, -0.116, z - 0.014], [-0.24, -0.116, z - 0.014],
    ], [0, 0, 0.05], CHROME);
  } else if (recipe.parts.grille === 'chrome') {
    prism(soups.trim, [
      [-0.33, -0.22, z - 0.016], [0.33, -0.22, z - 0.016],
      [0.3, -0.12, z - 0.012], [-0.3, -0.12, z - 0.012],
    ], [0, 0, 0.05], CHROME);
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
    // 'pods' → clear-lens teardrop units: dark housing tub recessed on the
    // nose face, two round corona elements proud of it (main low beam
    // outboard, smaller high beam inboard), amber indicator at the inner
    // top corner; the sweep up the fender is dark base under a narrow lens
    // strip so the whole unit still reads as one lamp.
    const zE = s1.z;
    const zG = s1.z + 0.25;
    for (const m of [-1, 1]) {
      const yB = s0.bodyY - 0.145, yT = s0.bodyY + 0.005;
      const A: V3 = [m * 0.27, yB, z - 0.007]; // housing front, recessed vs
      const B: V3 = [m * 0.585, yB, z - 0.004]; // the old flat lens plane
      const C: V3 = [m * 0.27, yT, z - 0.004];
      const D: V3 = [m * 0.6, yT, z - 0.001];
      const E: V3 = [m * 0.52, surf.bodyY(zE) + 0.02, zE]; // mid top (hood)
      const F: V3 = [m * (surf.halfW(zE) + 0.01), surf.bodyY(zE) - 0.045, zE]; // fender
      const G: V3 = [m * (surf.halfW(zG) + 0.008), surf.bodyY(zG) + 0.012, zG]; // tip
      const inner: V3 = [m * 0.4, -0.3, s1.z]; // inside the nose, for winding
      prism(soups.trim, [A, B, D, C], [0, 0, 0.05], colors.trim); // housing tub
      soups.trim.quad(C, D, F, E, colors.trim, inner); // dark sweep base
      soups.trim.tri(B, D, F, colors.trim, inner); // outer corner skirt
      soups.trim.tri(E, F, G, colors.trim, inner); // tip base
      // corona elements, proud of the housing (rear walls bury in the tub)
      corona(soups.head, m * 0.49, yB + 0.088, z - 0.036, 0.056, 0.042, 9, colors.head);
      corona(soups.head, m * 0.362, yB + 0.078, z - 0.028, 0.038, 0.034, 8, colors.head);
      // amber indicator wedge at the inner/upper corner (inside the tub)
      prism(soups.trim, [
        [m * 0.278, yB + 0.1, z - 0.016], [m * 0.345, yB + 0.104, z - 0.015],
        [m * 0.335, yB + 0.14, z - 0.014], [m * 0.278, yB + 0.143, z - 0.014],
      ], [0, 0, 0.03], AMBER);
      // narrow lens strip riding the dark sweep, plus an inset glowing tip
      const up = (p: V3): V3 => [p[0] + m * 0.004, p[1] + 0.007, p[2]];
      soups.head.quad(
        up(lerp(C, D, 0.45)), up(lerp(C, D, 0.9)),
        up(lerp(E, F, 0.85)), up(lerp(E, F, 0.35)), colors.head, inner,
      );
      const tc = lerp(lerp(E, F, 0.5), G, 0.33); // tip centroid-ish
      soups.head.tri(up(lerp(E, tc, 0.2)), up(lerp(F, tc, 0.2)), up(lerp(G, tc, 0.2)), colors.head, inner);
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
