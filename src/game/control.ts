import * as CANNON from 'cannon-es';
import { FIXED_DT, LAUNCH_SPEED } from './constants';
import type { Actor } from './types';
import type { HeightSampler } from './suspension';

const UP_AXIS = new CANNON.Vec3(0, 1, 0);
const _up = new CANNON.Vec3();

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
//    (MaxBoostSpeed sits ~+20 mph over MaxSpeed). 5-unit bar (GamePlayData
//    boost Capacity default). Refill-from-drift/airtime rates are invented —
//    BP keeps earn rules in code (Stunt-type behavior, ECarType 2).

// locks run ×1.5 over the BP-derived values (10°/1.6°) — hands-on verdict:
// authentic locks made ramming at speed nearly impossible on these tight maps
const STEER_LOCK_LOW = (22.5 * Math.PI) / 180;
const STEER_LOCK_HIGH = (3.6 * Math.PI) / 180;
const STEER_FULL_BELOW = 13.4; // m/s (30 mph)
const STEER_MIN_AT = 38; // m/s — lock fades fast: gripped steering is for
//                          ramming and lane changes, corners want the drift
//                          (BP SpeedForMinAngle is 90+ mph; ours is tighter
//                          because the map is tiny)
const STEER_RAMP = 1 / 0.4; // full lock in 0.4 s
const CENTER_BIAS = 2.5;
const WHEELBASE = 2.95;

const DRIFT_MIN_SPEED = 18; // m/s (40 mph)
// 40°, down from BP's 60° modal DriftMaxAngle — at 60° the car travels so
// far sideways that every walled sweeper ends in the barrier
const DRIFT_MAX_SLIP = (40 * Math.PI) / 180;
const DRIFT_EXIT_SLIP = (7 * Math.PI) / 180; // straightened out → tyres hook up
const DRIFT_ENTRY_TIME = 0.3; // s to reach base slip
const DRIFT_RECOVER_TIME = 0.55; // s back to full grip — BP hooks up fast
//                                  (NeutralTimeToReduceDrift = 0 on all 48 cars)
const GRIP_CHASE = 6.5; // gripped: velocity dir chases heading (1/s) — a few °
//                         of working slip in every corner reads as mass
const DRIFT_CHASE = 2.4; // recovering from a slide: it lags behind (1/s)
const DRIFT_DEEPEN = 1 / 0.45; // slip chases a deeper angle at this rate (1/s)
//                               (eased off 0.35 s — the angle slammed in)
const DRIFT_RELAX = 1 / 0.28; // straightening is brisker than deepening —
//                               the community-felt "instant hook-up"
const DRIFT_CARVE = 1.6; // path bend per rad of slip (1/s) — a deeper drift
//                          IS a tighter corner; that's what the angle is for
const DRIFT_TIGHTEN = (10 * Math.PI) / 180; // mid-drift brake tap digs in deeper
const COUNTERSTEER = 1.8;
const DRIFT_SCRUB = 3.5; // m/s² speed bleed at full slip (shallow scrubs less)

// weight feel (invented — BP gets this from real rigid-body dynamics):
const YAW_RESPONSE = 0.24; // s for the chassis to take up a yaw command
const ROLL_PER_LATG = 0.0033; // body roll vs lateral accel (rad per m/s²·v)
const ROLL_MAX = 0.09; // ~5°
const PITCH_PER_ACCEL = 0.0045; // squat/dive vs longitudinal accel
const PITCH_MIN = -0.05; // brake dive ~3°
const PITCH_MAX = 0.035; // boost squat ~2°

const TOP_SPEED = LAUNCH_SPEED;
const BOOST_TOP = 48;

// gears: BP runs up to 6 ratios (GearRatios1/2 vec slots) shifting up at
// 4500–7900 RPM. GearChangeTime is 0 in every retail vault — the felt
// "step" comes from torque×ratio dropping at each shift — but we keep a
// tiny torque gap so the steps read on a keyboard. Gear 6 is the boost
// band (MaxBoostSpeed sits ~20 mph over MaxSpeed).
const GEAR_TOPS = [7, 13, 21, 29, TOP_SPEED, BOOST_TOP]; // m/s ceiling per gear
const GEAR_ACCEL = [23, 20.5, 17.5, 15, 13, 10.5]; // m/s² of engine shove per gear
const SHIFT_CUT = 0.12; // s of torque gap on an upshift

const BOOST_ACCEL = 8;
const KICK_ACCEL = 15;
const KICK_TIME = 0.75;
const KICK_BELOW = 42;
const BRAKE_DECEL = 26;
const COAST_DRAG = 4.5; // m/s² rolloff with no throttle
export const BOOST_CAP = 5; // seconds of full burn
const REFILL_DRIFT = 0.45; // per s while drifting (invented)
const REFILL_AIR = 0.6; // per s airborne (invented)

export interface ControlInput {
  steer: number; // -1..1
  throttle: boolean; // engine acceleration — separate from boost
  boost: boolean;
  brake: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class PlayerControl {
  heading = 0; // nose yaw; world dir = (sin h, 0, cos h)
  velAngle = 0; // velocity yaw — lags heading while drifting
  steer = 0;
  speed = 0;
  drifting = false;
  boosting = false;
  boostMeter = BOOST_CAP;
  gear = 0; // 0-based; GEAR_TOPS[gear] is this gear's ceiling
  rpm = 0.25; // 0..1 within the current gear band — drives the engine pitch
  visualPitch = 0; // squat/dive, applied to the visual hull only
  visualRoll = 0; // body lean, ditto
  private shiftT = 0; // torque-gap timer after an upshift
  private yawVel = 0; // the chassis takes time to start (and stop) rotating
  private grip = 1; // 1 = full grip, 0 = drift slip
  private kickLeft = 0;
  private boostHeld = false;
  private tippedTime = 0;
  private recentBrake = 0; // tap buffer: a brake tap arms the drift briefly
  private brakeWasDown = false; // edge detector for mid-drift tighten taps
  private tighten = 0; // 1 right after a mid-drift tap, decays over ~0.6 s

  reset(heading: number): void {
    this.heading = heading;
    this.velAngle = heading;
    this.steer = 0;
    this.speed = 0;
    this.drifting = false;
    this.boosting = false;
    this.boostMeter = BOOST_CAP;
    this.gear = 0;
    this.rpm = 0.25;
    this.shiftT = 0;
    this.visualPitch = 0;
    this.visualRoll = 0;
    this.yawVel = 0;
    this.grip = 1;
    this.kickLeft = 0;
    this.boostHeld = false;
    this.tippedTime = 0;
    this.recentBrake = 0;
    this.brakeWasDown = false;
    this.tighten = 0;
  }

  update(player: Actor, input: ControlInput, heightAt: HeightSampler): void {
    const b = player.body;
    const dt = FIXED_DT;
    if (!player.started) {
      player.started = true;
      b.wakeUp(); // bodies spawn asleep; velocity writes don't wake them
    }

    // ---- tipped over (a blast can do it in practice mode): let physics
    // tumble the car freely, then right it after a beat, Burnout-style ----
    b.quaternion.vmult(UP_AXIS, _up);
    if (_up.y < 0.5) {
      this.tippedTime += dt;
      this.speed = Math.hypot(b.velocity.x, b.velocity.z); // track reality
      const ride = player.spec?.rideHeight ?? 0.8;
      // righting snaps the car to the road, so wait until it's actually near
      // the road — a car tumbling mid-air would teleport down from altitude
      const nearGround = b.position.y - heightAt(b.position.x, b.position.z) < ride + 1.5;
      if (this.tippedTime > 1.2 && nearGround) {
        this.tippedTime = 0;
        this.speed *= 0.25;
        this.velAngle = this.heading;
        this.yawVel = 0;
        b.position.y = heightAt(b.position.x, b.position.z) + (player.spec?.rideHeight ?? 0.8) + 0.05;
        b.quaternion.setFromAxisAngle(UP_AXIS, this.heading + Math.PI);
        b.angularVelocity.set(0, 0, 0);
        b.velocity.set(Math.sin(this.velAngle) * this.speed, 0, Math.cos(this.velAngle) * this.speed);
      }
      return;
    }
    this.tippedTime = 0;

    // ---- steering ramp (return-to-center is faster than steering in) ----
    const target = clamp(input.steer, -1, 1);
    const centering = Math.abs(target) < Math.abs(this.steer) || target * this.steer < 0;
    const rate = STEER_RAMP * (centering ? CENTER_BIAS : 1);
    this.steer += clamp(target - this.steer, -rate * dt, rate * dt);

    // ---- drift state. The brake tap is buffered for a beat, so both
    // "steer then tap" and "tap then steer" enter the slide; a fresh tap
    // mid-slide tightens the angle instead. The drift itself ends in the
    // slip model below — by straightening out, not by releasing steer ----
    const freshTap = input.brake && !this.brakeWasDown;
    this.brakeWasDown = input.brake;
    this.recentBrake = input.brake ? 0.25 : Math.max(0, this.recentBrake - dt);
    if (!this.drifting && this.recentBrake > 0 && Math.abs(this.steer) > 0.3 && this.speed > DRIFT_MIN_SPEED) {
      this.drifting = true; // a tap is enough — the slide persists while sideways
      this.tighten = 0;
    } else if (this.drifting && freshTap) {
      this.tighten = 1;
    }
    this.tighten = Math.max(0, this.tighten - dt / 0.6);
    const gripGoal = this.drifting ? 0 : 1;
    this.grip += (gripGoal - this.grip) * Math.min(1, dt / (this.drifting ? DRIFT_ENTRY_TIME : DRIFT_RECOVER_TIME));

    const speedBefore = this.speed;

    // ---- speed: throttle and boost are separate inputs (boost implies
    // full throttle, like BP's boost-over-gas). The engine works through
    // gears: each one shoves a little less, and an upshift cuts torque
    // for a beat — acceleration in steps, not a smooth ramp ----
    this.boosting = input.boost && this.boostMeter > 0;
    if (input.boost && !this.boostHeld) this.kickLeft = KICK_TIME; // fresh press arms the kick
    this.boostHeld = input.boost;
    const top = this.boosting ? BOOST_TOP : TOP_SPEED;

    let g = 0;
    while (g < GEAR_TOPS.length - 1 && this.speed > GEAR_TOPS[g]) g++;
    if (g > this.gear) this.shiftT = SHIFT_CUT; // upshift: the torque gap
    this.gear = g; // downshifts are instant (retail GearChangeTime is 0)
    this.shiftT = Math.max(0, this.shiftT - dt);
    const gearLow = this.gear === 0 ? 0 : GEAR_TOPS[this.gear - 1];
    this.rpm = clamp(0.25 + (0.75 * (this.speed - gearLow)) / (GEAR_TOPS[this.gear] - gearLow), 0.25, 1);

    if ((input.throttle || this.boosting) && this.speed < TOP_SPEED) {
      const acc = this.shiftT > 0 ? 0 : GEAR_ACCEL[this.gear];
      this.speed = Math.min(TOP_SPEED, this.speed + acc * dt);
    } else if (!input.throttle && !this.boosting && !input.brake) {
      this.speed = Math.max(0, this.speed - COAST_DRAG * dt); // coast down
    }
    if (this.boosting) {
      let acc = BOOST_ACCEL;
      if (this.kickLeft > 0 && this.speed < KICK_BELOW) acc += KICK_ACCEL;
      this.kickLeft -= dt;
      this.speed = Math.min(top, this.speed + acc * dt);
      this.boostMeter = Math.max(0, this.boostMeter - dt);
    }
    if (input.brake && !this.drifting) this.speed = Math.max(0, this.speed - BRAKE_DECEL * dt);
    if (this.drifting) {
      // a deeper angle scrubs more speed — shallow drifts carry momentum
      const sideways = Math.abs(wrapAngle(this.heading - this.velAngle)) / DRIFT_MAX_SLIP;
      this.speed = Math.max(10, this.speed - DRIFT_SCRUB * (0.35 + 0.65 * sideways) * dt);
    }
    if (this.speed > top) this.speed = Math.max(top, this.speed - 6 * dt); // settle down off boost

    // ---- yaw. The minus sign: with y up and headings mapped to
    // (sin h, 0, cos h), turning right (screen-right of travel) is -h ----
    const airborne = !player.susp.some((s) => s.grounded);
    if (this.drifting) {
      // ---- slip-angle drift, the corner tool: your steering sets the
      // ANGLE of the slide — hold it deep, feather it shallow — and the
      // path bends in proportion, so a deeper drift is a tighter corner.
      // Straighten the wheel and the slip unwinds until the tyres hook
      // up; countersteer unwinds it faster, and held past centre it
      // swings the tail out the other way (chaining, no new tap) ----
      let slip = wrapAngle(this.heading - this.velAngle);
      let want = -this.steer * DRIFT_MAX_SLIP * clamp(this.speed / 30, 0.7, 1);
      if (want !== 0) {
        want = clamp(want + Math.sign(want) * DRIFT_TIGHTEN * this.tighten, -DRIFT_MAX_SLIP, DRIFT_MAX_SLIP);
      }
      const deepening = want * slip >= 0 && Math.abs(want) > Math.abs(slip);
      let chaseRate = deepening ? DRIFT_DEEPEN : DRIFT_RELAX;
      if (this.steer * slip > 0) chaseRate *= COUNTERSTEER; // steering against the slide
      if (airborne) chaseRate *= 0.3; // attitude mostly holds in the air
      slip += (want - slip) * Math.min(1, chaseRate * dt);
      if (!airborne) this.velAngle = wrapAngle(this.velAngle + slip * DRIFT_CARVE * dt);
      const heading = wrapAngle(this.velAngle + slip);
      this.yawVel = wrapAngle(heading - this.heading) / dt; // keep roll & exit handoff continuous
      this.heading = heading;
      if ((Math.abs(slip) < DRIFT_EXIT_SLIP && Math.abs(want) < DRIFT_EXIT_SLIP * 2) || this.speed < 12) {
        this.drifting = false; // straightened out — grip recovers over the next beat
        this.speed = Math.min(TOP_SPEED, this.speed + 1.2); // BP's little exit kick
      }
    } else {
      // ---- gripped: bicycle model with a fast-fading lock — good for
      // ramming, hopeless in corners. The chassis takes YAW_RESPONSE
      // seconds to take up a yaw command — that lag is most of the
      // "weight" ----
      const lockT = clamp((this.speed - STEER_FULL_BELOW) / (STEER_MIN_AT - STEER_FULL_BELOW), 0, 1);
      const lock = STEER_LOCK_LOW + (STEER_LOCK_HIGH - STEER_LOCK_LOW) * lockT;
      let yawTarget = -(this.speed * Math.tan(lock * this.steer)) / WHEELBASE;
      if (airborne) yawTarget *= 0.3; // faint air control, Burnout style
      this.yawVel += (yawTarget - this.yawVel) * Math.min(1, dt / YAW_RESPONSE);
      this.heading = wrapAngle(this.heading + this.yawVel * dt);

      // velocity direction chases the nose — leftover slide from a drift
      // exit bleeds away as grip recovers; a few degrees of working slip
      // in every corner reads as mass
      const chase = GRIP_CHASE * this.grip + DRIFT_CHASE * (1 - this.grip);
      let slip = wrapAngle(this.heading - this.velAngle);
      this.velAngle = wrapAngle(this.velAngle + slip * Math.min(1, chase * dt));
      slip = wrapAngle(this.heading - this.velAngle);
      if (Math.abs(slip) > DRIFT_MAX_SLIP) {
        this.velAngle = wrapAngle(this.heading - Math.sign(slip) * DRIFT_MAX_SLIP);
      }
    }

    // ---- boost refill (invented: Stunt-style — earn by driving sideways
    // and flying; a deeper slide earns faster) ----
    if (this.drifting) {
      const sideways = Math.abs(wrapAngle(this.heading - this.velAngle)) / DRIFT_MAX_SLIP;
      this.boostMeter = Math.min(BOOST_CAP, this.boostMeter + REFILL_DRIFT * (0.4 + 0.6 * sideways) * dt);
    }
    if (airborne) this.boostMeter = Math.min(BOOST_CAP, this.boostMeter + REFILL_AIR * dt);

    // ---- weight transfer, visual only: lean out of corners, squat under
    // power, dive on the brakes ----
    const rollTarget = clamp(-this.yawVel * this.speed * ROLL_PER_LATG, -ROLL_MAX, ROLL_MAX);
    this.visualRoll += (rollTarget - this.visualRoll) * Math.min(1, dt * 6);
    const accel = (this.speed - speedBefore) / dt;
    const pitchTarget = airborne ? 0 : clamp(accel * PITCH_PER_ACCEL, PITCH_MIN, PITCH_MAX);
    this.visualPitch += (pitchTarget - this.visualPitch) * Math.min(1, dt * 5);

    // ---- write to the body ----
    b.velocity.set(Math.sin(this.velAngle) * this.speed, b.velocity.y, Math.cos(this.velAngle) * this.speed);
    const slope = Math.abs(
      heightAt(b.position.x + Math.sin(this.heading) * 1.6, b.position.z + Math.cos(this.heading) * 1.6) -
        heightAt(b.position.x - Math.sin(this.heading) * 1.6, b.position.z - Math.cos(this.heading) * 1.6),
    );
    if (!airborne && slope < 0.02) {
      b.angularVelocity.set(0, 0, 0);
      b.quaternion.setFromAxisAngle(UP_AXIS, this.heading + Math.PI); // hull forward is -z
    } else {
      // ramps and air: keep the suspension/ballistic pitch, only pin yaw
      b.angularVelocity.y = 0;
      b.angularVelocity.x *= 0.99;
      b.angularVelocity.z *= 0.99;
    }
  }
}
