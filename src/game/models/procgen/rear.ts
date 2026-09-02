import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import { prism, type Soup, type V3 } from './soup';
import { surfaceOf } from './surface';
import {
  AMBER, bezel, bounds, bowl, clipB, face, LAMP_FLOOR, LAMP_HOUSING, offsetPoly, plate, REVERSE_LENS, ribs, segment,
  TAIL_DEEP, TAIL_DOME, TAIL_RIB, TAIL_RIB_SHADE, type LampFrame, type P2,
} from './lampkit';

// ────────────────────────────────────────────────────────────────────────────
// Rear clip — Astra-H style. Taillight units hug the hatch-edge shoulders,
// built from the lamp kit (lampkit.ts): one tall bevelled bezel per side
// rising off the hatch, a dark housing floor, a red lens plate (emissive
// tail role) carrying a red reflector bowl + bulb dome and Fresnel ribs,
// an amber indicator and a clear reverse segment (its own emissive role,
// lit while reversing) on dark rims, and the white upper segment tapering
// along the hatch cutline as a ribbed clear plate. A garnish strip crosses under the window and a
// shallow recess carries the plate. The bumper is a faceted body-colour wrap
// (columns across the tail, corners pulled forward over the quarters, dark
// full-width lower insert rows closing the underside) kept inside the
// rear-bumper carve band (z within ~±0.15 of the tail face, y −0.60…−0.30)
// so it tears off with the fascia; all light geometry stays ABOVE that band.
// An octagonal exhaust tip exits under the left corner.
// ────────────────────────────────────────────────────────────────────────────

const WHITE_SEG = new THREE.Color(0xd8dadd); // reverse-lamp segment
const GARNISH = new THREE.Color(0x878d95); // steel strip under the window
const PLATE_WELL = new THREE.Color(0x33363b); // license recess shadow
const PLATE = new THREE.Color(0xc9cccf); // the plate itself
const HOUSING = new THREE.Color(0x141619); // bumper insert rows
const RIB_LIGHT = new THREE.Color(0xf0f2f4); // clear-plate rib slope
const RIB_SHADE = new THREE.Color(0x8e9399); // clear-plate rib return
const EXH_RIM = new THREE.Color(0x5a5f66); // dark-chrome exhaust tip
const EXH_BORE = new THREE.Color(0x101216); // bore walls + inner disc
const EXH_PIPE = new THREE.Color(0x26282c); // pipe run under the floor

interface ClipSoups {
  paint: Soup;
  trim: Soup;
  head: Soup;
  tail: Soup;
  reverse: Soup;
  /** Lamp housings / bezels / rims — dressing, never cut into a panel. */
  lampTrim: Soup;
}

interface ClipColors {
  paint: THREE.Color;
  trim: THREE.Color;
  head: THREE.Color;
  tail: THREE.Color;
}

export function buildRearClip(recipe: CarRecipe, soups: ClipSoups, colors: ClipColors): void {
  const surf = surfaceOf(recipe);
  const tail = surf.tail;
  const knee = recipe.stations[recipe.stations.length - 2];
  const zTail = tail.z;

  /** z of the hatch face at height y — follows the knee→tail slant and just
   *  keeps extrapolating below the tail foot (dressing there sits a touch
   *  prouder of the vertical cap, like the real light's bottom bulge). */
  const hatchZ = (y: number): number => {
    const t = (knee.bodyY - y) / (knee.bodyY - tail.bodyY);
    return knee.z + (tail.z - knee.z) * t;
  };
  /** Prism a face on the hatch plane, proud by `p`, extruded depth `d` into
   *  the body (−z). Corners are [x, y] pairs. */
  const pad = (soup: Soup, c: [number, number][], p: number, d: number, col: THREE.Color): void => {
    prism(
      soup,
      c.map(([x, y]) => [x, y, hatchZ(y) + p] as V3) as [V3, V3, V3, V3],
      [0, 0, -d],
      col,
    );
  };

  // ── taillights: tall tapered units flanking the hatch on the quarters ────
  if (recipe.parts.taillights === 'strip') {
    soups.tail.box(0, tail.bodyY - 0.07, zTail + 0.012, tail.halfW * 1.5, 0.05, 0.02, colors.tail);
  } else {
    // local frame ON the hatch plane: b runs up the slanted hatch face, d is
    // proud of it along its outward normal. Corners below are (|x|, y)
    // world pairs converted onto the plane, so the layout reads like the
    // old pads. The outline's (0.765, 0.005) corner is the unit's widest
    // point on the tail face and is kept exactly there.
    const ty = knee.bodyY - tail.bodyY, tz = tail.z - knee.z;
    const tl = Math.hypot(ty, tz);
    const vUp: V3 = [0, ty / tl, -tz / tl];
    const nOut: V3 = [0, tz / tl, ty / tl];
    const yRef = -0.12;
    const P = (x: number, y: number): P2 => [x, (y - yRef) / vUp[1]];
    for (const m of [-1, 1]) {
      const f: LampFrame = { o: [0, yRef, hatchZ(yRef)], u: [m, 0, 0], v: vUp, n: nOut };
      const outline: P2[] = [P(0.4, -0.26), P(0.74, -0.26), P(0.765, 0.005), P(0.78, 0.195), P(0.605, 0.195), P(0.5, 0.02)];
      const LIP = 0.042, FLOOR = 0.02;
      const lt = soups.lampTrim;
      const inner = bezel(lt, f, outline, LIP, FLOOR, 0.012, LAMP_HOUSING);
      face(lt, f, inner, FLOOR, LAMP_FLOOR);
      // upper clear segment: a white ribbed plate tapering up the cutline
      const upper = offsetPoly(clipB(inner, P(0, 0.035)[1], bounds(inner).b1), 0.003);
      plate(lt, f, upper, FLOOR, FLOOR + 0.008, WHITE_SEG);
      const ub = bounds(upper);
      ribs(lt, f, ub.a0 + 0.03, ub.a1 - 0.03, ub.b0 + 0.008, ub.b1 - 0.008, 3, FLOOR + 0.008, 0.004, RIB_LIGHT, RIB_SHADE);
      // red lens plate over the lower field, with the tail bulb's bowl
      const red = offsetPoly(clipB(inner, bounds(inner).b0, P(0, 0.02)[1]), 0.003);
      const c = P(0.645, -0.125);
      const TOP = FLOOR + 0.01;
      plate(soups.tail, f, red, FLOOR, TOP, colors.tail, { c, R: 0.058, seg: 12 });
      bowl(soups.tail, f, c, 0.058, 12, TOP, 0.01, colors.tail, TAIL_DEEP, { h: 0.018, col: TAIL_DOME });
      // Fresnel ribs under the bowl
      ribs(soups.tail, f, 0.585, 0.715, P(0, -0.243)[1], P(0, -0.195)[1], 2, TOP, 0.005, TAIL_RIB, TAIL_RIB_SHADE);
      // amber indicator (upper-inboard) and clear reverse lamp (lower-
      // inboard), each on a dark rim so the segments read separated
      const amber: P2[] = [P(0.515, -0.07), P(0.6, -0.07), P(0.6, -0.008), P(0.515, -0.008)];
      segment(lt, lt, f, amber, TOP, TOP + 0.004, TOP + 0.01, 0.005, LAMP_HOUSING, AMBER);
      const rev: P2[] = [P(0.462, -0.19), P(0.55, -0.19), P(0.55, -0.115), P(0.462, -0.115)];
      segment(lt, soups.reverse, f, rev, TOP, TOP + 0.004, TOP + 0.01, 0.005, LAMP_HOUSING, REVERSE_LENS);
    }
  }

  // ── garnish strip across the hatch under the window, between the lights ─
  pad(soups.trim, [[-0.55, 0.135], [0.55, 0.135], [0.55, 0.185], [-0.55, 0.185]], 0.014, 0.06, GARNISH);

  // ── license-plate recess: shallow dark inset centred on the hatch ───────
  pad(soups.trim, [[-0.27, -0.22], [0.27, -0.22], [0.27, -0.06], [-0.27, -0.06]], 0.008, 0.06, PLATE_WELL);
  pad(soups.trim, [[-0.22, -0.19], [0.22, -0.19], [0.22, -0.09], [-0.22, -0.09]], 0.016, 0.06, PLATE);

  // ── bumper: faceted body-colour wrap (stays inside the carve band) ───────
  const bumperSoup = recipe.parts.bumpers === 'painted' ? soups.paint : soups.trim;
  const bumperColor = recipe.parts.bumpers === 'painted' ? colors.paint : colors.trim;
  // columns across the tail: [x, rear face z]; corners hang back to the caps
  const cols: [number, number][] = [
    [-0.72, zTail + 0.005], [-0.46, zTail + 0.1], [0, zTail + 0.11],
    [0.46, zTail + 0.1], [0.72, zTail + 0.005],
  ];
  // rows top→bottom: shelf tucked into the body, top edge, mid bulge, lip,
  // then the dark insert rows folding forward to close the underside
  const rows = (x: number, zF: number): V3[] => [
    [x, -0.305, zTail - 0.045],
    [x, -0.315, zF - 0.035],
    [x, -0.44, zF],
    [x, -0.525, zF - 0.015],
    [x, -0.593, zF - 0.05],
    [x, -0.6, zTail - 0.12],
  ];
  const away: V3 = [0, -0.44, zTail - 0.55]; // interior point ahead of fascia
  for (let i = 0; i < cols.length - 1; i++) {
    const a = rows(cols[i][0], cols[i][1]);
    const b = rows(cols[i + 1][0], cols[i + 1][1]);
    for (let r = 0; r < 3; r++) bumperSoup.quad(a[r], a[r + 1], b[r + 1], b[r], bumperColor, away);
    for (let r = 3; r < 5; r++) soups.trim.quad(a[r], a[r + 1], b[r + 1], b[r], HOUSING, away);
  }
  // corner side returns, wrapping forward over the widening quarters
  const zQ = zTail - 0.13;
  const xQ = surf.halfW(zQ) - 0.025; // buried just inside the loft quarter
  for (const m of [-1, 1]) {
    const f = (y: number, zf: number): V3 => [m * 0.72, y, zf];
    const bk = (y: number): V3 => [m * xQ, y, zQ];
    bumperSoup.quad(f(-0.315, zTail - 0.03), bk(-0.32), bk(-0.45), f(-0.44, zTail + 0.005), bumperColor, away);
    bumperSoup.quad(f(-0.44, zTail + 0.005), bk(-0.45), bk(-0.53), f(-0.525, zTail - 0.01), bumperColor, away);
    soups.trim.quad(f(-0.525, zTail - 0.01), bk(-0.53), bk(-0.59), f(-0.593, zTail - 0.045), HOUSING, away);
  }

  // ── exhaust: octagonal tip under the left bumper corner, angled down ────
  const tips = recipe.parts.exhaust === 1 ? [-1] : [-1, 1];
  for (const m of tips) {
    const cx = m * 0.48;
    const zB = zTail - 0.11, zF = zTail + 0.055; // back ring → tip ring
    const yB = -0.59, yF = -0.617; // slight downward cant
    const ring = (cy: number, zc: number, r: number): V3[] => {
      const pts: V3[] = [];
      for (let k = 0; k < 8; k++) {
        const a = ((k + 0.5) * Math.PI) / 4;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), zc]);
      }
      return pts;
    };
    const outF = ring(yF, zF, 0.045), outB = ring(yB, zB, 0.045);
    const inF = ring(yF, zF, 0.028), inR = ring(yF - 0.004, zF - 0.035, 0.028);
    const axis: V3 = [cx, (yF + yB) / 2, (zF + zB) / 2];
    for (let k = 0; k < 8; k++) {
      const j = (k + 1) % 8;
      soups.trim.quad(outF[k], outF[j], outB[j], outB[k], EXH_RIM, axis); // barrel
      soups.trim.quad(outF[k], outF[j], inF[j], inF[k], EXH_RIM, [cx, yF, zF - 1]); // rim face
      const am = ((k + 1) * Math.PI) / 4; // bore wall faces the axis
      soups.trim.quad(inF[k], inF[j], inR[j], inR[k], EXH_BORE, [cx + 0.1 * Math.cos(am), yF + 0.1 * Math.sin(am), zF - 0.018]);
      soups.trim.tri(inR[k], inR[j], [cx, yF - 0.004, zF - 0.035], EXH_BORE, [cx, yF, zF - 1]); // recessed disc
    }
    // short dark pipe run disappearing under the floor
    soups.trim.box(cx, -0.64, zTail - 0.29, 0.075, 0.06, 0.42, EXH_PIPE);
  }
}
