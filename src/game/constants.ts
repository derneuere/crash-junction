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
export const DOWNFORCE_CAP = 1.5; // downforce ceiling (g)
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
