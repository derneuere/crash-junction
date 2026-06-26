// ────────────────────────────────────────────────────────────────────────────
// GarageScene — a standalone, self-contained three.js showroom for the car
// SELECT screen (the menu's "garage"). It is DELIBERATELY decoupled from the
// game sim: its own Scene + PerspectiveCamera + WebGLRenderer + rAF loop, no
// physics world, no RNG, no replay. Nothing here can perturb a pin — it never
// imports the Game, never touches simRand, and only READS the baked vehicle
// templates (getVehicleModel) which are produced once at boot.
//
// The look: a moody concrete bunker. Dark polished floor with a faked planar
// reflection (a mirrored copy of the car under a translucent floor pane — far
// cheaper than a real reflector and no extra render target), a few columns and
// a back wall to give the space depth, and a three-point rig (warm key, cool
// rim, soft fill) plus a dramatic overhead spotlight cone on the turntable.
// The car sits on a low turntable and the CAMERA slowly ORBITS it (the car
// itself does not spin — orbiting the camera keeps the key light raking the
// same flank, which reads more cinematic). One soft blob ground-shadow under
// the car; no shadow maps, no post.
//
// CHEAP TO MOUNT: one car mesh (cloned from the bake), a handful of boxes, a
// PMREM-free env. dispose() frees every GL resource and forces a context loss
// (the codebase leaks WebGL contexts otherwise).
// ────────────────────────────────────────────────────────────────────────────

/** Default paint = the player's spawn red (level1/gantryPoint spawn colour),
 *  so an un-customised car shows the colour it will actually drive in. */
export const GARAGE_DEFAULT_COLOR = 0xe8352a;

export const FLOOR_Y = -0.02; // a hair below the wheels' contact line
export const ORBIT_RADIUS = 6.4;
export const ORBIT_HEIGHT = 2.35;
export const ORBIT_SPEED = 0.16; // rad/s — a slow cinematic sweep
export const TARGET_Y = 0.55; // look a touch above the floor (at the car's waist)
