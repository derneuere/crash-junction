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
import type { ControlInput } from './input';
import { applyChassisOrientation } from './orientation';
import { updateSpeed } from './speed';
import {
  BURNOUT_TOP,
  CENTER_BIAS,
  COUNTERSTEER,
  DRIFT_CARVE,
  DRIFT_CHASE,
  DRIFT_DEEPEN,
  DRIFT_ENTRY_TIME,
  DRIFT_EXIT_SLIP,
  DRIFT_MAX_SLIP,
  DRIFT_MIN_SPEED,
  DRIFT_RECOVER_TIME,
  DRIFT_RELAX,
  DRIFT_TIGHTEN,
  GRIP_CHASE,
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
  VISUAL_STEER_GAIN,
  WHEELBASE,
  YAW_RESPONSE,
  clamp,
  wrapAngle,
} from './constants';

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
  drifting: boolean;
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
): void {
  const b = player.body;
  const dt = FIXED_DT;

  // ---- steering ramp (return-to-center is faster than steering in) ----
  const target = clamp(input.steer, -1, 1);
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
  if (!s.drifting && s.recentBrake > 0 && Math.abs(s.steer) > 0.3 && s.speed > DRIFT_MIN_SPEED) {
    s.drifting = true; // a tap is enough — the slide persists while sideways
    s.tighten = 0;
  } else if (s.drifting && freshTap) {
    s.tighten = 1;
  }
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
    let slip = wrapAngle(s.heading - s.velAngle);
    let want = -s.steer * DRIFT_MAX_SLIP * clamp(s.speed / 30, 0.7, 1);
    if (want !== 0) {
      want = clamp(want + Math.sign(want) * DRIFT_TIGHTEN * s.tighten, -DRIFT_MAX_SLIP, DRIFT_MAX_SLIP);
    }
    const deepening = want * slip >= 0 && Math.abs(want) > Math.abs(slip);
    let chaseRate = deepening ? DRIFT_DEEPEN : DRIFT_RELAX;
    if (s.steer * slip > 0) chaseRate *= COUNTERSTEER; // steering against the slide
    if (airborne) chaseRate *= 0.3; // attitude mostly holds in the air
    slip += (want - slip) * Math.min(1, chaseRate * dt);
    if (!airborne) s.velAngle = wrapAngle(s.velAngle + slip * DRIFT_CARVE * dt);
    const heading = wrapAngle(s.velAngle + slip);
    s.yawVel = wrapAngle(heading - s.heading) / dt; // keep roll & exit handoff continuous
    s.heading = heading;
    if ((Math.abs(slip) < DRIFT_EXIT_SLIP && Math.abs(want) < DRIFT_EXIT_SLIP * 2) || s.speed < 12) {
      s.drifting = false; // straightened out — grip recovers over the next beat
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
    const chase = GRIP_CHASE * s.grip + DRIFT_CHASE * (1 - s.grip);
    let slip = wrapAngle(s.heading - s.velAngle);
    s.velAngle = wrapAngle(s.velAngle + slip * Math.min(1, chase * dt));
    slip = wrapAngle(s.heading - s.velAngle);
    if (Math.abs(slip) > DRIFT_MAX_SLIP) {
      s.velAngle = wrapAngle(s.heading - Math.sign(slip) * DRIFT_MAX_SLIP);
    }
  }

  // ---- boost EARN (B3/BP "Driving Skills"): drift sideways, fly, and pass
  // traffic close (near-miss credit fed by Game). Boost is the reward for
  // risk — a deeper slide earns faster. Fills the EXTENDED bar (boostCap). --
  let earn = s.nearMissFill; // pending near-miss/oncoming credit, spent now
  s.nearMissFill = 0;
  if (s.drifting) {
    const sideways = Math.abs(wrapAngle(s.heading - s.velAngle)) / DRIFT_MAX_SLIP;
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
