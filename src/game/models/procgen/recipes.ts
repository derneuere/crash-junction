import type { CarRecipe } from './recipe';

/** Every generated car by id — the procshot tool's roster and, one entry at
 *  a time, the roster wiring in models/roster.ts. */
export const PROC_RECIPES: Record<string, CarRecipe> = {};

// ────────────────────────────────────────────────────────────────────────────
// The generated roster. All numbers are GROUP SPACE: origin at COM height
// (spec.rideHeight = 0.8 above ground for the sedan box), nose at -z,
// ground = -0.8, wheel centres at wheelY = -0.46. Dims stay inside the
// sedan crash box (1.9 × 1.35 × 4.6) the way the GLB wedge does — visually
// smaller is fine, the physics box is spec-sized either way.
// ────────────────────────────────────────────────────────────────────────────

/** METRO — the honest economy hatchback (slice 1's tracer bullet).
 *  Astra-H-style two-box: short nose, fast windshield flowing off the hood,
 *  roof peaking over the B-pillar, raked backlight, near-vertical hatch. */
export const METRO: CarRecipe = {
  dims: { length: 4.16, width: 1.76 },
  floorY: -0.64,
  wheels: { zFront: -1.32, zRear: 1.3, archX: 0.76, style: 'seven-spoke' },
  archR: 0.4,
  archBulge: 0.025,
  stations: [
    { z: -2.14, bodyY: -0.12, roofY: -0.12, halfW: 0.6 }, // nose face
    { z: -1.92, bodyY: -0.02, roofY: -0.02, halfW: 0.74 }, // hood leading edge
    { z: -0.95, bodyY: 0.06, roofY: 0.06, halfW: 0.86 }, // hood behind front arch
    { z: -0.62, bodyY: 0.09, roofY: 0.09, halfW: 0.88 }, // cowl / windshield base
    { z: -0.42, bodyY: 0.1, roofY: 0.216, halfW: 0.88 }, // windshield low (A-pillar edge)
    { z: 0.03, bodyY: 0.11, roofY: 0.5, halfW: 0.88 }, // windshield header
    { z: 0.45, bodyY: 0.12, roofY: 0.53, halfW: 0.88 }, // roof peak over B-pillar
    { z: 1.28, bodyY: 0.165, roofY: 0.475, halfW: 0.855 }, // roof rear
    { z: 1.42, bodyY: 0.17, roofY: 0.5, halfW: 0.845 }, // roof-lip spoiler
    { z: 1.8, bodyY: 0.2, roofY: 0.2, halfW: 0.79 }, // backlight bottom / hatch knee
    { z: 1.95, bodyY: -0.15, roofY: -0.15, halfW: 0.73 }, // hatch foot → bumper cap
  ],
  cabin: {
    z0: -0.5, z1: 1.74, beltY: 0.11, pillars: [0.45],
    // quarter glass ends at the z=1.42 station; the C-pillar panel kicks
    // outboard just aft of it and carries to the hatch knee
    cPillar: { z0: 1.45, z1: 1.82, kick: 0.055 },
  },
  tumblehome: 0.13,
  parts: {
    grille: 'bar',
    headlights: 'pods',
    taillights: 'pods',
    bumpers: 'painted',
    exhaust: 1,
  },
  trimColor: 0x1b1e23,
  antennaZ: 1.3,
};
PROC_RECIPES.metro = METRO;
