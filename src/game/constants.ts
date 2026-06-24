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

// ---- car-on-car shunt (Game.ts onCollide; Burnout-style ram impulse) ----
// The ram's kick is no longer a flat velocity blend — it's a contact-normal
// impulse fired through body.applyImpulse(J, r), so it couples linear AND
// angular: a square rear-end punts the victim straight, a flank/off-centre hit
// puts a torque through the tail and the car SPINS OUT. The launch direction is
// purely the contact normal (no heuristic rammer→victim blend); collision.ts's
// shoveOther/shoveSelf become the impulse-magnitude scalar (in m/s of intended
// closing-speed transfer), fed into the formula below rather than added raw.
//
// SHUNT_KICK_GAIN — how much of the (scaled) shove scalar becomes impulse, as a
// multiple of the victim's momentum-equivalent (J = gain · shove · m_victim,
// then mass-ratio-trimmed). 1.0 ≈ "shove scalar is the Δv a same-mass victim
// gets head-on"; the mass-ratio term then launches a light car harder and a bus
// barely at all.
export const SHUNT_KICK_GAIN = 1.0;
// SHUNT_MASS_RATIO_CLAMP — the lighter-victim-launches-more term is
// m_rammer/(m_rammer+m_victim) (a momentum split), clamped to this ceiling so a
// 15 t tanker shunting a 1.45 t sedan can't fling it at ~10× the closing speed.
export const SHUNT_MASS_RATIO_CLAMP = 1.8;
// SHUNT_YAW_MAX — ceiling on the imparted spin (|angularVelocity.y|, rad/s)
// after the impulse so an off-centre boost-ram spins the victim out without
// turning it into a helicopter. angularDamping (0.3) bleeds it off naturally.
export const SHUNT_YAW_MAX = 6;
// SHUNT_KICK_SPEED_GATE — closing speed (m/s along the normal) below which the
// kick fades toward zero, like Burnout's speed-gated shunt: a slow
// love-tap barely nudges, a boost-ram launches. Linear ramp from 0 at no
// closing to full at this speed and above.
export const SHUNT_KICK_SPEED_GATE = 10;
// SHUNT_BOUNCE_BOOST — Burnout's "bounce-boost": when the player/aggressor WINS
// a shunt they keep barging through instead of bleeding speed off the (now much
// less bouncy) contact. A small forward impulse along the rammer's heading,
// scaled by the same shove scalar, so repeats power through rather than stall.
export const SHUNT_BOUNCE_BOOST = 0.35;
// SHUNT_GOOD_IMPACT_VAR — seeded ± variation on the kick magnitude (Burnout's
// "good impact" wobble) so back-to-back shunts never feel identical.
// Drawn from the sim RNG (deterministic; fixtures re-record).
export const SHUNT_GOOD_IMPACT_VAR = 0.12;

// ---- recoverable destabilize gradient (Phase 4) ----
// Burnout doesn't snap a car out of shunt mode; control comes back gradually
// and the car carries a continuous "how close to wrecked" fragility (Road
// Rage style), so a car can RECOVER, or a second contact while it's already
// sliding can tip it into a WRECK. Modelled here as a 0..1 `howCloseToWrecked`
// accumulator on the Actor.
//
// SHUNT_FRAGILITY_GAIN — how much one shunt raises `howCloseToWrecked`, scaled
// by closing impact over the gate speed (so a tap barely registers, a boost-ram
// loads it up). Kept modest: a single clean shunt lands well under WRECK so the
// victim mostly recovers — the accumulator only matters when contacts STACK.
export const SHUNT_FRAGILITY_GAIN = 0.4;
// SHUNT_FRAGILITY_DECAY — per-second bleed-off of `howCloseToWrecked` while the
// car is recovering (in shunt mode but not taking fresh hits). Tuned so a lone
// shunt's load (GAIN ≈ 0.4) is fully shed in ~0.9 s — well inside even the
// longest 2.2 s slide, so recovery is the default — while still leaving a brief
// (~0.5 s) window where a second hard hit STACKS over SHUNT_WRECK_THRESHOLD and
// tips the car over. Tipping is the exception, not the rule.
export const SHUNT_FRAGILITY_DECAY = 0.45;
// SHUNT_WRECK_THRESHOLD — `howCloseToWrecked` at or above which a FURTHER hard
// contact while already destabilized tips the car over into a wreck instead of
// just re-sliding it. A first shunt loads less than this (see GAIN), so it takes
// a second hard hit landing before recovery to cross it — "shunted, then
// shunted again before you caught it" is the wreck, a single shunt is not.
export const SHUNT_WRECK_THRESHOLD = 0.55;
// SHUNT_FRAGILE_WALL_RELIEF — how much a full `howCloseToWrecked` lowers the
// wall-wreck closing-speed bar for an already-destabilized car (collision.ts
// wall path). Smoothly extends the existing wall-while-sliding wreck: the more
// loaded up the slide is, the gentler the barrier touch that finishes it.
export const SHUNT_FRAGILE_WALL_RELIEF = 1.5; // m/s off the closing bar at load 1

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

// ---- wheel render visuals (presentation only; the fixed-step sim never reads
// these). BP advances each wheel by its OWN angular velocity (Wheel::UpdateRotation),
// so the rendered roll diverges from ground speed under traction loss: rear-drive
// launch wheelspin and brake lockup. ----
// Forward speed by which launch wheelspin has faded back to plain rolling.
export const WHEELSPIN_FADE_SPEED = 16; // m/s
// Extra rear-ω multiplier at a standstill launch: ω = roll·(1 + this·launch).
export const WHEELSPIN_OVERSPIN = 2.6;
// Visual spin floor (rad/s) so the rears still scream from a DEAD stop, where
// ground speed — and thus the multiplicative overspin term — is ~0.
export const WHEELSPIN_FLOOR = 40; // rad/s
// Roll multiplier under braking — wheels near-lock (not a hard 0; a touch creeps).
export const BRAKE_LOCKUP_FACTOR = 0.06;
