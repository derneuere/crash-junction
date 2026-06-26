import { FIXED_DT } from '../constants';
import type { Variant } from '../types';
import { HANDLING } from '../handling';
import { ENGINE_MODELS, brakeDecelCurve, curveAccel, lsdClamp } from '../engine';
import type { ControlInput } from './input';
import {
  BOOST_ACCEL,
  BURNOUT_ACCEL,
  BURNOUT_ENTER,
  COAST_DRAG,
  DRIFT_MAX_SLIP,
  DRIFT_SCRUB,
  KICK_ACCEL,
  KICK_BELOW,
  KICK_TIME,
  SHIFT_CUT,
  TOP_HARD,
  clamp,
  wrapAngle,
} from './constants';

/** The mutable longitudinal/boost state the speed step reads and writes. */
export interface SpeedState {
  speed: number;
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
  drifting: boolean;
  heading: number;
  velAngle: number;
  readonly boostCap: number;
  // ---- Feature E (engine depth) plumbing, all OPTIONAL so an un-updated caller
  // (which builds the state literal without these) cleanly falls back to the
  // sedan accel-table path = today's behaviour, and replay checksums hold. ----
  /** Active handling variant; absent → 'sedan' (today). When set to bus/tanker
   *  the speed step reads that variant's engine tiers/tables AND switches on the
   *  guarded torque-curve model for it. */
  variant?: Variant;
  /** Flywheel-smoothed delivered engine accel (m/s²), carried across steps so
   *  the torque-curve model spools up/down rather than snapping. Seeded lazily. */
  enginePower?: number;
  /** Synthetic brake-pedal ramp (0..1) for the non-linear brake curve: ramps in
   *  while braking, releases when off the brake. Carried across steps. */
  brakePedal?: number;
}

/**
 * The speed model: throttle/boost acceleration through the gears, the B3 boost
 * economy + sustained-Burnout state machine, braking, drift scrub and the tier
 * clamps. Mutates `s` in place.
 *
 * Feature E layers an OPT-IN, per-variant torque-curve drivetrain on top of the
 * proven per-gear accel table (see ../engine.ts): a torque(rpm) curve through a
 * differential + gearbox, flywheel-smoothed delivery, a rev limiter, a
 * limited-slip clamp and an RWD split, plus a non-linear (soft-start, sharp-end)
 * brake. It is gated per variant by `ENGINE_MODELS[variant].torqueModel` /
 * `.brakeCurve` and is OFF for the sedan, so the sedan path — and its replay
 * checksums — are bit-for-bit the previous behaviour. The speed TIERS and gear
 * ceilings are now read from `HANDLING[variant].engine` (verbatim-equal to the
 * old globals for the sedan), so bus/tanker get their own tables once a caller
 * plumbs `s.variant`.
 */
export function updateSpeed(s: SpeedState, input: ControlInput): void {
  const dt = FIXED_DT;
  // Resolve the per-variant engine vault + drivetrain model. Default sedan ⇒
  // the values below are verbatim-equal to the old module constants, so the
  // un-plumbed caller is behaviour-identical.
  const variant = s.variant ?? 'sedan';
  const eng = HANDLING[variant].engine;
  const model = ENGINE_MODELS[variant];
  const GEAR_TOPS = eng.gearTops;
  const GEAR_ACCEL = eng.gearAccel;
  const CRUISE = eng.cruiseSpeed; // engine-only ceiling (sedan = TOP_CRUISE)
  const BTOP = eng.launchSpeed; // regular-boost ceiling (sedan = BOOST_TOP)
  const BNTOP = eng.burnoutSpeed; // Burnout ceiling (sedan = BURNOUT_TOP)
  const BRAKE = eng.brakeDecel; // flat brake decel (sedan = BRAKE_DECEL)
  // ---- speed: throttle and boost are separate inputs (boost implies
  // full throttle, like BP's boost-over-gas). The engine works through
  // gears: each one shoves a little less, and an upshift cuts torque
  // for a beat — acceleration in steps, not a smooth ramp. The engine
  // ALONE only reaches CRUISE; the speed band above is gated behind
  // earned boost (Burnout risk/reward) ----
  s.boosting = input.boost && s.boostMeter > 0;
  if (input.boost && !s.boostHeld) s.kickLeft = KICK_TIME; // fresh press arms the kick
  s.boostHeld = input.boost;

  // Burnout state (B3): the bar reaching full ARMS a Burnout; while you keep
  // burning, that arm is cashed into a sustained, stronger boost. Refilling
  // to full again mid-Burnout chains another. Dropping out of boost (or
  // emptying the bar) ends it. The chain counts discrete refill EVENTS (the
  // rising edge into full), not every frame the bar happens to be topped.
  const cap = s.boostCap;
  const full = s.boostMeter >= cap * BURNOUT_ENTER;
  if (full) {
    if (!s.burnoutWasFull && s.boosting && s.burnout) s.burnoutChain++; // refilled mid-Burnout → chain
    s.burnoutArmed = true;
  }
  s.burnoutWasFull = full;
  if (s.boosting && s.burnoutArmed) {
    s.burnout = true; // cash the armed Burnout the moment we're burning
  }
  if (!s.boosting || s.boostMeter <= 0) {
    s.burnout = false;
    s.burnoutArmed = false;
    s.burnoutChain = 0;
  }
  // tier ceilings: engine-only cruise, regular boost, sustained Burnout
  const top = s.burnout ? BNTOP : s.boosting ? BTOP : CRUISE;

  // ---- automatic gearbox. The proven rule: walk up to the gear whose ceiling
  // we have outrun. The torque-curve model layers an up-RPM threshold on top
  // (BP shifts at a band fraction, not just at the gear ceiling) so a heavy
  // lump can short-shift before redline — but it can only ADD an earlier
  // upshift, never hold a gear past its ceiling, so the sedan (no torque model)
  // sees the identical walk. ----
  let g = 0;
  while (g < GEAR_TOPS.length - 1 && s.speed > GEAR_TOPS[g]) g++;
  if (model.torqueModel) {
    // up-RPM short-shift: if we're past the gear's up-RPM and there's a gear to
    // take, go up one (auto-box behaviour from gear ratios + up-RPM threshold).
    const gLow = g === 0 ? 0 : GEAR_TOPS[g - 1];
    const bandRPM = clamp(0.25 + (0.75 * (s.speed - gLow)) / (GEAR_TOPS[g] - gLow), 0.25, 1);
    if (bandRPM >= model.upShiftRPM && g < GEAR_TOPS.length - 1) g++;
  }
  if (g > s.gear) s.shiftT = SHIFT_CUT; // upshift: the torque gap
  s.gear = g; // downshifts are instant (retail GearChangeTime is 0)
  s.shiftT = Math.max(0, s.shiftT - dt);
  const gearLow = s.gear === 0 ? 0 : GEAR_TOPS[s.gear - 1];
  // rev limiter: rpm normalised within the gear band, hard-capped at 1 (BP
  // MaxRPM). The torque-curve model bounces delivery off the limiter below.
  s.rpm = clamp(0.25 + (0.75 * (s.speed - gearLow)) / (GEAR_TOPS[s.gear] - gearLow), 0.25, 1);

  // ---- the engine shove this step. `engineAccel(base)` returns the per-gear
  // m/s² to apply, running EITHER the proven flat accel table (sedan / torque
  // model off) OR the torque-curve model (bus/tanker) blended by torqueStrength,
  // flywheel-smoothed, rev-limited and limited-slip clamped. With the model off
  // it returns `base` unchanged, so the sedan path is unaltered. ----
  const engineAccel = (base: number): number => {
    if (!model.torqueModel) return base; // sedan: the proven flat per-gear shove
    // torque(rpm) × gear/diff/efficiency, blended toward the flat shove
    let acc = curveAccel(s.rpm, s.gear, base, model);
    // rev limiter: at/above redline, cut delivered torque (the limiter bounce)
    if (s.rpm >= 1) acc *= model.revLimitCut;
    // RWD split: a rear-only axle puts the power down a touch softer off the
    // line (powerToRear 1 = full; <1 would scale the launch shove down)
    acc *= model.powerToRear;
    // flywheel: smooth the delivery toward `acc` over flywheelTau (heavy
    // rotating mass spools up/down). Seed lazily on first use.
    if (s.enginePower === undefined) s.enginePower = acc;
    const a = model.flywheelTau > 0 ? Math.min(1, dt / model.flywheelTau) : 1;
    const smoothed = s.enginePower + (acc - s.enginePower) * a;
    // limited-slip diff: hold the delivered accel within lsdSpread of the
    // smoothed mean so a torque spike ramps in rather than snapping the drive.
    const clamped = lsdClamp(acc, smoothed, model);
    s.enginePower = smoothed;
    return clamped;
  };

  if (input.throttle && !s.boosting && s.speed < CRUISE) {
    const acc = s.shiftT > 0 ? 0 : engineAccel(GEAR_ACCEL[s.gear]);
    s.speed = Math.min(CRUISE, s.speed + acc * dt);
  } else if (!input.throttle && !s.boosting && !input.brake) {
    s.speed = Math.max(0, s.speed - COAST_DRAG * dt); // coast down
    if (model.torqueModel && s.enginePower !== undefined) s.enginePower = 0; // engine spools down off-throttle
  }
  if (s.boosting) {
    // boost carries the engine shove too (so it never feels weaker than
    // flooring it), plus the boost accel on top, plus the launch kick
    let acc =
      (s.shiftT > 0 ? 0 : engineAccel(GEAR_ACCEL[s.gear])) + (s.burnout ? BURNOUT_ACCEL : BOOST_ACCEL);
    if (s.kickLeft > 0 && s.speed < KICK_BELOW) acc += KICK_ACCEL;
    s.kickLeft -= dt;
    s.speed = Math.min(top, s.speed + acc * dt);
    // drain: a Burnout sips a little slower (a full bar is a real reward)
    s.boostMeter = Math.max(0, s.boostMeter - dt * (s.burnout ? 0.85 : 1));
  }

  // ---- braking. Stock = a flat decel. The torque-model variants use a
  // non-linear (soft-start, sharp-end) brake curve driven by a synthetic pedal
  // ramp: the bite eases in over the first beat then sharpens, so a heavy rig
  // settles onto the brakes instead of locking instantly. Gated by
  // model.brakeCurve, so the sedan keeps the flat BRAKE decel verbatim. ----
  if (model.brakeCurve) {
    s.brakePedal =
      input.brake && !s.drifting
        ? Math.min(1, (s.brakePedal ?? 0) + dt / 0.35) // ramp to full pedal in ~0.35 s
        : Math.max(0, (s.brakePedal ?? 0) - dt / 0.2); // release faster
  }
  if (input.brake && !s.drifting) {
    const decel = model.brakeCurve ? brakeDecelCurve(BRAKE, s.brakePedal ?? 0, model) : BRAKE;
    s.speed = Math.max(0, s.speed - decel * dt);
  }
  if (s.drifting) {
    // a deeper angle scrubs more speed — shallow drifts carry momentum
    const sideways = Math.abs(wrapAngle(s.heading - s.velAngle)) / DRIFT_MAX_SLIP;
    s.speed = Math.max(10, s.speed - DRIFT_SCRUB * (0.35 + 0.65 * sideways) * dt);
  }
  if (s.speed > top) s.speed = Math.max(top, s.speed - 6 * dt); // settle down a tier
  if (s.speed > TOP_HARD) s.speed = TOP_HARD; // absolute clamp
}
