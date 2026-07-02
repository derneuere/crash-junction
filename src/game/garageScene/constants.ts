// ────────────────────────────────────────────────────────────────────────────
// GarageScene — a standalone, self-contained three.js parking garage for the
// car SELECT screen, styled after Burnout 3's garage. It is DELIBERATELY
// decoupled from the game sim: its own Scene + PerspectiveCamera +
// WebGLRenderer + rAF loop, no physics world, no RNG, no replay. Nothing here
// can perturb a pin — it never imports the Game, never touches simRand, and
// only READS the baked vehicle templates (getVehicleModel) produced at boot.
//
// The look: a dark concrete parking level. Every roster car is PARKED in its
// own painted bay along one wall — pillars between bays, hazard stripes on the
// wall, fluorescent fixtures overhead, a warm spotlight pool per bay. The
// camera holds a three-quarter-front framing on the selected car and GLIDES to
// the neighbouring bay when the player cycles (the B3 move); a slow idle sway
// keeps the shot alive without ever orbiting to the car's rear. The floor
// carries a faked planar reflection (a mirrored copy of each car under a
// translucent pane — far cheaper than a Reflector and no extra render target).
//
// CHEAP TO MOUNT: one cloned mesh set per roster car, a handful of boxes, a
// PMREM-free env. dispose() frees every GL resource and forces a context loss
// (the codebase leaks WebGL contexts otherwise).
// ────────────────────────────────────────────────────────────────────────────

import type { PlayerCarId } from '../models';

/** Default paint = the player's spawn red (level1/gantryPoint spawn colour),
 *  so an un-customised car shows the colour it will actually drive in. */
export const GARAGE_DEFAULT_COLOR = 0xe8352a;

/** Lineup paint per roster car — what each car wears while it is NOT the one
 *  being recoloured, so the parked row reads as four distinct machines
 *  (B3's garage is never four identical reds). Every value appears in
 *  CarSelect's swatch palette so the active swatch always matches. */
export const GARAGE_LINEUP_COLORS: Record<PlayerCarId, number> = {
  compact: GARAGE_DEFAULT_COLOR, // spawn red
  wedge: 0x2266dd, // electric blue
  vector: 0xf2b01e, // gold
  prowler: 0xe8e8ec, // pearl white — interceptor livery
};

export const FLOOR_Y = -0.02; // a hair below the wheels' contact line

// ── parking-bay layout: ANGLE parking. Each car sits at its bay centre,
// yawed nose-left toward the viewer (the B3 stance), painted stall lines
// parallel to the car. The camera stays nearly perpendicular to the row —
// an oblique camera at this radius would land INSIDE the neighbouring car.
export const BAY_SPACING = 3.9; // centre-to-centre, x axis
export const BAY_HALF_W = 1.7; // painted line offset from bay centre
export const CAR_YAW = Math.PI - 0.85; // π = nose at camera; -0.85 angles it screen-left, near 3/4
export const WALL_Z = -2.9; // back wall (angled rear corner reaches z ≈ -1.9)
export const CEILING_Y = 3.4;

// ── camera framing (three-quarter front via the parked yaw, car right of centre) ──
export const CAM_AZIMUTH = -0.1; // nearly square to the row; the yaw supplies the 3/4
export const CAM_RADIUS = 7.0; // distance that fits the 4.6 m sedan + air
export const CAM_HEIGHT = 1.7;
export const TARGET_Y = 0.5; // look at the car's waist
export const FRAME_SHIFT = 0.85; // world-units of view-left shift → car sits right of centre
export const SWAY_SPEED = 0.22; // rad/s of the idle sway oscillator
export const SWAY_AMOUNT = 0.03; // rad of azimuth wobble
export const GLIDE_RATE = 3.2; // 1/s — exp-damp rate of the bay-to-bay glide
