import * as CANNON from 'cannon-es';
import {
  BOOST_SEGMENT_SECS,
  BOOST_START_SEGMENTS,
  BURNOUT_SPEED,
  CRUISE_SPEED,
  LAUNCH_SPEED,
} from '../constants';

export const UP_AXIS = new CANNON.Vec3(0, 1, 0);
export const X_AXIS = new CANNON.Vec3(1, 0, 0);
export const Z_AXIS = new CANNON.Vec3(0, 0, 1);
export const _up = new CANNON.Vec3();
export const _qTilt = new CANNON.Quaternion();
// Scratch target for the landing settle: the road-plane pose case 1 would snap
// to, blended into over LAND_SETTLE_SECS instead of an instant re-pin.
export const _qLand = new CANNON.Quaternion();
// Scratch target for the airborne attitude (case 3): yaw=heading, pitch chases
// the trajectory, roll auto-levels. Written straight onto the body each air
// frame, the same kinematic-orientation idiom the on-ground pin (case 1) uses.
export const _qAir = new CANNON.Quaternion();

// Arcade driving grounded in Burnout Paradise's AttribSys handling data
// (steward's attribsys-ranges sweep of 48 retail vehicle vaults):
//  - steering lock 15° → 2° between 13.4 and 54 m/s (MaxAngle/MinAngle at
//    SpeedForMaxAngle/SpeedForMinAngle), 0.4 s ramp to lock (TimeForLock),
//    centering ~2.5× faster (StraightReactionBias)
//  - tap-to-drift: brake input while steering above ~18 m/s
//    (MinSpeedForDrift 40 mph; BrakingDriftScaleFactor dominates the drift
//    initiators). Once sliding, STEERING SETS THE SLIP ANGLE — the loop the
//    burnout wiki documents for BP itself: steer into the slide to deepen
//    the angle, tap the brake to tighten it further, straighten out and the
//    drift ends. Slip chases its target over ~0.35 s
//    (ForcedDriftTimeToReachBaseSlip), capped at 60° (DriftMaxAngle modal
//    value); countersteer unwinds it ×1.8 faster
//    (CounterSteeringDriftScaleFactor) and held past centre swings the tail
//    out the other way (drift chaining, no new tap); easing off starts the
//    straighten immediately (NeutralTimeToReduceDrift = 0)
//  - boost: +8 m/s² sustained (BoostAcceleration mean), an initial kick of
//    +15 m/s² for up to 0.75 s below ~42 m/s (BoostKickAcceleration /
//    BoostKickMinTime / BoostKickMaxStartSpeed), and a raised top speed
//    (MaxBoostSpeed sits ~+20 mph over MaxSpeed). Refill-from-drift/airtime
//    rates are invented — BP keeps earn rules in code (Stunt-type behavior).
//
// BOOST ECONOMY (Burnout 3 / Revenge "aggressive boost", modelled here):
//  - The engine ALONE tops out at CRUISE_SPEED; the top-speed band is gated
//    behind boost, so boost is the reward, not the default route to fast.
//  - The bar is EARNED by dangerous driving: drifting (deeper = faster),
//    airtime, and near-misses/oncoming traffic (Game feeds nearMiss()). It is
//    NOT free — it starts empty-ish and you spend it down while burning.
//  - The bar is segmented (B3's 1x→4x). Each TAKEDOWN extends it one segment
//    AND instantly refills the whole bar (addSegment(); the chained reward
//    loop). Crashing resets it to one segment.
//  - A FULL bar lets you tip into a sustained "Burnout": boost burns stronger
//    and reaches BURNOUT_SPEED. Refilling to full again mid-Burnout (keeping
//    the dangerous driving up) CHAINS another Burnout — the B3 loop.

// locks run ×1.5 over the BP-derived values (10°/1.6°) — hands-on verdict:
// authentic locks made ramming at speed nearly impossible on these tight maps
export const STEER_LOCK_LOW = (22.5 * Math.PI) / 180;
export const STEER_LOCK_HIGH = (3.6 * Math.PI) / 180;
export const STEER_FULL_BELOW = 13.4; // m/s (30 mph)
export const STEER_MIN_AT = 38; // m/s — lock fades fast: gripped steering is for
//                          ramming and lane changes, corners want the drift
//                          (BP SpeedForMinAngle is 90+ mph; ours is tighter
//                          because the map is tiny)
export const STEER_RAMP = 1 / 0.4; // full lock in 0.4 s
// VISUAL-ONLY gain on the front-wheel render angle (steerAngle), read by
// Game.updateWheels — NOT the handling lock. The physics lock above is tuned
// for ramming feel, but at that angle the cranked wheels barely read from the
// chase cam; exaggerating the rendered turn (≈40° at full low-speed lock) makes
// the steer obvious without touching handling. Pure presentation → replay-safe.
export const VISUAL_STEER_GAIN = 1.8;
export const CENTER_BIAS = 2.5;
export const WHEELBASE = 2.95;

export const DRIFT_MIN_SPEED = 18; // m/s (40 mph)
// 40°, down from BP's 60° modal DriftMaxAngle — at 60° the car travels so
// far sideways that every walled sweeper ends in the barrier
export const DRIFT_MAX_SLIP = (40 * Math.PI) / 180;
export const DRIFT_EXIT_SLIP = (7 * Math.PI) / 180; // straightened out → tyres hook up
export const DRIFT_ENTRY_TIME = 0.3; // s to reach base slip
export const DRIFT_RECOVER_TIME = 0.55; // s back to full grip — BP hooks up fast
//                                  (NeutralTimeToReduceDrift = 0 on all 48 cars)
export const GRIP_CHASE = 6.5; // gripped: velocity dir chases heading (1/s) — a few °
//                         of working slip in every corner reads as mass
export const DRIFT_CHASE = 2.4; // recovering from a slide: it lags behind (1/s)
export const DRIFT_DEEPEN = 1 / 0.45; // slip chases a deeper angle at this rate (1/s)
//                               (eased off 0.35 s — the angle slammed in)
export const DRIFT_RELAX = 1 / 0.28; // straightening is brisker than deepening —
//                               the community-felt "instant hook-up"
export const DRIFT_CARVE = 1.6; // path bend per rad of slip (1/s) — a deeper drift
//                          IS a tighter corner; that's what the angle is for
export const DRIFT_TIGHTEN = (10 * Math.PI) / 180; // mid-drift brake tap digs in deeper
export const COUNTERSTEER = 1.8;
export const DRIFT_SCRUB = 3.5; // m/s² speed bleed at full slip (shallow scrubs less)

// weight feel (invented — BP gets this from real rigid-body dynamics):
export const YAW_RESPONSE = 0.24; // s for the chassis to take up a yaw command
export const ROLL_PER_LATG = 0.0033; // body roll vs lateral accel (rad per m/s²·v)
export const ROLL_MAX = 0.09; // ~5°
export const PITCH_PER_ACCEL = 0.0045; // squat/dive vs longitudinal accel
export const PITCH_MIN = -0.05; // brake dive ~3°
export const PITCH_MAX = 0.035; // boost squat ~2°

// Three speed tiers (Burnout risk/reward): engine-only CRUISE, regular boost
// to BOOST_TOP, and the full-bar "Burnout" to BURNOUT_SPEED (the reward
// ceiling). CRUISE sits a clear step below boosted speed so the engine alone
// never feels as fast as earning + burning boost.
export const TOP_CRUISE = CRUISE_SPEED; // engine-only ceiling (31)
export const BOOST_TOP = LAUNCH_SPEED; // regular-boost ceiling (39 — the familiar fast)
export const BURNOUT_TOP = BURNOUT_SPEED; // sustained-Burnout ceiling (44 — the reward)
export const TOP_HARD = 48; // absolute speed clamp (e.g. downhill carry)

// gears: BP runs up to 6 ratios (GearRatios1/2 vec slots) shifting up at
// 4500–7900 RPM. GearChangeTime is 0 in every retail vault — the felt
// "step" comes from torque×ratio dropping at each shift — but we keep a
// tiny torque gap so the steps read on a keyboard. The top gears are the
// boost band (MaxBoostSpeed sits over MaxSpeed; the engine alone tops out
// in gear 5 at CRUISE).
export const GEAR_TOPS = [7, 13, 21, 29, TOP_CRUISE, BURNOUT_TOP]; // m/s ceiling per gear
export const GEAR_ACCEL = [23, 20.5, 17.5, 15, 13, 10.5]; // m/s² of engine shove per gear
export const SHIFT_CUT = 0.12; // s of torque gap on an upshift

export const BOOST_ACCEL = 8; // regular-boost sustained accel
export const BURNOUT_ACCEL = 11; // Burnout-state accel — markedly stronger
export const KICK_ACCEL = 15;
export const KICK_TIME = 0.75;
export const KICK_BELOW = 42;
// ---- boost-kick wheelie (the boost-kick is a wheelie
// generator that self-limits past a max angle; 2.0s cooldown). The kick FORCE
// itself is the KICK_ACCEL add already in the speed economy; these tune the
// nose-up POSE the kick produces. ----
export const KICK_COOLDOWN = 2.0; // s min gap since last boost-kick
export const WHEELIE_RISE = 1 / 0.18; // 1/s — cosmetic nose-up ramps in fast on the kick
export const WHEELIE_DECAY = 1 / 0.3; // 1/s — eases back down after the kick window
export const WHEELIE_PITCH_MAX = 0.22; // rad (~13°) cosmetic grounded nose-up self-limit
export const WHEELIE_AIR_SEED = 0.3; // rad — physical air-pitch seed if we launch mid-kick (< MAX_WHEELIE_ANGLE 0.38)
export const BRAKE_DECEL = 26;
export const COAST_DRAG = 4.5; // m/s² rolloff with no throttle

// ---- reverse (arcade brake-is-reverse) -------------------------------------
// There is no separate reverse key: holding the brake once the car has braked
// to a near-stop drives it backward at a limited speed (Burnout Paradise does
// exactly this). The engine/boost economy is forward-only — updateSpeed clamps
// speed ≥ 0 — so reverse can't come from there; the grounded drive path applies
// it as a modest negative drive force, cut once the reverse-speed cap is
// reached so it settles at a steady crawl.
export const REVERSE_ACCEL = 6; // m/s² backward push while reversing
export const REVERSE_MAX_SPEED = 8; // m/s cap on reverse speed (~29 km/h)
export const REVERSE_ENGAGE_BELOW = 0.8; // engage once forward speed drops below this (m/s)

// ---- boost economy (earned + segmented; see header) ----
// One full segment is BOOST_SEGMENT_SECS of burn; the bar holds `segments` of
// them. BOOST_CAP is kept as the *starting* capacity (one segment) so callers
// that imported it as the fraction reference still read a sane base.
export const BOOST_CAP = BOOST_SEGMENT_SECS * BOOST_START_SEGMENTS;
export const REFILL_DRIFT = 0.55; // per s while drifting at full slip (deeper = faster)
export const REFILL_AIR = 0.7; // per s airborne
export const REFILL_NEARMISS = 0.45; // per near-miss/oncoming event (Game feeds it)
export const BURNOUT_ENTER = 0.999; // bar fraction that arms the sustained Burnout

// ---- Feature C: tire grip curve (guarded modulation) -----------------------
// CJ's player is kinematic (scalar speed/heading written to the body); the spec
// is explicit that we do NOT rip that out. Instead the Pacejka-like lateral grip
// curve (grip.ts) MODULATES the existing yaw/slip rates — a deeper lateral slip
// past the curve's peak develops LESS grip, so the velocity vector hooks the
// nose less and the rear steps out, exactly the "break-loose" feel. The blend
// scalar is how much the curve's verdict bends the stock rate:
//   modulated = stock · (1 + GRIP_CURVE_BLEND · (coeff − refCoeff))
// At GRIP_CURVE_BLEND = 0 this is a pure no-op (= today's behaviour). The sedan
// default is small so its feel is preserved; raise per variant for more
// breakaway character (bus/tanker lean on it harder via their lower grip
// coefficients). Reversible to zero, per the guard rails.
export const GRIP_CURVE_BLEND = 0.35; // 0 = stock; how hard the lat curve bends yaw/chase
// Reference coefficient the modulation is measured AGAINST: at peak grip
// (coeff ≈ refCoeff) the rate is unchanged, only the FALL past peak loosens it.
// Tracks the median peak so a curve sitting at its peak is a no-op.
export const GRIP_REF_COEFF = 1.0;
// Floor on the grip multiplier so a fully-slid tyre still bites a little (a 0
// would freeze the kinematic chase entirely and feel dead).
export const GRIP_MOD_FLOOR = 0.45;

// ---- Feature D: drift finite-state machine (scripted, gated forces) ---------
// The boolean `drifting` is hardened to a tri-state FSM (NONE/LEFT/RIGHT, see
// driving.ts DriftState). EnterDrift latches the direction from the SIGN of the
// steering input; that sign then signs every drift force. Each scripted force is
// gated behind its own strength scalar so it can be dialled to zero (= the old
// pure slip-chase). Defaults are tuned so the sedan's slip-chase feel is largely
// preserved — the forces are a thin garnish on top, not a replacement — while
// the heavier variants (which read bigger BP sideForce/naturalYawTorque numbers)
// get a more pronounced step-out and self-align.
//
// MaintainDriftSpeed: anti-scrub impulse along the velocity blend so a slide
// doesn't bleed all its speed (BP MaintainDriftSpeed, findings §8). As a CJ
// kinematic nudge: top the drift speed back up toward a maintained target at
// this fraction of the deficit per second, gated on throttle.
export const DRIFT_MAINTAIN_STRENGTH = 1.0; // 0 = no anti-scrub (raw scrub only); gated on input.throttle
// DriftScale/Yaw: self-aligning yaw via the per-variant naturalYawTorque,
// remapped from BP's torque (thousands, on its internal inertia scale) into a CJ
// yaw-rate nudge by dividing by this reference. Heavier variants carry a bigger
// torque AND a bigger reference, so the felt self-align scales gently.
export const DRIFT_YAW_TORQUE_REF = 9000; // BP NaturalYawTorque → CJ yaw-rate divisor
export const DRIFT_YAW_STRENGTH = 0.6; // 0 = no self-align; scales the yaw nudge
// DriftLatForce: the sideways step-out, shaped by the Feature-C DRIFT lateral
// curve and signed by the latched drift direction. BP SideForceMagnitude
// (15/27/35) is remapped to a CJ slip-rate add by dividing by this reference.
export const DRIFT_LAT_FORCE_REF = 40; // BP SideForceMagnitude → CJ slip-rate divisor
export const DRIFT_LAT_STRENGTH = 0.5; // 0 = no scripted step-out (slip-chase only)
// drift.angularDamping bleed: extra spin damp while drifting (BP
// DriftAngularDamping 0.05–0.2), applied as a per-second decay on the slip-chase
// overspeed. Gated by this scalar.
export const DRIFT_ANGDAMP_STRENGTH = 1.0; // 0 = no extra spin bleed

// ---- steering input shaping (BP ModifyControlsForSteeringWheelInput) --------
// BP applies a quartic stiffening to the raw stick: soft centre, sharp extreme
// (`−1.0 − sign·(s⁴·1.25)`, findings §8). On a keyboard the steer input is
// already ±1 binary, but analog pads / the AI feed continuous values, and the
// quartic gives the sedan a calmer centre without losing full lock. Blend keeps
// the sedan close to linear (the proven feel) while letting heavier variants use
// more of the soft centre. STEER_SHAPE_BLEND = 0 ⇒ pure linear (= today).
export const STEER_SHAPE_BLEND = 0.2; // 0 = linear input; 1 = full BP quartic
export const STEER_SHAPE_EXP = 4; // BP uses s⁴ (quartic)

// ---- slope-following chassis tilt ------------------------------------------
// Post-world.step fixup (orientation.ts pinChassisSlope) slerps the GROUNDED
// chassis roll+pitch toward the resampled contact-plane normal, keeping the
// emergent yaw and never unlocking angularFactor. Per-frame slerp fraction kept
// low (the roadmap's corrected ~0.05, not 0.25) so a sharp kerb lip can't set up
// a resample limit-cycle — the low-pass + the gates below damp the feedback.
export const SLOPE_FOLLOW_RATE = 0.05; // chassis→slope slerp per frame
export const SLOPE_MIN_GROUNDED = 3; // need ≥3 grounded corners to fit a plane
export const SLOPE_MIN_NY = 0.5; // floor on the fitted normal's world-y (skip too-steep/degenerate fits)
export const SLOPE_MIN_UP_Y = 0.5; // chassis-up.y below this = tipped/on its side → skip (matches the playerControl tipped gate)

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** BP quartic steering shaping: soft centre, sharp extreme. Blends between the
 *  raw linear input (blend 0) and `sign·|x|^EXP` (blend 1). Sign-preserving and
 *  monotone, so it never reverses or saturates beyond ±1. */
export const shapeSteer = (x: number, blend: number): number => {
  const a = Math.abs(x);
  const shaped = Math.sign(x) * Math.pow(a, STEER_SHAPE_EXP);
  return x + (shaped - x) * blend;
};
