import type { CarRecipe } from './recipe';

// ────────────────────────────────────────────────────────────────────────────
// The generated roster. All numbers are GROUP SPACE: origin at COM height
// (spec.rideHeight = 0.8 above ground for the sedan box), nose at -z,
// ground = -0.8, wheel centres at wheelY = -0.46. Dims stay inside the
// sedan crash box (1.9 × 1.35 × 4.6) the way the GLB wedge does — visually
// smaller is fine, the physics box is spec-sized either way.
// ────────────────────────────────────────────────────────────────────────────

/** METRO — the honest economy hatchback (slice 1's tracer bullet).
 *  Two-box silhouette: short nose, tall cabin, hatch tail. */
export const METRO: CarRecipe = {
  dims: { length: 4.15, width: 1.76 },
  floorY: -0.62,
  wheels: { zFront: -1.32, zRear: 1.3, archX: 0.76, style: 'steelie' },
  archR: 0.41,
  stations: [
    { z: -2.075, bodyY: -0.1, roofY: -0.1, halfW: 0.62 }, // nose face
    { z: -1.8, bodyY: -0.02, roofY: -0.02, halfW: 0.76 }, // hood front
    { z: -0.9, bodyY: 0.06, roofY: 0.06, halfW: 0.86 }, // hood mid
    { z: -0.45, bodyY: 0.1, roofY: 0.1, halfW: 0.88 }, // cowl (windshield base)
    { z: -0.02, bodyY: 0.12, roofY: 0.5, halfW: 0.88 }, // roof front
    { z: 0.85, bodyY: 0.12, roofY: 0.5, halfW: 0.87 }, // roof rear
    { z: 1.55, bodyY: 0.16, roofY: 0.3, halfW: 0.82 }, // backlight bottom
    { z: 2.075, bodyY: 0.24, roofY: 0.24, halfW: 0.7 }, // hatch face
  ],
  cabin: { z0: -0.45, z1: 1.55, beltY: 0.12, pillars: [0.42] },
  tumblehome: 0.13,
  parts: {
    grille: 'bar',
    headlights: 'pods',
    taillights: 'pods',
    bumpers: 'painted',
    exhaust: 1,
  },
  trimColor: 0x1b1e23,
};
