import {
  FIXED_DT,
  LAND_SETTLE_SECS,
  LAND_STEER_SOFTEN_SECS,
  MAX_WHEELIE_ANGLE,
  TAKEOFF_PITCH_DAMP,
  TAKEOFF_ROLL_DAMP,
  TAKEOFF_YAW_DAMP,
} from '../constants';
import type { Actor } from '../types';
import type { HeightSampler } from '../suspension';
import type { HandlingAttribs } from '../handling';
import type { ControlInput } from './input';
import { grip, latGripCurve, driftLatGripCurve } from '../grip';
import { applyChassisOrientation } from './orientation';
import { updateSpeed } from './speed';
import {
  BURNOUT_TOP,
  CENTER_BIAS,
  COUNTERSTEER,
  DRIFT_ANGDAMP_STRENGTH,
  DRIFT_CHASE,
  DRIFT_ENTRY_TIME,
  DRIFT_EXIT_SLIP,
  DRIFT_LAT_FORCE_REF,
  DRIFT_LAT_STRENGTH,
  DRIFT_MAINTAIN_STRENGTH,
  DRIFT_MIN_SPEED,
  DRIFT_RECOVER_TIME,
  DRIFT_TIGHTEN,
  DRIFT_YAW_STRENGTH,
  DRIFT_YAW_TORQUE_REF,
  GRIP_CHASE,
  GRIP_CURVE_BLEND,
  GRIP_MOD_FLOOR,
  GRIP_REF_COEFF,
  PITCH_MAX,
  PITCH_MIN,
  PITCH_PER_ACCEL,
  REFILL_AIR,
  REFILL_DRIFT,
  ROLL_MAX,
  ROLL_PER_LATG,
  STEER_FULL_BELOW,
  STEER_LOCK_HIGH,
  STEER_LOCK_LOW,
  STEER_MIN_AT,
  STEER_RAMP,
  STEER_SHAPE_BLEND,
  VISUAL_STEER_GAIN,
  WHEELBASE,
  YAW_RESPONSE,
  clamp,
  shapeSteer,
  wrapAngle,
} from './constants';

/** Drift finite-state machine (Feature D). The boolean drift is hardened to a
 *  tri-state: NONE, or a LEFT/RIGHT slide whose direction is LATCHED from the
 *  sign of the steering input at entry (BP `mu8DriftState`, findings §8). The
 *  latched sign then signs every scripted drift force, so the slide can't flip
 *  direction mid-corner without re-entering. */
export enum DriftState {
  None = 0,
  Left = 1, // steering left at entry (steer > 0 in CJ's sign convention)
  Right = 2, // steering right at entry (steer < 0)
}

/** Signed direction (+1 left / −1 right / 0 none) for a DriftState — the sign
 *  every drift force is multiplied by. CJ's steer is +left/−right (the yaw model
 *  uses `-steer`), so Left → +1, Right → −1. */
const driftSign = (d: DriftState): number => (d === DriftState.Left ? 1 : d === DriftState.Right ? -1 : 0);

/**
 * The full per-frame driving state — every PlayerControl field the driving step
 * reads or writes (everything but `tippedTime`, which the caller owns for the
 * tumble/right branch). The class hands a view of itself in, the step mutates it,
 * the class copies it back; the math is bit-identical to the inlined version.
 */
export interface DriveState {
  heading: number;
  velAngle: number;
  steer: number;
  speed: number;
  drifting: boolean; // FSM active view: driftState !== None (kept for callers)
  driftState: DriftState; // tri-state FSM (Feature D) — NONE/LEFT/RIGHT
  boosting: boolean;
  boostMeter: number;
  boostHeld: boolean;
  kickLeft: number;
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
  yawVel: number;
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
  airPitch: number;
  airRoll: number;
  readonly boostCap: number;
}

/**
 * One fixed-step of the driving model, run after the tipped-over branch: steering
 * ramp, drift state, the speed/boost economy, yaw + slip integration, boost earn,
 * visual weight transfer, the front-wheel render steer, and finally the body
 * velocity + chassis-orientation write. Every number, branch and order of
 * operations is preserved verbatim from the inlined PlayerControl.update body.
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

  // ---- steering ramp (return-to-center is faster than steering in) ----
  // BP ModifyControlsForSteeringWheelInput: a quartic stiffening shapes the raw
  // input (soft centre, sharp extreme) before the ramp. STEER_SHAPE_BLEND
  // defaults small so the sedan stays close to linear (= today's feel); the
  // shaped value is what the steer chases. On a binary keyboard input (±1) this
  // is a no-op since |±1|^4 = ±1; it only bites for analog/AI continuous input.
  const target = clamp(shapeSteer(input.steer, STEER_SHAPE_BLEND), -1, 1);
  const centering = Math.abs(target) < Math.abs(s.steer) || target * s.steer < 0;
  const rate = STEER_RAMP * (centering ? CENTER_BIAS : 1);
  s.steer += clamp(target - s.steer, -rate * dt, rate * dt);

  // ---- drift state. The brake tap is buffered for a beat, so both
  // "steer then tap" and "tap then steer" enter the slide; a fresh tap
  // mid-slide tightens the angle instead. The drift itself ends in the
  // slip model below — by straightening out, not by releasing steer ----
  const freshTap = input.brake && !s.brakeWasDown;
  s.brakeWasDown = input.brake;
  s.recentBrake = input.brake ? 0.25 : Math.max(0, s.recentBrake - dt);
  // Reconcile an EXTERNAL drift clear (Game/core.ts forces `control.drifting =
  // false` on crashes/resets). The FSM is otherwise authoritative, but if the
  // boolean was cleared from outside while the FSM still held a direction, honour
  // it as an ExitDrift so the two never disagree.
  if (!s.drifting && s.driftState !== DriftState.None) s.driftState = DriftState.None;
  // ---- drift FSM entry (Feature D). The same tap-buffer entry condition as
  // before, but EnterDrift now LATCHES the direction from the sign of the
  // steering input (BP: steer ≤ 0 → FacingRight, else FacingLeft). CJ steer is
  // +left/−right, so steer > 0 → Left, steer < 0 → Right. That latched enum
  // then signs every scripted drift force below. ExitDrift runs in the slip
  // model (straightened-out / low-speed guards), which clears driftState. ----
  if (s.driftState === DriftState.None && s.recentBrake > 0 && Math.abs(s.steer) > 0.3 && s.speed > DRIFT_MIN_SPEED) {
    s.driftState = s.steer > 0 ? DriftState.Left : DriftState.Right;
    s.tighten = 0;
  } else if (s.driftState !== DriftState.None && freshTap) {
    s.tighten = 1;
  }
  s.drifting = s.driftState !== DriftState.None; // derived view for the rest of the step
  s.tighten = Math.max(0, s.tighten - dt / 0.6);
  const gripGoal = s.drifting ? 0 : 1;
  s.grip += (gripGoal - s.grip) * Math.min(1, dt / (s.drifting ? DRIFT_ENTRY_TIME : DRIFT_RECOVER_TIME));

  const speedBefore = s.speed;

  // ---- speed model (throttle/boost through the gears, the B3 boost economy +
  // sustained-Burnout state machine, braking, drift scrub, tier clamps) ----
  updateSpeed(s, input);

  // ---- yaw. The minus sign: with y up and headings mapped to
  // (sin h, 0, cos h), turning right (screen-right of travel) is -h ----
  const airborne = !player.susp.some((susp) => susp.grounded);
  // ---- takeoff/landing edges + air timers (bookkeeping; consumed by the
  // airborne attitude + landing-settle model). Timers tick on FIXED_DT. ----
  const takeoffEdge = airborne && !s.hadAirLastFrame;
  const landingEdge = !airborne && s.hadAirLastFrame;
  s.hadAirLastFrame = airborne;
  s.timeInAir = airborne ? s.timeInAir + dt : 0;
  if (takeoffEdge) {
    s.takeoffHeading = s.heading;
    // one-shot per-axis spin damp (BP *DampingOnTakeOff): bleed the rotation
    // the ramp lip imparted so the car leaves COMPOSED — roll and yaw are
    // near-killed, a little pitch kick is kept. The kinematic air attitude
    // (case 3a) takes over from here, so seed its eased pitch from the launch
    // trajectory and start roll flat (rubber-down intent).
    b.angularVelocity.x *= TAKEOFF_PITCH_DAMP;
    b.angularVelocity.y *= TAKEOFF_YAW_DAMP;
    b.angularVelocity.z *= TAKEOFF_ROLL_DAMP;
    const horiz = Math.hypot(b.velocity.x, b.velocity.z);
    s.airPitch = clamp(Math.atan2(b.velocity.y, Math.max(2, horiz)), -MAX_WHEELIE_ANGLE, MAX_WHEELIE_ANGLE);
    s.airRoll = 0;
  }
  if (landingEdge) {
    s.landingSettleT = LAND_SETTLE_SECS;
    s.steerSoftenT = LAND_STEER_SOFTEN_SECS;
  }
  s.landingSettleT = Math.max(0, s.landingSettleT - dt);
  s.steerSoftenT = Math.max(0, s.steerSoftenT - dt);
  if (s.drifting) {
    // ---- slip-angle drift, the corner tool: your steering sets the
    // ANGLE of the slide — hold it deep, feather it shallow — and the
    // path bends in proportion, so a deeper drift is a tighter corner.
    // Straighten the wheel and the slip unwinds until the tyres hook
    // up; countersteer unwinds it faster, and held past centre it
    // swings the tail out the other way (chaining, no new tap) ----
    const dir = driftSign(s.driftState); // latched at entry — signs every drift force
    const dh = attribs.drift;
    let slip = wrapAngle(s.heading - s.velAngle);
    // DriftScale: grow the slide toward the per-variant cap (BP DriftMaxAngle →
    // dh.maxSlip; tanker barely drifts, sedan/bus more). Steering still sets the
    // angle within the cap, kept by tap-tighten and countersteer as before.
    let want = -s.steer * dh.maxSlip * clamp(s.speed / 30, 0.7, 1);
    if (want !== 0) {
      want = clamp(want + Math.sign(want) * DRIFT_TIGHTEN * s.tighten, -dh.maxSlip, dh.maxSlip);
    }
    const deepening = want * slip >= 0 && Math.abs(want) > Math.abs(slip);
    let chaseRate = deepening ? dh.deepen : dh.relax;
    if (s.steer * slip > 0) chaseRate *= COUNTERSTEER; // steering against the slide
    if (airborne) chaseRate *= 0.3; // attitude mostly holds in the air
    slip += (want - slip) * Math.min(1, chaseRate * dt);

    // ---- scripted drift forces (Feature D), each GATED to zero-able and
    // signed by the latched drift direction. They are ground-relative slip /
    // speed nudges on the kinematic state, the CJ analogue of BP's ground-
    // tangent-projected impulses (findings §8). All no-ops when their strength
    // scalar is 0 (= the old pure slip-chase). ----
    if (!airborne) {
      // DriftLatForce: scripted sideways step-out, shaped by the dedicated,
      // flatter DRIFT lateral grip curve (Feature C). The curve sampled at the
      // current slip gives how readily the rear keeps stepping out; lower
      // (flatter) drift coeff = looser = the rear walks out further. Added as an
      // extra slip rate in the latched direction, capped to maxSlip.
      const driftCoeff = Math.abs(grip(slip, driftLatGripCurve(attribs)));
      const latAdd = dir * (dh.sideForce / DRIFT_LAT_FORCE_REF) * driftCoeff * DRIFT_LAT_STRENGTH * dt;
      slip = clamp(slip + latAdd, -dh.maxSlip, dh.maxSlip);
      // drift.angularDamping: bleed excess slide that overshoots the target —
      // heavier variants (higher angularDamping) settle their spin harder.
      const overslip = slip - want;
      slip -= overslip * Math.min(1, dh.angularDamping * DRIFT_ANGDAMP_STRENGTH * dt * 12);
    }
    if (!airborne) s.velAngle = wrapAngle(s.velAngle + slip * dh.carve * dt);
    const heading = wrapAngle(s.velAngle + slip);
    // DriftScale/Yaw self-align: nudge the nose toward the slide direction via
    // the per-variant naturalYawTorque (BP NaturalYawTorque, remapped to a CJ
    // yaw-rate add). Folded into the heading delta so yawVel stays continuous
    // for the roll/exit handoff.
    const yawAlign = dir * (dh.naturalYawTorque / DRIFT_YAW_TORQUE_REF) * DRIFT_YAW_STRENGTH * dt;
    const headingAligned = wrapAngle(heading + (airborne ? 0 : yawAlign));
    s.yawVel = wrapAngle(headingAligned - s.heading) / dt; // keep roll & exit handoff continuous
    s.heading = headingAligned;

    // MaintainDriftSpeed: anti-scrub — a slide shouldn't bleed all its speed.
    // Top the speed back up toward the speed it entered the slide with, at a
    // fraction of the deficit per second (BP MaintainDriftSpeed impulse along
    // the velocity blend), gated on throttle. Speed itself is owned by
    // updateSpeed/scrub above; this only ADDS back, never removes.
    if (!airborne && input.throttle && s.speed < speedBefore) {
      const refill = (speedBefore - s.speed) * Math.min(1, DRIFT_MAINTAIN_STRENGTH * dt * 6);
      s.speed = Math.min(BURNOUT_TOP, s.speed + refill);
    }

    if ((Math.abs(slip) < DRIFT_EXIT_SLIP && Math.abs(want) < DRIFT_EXIT_SLIP * 2) || s.speed < 12) {
      s.driftState = DriftState.None; // ExitDrift: straightened out — grip recovers
      s.drifting = false;
      s.speed = Math.min(BURNOUT_TOP, s.speed + 1.2); // BP's little exit kick
    }
  } else {
    // ---- gripped: bicycle model with a fast-fading lock — good for
    // ramming, hopeless in corners. The chassis takes YAW_RESPONSE
    // seconds to take up a yaw command — that lag is most of the
    // "weight" ----
    const lockT = clamp((s.speed - STEER_FULL_BELOW) / (STEER_MIN_AT - STEER_FULL_BELOW), 0, 1);
    const lock = STEER_LOCK_LOW + (STEER_LOCK_HIGH - STEER_LOCK_LOW) * lockT;
    // Briefly soften the steer fed to the yaw model right after a hard
    // landing so the player can't snap-turn out of the squash. Only on the
    // ground (in the air control is already faint); decays to 1.0 over
    // LAND_STEER_SOFTEN_SECS, and is exactly 1.0 once the timer elapses, so
    // it is a no-op in steady state.
    const steerSoften =
      !airborne && s.steerSoftenT > 0 ? 0.5 + 0.5 * (1 - s.steerSoftenT / LAND_STEER_SOFTEN_SECS) : 1;
    let yawTarget = -(s.speed * Math.tan(lock * s.steer * steerSoften)) / WHEELBASE;
    if (airborne) yawTarget *= 0.3; // faint air control, Burnout style
    s.yawVel += (yawTarget - s.yawVel) * Math.min(1, dt / YAW_RESPONSE);
    s.heading = wrapAngle(s.heading + s.yawVel * dt);

    // velocity direction chases the nose — leftover slide from a drift
    // exit bleeds away as grip recovers; a few degrees of working slip
    // in every corner reads as mass
    let chase = GRIP_CHASE * s.grip + DRIFT_CHASE * (1 - s.grip);
    let slip = wrapAngle(s.heading - s.velAngle);
    // ---- Feature C: tire grip curve MODULATES the chase rate (kinematic-
    // compatible — no force replacement). The lateral slip estimate is the
    // working slip; sample the per-variant lateral grip curve at it. Near the
    // curve's peak (small slip) grip is high → the velocity vector hooks the
    // nose at full rate (today's behaviour). Past the peak grip FALLS, so the
    // car keeps less of its chase — it runs wide / the rear walks out, the
    // break-loose feel. Blended behind GRIP_CURVE_BLEND (0 = stock); the sedan
    // default is small so its corner feel is preserved. ----
    if (GRIP_CURVE_BLEND > 0 && !airborne) {
      const coeff = Math.abs(grip(slip, latGripCurve(attribs)));
      const gripMod = clamp(1 + GRIP_CURVE_BLEND * (coeff - GRIP_REF_COEFF), GRIP_MOD_FLOOR, 1.5);
      chase *= gripMod;
    }
    s.velAngle = wrapAngle(s.velAngle + slip * Math.min(1, chase * dt));
    slip = wrapAngle(s.heading - s.velAngle);
    const maxSlip = attribs.drift.maxSlip; // per-variant cap (sedan = today's 40°)
    if (Math.abs(slip) > maxSlip) {
      s.velAngle = wrapAngle(s.heading - Math.sign(slip) * maxSlip);
    }
  }

  // ---- boost EARN (B3/BP "Driving Skills"): drift sideways, fly, and pass
  // traffic close (near-miss credit fed by Game). Boost is the reward for
  // risk — a deeper slide earns faster. Fills the EXTENDED bar (boostCap). --
  let earn = s.nearMissFill; // pending near-miss/oncoming credit, spent now
  s.nearMissFill = 0;
  if (s.drifting) {
    const sideways = Math.abs(wrapAngle(s.heading - s.velAngle)) / attribs.drift.maxSlip;
    earn += REFILL_DRIFT * (0.4 + 0.6 * sideways) * dt;
  }
  if (airborne) earn += REFILL_AIR * dt;
  if (earn > 0) s.boostMeter = Math.min(s.boostCap, s.boostMeter + earn);

  // ---- weight transfer, visual only: lean out of corners, squat under
  // power, dive on the brakes ----
  const rollTarget = clamp(-s.yawVel * s.speed * ROLL_PER_LATG, -ROLL_MAX, ROLL_MAX);
  s.visualRoll += (rollTarget - s.visualRoll) * Math.min(1, dt * 6);
  const accel = (s.speed - speedBefore) / dt;
  const pitchTarget = airborne ? 0 : clamp(accel * PITCH_PER_ACCEL, PITCH_MIN, PITCH_MAX);
  s.visualPitch += (pitchTarget - s.visualPitch) * Math.min(1, dt * 5);

  // ---- front-wheel visual steer (BP GetSteeringAngle), presentation-only ----
  // Same speed-sensitive lock the gripped yaw model uses above (line ~452):
  // MaxAngle at low speed lerps down to MinAngle by SpeedForMinAngle. s.steer
  // is already eased toward input, so steerAngle is smooth with no extra easing.
  // Game.updateWheels yaws the front wheel meshes by this; the sim never reads it.
  // VISUAL_STEER_GAIN exaggerates the RENDERED turn for readability (the handling
  // lock is unchanged) — see the constant's note.
  const lockVis =
    STEER_LOCK_LOW +
    (STEER_LOCK_HIGH - STEER_LOCK_LOW) * clamp((s.speed - STEER_FULL_BELOW) / (STEER_MIN_AT - STEER_FULL_BELOW), 0, 1);
  s.steerAngle = lockVis * s.steer * VISUAL_STEER_GAIN;
  // raw input flags for the wheelspin/lockup spin model (presentation-only)
  s.throttling = input.throttle;
  s.braking = input.brake;

  // ---- write to the body ----
  b.velocity.set(Math.sin(s.velAngle) * s.speed, b.velocity.y, Math.cos(s.velAngle) * s.speed);
  applyChassisOrientation(b, airborne, heightAt, s);
}
