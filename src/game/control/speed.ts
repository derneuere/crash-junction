import { FIXED_DT } from '../constants';
import type { ControlInput } from './input';
import {
  BOOST_ACCEL,
  BOOST_TOP,
  BRAKE_DECEL,
  BURNOUT_ACCEL,
  BURNOUT_ENTER,
  BURNOUT_TOP,
  COAST_DRAG,
  DRIFT_MAX_SLIP,
  DRIFT_SCRUB,
  GEAR_ACCEL,
  GEAR_TOPS,
  KICK_ACCEL,
  KICK_BELOW,
  KICK_TIME,
  SHIFT_CUT,
  TOP_CRUISE,
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
}

/**
 * The speed model: throttle/boost acceleration through the gears, the B3 boost
 * economy + sustained-Burnout state machine, braking, drift scrub and the tier
 * clamps. Mutates `s` in place; every number, branch and order of operations is
 * preserved verbatim from the inlined version so the replay checksums hold.
 */
export function updateSpeed(s: SpeedState, input: ControlInput): void {
  const dt = FIXED_DT;
  // ---- speed: throttle and boost are separate inputs (boost implies
  // full throttle, like BP's boost-over-gas). The engine works through
  // gears: each one shoves a little less, and an upshift cuts torque
  // for a beat — acceleration in steps, not a smooth ramp. The engine
  // ALONE only reaches TOP_CRUISE; the speed band above is gated behind
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
  const top = s.burnout ? BURNOUT_TOP : s.boosting ? BOOST_TOP : TOP_CRUISE;

  let g = 0;
  while (g < GEAR_TOPS.length - 1 && s.speed > GEAR_TOPS[g]) g++;
  if (g > s.gear) s.shiftT = SHIFT_CUT; // upshift: the torque gap
  s.gear = g; // downshifts are instant (retail GearChangeTime is 0)
  s.shiftT = Math.max(0, s.shiftT - dt);
  const gearLow = s.gear === 0 ? 0 : GEAR_TOPS[s.gear - 1];
  s.rpm = clamp(0.25 + (0.75 * (s.speed - gearLow)) / (GEAR_TOPS[s.gear] - gearLow), 0.25, 1);

  if (input.throttle && !s.boosting && s.speed < TOP_CRUISE) {
    const acc = s.shiftT > 0 ? 0 : GEAR_ACCEL[s.gear];
    s.speed = Math.min(TOP_CRUISE, s.speed + acc * dt);
  } else if (!input.throttle && !s.boosting && !input.brake) {
    s.speed = Math.max(0, s.speed - COAST_DRAG * dt); // coast down
  }
  if (s.boosting) {
    // boost carries the engine shove too (so it never feels weaker than
    // flooring it), plus the boost accel on top, plus the launch kick
    let acc = (s.shiftT > 0 ? 0 : GEAR_ACCEL[s.gear]) + (s.burnout ? BURNOUT_ACCEL : BOOST_ACCEL);
    if (s.kickLeft > 0 && s.speed < KICK_BELOW) acc += KICK_ACCEL;
    s.kickLeft -= dt;
    s.speed = Math.min(top, s.speed + acc * dt);
    // drain: a Burnout sips a little slower (a full bar is a real reward)
    s.boostMeter = Math.max(0, s.boostMeter - dt * (s.burnout ? 0.85 : 1));
  }
  if (input.brake && !s.drifting) s.speed = Math.max(0, s.speed - BRAKE_DECEL * dt);
  if (s.drifting) {
    // a deeper angle scrubs more speed — shallow drifts carry momentum
    const sideways = Math.abs(wrapAngle(s.heading - s.velAngle)) / DRIFT_MAX_SLIP;
    s.speed = Math.max(10, s.speed - DRIFT_SCRUB * (0.35 + 0.65 * sideways) * dt);
  }
  if (s.speed > top) s.speed = Math.max(top, s.speed - 6 * dt); // settle down a tier
  if (s.speed > TOP_HARD) s.speed = TOP_HARD; // absolute clamp
}
