import * as CANNON from 'cannon-es';
import {
  AIR_DAMP,
  AIR_MIN_ROLL_TO_CORRECT,
  AIR_PITCH_FOLLOW_RATE,
  AIR_ROLL_CORRECTION,
  AIR_STEER_TORQUE,
  BOOST_MAX_SEGMENTS,
  BOOST_SEGMENT_SECS,
  BOOST_START_SEGMENTS,
  BURNOUT_SPEED,
  CRUISE_SPEED,
  FIXED_DT,
  LAND_SETTLE_SECS,
  LAND_STEER_SOFTEN_SECS,
  LAND_VY_ABSORB,
  LAUNCH_SPEED,
  MAX_WHEELIE_ANGLE,
  TAKEOFF_PITCH_DAMP,
  TAKEOFF_ROLL_DAMP,
  TAKEOFF_ROLL_LIMIT,
  TAKEOFF_YAW_DAMP,
} from './constants';
import type { Actor } from './types';
import type { HeightSampler } from './suspension';

const UP_AXIS = new CANNON.Vec3(0, 1, 0);
const X_AXIS = new CANNON.Vec3(1, 0, 0);
const Z_AXIS = new CANNON.Vec3(0, 0, 1);
const _up = new CANNON.Vec3();
const _qTilt = new CANNON.Quaternion();
// Scratch target for the landing settle: the road-plane pose case 1 would snap
// to, blended into over LAND_SETTLE_SECS instead of an instant re-pin.
const _qLand = new CANNON.Quaternion();
// Scratch target for the airborne attitude (case 3): yaw=heading, pitch chases
// the trajectory, roll auto-levels. Written straight onto the body each air
// frame, the same kinematic-orientation idiom the on-ground pin (case 1) uses.
const _qAir = new CANNON.Quaternion();

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

// Three speed tiers (Burnout risk/reward): engine-only CRUISE, regular boost
// to BOOST_TOP, and the full-bar "Burnout" to BURNOUT_SPEED (the reward
// ceiling). CRUISE sits a clear step below boosted speed so the engine alone
// never feels as fast as earning + burning boost.
const TOP_CRUISE = CRUISE_SPEED; // engine-only ceiling (31)
const BOOST_TOP = LAUNCH_SPEED; // regular-boost ceiling (39 — the familiar fast)
const BURNOUT_TOP = BURNOUT_SPEED; // sustained-Burnout ceiling (44 — the reward)
const TOP_HARD = 48; // absolute speed clamp (e.g. downhill carry)

// gears: BP runs up to 6 ratios (GearRatios1/2 vec slots) shifting up at
// 4500–7900 RPM. GearChangeTime is 0 in every retail vault — the felt
// "step" comes from torque×ratio dropping at each shift — but we keep a
// tiny torque gap so the steps read on a keyboard. The top gears are the
// boost band (MaxBoostSpeed sits over MaxSpeed; the engine alone tops out
// in gear 5 at CRUISE).
const GEAR_TOPS = [7, 13, 21, 29, TOP_CRUISE, BURNOUT_TOP]; // m/s ceiling per gear
const GEAR_ACCEL = [23, 20.5, 17.5, 15, 13, 10.5]; // m/s² of engine shove per gear
const SHIFT_CUT = 0.12; // s of torque gap on an upshift

const BOOST_ACCEL = 8; // regular-boost sustained accel
const BURNOUT_ACCEL = 11; // Burnout-state accel — markedly stronger
const KICK_ACCEL = 15;
const KICK_TIME = 0.75;
const KICK_BELOW = 42;
const BRAKE_DECEL = 26;
const COAST_DRAG = 4.5; // m/s² rolloff with no throttle

// ---- boost economy (earned + segmented; see header) ----
// One full segment is BOOST_SEGMENT_SECS of burn; the bar holds `segments` of
// them. BOOST_CAP is kept as the *starting* capacity (one segment) so callers
// that imported it as the fraction reference still read a sane base.
export const BOOST_CAP = BOOST_SEGMENT_SECS * BOOST_START_SEGMENTS;
const REFILL_DRIFT = 0.55; // per s while drifting at full slip (deeper = faster)
const REFILL_AIR = 0.7; // per s airborne
const REFILL_NEARMISS = 0.45; // per near-miss/oncoming event (Game feeds it)
const BURNOUT_ENTER = 0.999; // bar fraction that arms the sustained Burnout

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
  // ---- boost economy ----
  // Start with the first segment charged (B3 starts a run WITH boost in the
  // bar): you can boost off the line, but it DRAINS and must be re-earned —
  // that spend/earn loop is the change, not "begin empty".
  boostMeter = BOOST_SEGMENT_SECS * BOOST_START_SEGMENTS;
  boostSegments = BOOST_START_SEGMENTS; // bar length in segments (B3 1x→4x)
  burnout = false; // sustained Burnout state (full-bar tip-in)
  burnoutChain = 0; // Burnouts strung together without dropping out
  private burnoutArmed = false; // bar reached full → next burn is a Burnout
  private burnoutWasFull = false; // edge detector: only chain on refill-to-full
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
  private nearMissFill = 0; // pending boost credit from near-misses (Game feeds it)
  // ---- airborne / jump attitude bookkeeping (consumed by the air & landing
  // model). Every field is re-seeded in reset() — a missed seed silently
  // breaks replay reproducibility. ----
  private hadAirLastFrame = false; // edge detector for takeoff/landing
  private timeInAir = 0; // seconds since takeoff (0 on ground)
  private takeoffHeading = 0; // launch attitude snapshot
  private landingSettleT = 0; // s remaining of the road-plane settle blend
  private steerSoftenT = 0; // s remaining of post-landing steer softening
  private airPitch = 0; // eased airborne pitch — chases the trajectory tangent
  private airRoll = 0; // eased airborne roll — player lean that auto-levels

  /** Max meter the bar can hold right now (segments × segment length). */
  get boostCap(): number {
    return this.boostSegments * BOOST_SEGMENT_SECS;
  }

  /** A takedown extends the bar one segment (up to B3's 4x) AND instantly
   *  refills the whole, now-larger bar — the chained reward loop. */
  addBoostSegment(): void {
    this.boostSegments = Math.min(BOOST_MAX_SEGMENTS, this.boostSegments + 1);
    this.boostMeter = this.boostCap; // full refill on the extended bar
  }

  /** Crashing/getting wrecked collapses the earned bar back to one segment. */
  resetBoostBar(): void {
    this.boostSegments = BOOST_START_SEGMENTS;
    this.boostMeter = Math.min(this.boostMeter, this.boostCap);
    this.burnout = false;
    this.burnoutChain = 0;
    this.burnoutArmed = false;
    this.burnoutWasFull = false;
  }

  /** Game reports a near-miss / oncoming pass; credits a pulse of boost
   *  (Burnout's "Driving Skills" fill). Accumulated, spent next update. */
  nearMiss(strength = 1): void {
    this.nearMissFill += REFILL_NEARMISS * strength;
  }

  reset(heading: number): void {
    this.heading = heading;
    this.velAngle = heading;
    this.steer = 0;
    this.speed = 0;
    this.drifting = false;
    this.boosting = false;
    this.boostMeter = BOOST_SEGMENT_SECS * BOOST_START_SEGMENTS; // start charged
    this.boostSegments = BOOST_START_SEGMENTS;
    this.burnout = false;
    this.burnoutChain = 0;
    this.burnoutArmed = false;
    this.burnoutWasFull = false;
    this.nearMissFill = 0;
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
    this.hadAirLastFrame = false;
    this.timeInAir = 0;
    this.takeoffHeading = 0;
    this.landingSettleT = 0;
    this.steerSoftenT = 0;
    this.airPitch = 0;
    this.airRoll = 0;
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
    // for a beat — acceleration in steps, not a smooth ramp. The engine
    // ALONE only reaches TOP_CRUISE; the speed band above is gated behind
    // earned boost (Burnout risk/reward) ----
    this.boosting = input.boost && this.boostMeter > 0;
    if (input.boost && !this.boostHeld) this.kickLeft = KICK_TIME; // fresh press arms the kick
    this.boostHeld = input.boost;

    // Burnout state (B3): the bar reaching full ARMS a Burnout; while you keep
    // burning, that arm is cashed into a sustained, stronger boost. Refilling
    // to full again mid-Burnout chains another. Dropping out of boost (or
    // emptying the bar) ends it. The chain counts discrete refill EVENTS (the
    // rising edge into full), not every frame the bar happens to be topped.
    const cap = this.boostCap;
    const full = this.boostMeter >= cap * BURNOUT_ENTER;
    if (full) {
      if (!this.burnoutWasFull && this.boosting && this.burnout) this.burnoutChain++; // refilled mid-Burnout → chain
      this.burnoutArmed = true;
    }
    this.burnoutWasFull = full;
    if (this.boosting && this.burnoutArmed) {
      this.burnout = true; // cash the armed Burnout the moment we're burning
    }
    if (!this.boosting || this.boostMeter <= 0) {
      this.burnout = false;
      this.burnoutArmed = false;
      this.burnoutChain = 0;
    }
    // tier ceilings: engine-only cruise, regular boost, sustained Burnout
    const top = this.burnout ? BURNOUT_TOP : this.boosting ? BOOST_TOP : TOP_CRUISE;

    let g = 0;
    while (g < GEAR_TOPS.length - 1 && this.speed > GEAR_TOPS[g]) g++;
    if (g > this.gear) this.shiftT = SHIFT_CUT; // upshift: the torque gap
    this.gear = g; // downshifts are instant (retail GearChangeTime is 0)
    this.shiftT = Math.max(0, this.shiftT - dt);
    const gearLow = this.gear === 0 ? 0 : GEAR_TOPS[this.gear - 1];
    this.rpm = clamp(0.25 + (0.75 * (this.speed - gearLow)) / (GEAR_TOPS[this.gear] - gearLow), 0.25, 1);

    if (input.throttle && !this.boosting && this.speed < TOP_CRUISE) {
      const acc = this.shiftT > 0 ? 0 : GEAR_ACCEL[this.gear];
      this.speed = Math.min(TOP_CRUISE, this.speed + acc * dt);
    } else if (!input.throttle && !this.boosting && !input.brake) {
      this.speed = Math.max(0, this.speed - COAST_DRAG * dt); // coast down
    }
    if (this.boosting) {
      // boost carries the engine shove too (so it never feels weaker than
      // flooring it), plus the boost accel on top, plus the launch kick
      let acc = (this.shiftT > 0 ? 0 : GEAR_ACCEL[this.gear]) + (this.burnout ? BURNOUT_ACCEL : BOOST_ACCEL);
      if (this.kickLeft > 0 && this.speed < KICK_BELOW) acc += KICK_ACCEL;
      this.kickLeft -= dt;
      this.speed = Math.min(top, this.speed + acc * dt);
      // drain: a Burnout sips a little slower (a full bar is a real reward)
      this.boostMeter = Math.max(0, this.boostMeter - dt * (this.burnout ? 0.85 : 1));
    }
    if (input.brake && !this.drifting) this.speed = Math.max(0, this.speed - BRAKE_DECEL * dt);
    if (this.drifting) {
      // a deeper angle scrubs more speed — shallow drifts carry momentum
      const sideways = Math.abs(wrapAngle(this.heading - this.velAngle)) / DRIFT_MAX_SLIP;
      this.speed = Math.max(10, this.speed - DRIFT_SCRUB * (0.35 + 0.65 * sideways) * dt);
    }
    if (this.speed > top) this.speed = Math.max(top, this.speed - 6 * dt); // settle down a tier
    if (this.speed > TOP_HARD) this.speed = TOP_HARD; // absolute clamp

    // ---- yaw. The minus sign: with y up and headings mapped to
    // (sin h, 0, cos h), turning right (screen-right of travel) is -h ----
    const airborne = !player.susp.some((s) => s.grounded);
    // ---- takeoff/landing edges + air timers (bookkeeping; consumed by the
    // airborne attitude + landing-settle model). Timers tick on FIXED_DT. ----
    const takeoffEdge = airborne && !this.hadAirLastFrame;
    const landingEdge = !airborne && this.hadAirLastFrame;
    this.hadAirLastFrame = airborne;
    this.timeInAir = airborne ? this.timeInAir + dt : 0;
    if (takeoffEdge) {
      this.takeoffHeading = this.heading;
      // one-shot per-axis spin damp (BP *DampingOnTakeOff): bleed the rotation
      // the ramp lip imparted so the car leaves COMPOSED — roll and yaw are
      // near-killed, a little pitch kick is kept. The kinematic air attitude
      // (case 3a) takes over from here, so seed its eased pitch from the launch
      // trajectory and start roll flat (rubber-down intent).
      b.angularVelocity.x *= TAKEOFF_PITCH_DAMP;
      b.angularVelocity.y *= TAKEOFF_YAW_DAMP;
      b.angularVelocity.z *= TAKEOFF_ROLL_DAMP;
      const horiz = Math.hypot(b.velocity.x, b.velocity.z);
      this.airPitch = clamp(Math.atan2(b.velocity.y, Math.max(2, horiz)), -MAX_WHEELIE_ANGLE, MAX_WHEELIE_ANGLE);
      this.airRoll = 0;
    }
    if (landingEdge) {
      this.landingSettleT = LAND_SETTLE_SECS;
      this.steerSoftenT = LAND_STEER_SOFTEN_SECS;
    }
    this.landingSettleT = Math.max(0, this.landingSettleT - dt);
    this.steerSoftenT = Math.max(0, this.steerSoftenT - dt);
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
        this.speed = Math.min(BURNOUT_TOP, this.speed + 1.2); // BP's little exit kick
      }
    } else {
      // ---- gripped: bicycle model with a fast-fading lock — good for
      // ramming, hopeless in corners. The chassis takes YAW_RESPONSE
      // seconds to take up a yaw command — that lag is most of the
      // "weight" ----
      const lockT = clamp((this.speed - STEER_FULL_BELOW) / (STEER_MIN_AT - STEER_FULL_BELOW), 0, 1);
      const lock = STEER_LOCK_LOW + (STEER_LOCK_HIGH - STEER_LOCK_LOW) * lockT;
      // Briefly soften the steer fed to the yaw model right after a hard
      // landing so the player can't snap-turn out of the squash. Only on the
      // ground (in the air control is already faint); decays to 1.0 over
      // LAND_STEER_SOFTEN_SECS, and is exactly 1.0 once the timer elapses, so
      // it is a no-op in steady state.
      const steerSoften =
        !airborne && this.steerSoftenT > 0 ? 0.5 + 0.5 * (1 - this.steerSoftenT / LAND_STEER_SOFTEN_SECS) : 1;
      let yawTarget = -(this.speed * Math.tan(lock * this.steer * steerSoften)) / WHEELBASE;
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

    // ---- boost EARN (B3/BP "Driving Skills"): drift sideways, fly, and pass
    // traffic close (near-miss credit fed by Game). Boost is the reward for
    // risk — a deeper slide earns faster. Fills the EXTENDED bar (boostCap). --
    let earn = this.nearMissFill; // pending near-miss/oncoming credit, spent now
    this.nearMissFill = 0;
    if (this.drifting) {
      const sideways = Math.abs(wrapAngle(this.heading - this.velAngle)) / DRIFT_MAX_SLIP;
      earn += REFILL_DRIFT * (0.4 + 0.6 * sideways) * dt;
    }
    if (airborne) earn += REFILL_AIR * dt;
    if (earn > 0) this.boostMeter = Math.min(this.boostCap, this.boostMeter + earn);

    // ---- weight transfer, visual only: lean out of corners, squat under
    // power, dive on the brakes ----
    const rollTarget = clamp(-this.yawVel * this.speed * ROLL_PER_LATG, -ROLL_MAX, ROLL_MAX);
    this.visualRoll += (rollTarget - this.visualRoll) * Math.min(1, dt * 6);
    const accel = (this.speed - speedBefore) / dt;
    const pitchTarget = airborne ? 0 : clamp(accel * PITCH_PER_ACCEL, PITCH_MIN, PITCH_MAX);
    this.visualPitch += (pitchTarget - this.visualPitch) * Math.min(1, dt * 5);

    // ---- write to the body ----
    b.velocity.set(Math.sin(this.velAngle) * this.speed, b.velocity.y, Math.cos(this.velAngle) * this.speed);
    // The orientation pin judges FEATURE slope only (elevation.md): the
    // old absolute test read any real road grade as "a ramp", so on a hill
    // the chassis never re-pinned after a knock and its orientation
    // drifted. Road grade is something to pin TO, not bail out over —
    // ramps and kerbs (features) keep the free-pitching branch below.
    const fx = Math.sin(this.heading) * 1.6;
    const fz = Math.cos(this.heading) * 1.6;
    const baseF = heightAt.base(b.position.x + fx, b.position.z + fz);
    const baseA = heightAt.base(b.position.x - fx, b.position.z - fz);
    const slope = Math.abs(
      heightAt(b.position.x + fx, b.position.z + fz) - baseF -
        (heightAt(b.position.x - fx, b.position.z - fz) - baseA),
    );
    if (!airborne && this.landingSettleT <= 0 && slope < 0.02) {
      // CASE 1 — steady-state on-ground pin (instant). This is the END state
      // the landing settle (case 2) blends toward; the `landingSettleT <= 0`
      // guard routes a fresh landing to case 2 first. Preserved verbatim: on
      // flat ground both base differentials are exactly 0, so this is the
      // bit-identical no-op the determinism pins require.
      b.angularVelocity.set(0, 0, 0);
      b.quaternion.setFromAxisAngle(UP_AXIS, this.heading + Math.PI); // hull forward is -z
      // pin to the sampled local ROAD plane, not world-flat: pitch from the
      // fore/aft base differential, roll from the lateral one.
      const cxs = Math.cos(this.heading) * 1.6;
      const czs = Math.sin(this.heading) * 1.6;
      const baseR = heightAt.base(b.position.x - cxs, b.position.z + czs); // car's right
      const baseL = heightAt.base(b.position.x + cxs, b.position.z - czs);
      if (baseF !== baseA || baseR !== baseL) {
        _qTilt.setFromAxisAngle(X_AXIS, Math.atan2(baseF - baseA, 3.2)); // nose up the grade
        b.quaternion.mult(_qTilt, b.quaternion);
        _qTilt.setFromAxisAngle(Z_AXIS, Math.atan2(baseR - baseL, 3.2)); // bank with the camber
        b.quaternion.mult(_qTilt, b.quaternion);
      }
    } else if (!airborne && this.landingSettleT > 0) {
      // CASE 2 — landing settle: just touched down. Instead of snapping to the
      // road plane, BLEND the current (airborne) attitude toward the exact pose
      // case 1 computes, over LAND_SETTLE_SECS. Build that pose into _qLand the
      // same way case 1 builds the body quaternion, then slerp into it. On flat
      // ground the differentials are 0 so _qLand is the pure-yaw quaternion and
      // the slerp endpoint equals the old no-op — once the timer elapses the
      // next frame routes to case 1 and the determinism pin holds.
      _qLand.setFromAxisAngle(UP_AXIS, this.heading + Math.PI);
      const cxs = Math.cos(this.heading) * 1.6;
      const czs = Math.sin(this.heading) * 1.6;
      const baseR = heightAt.base(b.position.x - cxs, b.position.z + czs); // car's right
      const baseL = heightAt.base(b.position.x + cxs, b.position.z - czs);
      if (baseF !== baseA || baseR !== baseL) {
        _qTilt.setFromAxisAngle(X_AXIS, Math.atan2(baseF - baseA, 3.2)); // nose up the grade
        _qLand.mult(_qTilt, _qLand);
        _qTilt.setFromAxisAngle(Z_AXIS, Math.atan2(baseR - baseL, 3.2)); // bank with the camber
        _qLand.mult(_qTilt, _qLand);
      }
      // blend factor walks 0→1 as the settle window elapses (the decremented
      // timer means t advances every frame; t = 1 when landingSettleT hits 0)
      const t = clamp(1 - this.landingSettleT / LAND_SETTLE_SECS, 0, 1);
      b.quaternion.slerp(_qLand, t, b.quaternion);
      // bleed the airborne spin out over the same window rather than zeroing it
      // instantly — the chassis settles, it doesn't snap
      const decay = 1 - Math.min(1, t);
      b.angularVelocity.x *= decay;
      b.angularVelocity.y *= decay;
      b.angularVelocity.z *= decay;
    } else if (airborne) {
      // CASE 3a — genuinely airborne: BP-style attitude control. The body
      // quaternion is driven DIRECTLY (the same kinematic idiom as the
      // on-ground pin) so the nose chases the trajectory and roll auto-levels —
      // the car leaves a ramp composed and lands on its wheels. No linear
      // velocity is touched here: gravity and the suspension launch cap own the
      // arc; this only sets ORIENTATION, so it can never add upward velocity.
      const horiz = Math.hypot(b.velocity.x, b.velocity.z);
      // pitch eases toward the trajectory tangent, clamped to a believable
      // wheelie angle so a steep launch (or dive) never points past it.
      const pitchTarget = clamp(
        Math.atan2(b.velocity.y, Math.max(2, horiz)),
        -MAX_WHEELIE_ANGLE,
        MAX_WHEELIE_ANGLE,
      );
      this.airPitch += (pitchTarget - this.airPitch) * Math.min(1, AIR_PITCH_FOLLOW_RATE * dt);
      // roll: the player leans the car as a RATE (a nudge, not a teleport), and
      // past a small dead-band it eases back toward level so a released stick
      // lands the car rubber-down. Clamped to the takeoff roll limit.
      this.airRoll += this.steer * AIR_STEER_TORQUE * dt;
      if (Math.abs(this.airRoll) > AIR_MIN_ROLL_TO_CORRECT) {
        this.airRoll -= this.airRoll * Math.min(1, AIR_ROLL_CORRECTION * dt);
      }
      this.airRoll = clamp(this.airRoll, -TAKEOFF_ROLL_LIMIT, TAKEOFF_ROLL_LIMIT);
      // build yaw→pitch→roll exactly the way case 1 builds the on-ground pose
      _qAir.setFromAxisAngle(UP_AXIS, this.heading + Math.PI);
      _qTilt.setFromAxisAngle(X_AXIS, this.airPitch);
      _qAir.mult(_qTilt, _qAir);
      _qTilt.setFromAxisAngle(Z_AXIS, this.airRoll);
      _qAir.mult(_qTilt, _qAir);
      b.quaternion.copy(_qAir);
      // bleed residual ramp spin so the solver doesn't fight the kinematic pose
      // (InAirDamping intent). The per-frame set above is authoritative; this
      // just decays the leftover angular velocity toward zero.
      const ad = Math.max(0, 1 - AIR_DAMP * dt);
      b.angularVelocity.x *= ad;
      b.angularVelocity.y *= ad;
      b.angularVelocity.z *= ad;
    } else {
      // CASE 3b — grounded on a steep feature (a ramp surface) with no active
      // settle: keep the suspension/ballistic pitch, only pin yaw. Unchanged
      // from the pre-airborne-model behaviour — driving up a ramp must keep its
      // surface-following pitch, not snap to the (near-flat) trajectory.
      b.angularVelocity.y = 0;
      b.angularVelocity.x *= 0.99;
      b.angularVelocity.z *= 0.99;
    }
  }
}
