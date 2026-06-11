// Global tunables. Per-vehicle numbers live in vehicles.ts (SPECS),
// level layout in levels/.

export const GRAVITY = -11.5;
export const FIXED_DT = 1 / 120; // physics step (s)

export const SLOWMO = 0.13; // crashtime timescale
export const SLOWMO_HOLD = 2.6; // seconds of real time held slow

export const LAUNCH_SPEED = 39; // player top speed (m/s)
export const LAUNCH_ACCEL = 34;

export const CRUSH_MAX = 0.55; // max vertex crumple depth (m)
export const CRUSH_SCALE = 0.1; // crumple amount per impact unit
export const AFTERTOUCH_F = 9000; // aftertouch force (N) — sized to the 1.45 t sedan

// ---- suspension + downforce (see suspension.ts) ----
// Arcade-standard model: the chassis box never touches the road while
// driving — four spring-damper "wheel rays" hold it at ride height,
// and speed² aero downforce presses it on. Box contact only matters
// in crashes (flips, landings, riding over wrecks).
export const SUSP_SAG = 0.055; // compression that doubles spring force
export const SUSP_ZETA = 0.6; // damping ratio (1 = critical)
export const SUSP_DROOP = 0.18; // wheel reach below ride height before airborne (m)
export const SUSP_MAX_COMP = 0.12;
export const DOWNFORCE = 0.009; // down-accel per (m/s)²
// Downforce squat compresses the springs by CAP × SUSP_SAG metres. That must
// stay under the chassis box's ground clearance (sedan: rideHeight 0.8 −
// halfY 0.72 = 0.08 m) or the box scrapes the physical ground plane at top
// speed — which, with the controller force-restoring horizontal velocity,
// pole-vaults the car off its own corner (the boost-jump bug). 1.5 × 0.055
// = 0.0825 m was past the clearance; 1.0 leaves ~2 cm even with the ζ=0.6
// rebound overshoot. Downforce never feeds the handling model, so this only
// changes squat depth, not grip.
export const DOWNFORCE_CAP = 1.0; // downforce ceiling (g)
// A driven (un-wrecked) chassis may gain at most this much upward velocity
// per physics step. Suspension at full clamp adds ≤ ~0.4 m/s per step and
// explosions write velocity before the step, so both pass through — only
// solver catapults from chassis-box/ground contacts get eaten (hard landings
// would otherwise relaunch off the box corner; see the boost-jump fixture).
export const LIVE_VY_GAIN_PER_STEP = 1.0; // m/s per fixed step
// Ceiling on the vy the kinematic ground-follow hands a car riding a rising
// height field. The per-surface √(4·g·height) bound is what keeps kerbs and
// ramp side-skirts (which read as 30+ m/s rises when crossed at speed) down
// to blips; this is the absolute roof — the proving-ground test ramps top
// out at √(4·11.5·2.8) ≈ 11.3.
export const RAMP_LAUNCH_VY_MAX = 12; // m/s
export const WRECK_GRIP = 0.85; // Coulomb friction of wrecks rolling on suspension

// ---- explosions ----
export const EXPLOSION_RADIUS_BASE = 9; // m
export const EXPLOSION_RADIUS_PER_POWER = 5; // m per power unit
export const EXPLOSION_KICK = 6.5; // Δv (m/s) at ground zero per power unit (and base)
export const EXPLOSION_MASS_REF = 1700; // kg that takes the full kick — heavier bodies loft less
// Crashbreaker is EARNED, Burnout-3 style: wrecking vehicles fills the
// meter; full meter → press E → detonate → meter resets (rechargeable).
export const CB_PER_WRECK = 0.34; // 3 wrecks = one detonation
export const CRASHBREAKER_POWER = 1.9;

// Seconds of wall-wreck immunity the player earns from a takedown. Wall
// takedowns by nature happen AGAINST a wall the player is also hugging —
// often mid-sweeper, with the takedown cam's autopilot holding the wheel —
// so without grace the reward is routinely followed by the player's own
// wreck ~0.4 s later. During grace, would-be wall wrecks downgrade to
// glances (speed still scrubs) and the victim's debris can't destabilize.
// Sized to outlast the 1.7 s camera beat.
export const TAKEDOWN_WALL_GRACE = 2.0;
