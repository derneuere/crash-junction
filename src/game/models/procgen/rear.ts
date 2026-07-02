import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import { prism, type Soup, type V3 } from './soup';
import { surfaceOf } from './surface';

// ────────────────────────────────────────────────────────────────────────────
// Rear clip — Astra-H style. Taillight units hug the hatch-edge shoulders:
// a near-black housing wedge carrying a red lens field (emissive tail role)
// with an amber indicator and a white reverse element seated on dark backing
// pads so the segments read separated, and the white upper segment tapering
// along the hatch cutline. A garnish strip crosses under the window and a
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
const HOUSING = new THREE.Color(0x141619); // taillight housing / segment rims
const AMBER = new THREE.Color(0xd98a1e); // indicator segment
const EXH_RIM = new THREE.Color(0x5a5f66); // dark-chrome exhaust tip
const EXH_BORE = new THREE.Color(0x101216); // bore walls + inner disc
const EXH_PIPE = new THREE.Color(0x26282c); // pipe run under the floor

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
    for (const m of [-1, 1]) {
      // near-black housing wedge: wide at the bumper, sweeping up-outboard
      pad(soups.trim, [[m * 0.4, -0.26], [m * 0.74, -0.26], [m * 0.75, 0.02], [m * 0.5, 0.02]], 0.012, 0.1, HOUSING);
      // red lens field inset so the housing reads as a rim (emissive role)
      pad(soups.tail, [[m * 0.425, -0.245], [m * 0.725, -0.245], [m * 0.735, 0.005], [m * 0.52, 0.005]], 0.026, 0.05, colors.tail);
      // amber indicator inboard under the white segment, on a dark backing
      pad(soups.trim, [[m * 0.53, -0.075], [m * 0.635, -0.075], [m * 0.638, -0.002], [m * 0.54, -0.002]], 0.03, 0.012, HOUSING);
      pad(soups.trim, [[m * 0.542, -0.062], [m * 0.622, -0.062], [m * 0.625, -0.014], [m * 0.55, -0.014]], 0.037, 0.012, AMBER);
      // white reverse element low-inboard, likewise rimmed
      pad(soups.trim, [[m * 0.475, -0.19], [m * 0.578, -0.19], [m * 0.585, -0.112], [m * 0.49, -0.112]], 0.03, 0.012, HOUSING);
      pad(soups.trim, [[m * 0.488, -0.177], [m * 0.565, -0.177], [m * 0.571, -0.125], [m * 0.5, -0.125]], 0.037, 0.012, WHITE_SEG);
      // white upper segment tapering to a tip beside the hatch-glass corner,
      // its own housing quad continuing the dark rim around the whole unit
      pad(soups.trim, [[m * 0.485, 0.005], [m * 0.765, 0.005], [m * 0.795, 0.195], [m * 0.605, 0.195]], 0.008, 0.1, HOUSING);
      pad(soups.trim, [[m * 0.5, 0.02], [m * 0.75, 0.02], [m * 0.775, 0.18], [m * 0.625, 0.18]], 0.018, 0.05, WHITE_SEG);
    }
  }

  // ── garnish strip across the hatch under the window, between the lights ─
  pad(soups.trim, [[-0.58, 0.135], [0.58, 0.135], [0.58, 0.185], [-0.58, 0.185]], 0.014, 0.06, GARNISH);

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
