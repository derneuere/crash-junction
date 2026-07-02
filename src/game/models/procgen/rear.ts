import * as THREE from 'three';
import type { CarRecipe } from './recipe';
import type { Soup, V3 } from './soup';

// ────────────────────────────────────────────────────────────────────────────
// Rear clip: the dressing bolted onto the loft's tail — Astra-H style.
// Taillight wedges hug the hatch-edge shoulders between the knee and the
// bumper (red lens below, white segment above, tapering up-inward along the
// hatch cutline); a slim garnish strip crosses the hatch under the window;
// a shallow dark recess suggests the license plate; the bumper is a body
// slab with a full-width dark lower insert. Everything proud of its face by
// a few mm so nothing z-fights. The bumper mass stays inside the rear-bumper
// carve region (z within ~±0.15 of the tail face, y −0.60…−0.30) so it tears
// off with the fascia; the lights stay ABOVE that band.
// ────────────────────────────────────────────────────────────────────────────

const WHITE_SEG = new THREE.Color(0xd8dadd); // reverse-lamp segment
const GARNISH = new THREE.Color(0x878d95); // steel strip under the window
const PLATE_WELL = new THREE.Color(0x33363b); // license recess shadow
const PLATE = new THREE.Color(0xc9cccf); // the plate itself
const INSERT = new THREE.Color(0x24272c); // bumper lower insert
const EXHAUST = new THREE.Color(0x2c2f34);

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

/** Extrude a 4-corner front face straight forward (−z) by `depth`, closing
 *  all six sides. Corners wind bottom-in → bottom-out → top-out → top-in;
 *  the soup's awayFrom reference fixes each face outward. */
function prism(soup: Soup, front: [V3, V3, V3, V3], depth: number, color: THREE.Color): void {
  const back = front.map(([x, y, z]) => [x, y, z - depth] as V3) as [V3, V3, V3, V3];
  const ctr: V3 = [
    (front[0][0] + front[1][0] + front[2][0] + front[3][0]) / 4,
    (front[0][1] + front[1][1] + front[2][1] + front[3][1]) / 4,
    (front[0][2] + front[1][2] + front[2][2] + front[3][2]) / 4 - depth / 2,
  ];
  soup.quad(front[0], front[1], front[2], front[3], color, ctr);
  soup.quad(back[0], back[1], back[2], back[3], color, ctr);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    soup.quad(front[i], front[j], back[j], back[i], color, ctr);
  }
}

export function buildRearClip(recipe: CarRecipe, soups: ClipSoups, colors: ClipColors): void {
  const tail = recipe.stations[recipe.stations.length - 1];
  const knee = recipe.stations[recipe.stations.length - 2];
  const zTail = tail.z;

  /** z of the hatch face at height y — follows the knee→tail slant and just
   *  keeps extrapolating below the tail foot (dressing there sits a touch
   *  prouder of the vertical cap, like the real light's bottom bulge). */
  const hatchZ = (y: number): number => {
    const t = (knee.bodyY - y) / (knee.bodyY - tail.bodyY);
    return knee.z + (tail.z - knee.z) * t;
  };

  // ── taillights: tall tapered units flanking the hatch on the quarters ────
  if (recipe.parts.taillights === 'strip') {
    soups.tail.box(0, tail.bodyY - 0.07, zTail + 0.012, tail.halfW * 1.5, 0.05, 0.02, colors.tail);
  } else {
    const P = 0.018; // lens proud of the hatch face
    const D = 0.1; // extrusion depth back into the body
    for (const m of [-1, 1]) {
      // red lower lens: wide at the bumper, inner edge sweeping outboard
      const rB = -0.26, rT = 0.02;
      prism(
        soups.tail,
        [
          [m * 0.4, rB, hatchZ(rB) + P],
          [m * 0.74, rB, hatchZ(rB) + P],
          [m * 0.75, rT, hatchZ(rT) + P],
          [m * 0.5, rT, hatchZ(rT) + P],
        ],
        D,
        colors.tail,
      );
      // white upper segment tapering to a tip beside the hatch-glass corner
      const wB = rT, wT = 0.18;
      prism(
        soups.trim,
        [
          [m * 0.5, wB, hatchZ(wB) + P],
          [m * 0.75, wB, hatchZ(wB) + P],
          [m * 0.78, wT, hatchZ(wT) + P],
          [m * 0.62, wT, hatchZ(wT) + P],
        ],
        D,
        WHITE_SEG,
      );
    }
  }

  // ── garnish strip across the hatch under the window, between the lights ─
  prism(
    soups.trim,
    [
      [-0.58, 0.135, hatchZ(0.135) + 0.014],
      [0.58, 0.135, hatchZ(0.135) + 0.014],
      [0.58, 0.185, hatchZ(0.185) + 0.014],
      [-0.58, 0.185, hatchZ(0.185) + 0.014],
    ],
    0.06,
    GARNISH,
  );

  // ── license-plate recess: shallow dark inset centred on the hatch ───────
  prism(
    soups.trim,
    [
      [-0.27, -0.22, hatchZ(-0.22) + 0.008],
      [0.27, -0.22, hatchZ(-0.22) + 0.008],
      [0.27, -0.06, hatchZ(-0.06) + 0.008],
      [-0.27, -0.06, hatchZ(-0.06) + 0.008],
    ],
    0.06,
    PLATE_WELL,
  );
  prism(
    soups.trim,
    [
      [-0.22, -0.19, hatchZ(-0.19) + 0.016],
      [0.22, -0.19, hatchZ(-0.19) + 0.016],
      [0.22, -0.09, hatchZ(-0.09) + 0.016],
      [-0.22, -0.09, hatchZ(-0.09) + 0.016],
    ],
    0.06,
    PLATE,
  );

  // ── bumper: body slab + full-width dark lower insert (carve band) ───────
  const bumperSoup = recipe.parts.bumpers === 'painted' ? soups.paint : soups.trim;
  const bumperColor = recipe.parts.bumpers === 'painted' ? colors.paint : colors.trim;
  bumperSoup.box(0, -0.42, zTail + 0.02, 1.48, 0.2, 0.16, bumperColor);
  soups.trim.box(0, -0.555, zTail + 0.015, 1.4, 0.09, 0.13, INSERT);

  // ── exhaust tips under the bumper ────────────────────────────────────────
  for (let i = 0; i < recipe.parts.exhaust; i++) {
    const x = recipe.parts.exhaust === 1 ? -0.34 : (i === 0 ? -1 : 1) * 0.34;
    soups.trim.box(x, recipe.floorY + 0.05, zTail + 0.05, 0.09, 0.07, 0.16, EXHAUST);
  }
}
