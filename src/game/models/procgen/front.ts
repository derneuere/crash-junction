import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import { prism, type Soup, type V3 } from './soup';
import { surfaceOf } from './surface';
import { fpt, headlightUnit, LAMP_LIP, type LampFrame, type P2 } from './lampkit';

// ────────────────────────────────────────────────────────────────────────────
// Front clip + mirrors — Astra-H style. The bumper is a faceted body-colour
// wrap (columns across the nose, corners pulled back) carrying a dark lower
// intake slot, fog-lamp recesses on the corner facets and a light plate pad;
// the grille is a chrome moustache over a dark slot high between the lights;
// the headlights are teardrop units built from the lamp kit (lampkit.ts):
// a bevelled bezel rising off the nose face, a dark housing floor, a big
// low-beam reflector bowl outboard and a smaller high-beam bowl inboard
// (both head-role, so they glow at night) each with a projector dome, an
// amber indicator strip at the inner end, and a dark sweep up the fender
// carrying a narrow lens strip to the tip. Mirrors are five-face
// teardrop housings on short stalks at the A-pillar/beltline junction.
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
  /** Lamp housings / bezels / sweeps — dressing, never cut into a panel. */
  lampTrim: Soup;
}

interface ClipColors {
  paint: THREE.Color;
  trim: THREE.Color;
  head: THREE.Color;
  tail: THREE.Color;
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
    // 'pods' → teardrop lamp units on the nose face. The outline (A B D C)
    // is the unit's footprint: the bezel rises off the face inside it and
    // the bowls sit in the housing behind the bezel; the sweep up the
    // fender continues the unit's top edge from the lip.
    const zE = s1.z;
    const zG = s1.z + 0.25;
    for (const m of [-1, 1]) {
      const yB = s0.bodyY - 0.145, yT = s0.bodyY + 0.005;
      // local frame on the nose face: a outboard, b up, d proud (−z)
      const f: LampFrame = { o: [0, 0, z], u: [m, 0, 0], v: [0, 1, 0], n: [0, 0, -1] };
      const outline: P2[] = [[0.27, yB], [0.585, yB], [0.6, yT], [0.27, yT]];
      headlightUnit({ head: soups.head, trim: soups.lampTrim }, f, outline, 12);
      // the dark sweep up the fender starts at the unit's top lip
      const C = fpt(f, 0.27, yT, LAMP_LIP);
      const D = fpt(f, 0.6, yT, LAMP_LIP);
      const B = fpt(f, 0.585, yB, LAMP_LIP);
      const E: V3 = [m * 0.52, surf.bodyY(zE) + 0.02, zE]; // mid top (hood)
      const F: V3 = [m * (surf.halfW(zE) + 0.01), surf.bodyY(zE) - 0.045, zE]; // fender
      const G: V3 = [m * (surf.halfW(zG) + 0.008), surf.bodyY(zG) + 0.012, zG]; // tip
      const inner: V3 = [m * 0.4, -0.3, s1.z]; // inside the nose, for winding
      soups.lampTrim.quad(C, D, F, E, colors.trim, inner); // dark sweep base
      soups.lampTrim.tri(B, D, F, colors.trim, inner); // outer corner skirt
      soups.lampTrim.tri(E, F, G, colors.trim, inner); // tip base
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
