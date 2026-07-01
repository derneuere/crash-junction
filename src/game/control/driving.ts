import * as CANNON from 'cannon-es';
import {
  AIR_PITCH_FOLLOW,
  AIR_PITCH_KD,
  AIR_PITCH_KP,
  AIR_ROLL_KD,
  AIR_ROLL_KP,
  AIR_YAW_FOLLOW,
  AIR_YAW_RATE,
  FIXED_DT,
  HARD_LAND_MIN_AIR,
  HARD_LAND_MIN_VY,
  HARD_LAND_SETTLE_SECS,
  HARD_LAND_YAW_DAMP,
  MAX_WHEELIE_ANGLE,
  TAKEOFF_KEEP_PITCH,
  TAKEOFF_KEEP_ROLL,
  TAKEOFF_KEEP_YAW,
} from '../constants';
import type { Actor } from '../types';
import type { HeightSampler } from '../suspension';
import type { HandlingAttribs } from '../handling';
import type { ControlInput } from './input';
import { latGripCurve, driftLatGripCurve, longGripCurve } from '../grip';
import { tireForce, type TireParams } from '../tireForce';
import { updateSpeed } from './speed';
import {
  BOOST_ACCEL,
  BURNOUT_ACCEL,
  KICK_ACCEL,
  KICK_BELOW,
  KICK_COOLDOWN,
  WHEELIE_RISE,
  WHEELIE_DECAY,
  WHEELIE_PITCH_MAX,
  WHEELIE_AIR_SEED,
  CENTER_BIAS,
  REFILL_AIR,
  REFILL_DRIFT,
  PITCH_MAX,
  PITCH_MIN,
  PITCH_PER_ACCEL,
  REVERSE_ACCEL,
  REVERSE_ENGAGE_BELOW,
  REVERSE_MAX_SPEED,
  ROLL_MAX,
  ROLL_PER_LATG,
  STEER_FULL_BELOW,
  STEER_LOCK_HIGH,
  STEER_LOCK_LOW,
  STEER_MIN_AT,
  STEER_RAMP,
  STEER_SHAPE_BLEND,
  VISUAL_STEER_GAIN,
  clamp,
  shapeSteer,
  wrapAngle,
} from './constants';

/**
 * THE FORCE-BASED DRIVING STEP (Burnout-faithful rewrite —
 * . Replaces the old kinematic
 * model: instead of computing heading/velAngle/speed by hand and OVERWRITING
 * `body.velocity` + `body.quaternion`, this banks real forces and lets cannon
 * integrate the full 6-DOF rigid body. Yaw, slide and spin-out EMERGE from the
 * off-centre tire forces (`r × F`); the body's actual orientation IS the car's
 * orientation when grounded (no pin). heading/velAngle/speed/yawVel are now
 * DERIVED from the body each frame for the camera, wheels, AI and HUD.
 *
 * P1 scope: grounded driving is fully force-based (engine drive + the
 * weight-loaded tire friction ellipse + steering + a basic drift). Airborne
 * still uses the kinematic air-attitude pin (orientation.ts) — ported to
 * torques in a later phase. The boost economy, gearbox, drift FSM and per-
 * variant attribs vault are reused unchanged; only the integration changed.
 */

// ---- force-model tuning (global for P1; per-variant later) -------------------
/** Lateral friction-ellipse coefficient: how hard the car corners before the
 *  grip curve breaks it loose. Scaled per corner by the spring's normal load.
 *  Kept moderate so peak cornering load stays within the suspension's capacity
 *  (too high → a corner spring spikes to fmax and launches the car). */
const LAT_MU = 1.7;
/** Longitudinal friction-ellipse coefficient: generous so CJ's tuned per-gear
 *  arcade acceleration survives; it only gates drive once cornering eats grip. */
const LONG_MU = 3.2;
/** Rear lateral-grip multiplier while drifting — the rear lets go so the tail
 *  steps out (the dedicated drift curve does the rest). */
const DRIFT_REAR_GRIP = 0.6;
/** Vertical fraction of ride height at which tire forces are applied below the
 *  COM. Full contact depth (1.0) is physically correct but levers a tall roll
 *  moment that lifts the inner wheels and rolls an arcade car onto its side at
 *  speed; the YAW (the emergent part we want) comes from the horizontal ax/az
 *  lever and is unaffected by this. So we apply tire force near COM height —
 *  cornering makes yaw, not rollover — and leave body lean to the suspension's
 *  weight transfer. Raise (toward 1.0, with real anti-roll) for more sim feel.
 *  0 = forces at COM height → pure yaw, zero roll moment → the car can corner at
 *  2g+ without ever rolling onto its side (the arcade/Burnout choice). */
const CONTACT_Y_FRAC = 0;
/** Drift yaw PD (Burnout's drift-angle + drift-yaw model): rotate the nose to a
 *  TARGET slip angle so a drift HOLDS at a controllable angle instead of
 *  spinning. KP drives slip→target, KD damps the yaw rate (the slide settles,
 *  doesn't run away). Both scaled per variant by drift.naturalYawTorque/7000.
 *  Yaw-only, so the grounded angularFactor lock is honored. N·m. */
const DRIFT_YAW_KP = 55000;
const DRIFT_YAW_KD = 16000;
/** Faint forward thrust kept while airborne so boost/throttle still reads in a
 *  jump (no traction up there). Fraction of the grounded drive force. */
const AIR_THRUST_FRAC = 0.35;
/** High-speed yaw stability (Burnout's high-speed angular damping). The tire
 *  grip curve breaks loose at a low slip angle (~7°), so at speed a steering
 *  input can push body-slip past the peak before the rear stabilises it and the
 *  yaw runs away into a spin. This bleeds yaw RATE proportional to speed (0 below
 *  STEER_FULL_BELOW, full at STEER_MIN_AT), keeping the car from oversteer-
 *  spinning while leaving low-speed agility untouched. N·m per (rad/s) at top. */
const YAW_DAMP_TOP = 4200;

/** Drift finite-state machine. NONE, or a LEFT/RIGHT slide whose
 *  direction is LATCHED from the sign of the steering input at entry; the
 *  latched sign then signs the drift yaw torque. */
export enum DriftState {
  None = 0,
  Left = 1, // steering left at entry (input.steer < 0)
  Right = 2, // steering right at entry (input.steer > 0)
}

/** Signed direction (+1 left / −1 right / 0 none) for a DriftState. */
const driftSign = (d: DriftState): number => (d === DriftState.Left ? 1 : d === DriftState.Right ? -1 : 0);

// ---- scratch (module-scope, reused, deterministic) ---------------------------
const FWD_L = new CANNON.Vec3(0, 0, -1); // hull forward is -z local
const RIGHT_L = new CANNON.Vec3(1, 0, 0);
const UP_L = new CANNON.Vec3(0, 1, 0);
const UP_W = new CANNON.Vec3(0, 1, 0); // WORLD up — the air roll/pitch level reference
const _fwd = new CANNON.Vec3();
const _right = new CANNON.Vec3();
const _up = new CANNON.Vec3();
const _wfwd = new CANNON.Vec3();
const _wlat = new CANNON.Vec3();
const _r = new CANNON.Vec3();
const _vc = new CANNON.Vec3();
const _force = new CANNON.Vec3();
const _tmp = new CANNON.Vec3();
const _torque = new CANNON.Vec3();
const _steerQ = new CANNON.Quaternion();

/**
 * The full per-frame driving state — the PlayerControl view the step reads and
 * writes. Unchanged shape from the kinematic version so PlayerControl needs no
 * edit; several fields (yawVel, velAngle, heading) are now DERIVED outputs
 * rather than authored state.
 */
export interface DriveState {
  heading: number; // derived: body forward yaw (for camera/wheels/AI)
  velAngle: number; // derived: velocity yaw
  steer: number;
  speed: number; // derived: forward speed (m/s)
  drifting: boolean;
  driftState: DriftState;
  driftScale: number; // 0..1 slide depth (grows in while drifting, decays out)
  boosting: boolean;
  boostMeter: number;
  boostHeld: boolean;
  kickLeft: number;
  kickCooldown: number; // boost-kick cooldown timer (s)
  wheelieT: number; // 0..1 boost-kick wheelie amount (cosmetic pitch + air seed)
  kickPrev: boolean; // fresh-boost-press edge detector
  burnout: boolean;
  burnoutArmed: boolean;
  burnoutWasFull: boolean;
  burnoutChain: number;
  gear: number;
  shiftT: number;
  rpm: number;
  visualPitch: number;
  visualRoll: number;
  steerAngle: number;
  throttling: boolean;
  braking: boolean;
  yawVel: number; // derived: body yaw rate
  grip: number;
  recentBrake: number;
  brakeWasDown: boolean;
  tighten: number;
  nearMissFill: number;
  hadAirLastFrame: boolean;
  timeInAir: number;
  takeoffHeading: number;
  landingSettleT: number;
  steerSoftenT: number;
  hardLandT: number;
  airPitch: number;
  airRoll: number;
  readonly boostCap: number;
}

/** Speed-sensitive steering lock (rad) — full lock low, fades to a sliver at
 *  speed (Burnout's speed-sensitive steering). Shared by the wheel steer + the visual. */
function steerLock(speed: number): number {
  const t = clamp((speed - STEER_FULL_BELOW) / (STEER_MIN_AT - STEER_FULL_BELOW), 0, 1);
  return STEER_LOCK_LOW + (STEER_LOCK_HIGH - STEER_LOCK_LOW) * t;
}

/**
 * The minimal per-frame force state the SHARED core (stepVehicleForces) reads
 * and writes. DriveState extends this with the player-only wrapper fields
 * (visual weight transfer, boost-earn, landing bookkeeping). AI rivals and
 * traffic carry a plain object of exactly this shape (createForceState) — NOT a
 * full PlayerControl — so the same solver drives every car.
 */
export interface VehicleForceState {
  variant?: import('../types').Variant; // updateSpeed reads this; absent => sedan
  heading: number;
  velAngle: number;
  steer: number;
  speed: number;
  drifting: boolean;
  driftState: DriftState;
  driftScale: number;
  boosting: boolean;
  boostMeter: number;
  boostHeld: boolean;
  kickLeft: number;
  kickCooldown: number;
  wheelieT: number;
  kickPrev: boolean;
  burnout: boolean;
  burnoutArmed: boolean;
  burnoutWasFull: boolean;
  burnoutChain: number;
  gear: number;
  shiftT: number;
  rpm: number;
  yawVel: number;
  grip: number;
  recentBrake: number;
  brakeWasDown: boolean;
  tighten: number;
  hadAirLastFrame: boolean;
  timeInAir: number;
  takeoffHeading: number;
  hardLandT: number;
  airPitch: number;
  airRoll: number;
  readonly boostCap: number;
}

/** What stepVehicleForces hands back to the PLAYER wrapper (AI/traffic ignore
 *  it). Lets the wrapper do its visual/earn/landing bookkeeping without
 *  recomputing the body frame. */
export interface ForceStepResult {
  airborne: boolean;
  forwardSpeed: number; // signed forward speed (m/s)
  desiredAccel: number; // m/s² the drivetrain wanted this step (for visual pitch)
  bodySlip: number; // wrapAngle(heading - velAngle)
}

/** Build a lightweight force state for a scripted (AI/traffic) actor, seeded
 *  deterministically (NO simRand). boostMeter=0 so s.boosting can never latch
 *  (the AI/traffic ControlInput leaves boost false anyway) and the boost
 *  economy stays inert; gear/rpm seed exactly as PlayerControl.reset does. The
 *  caller sets heading/velAngle/speed from the body each frame before the step. */
export function createForceState(variant: import('../types').Variant, heading: number, speed: number): VehicleForceState {
  return {
    variant,
    heading,
    velAngle: heading,
    steer: 0,
    speed,
    drifting: false,
    driftState: DriftState.None,
    driftScale: 0,
    boosting: false,
    boostMeter: 0, // scripted cars never boost; keeps updateSpeed's boost path off
    boostHeld: false,
    kickLeft: 0,
    kickCooldown: 0,
    wheelieT: 0,
    kickPrev: false,
    burnout: false,
    burnoutArmed: false,
    burnoutWasFull: false,
    burnoutChain: 0,
    gear: 0,
    shiftT: 0,
    rpm: 0.25,
    yawVel: 0,
    grip: 1,
    recentBrake: 0,
    brakeWasDown: false,
    tighten: 0,
    hadAirLastFrame: false,
    timeInAir: 0,
    takeoffHeading: heading,
    hardLandT: 0,
    airPitch: 0,
    airRoll: 0,
    boostCap: 0,
  };
}

/**
 * THE SHARED FORCE CORE (extracted from stepDrive). Banks engine/tire/boost/
 * drift/air forces onto `actor.body` from a ControlInput and the body's ACTUAL
 * orientation; heading/velAngle/speed/yawVel are DERIVED outputs written back
 * onto `s`. Every car — player, rival, traffic — runs this; the grounded
 * yaw-only angularFactor lock is applied here so all of them inherit the
 * stability keystone. Returns the frame readouts the player wrapper needs.
 */
export function stepVehicleForces(
  s: VehicleForceState,
  player: Actor,
  input: ControlInput,
  heightAt: HeightSampler,
  attribs: HandlingAttribs,
): ForceStepResult {
  const b = player.body;
  const dt = FIXED_DT;
  const spec = player.spec!;

  // ---- derive the body frame + the kinematic readouts (the force model reads
  //      the body's ACTUAL orientation; heading/velAngle/speed are outputs) ----
  b.quaternion.vmult(FWD_L, _fwd);
  b.quaternion.vmult(RIGHT_L, _right);
  b.quaternion.vmult(UP_L, _up);
  const forwardSpeed = b.velocity.dot(_fwd); // signed (+ forward, − reverse)
  s.heading = Math.atan2(_fwd.x, _fwd.z); // world dir = (sin h, 0, cos h)
  const planarV = Math.hypot(b.velocity.x, b.velocity.z);
  s.velAngle = planarV > 0.05 ? Math.atan2(b.velocity.x, b.velocity.z) : s.heading;
  s.yawVel = b.angularVelocity.y;

  // ---- steering ramp (quartic shaping + faster return-to-centre) -------------
  const target = clamp(shapeSteer(input.steer, STEER_SHAPE_BLEND), -1, 1);
  const centering = Math.abs(target) < Math.abs(s.steer) || target * s.steer < 0;
  const rate = STEER_RAMP * (centering ? CENTER_BIAS : 1);
  s.steer += clamp(target - s.steer, -rate * dt, rate * dt);

  // ---- drift FSM (entry/exit on the DERIVED body slip) ------------------------
  const freshTap = input.brake && !s.brakeWasDown;
  s.brakeWasDown = input.brake;
  s.recentBrake = input.brake ? 0.25 : Math.max(0, s.recentBrake - dt);
  if (!s.drifting && s.driftState !== DriftState.None) s.driftState = DriftState.None;
  const bodySlip = wrapAngle(s.heading - s.velAngle); // actual slip angle now
  if (
    s.driftState === DriftState.None &&
    s.recentBrake > 0 &&
    Math.abs(s.steer) > 0.3 &&
    forwardSpeed > attribs.drift.minSpeed
  ) {
    s.driftState = s.steer > 0 ? DriftState.Right : DriftState.Left; // input.steer +1 = right
    s.driftScale = 0.4; // kickstart the slide so the small entry slip can't trip the exit guard
    s.tighten = 0;
  } else if (s.driftState !== DriftState.None && freshTap) {
    s.tighten = 1;
  }
  s.drifting = s.driftState !== DriftState.None;
  s.tighten = Math.max(0, s.tighten - dt / 0.6);
  // exit: the slide has wound down (driftScale decays to ~0 once you stop
  // steering INTO it — see the grounded drift block) or it's too slow to
  // sustain. NOT on the small ENTRY slip: driftScale is kickstarted so the slide
  // gets a chance to build before this can fire.
  if (s.drifting && (s.driftScale < 0.12 || forwardSpeed < 12)) {
    s.driftState = DriftState.None;
    s.drifting = false;
  }
  // grip blend (cosmetic / earn weighting; the real grip is per-tire now)
  const gripGoal = s.drifting ? 0 : 1;
  s.grip += (gripGoal - s.grip) * Math.min(1, dt / (s.drifting ? 0.18 : 0.35));

  // ---- engine drive force: run the boost/gear/brake ECONOMY and READ OFF its
  //      intended acceleration as a force. Feed it the REAL measured speed; its
  //      speed integration becomes a per-frame scratch whose delta = the accel
  //      the drivetrain wants. All gears/boost/burnout/tier logic reused as-is. -
  const measured = Math.max(0, forwardSpeed);
  s.speed = measured;
  updateSpeed(s, input); // advances gear/boost economy + s.speed scratch
  const desiredAccel = (s.speed - measured) / dt; // m/s² the drivetrain wants
  s.speed = Math.max(0, forwardSpeed); // expose speedo-style forward speed (≥0) downstream
  let driveForce = 0;
  let brakeForce = 0;
  if (desiredAccel >= 0) driveForce = b.mass * desiredAccel;
  else brakeForce = b.mass * -desiredAccel; // throttle-off coast, tier-settle and braking

  // ---- boost as a clean COM shove + boost-kick wheelie ---------
  // Boost = mass·boostAccel applied AT THE COM (ellipse-free — a forward boost
  // force), NOT split through the friction ellipse,
  // so it shoves straight even mid-corner while the ENGINE fraction still has to
  // find grip. boostAccel mirrors updateSpeed's economy (BOOST/BURNOUT + the
  // launch kick) and the matching force is SUBTRACTED from driveForce so total
  // forward thrust is unchanged, just re-routed.
  let boostAccel = 0;
  if (s.boosting && s.boostMeter > 0) {
    boostAccel = s.burnout ? BURNOUT_ACCEL : BOOST_ACCEL;
    if (s.kickLeft > 0 && measured < KICK_BELOW) boostAccel += KICK_ACCEL;
  }
  // route only the part driveForce actually realised this frame to the COM: near
  // a speed cap desiredAccel shrinks, so does the boost shove — never double-count.
  const boostForce = Math.min(driveForce, b.mass * boostAccel);
  driveForce -= boostForce;
  // boost-kick wheelie: a FRESH boost press from low speed with the cooldown
  // elapsed fires the launch kick (fresh boost && since-last>2.0s && speed below
  // the cap). The kick is a wheelie generator — cosmetic
  // nose-up while grounded (visualPitch, below), physical via the airPitch seed if
  // we launch mid-kick. KICK_COOLDOWN(2.0) > KICK_TIME(0.75) so kickCooldown stays
  // >0 for the whole kick window, then keeps blocking a re-kick.
  const freshBoost = input.boost && !s.kickPrev;
  s.kickPrev = input.boost;
  s.kickCooldown = Math.max(0, s.kickCooldown - dt);
  if (s.boosting && s.boostMeter > 0 && freshBoost && measured < KICK_BELOW && s.kickCooldown <= 0) {
    s.kickCooldown = KICK_COOLDOWN; // arm the kick + its cooldown
  }
  const kicking =
    s.boosting && s.boostMeter > 0 && s.kickLeft > 0 && measured < KICK_BELOW && s.kickCooldown > 0;
  // wheelieT ramps in while the kick is live, eases out after; clamped to 1 so the
  // cosmetic pitch self-limits at WHEELIE_PITCH_MAX (Burnout's wheelie self-limit).
  s.wheelieT = clamp(
    s.wheelieT + ((kicking ? 1 : 0) - s.wheelieT) * Math.min(1, (kicking ? WHEELIE_RISE : WHEELIE_DECAY) * dt),
    0,
    1,
  );

  const airborne = !player.susp.some((su) => su.grounded);

  // ---- reverse: once braking has brought the car to a near-stop, continuing to
  //      hold the brake drives it backward at a limited speed (arcade brake-is-
  //      reverse — there's no separate reverse key, and the forward-only speed
  //      economy above never produces this). A modest negative drive force, cut
  //      once the reverse-speed cap is reached so it settles at a steady crawl.
  //      Grounded-only; suppressed on throttle (forward intent) and while
  //      drifting (a brake tap there is the drift, not reverse). ---------------
  if (!airborne && input.brake && !input.throttle && !s.drifting && forwardSpeed < REVERSE_ENGAGE_BELOW) {
    brakeForce = 0; // don't let the brake fight the reverse drive (it opposes motion either way)
    driveForce = -forwardSpeed >= REVERSE_MAX_SPEED ? 0 : -b.mass * REVERSE_ACCEL;
  }

  if (!airborne) {
    // ---- yaw-only chassis while grounded (the stability keystone) ------------
    // Lock roll/pitch torque integration (cannon angularFactor) so the box can
    // ONLY yaw. Steering, drift and spin-out stay fully emergent (they're all
    // yaw), but the 4-spring suspension can never drive the body into a roll/
    // pitch launch-runaway — the failure mode a freely-tumbling force box hits
    // under hard cornering. Body lean/squat stay cosmetic (the hull's
    // visualRoll/visualPitch). Restored to full rotation when airborne so jumps
    // tumble. (Slope-following chassis tilt is a follow-up via the orientation
    // sampler; flat levels are unaffected.)
    b.angularFactor.set(0, 1, 0);
    b.angularVelocity.x = 0;
    b.angularVelocity.z = 0;

    // ---- per-wheel tire forces (THE KEYSTONE) -------------------------------
    // Each grounded wheel turns its slip + spring load into a contact force,
    // applied AT the contact → yaw/slide emerge. RWD: drive on the rear axle.
    // input.steer is +1 for RIGHT / −1 for LEFT; a +rotation about the body up
    // axis points the wheel LEFT, so negate to steer the correct way.
    const steerAngle = -steerLock(measured) * s.steer;
    _steerQ.setFromAxisAngle(_up, steerAngle);

    let rearGrounded = 0;
    let frontGrounded = 0;
    let groundedCount = 0;
    for (const su of player.susp) {
      if (!su.grounded || su.load <= 0) continue;
      groundedCount++;
      if (su.az < 0) frontGrounded++;
      else rearGrounded++;
    }
    if (groundedCount === 0) groundedCount = 1;
    const dir = driftSign(s.driftState);

    const latC = latGripCurve(attribs);
    const longC = longGripCurve(attribs);
    const driftC = driftLatGripCurve(attribs);

    for (const su of player.susp) {
      if (!su.grounded || su.load <= 0) continue;
      const isFront = su.az < 0;

      // lever arm r (world) from COM to the contact patch
      _r.set(su.ax, -spec.rideHeight * CONTACT_Y_FRAC, su.az);
      b.quaternion.vmult(_r, _r);

      // wheel forward: rear = body forward; front = steered
      if (isFront) _steerQ.vmult(_fwd, _wfwd);
      else _wfwd.copy(_fwd);
      _wfwd.cross(_up, _wlat); // wheel right = forward × up
      _wlat.normalize();

      // contact-point velocity = v + ω × r
      b.angularVelocity.cross(_r, _vc);
      _vc.vadd(b.velocity, _vc);
      const vLong = _vc.dot(_wfwd);
      const vLat = _vc.dot(_wlat);

      // drive split across the powered axle's grounded wheels
      const rearShare = attribs.engine.powerToRear;
      let wd: number;
      if (isFront) wd = frontGrounded > 0 ? (driveForce * (1 - rearShare)) / frontGrounded : 0;
      else wd = rearGrounded > 0 ? (driveForce * rearShare) / rearGrounded : 0;
      const wb = brakeForce / groundedCount;

      // drifting: the REAR uses the flatter drift curve at reduced grip so the
      // tail steps out; the front keeps full lateral grip to point the slide.
      const useDrift = s.drifting && !isFront;
      const params: TireParams = {
        latCurve: useDrift ? driftC : latC,
        longCurve: longC,
        latMu: useDrift ? LAT_MU * DRIFT_REAR_GRIP : LAT_MU,
        longMu: LONG_MU,
        surfaceGrip: 1,
        cornerMass: b.mass / 4,
        dt,
      };
      const out = tireForce({ load: su.load, vLong, vLat, driveForce: wd, brakeForce: wb }, params);

      _wfwd.scale(out.fLong, _force);
      _wlat.scale(out.fLat, _tmp);
      _force.vadd(_tmp, _force);
      b.applyForce(_force, _r); // r × F → emergent yaw
    }

    // ---- boost: the ellipse-free COM shove (no lever arm → pure forward thrust,
    //      zero torque → honors the yaw-only lock). The engine fraction above went
    //      through the tires; this is the boost fraction split out of driveForce. -
    if (boostForce > 0) {
      _fwd.scale(boostForce, _force);
      b.applyForce(_force); // at COM (no r) → no roll/pitch moment
    }

    // ---- high-speed yaw stability (Burnout's high-speed angular damping) ---------------
    // Speed-gated yaw-rate bleed: keeps a fast corner from oversteer-spinning.
    // Suppressed while drifting (the slide is intentional yaw).
    if (!s.drifting) {
      const spd = Math.abs(forwardSpeed);
      const gate = clamp((spd - STEER_FULL_BELOW) / (STEER_MIN_AT - STEER_FULL_BELOW), 0, 1);
      const yawDampK = YAW_DAMP_TOP * gate * (attribs.base.highSpeedAngularDamping / 0.15);
      if (yawDampK > 0) {
        _torque.set(0, -b.angularVelocity.y * yawDampK, 0);
        b.applyTorque(_torque);
      }
    }

    // ---- drift: hold a controllable slide (Burnout's drift-angle + drift-yaw model)
    // The rear's reduced grip (drift curve, in the tire loop) lets the tail step
    // out; this yaw PD rotates the nose to a TARGET slip angle set by how hard
    // you steer INTO the slide, grown in over driftScale and damped so it holds
    // instead of spinning. Pure yaw → honors the angularFactor lock.
    if (s.drifting) {
      const steerIntoDrift = clamp(-dir * s.steer, -1, 1); // +1 deepening, −1 countersteer
      // Hold the slide at full depth while you steer INTO it (past the entry
      // threshold); straighten or countersteer and depth → 0 so driftScale decays
      // and the drift exits. Robust to the steer ramp at entry.
      const depth = steerIntoDrift > 0.25 ? 1 : clamp(steerIntoDrift, 0, 1);
      const scaleRate = depth > s.driftScale ? attribs.drift.deepen : attribs.drift.relax;
      s.driftScale = clamp(s.driftScale + (depth - s.driftScale) * Math.min(1, scaleRate * dt), 0, 1);
      const targetSlip = dir * attribs.drift.maxSlip * s.driftScale;
      const slipErr = wrapAngle(targetSlip - bodySlip);
      const yawScale = attribs.drift.naturalYawTorque / 7000; // per-variant (median 7000)
      _torque.set(0, (DRIFT_YAW_KP * slipErr - DRIFT_YAW_KD * b.angularVelocity.y) * yawScale, 0);
      b.applyTorque(_torque);
    } else {
      s.driftScale = Math.max(0, s.driftScale - dt / 0.25); // decay out of the slide
    }
  } else {
    // ---- airborne: restore full rotation (jumps tumble), faint forward thrust,
    //      and PD ATTITUDE TORQUES (Burnout's airborne attitude, torque port). The
    //      kinematic quaternion pin (orientation CASE 3a) is gone — angularFactor
    //      is (1,1,1) here so these roll/pitch/yaw torques actually integrate. --
    b.angularFactor.set(1, 1, 1);
    // airborne forward thrust uses the FULL drive force (engine + boost): the
    // boost COM-shove block is grounded-only, so boostForce was split out of
    // driveForce but is never re-applied up here — add it back so a boost held
    // off a jump still pushes (no double force: the grounded apply never ran).
    const airThrust = driveForce + (boostForce > 0 ? boostForce : 0);
    if (airThrust > 0) {
      _fwd.scale(airThrust * AIR_THRUST_FRAC, _force);
      b.applyForce(_force);
    }

    // The body basis {_right,_up,_fwd} (computed at the top of stepDrive, not
    // touched in the air path) is orthonormal — project ω onto it for the rate
    // (KD) terms so each PD acts on its own DOF, not a world axis.
    const wRoll = b.angularVelocity.dot(_fwd); // spin about body forward = roll
    const wPitch = b.angularVelocity.dot(_right); // spin about body right = pitch
    const wYaw = b.angularVelocity.dot(_up); // spin about body up = yaw

    // ROLL auto-level: signed error is the body-right component of WORLD up — 0 at
    // level, grows as the car banks. P-term is PLUS (a minus rolls toward inverted).
    const rollSignedErr = _right.dot(UP_W);
    const rollTau = AIR_ROLL_KP * rollSignedErr - AIR_ROLL_KD * wRoll;
    _torque.copy(_fwd).scale(rollTau, _torque);
    b.applyTorque(_torque);

    // PITCH follow/clamp: curPitch = asin(clamp(_fwd.y)) (NOT -_fwd.y). The target
    // eases toward the trajectory tangent, clamped to a wheelie angle. _fwd.y>0 =
    // nose up. s.airPitch carries the takeoff seed (boost may compose a wheelie in).
    const curPitch = Math.asin(clamp(_fwd.y, -1, 1)); // NaN-guarded by clamp
    const horizV = Math.hypot(b.velocity.x, b.velocity.z);
    const trajPitch = clamp(Math.atan2(b.velocity.y, Math.max(2, horizV)), -MAX_WHEELIE_ANGLE, MAX_WHEELIE_ANGLE);
    s.airPitch += (trajPitch - s.airPitch) * Math.min(1, AIR_PITCH_FOLLOW * dt);
    s.airPitch = clamp(s.airPitch, -MAX_WHEELIE_ANGLE, MAX_WHEELIE_ANGLE);
    const pitchTau = AIR_PITCH_KP * (s.airPitch - curPitch) - AIR_PITCH_KD * wPitch;
    _torque.copy(_right).scale(pitchTau, _torque);
    b.applyTorque(_torque);

    // airborne AFTERTOUCH: steering commands a YAW RATE — the missing air control.
    // A rate-target PD chases ±AIR_YAW_RATE at full lock (so you can line up a
    // landing or pull the nose around mid-jump) and, at steer 0, chases 0 so the
    // nose settles instead of slewing at touchdown. +steer = right, and a
    // +rotation about body-up points the nose LEFT (grounded-steer convention), so
    // the target is negated.
    const targetYaw = -AIR_YAW_RATE * s.steer;
    const yawTau = AIR_YAW_FOLLOW * (targetYaw - wYaw);
    _torque.copy(_up).scale(yawTau, _torque);
    b.applyTorque(_torque);

    s.airRoll = Math.asin(clamp(_right.dot(UP_W), -1, 1)); // bank readout (NaN-guarded; nothing consumes it yet)
  }

  return { airborne, forwardSpeed, desiredAccel, bodySlip };
}

/**
 * THE PLAYER DRIVING STEP. Thin wrapper over the shared force core: runs
 * stepVehicleForces (engine/tire/boost/drift/air on the body), then keeps the
 * PLAYER-ONLY bookkeeping the core doesn't need — boost EARN, the
 * airborne/landing edges (takeoff seed / hard-land settle), the visual weight
 * transfer, and the front-wheel visual steer. Bit-identical to the pre-
 * extraction inline body (same call order, same field writes).
 */
export function stepDrive(
  s: DriveState,
  player: Actor,
  input: ControlInput,
  heightAt: HeightSampler,
  attribs: HandlingAttribs,
): void {
  const b = player.body;
  const dt = FIXED_DT;
  const { airborne, forwardSpeed, desiredAccel, bodySlip } = stepVehicleForces(s, player, input, heightAt, attribs);

  // ---- boost EARN (drift sideways / fly / near-miss) -------------------------
  let earn = s.nearMissFill;
  s.nearMissFill = 0;
  if (s.drifting) {
    const sideways = Math.min(1, Math.abs(bodySlip) / attribs.drift.maxSlip);
    earn += REFILL_DRIFT * (0.4 + 0.6 * sideways) * dt;
  }
  if (airborne) earn += REFILL_AIR * dt;
  if (earn > 0) s.boostMeter = Math.min(s.boostCap, s.boostMeter + earn);

  // ---- airborne / landing edge bookkeeping (consumed by the air attitude) ----
  const takeoffEdge = airborne && !s.hadAirLastFrame;
  const landingEdge = !airborne && s.hadAirLastFrame;
  s.hadAirLastFrame = airborne;
  const airtimeAtLanding = s.timeInAir; // snapshot BEFORE the zero-on-landing below (hard-land trigger)
  s.timeInAir = airborne ? s.timeInAir + dt : 0;
  if (takeoffEdge) {
    s.takeoffHeading = s.heading;
    const horiz = Math.hypot(b.velocity.x, b.velocity.z);
    // seed the pitch target from the launch trajectory (boost may compose a
    // wheelie into this same field this frame — keep, don't clobber). Clamped to
    // the wheelie angle so the steady-air PD inherits a sane target.
    s.airPitch = clamp(Math.atan2(b.velocity.y, Math.max(2, horiz)), -MAX_WHEELIE_ANGLE, MAX_WHEELIE_ANGLE);
    if (s.wheelieT > 0) s.airPitch = Math.max(s.airPitch, s.wheelieT * WHEELIE_AIR_SEED);
    s.airRoll = 0;
    // ONE-SHOT take-off spin-bleed (Burnout's takeoff damping): decompose ω onto the
    // ORTHONORMAL body basis {_right(pitch),_up(yaw),_fwd(roll)} — bleeding yaw
    // about body _up (NOT world (0,1,0)) keeps a banked-lip launch from having
    // its ω corrupted — scale each component by its KEEP fraction, rebuild ω.
    const tRoll = b.angularVelocity.dot(_fwd) * TAKEOFF_KEEP_ROLL;
    const tPitch = b.angularVelocity.dot(_right) * TAKEOFF_KEEP_PITCH;
    const tYaw = b.angularVelocity.dot(_up) * TAKEOFF_KEEP_YAW;
    b.angularVelocity.set(
      _fwd.x * tRoll + _right.x * tPitch + _up.x * tYaw,
      _fwd.y * tRoll + _right.y * tPitch + _up.y * tYaw,
      _fwd.z * tRoll + _right.z * tPitch + _up.z * tYaw,
    );
  }
  if (landingEdge) {
    s.landingSettleT = 0; // grounded force model settles physically — no pin blend
    s.steerSoftenT = 0;
    // HARD-LANDING settle (Burnout's hard-landing stabilisation): a heavy touchdown (long
    // airtime OR fast descent) arms a window that damps residual yaw ω and softens
    // steering. b.velocity.y is the pre-step descent velocity (runs in stepControls
    // before world.step); airtimeAtLanding is the airtime captured before the zero.
    const descent = Math.max(0, -b.velocity.y);
    if (airtimeAtLanding >= HARD_LAND_MIN_AIR || descent >= HARD_LAND_MIN_VY) {
      s.hardLandT = HARD_LAND_SETTLE_SECS;
      s.steerSoftenT = HARD_LAND_SETTLE_SECS; // soften steering across the squash
    }
  }
  // bleed residual yaw spin during the hard-landing window — the only DOF that
  // survives the grounded angularFactor lock (ωx/ωz are hard-zeroed above), so a
  // grounded settle on roll/pitch would be a no-op (dropped per the roadmap).
  if (s.hardLandT > 0 && !airborne) {
    b.angularVelocity.y *= Math.max(0, 1 - HARD_LAND_YAW_DAMP * dt);
  }
  s.hardLandT = Math.max(0, s.hardLandT - dt);
  s.landingSettleT = Math.max(0, s.landingSettleT - dt);
  s.steerSoftenT = Math.max(0, s.steerSoftenT - dt);

  // ---- visual weight transfer (hull lean ON TOP of the now-physical body roll;
  //      kept subtle so it reads as load, not a double tilt) -------------------
  const rollTarget = clamp(-s.yawVel * Math.abs(forwardSpeed) * ROLL_PER_LATG, -ROLL_MAX, ROLL_MAX);
  s.visualRoll += (rollTarget - s.visualRoll) * Math.min(1, dt * 6);
  const accel = desiredAccel;
  if (s.wheelieT > 0 && !airborne) {
    // boost-kick wheelie owns the pitch this frame: nose-up (positive), self-
    // limited by wheelieT≤1 at WHEELIE_PITCH_MAX. Skips the squat ease below so
    // the two writes don't fight on the same field.
    const wheelieTarget = s.wheelieT * WHEELIE_PITCH_MAX;
    s.visualPitch += (wheelieTarget - s.visualPitch) * Math.min(1, dt * 8);
  } else {
    const pitchTarget = airborne ? 0 : clamp(accel * PITCH_PER_ACCEL, PITCH_MIN, PITCH_MAX);
    s.visualPitch += (pitchTarget - s.visualPitch) * Math.min(1, dt * 5);
  }

  // ---- front-wheel visual steer (presentation-only) --------------------------
  s.steerAngle = steerLock(Math.abs(forwardSpeed)) * s.steer * VISUAL_STEER_GAIN;
  s.throttling = input.throttle;
  s.braking = input.brake;

  // ---- airborne attitude is now FORCE-BASED (PD torques in the airborne else-
  //      branch above); grounded pose is the body's physical pose. No pin. -----
}
