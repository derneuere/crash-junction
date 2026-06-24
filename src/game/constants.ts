// Global tunables. Per-vehicle numbers live in vehicles.ts (SPECS),
// level layout in levels/.

export const GRAVITY = -11.5;
export const FIXED_DT = 1 / 120; // physics step (s)

export const SLOWMO = 0.13; // crashtime timescale
export const SLOWMO_HOLD = 2.6; // seconds of real time held slow

export const LAUNCH_SPEED = 44; // regular-boost top speed (m/s) — the familiar
//                                 "fast"; the Burnout state goes faster still.
//                                 Kept high so designed ramp jumps still launch.
export const LAUNCH_ACCEL = 34;

// ---- speed tiers + boost economy (control.ts owns the mechanics) ----
// Burnout's core risk/reward: the engine alone only reaches a CRUISE ceiling;
// the top speed band is GATED behind boost, which you EARN by dangerous
// driving (drift/air/near-miss), B3-Revenge style — boost is the reward, not
// the default. CRUISE sits a clear step under LAUNCH_SPEED so flooring it the
// whole straight is visibly slower than a driver who earns and burns boost.
export const CRUISE_SPEED = 32; // engine-only top speed (m/s) — no boost; a
//                                 clear step under boosted speed (the gate)
// Burnout-3 segmented bar: one segment = one "unit" of boost, drained in
// BOOST_SEGMENT_SECS of burn. The bar starts at 1 segment and EXTENDS one
// segment per takedown (chained reward loop) up to BOOST_MAX_SEGMENTS — each
// takedown also instantly refills the whole, now-larger bar.
export const BOOST_SEGMENT_SECS = 2.0; // seconds of full burn per segment
export const BOOST_START_SEGMENTS = 1;
export const BOOST_MAX_SEGMENTS = 4; // B3's 1x→4x meter
// A full bar lets you tip into a sustained "Burnout": boost keeps burning at a
// stronger rate AND reaches a higher top speed than regular boost. Refilling
// the bar mid-Burnout (by keeping the dangerous driving up) chains another
// Burnout — the B3 loop. This is the genuine top of the speed ladder.
export const BURNOUT_SPEED = 48; // Burnout-state top speed (above LAUNCH_SPEED)

export const CRUSH_MAX = 0.55; // max vertex crumple depth (m)
// Panel-damage sensor scale (BP-style detach thresholds are tuned to it).
export const CRUSH_SCALE = 0.1;
// Visual vertex crumple per impact unit — half the sensor scale: at full
// scale a parking-speed tap already caved half the bodywork in. Hard
// crashes still reach CRUSH_MAX, it just takes real hits to get there.
export const CRUSH_VISUAL = 0.05;
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
// Upward-velocity ceiling for a LIVE car during any solver contact.
// Designed jumps ride the suspension ground-follow (live chassis are
// décor-filtered off the ramps entirely), so contact-equation lift is
// always an artifact: the per-step gain cap above still allows 120 m/s²,
// and a 48 m/s rammer used it to climb a rival's bodywork, then the
// wreck it became, then the wall top — 6 m over the barrier. Contact is
// a shunt or a scrape, not a ramp: same 1.5 the destabilized-slide rule
// uses. Crashed cars are exempt — flings belong to wrecks.
export const LIVE_CAR_CONTACT_VY = 1.5; // m/s
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

// A pileup launch can throw a live car clean over the barrier; it
// self-rights on the grass but the circuit is walled — there is no way
// back. After this long continuously off the track, the reset-pair
// respawn brings the player home.
export const OFF_TRACK_RESCUE_SECS = 5;

// ---- T-BONE takedown (collision.ts resolveRaceContact) ----
// The flank wreck the spec calls for: ram a rival in the SIDE, fast enough
// that it's a broadside kill rather than a nudge, and the rival is wrecked
// OUTRIGHT (no wall needed) — that's the piece that was missing. Gated on
// BOTH a speed floor and an angle window so an ordinary catch-up shunt or a
// door-to-door scrape never trips it.
//
// TBONE_MIN_CLOSING — how hard the rammer must be driving INTO the victim
// along the line between them (their velocity projected onto rammer→victim).
// Above the regular shunt floor (impact > 4) by a clear margin: below it the
// contact stays a shunt (destabilize, no outright wreck). A boosted car at
// 40+ m/s hitting square clears this easily; a 12 m/s catch-up tap does not,
// so it stays a shunt.
export const TBONE_MIN_CLOSING = 18; // m/s of closing along the contact line
// TBONE_MAX_ALIGN — the angle gate. cos(angle) between the rammer's heading
// and the victim's travel axis must be UNDER this for a broadside: |dot| ~1 is
// nose-to-tail / head-on (longitudinal), |dot| ~0 is dead abeam. cos 45° ≈
// 0.707, so |dot| < 0.707 ⇒ the impact angle is 45°…135° — the T-bone window.
// A near-parallel door-to-door (dot ≈ 1) and a head-on (dot ≈ -1) both fall
// outside it and stay shunts/scrapes, exactly as the fixtures require.
export const TBONE_MAX_ALIGN = 0.7;

// ---- airborne / jump attitude (BP AttribSys medians → CJ per-frame model) ----
// All derived from steward's sweep of 48 retail VEH_*_AT.BIN attribute vaults.
// BP runs a full rigid-body solver; CJ writes the body quaternion directly in
// control.ts, so these map BP's intent into CJ's `x += (target-x)*min(1,rate*dt)`
// easing. See docs/research/jump-physics.md.

// Sustained chase of the velocity vector (nose follows the trajectory in air).
// Invented rate — BP gets this from rigid-body dynamics, no single scalar to
// copy; ~0.3 s to take up the arc. PitchDampingOnTakeOff (median 0.9) sets the
// takeoff pose, this governs the in-flight follow.
export const AIR_PITCH_FOLLOW_RATE = 3.0; // 1/s

// In-air auto-level: roll eases back toward 0 so the car lands on its wheels.
// From BP's intent (RollDampingOnTakeOff median ~0.00125 kills launch roll, then
// active in-air correction holds level). ~0.45 s to level.
export const AIR_ROLL_CORRECTION = 2.2; // 1/s
// Dead-band before auto-level engages, so ramp-lip bank + float noise don't
// fight it. ~3.4°. Invented small threshold.
export const AIR_MIN_ROLL_TO_CORRECT = 0.06; // rad

// One-shot multipliers applied to angular velocity on the TAKEOFF frame (used
// verbatim — BP's *DampingOnTakeOff are dimensionless one-shot multipliers, no
// factor^dt conversion needed). Roll near-zero is what leaves the car COMPOSED.
export const TAKEOFF_PITCH_DAMP = 0.9; // from BP PitchDampingOnTakeOff median 0.9
export const TAKEOFF_YAW_DAMP = 0.04; // from BP YawDampingOnTakeOff median 0.04
export const TAKEOFF_ROLL_DAMP = 0.00125; // from BP RollDampingOnTakeOff median 0.00125

// Cap on the snapshot roll magnitude at takeoff (~46°). Read as a radian angle
// limit. from BP RollLimitOnTakeOff median 0.8
export const TAKEOFF_ROLL_LIMIT = 0.8; // rad

// General in-air spin bleed. BP InAirDamping is a CONSTANT 30 across all 48 cars
// on BP's internal angular scale — fed raw into min(1,rate*dt) it clamps every
// frame (30/120=0.25/frame, all spin gone in ~4 frames). Remapped to a sane CJ
// rate (~0.5 s decay). from BP InAirDamping (const 30, intent only)
export const AIR_DAMP = 2.0; // 1/s

// Clamp on nose-up "wheelie" pitch in air (~22°). BP clamps wheelie pitch; no
// single field, chosen for a believable air pose.
export const MAX_WHEELIE_ANGLE = 0.38; // rad

// Player steer maps to a small attitude TORQUE in air (a nudge, never a
// teleport). Invented — BP air control is faint and torque-based.
export const AIR_STEER_TORQUE = 0.9; // rad/s at full steer

// Landing settle: over this window the chassis blends to the road plane
// (replaces the old instant slope<0.02 re-pin). from BP TimeToDampAfterLanding
// median 0.1
export const LAND_SETTLE_SECS = 0.1; // s

// Fraction of incoming DOWNWARD vy absorbed across the settle (squash). Only
// while descending into contact; never adds upward velocity. from BP
// MaxVertVelocityDampingOnLanding median 0.1
export const LAND_VY_ABSORB = 0.1;

// Briefly soften steering after a hard landing so the player can't snap-turn
// out of the squash. Invented; BP softens steering post-landing.
export const LAND_STEER_SOFTEN_SECS = 0.25; // s
