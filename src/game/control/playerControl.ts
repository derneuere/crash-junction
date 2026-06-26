import {
  BOOST_MAX_SEGMENTS,
  BOOST_SEGMENT_SECS,
  BOOST_START_SEGMENTS,
  FIXED_DT,
} from '../constants';
import type { Actor } from '../types';
import type { HeightSampler } from '../suspension';
import type { ControlInput } from './input';
import { DriftState, stepDrive } from './driving';
import { REFILL_NEARMISS, UP_AXIS, _up } from './constants';
import { HANDLING, type HandlingAttribs } from '../handling';

export class PlayerControl {
  // The active variant's grouped handling vault (Feature A foundation). The
  // feature modules (driving, speed, suspension, collision) read HANDLING
  // through this field OR import HANDLING directly. Defaults to sedan and is
  // re-resolved from the player's spec the first time `update()` sees a variant
  // (PlayerControl is constructed before its car's spec is known) — sedan's
  // values reproduce today, so the default is also behaviour-identical.
  attribs: HandlingAttribs = HANDLING.sedan;
  private attribVariant: string | null = null; // which variant `attribs` is for

  heading = 0; // nose yaw; world dir = (sin h, 0, cos h)
  velAngle = 0; // velocity yaw — lags heading while drifting
  steer = 0;
  speed = 0;
  drifting = false; // derived view of driftState (driftState !== None)
  driftState: DriftState = DriftState.None; // tri-state drift FSM (Feature D)
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
  // PRESENTATION-ONLY (read by Game.updateWheels, never by the sim): the BP
  // GetSteeringAngle the front wheels visually turn to, and the throttle/brake
  // input flags that drive wheelspin/lockup. All three are pure derived values —
  // nothing in the fixed step reads them, so replay checksums stay identical.
  steerAngle = 0; // front-wheel visual steer lock (radians), speed-sensitive
  throttling = false; // raw throttle input — rear wheelspin under launch power
  braking = false; // raw brake input — near-lockup of all wheels
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
    // Drop the cached variant so the next update() re-resolves attribs from the
    // (possibly swapped) car's spec; attribs itself stays sedan until then.
    this.attribVariant = null;
    this.attribs = HANDLING.sedan;
    this.heading = heading;
    this.velAngle = heading;
    this.steer = 0;
    this.speed = 0;
    this.drifting = false;
    this.driftState = DriftState.None;
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
    this.steerAngle = 0; // presentation-only, but must be seeded for replay parity
    this.throttling = false;
    this.braking = false;
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
    // Resolve this car's handling vault once (cheap guard — only re-resolves if
    // the variant changes). Feature modules read `this.attribs.*`.
    const variant = player.spec?.variant ?? 'sedan';
    if (variant !== this.attribVariant) {
      this.attribs = HANDLING[variant];
      this.attribVariant = variant;
    }
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

    // ---- the driving step proper. Run on a state view of `this` and copied
    // back — bit-identical to the inlined body, just relocated to ./driving. ----
    const s = {
      variant, // per-variant engine model (Feature E) reads this; sedan = stock
      heading: this.heading,
      velAngle: this.velAngle,
      steer: this.steer,
      speed: this.speed,
      drifting: this.drifting,
      driftState: this.driftState,
      boosting: this.boosting,
      boostMeter: this.boostMeter,
      boostHeld: this.boostHeld,
      kickLeft: this.kickLeft,
      burnout: this.burnout,
      burnoutArmed: this.burnoutArmed,
      burnoutWasFull: this.burnoutWasFull,
      burnoutChain: this.burnoutChain,
      gear: this.gear,
      shiftT: this.shiftT,
      rpm: this.rpm,
      visualPitch: this.visualPitch,
      visualRoll: this.visualRoll,
      steerAngle: this.steerAngle,
      throttling: this.throttling,
      braking: this.braking,
      yawVel: this.yawVel,
      grip: this.grip,
      recentBrake: this.recentBrake,
      brakeWasDown: this.brakeWasDown,
      tighten: this.tighten,
      nearMissFill: this.nearMissFill,
      hadAirLastFrame: this.hadAirLastFrame,
      timeInAir: this.timeInAir,
      takeoffHeading: this.takeoffHeading,
      landingSettleT: this.landingSettleT,
      steerSoftenT: this.steerSoftenT,
      airPitch: this.airPitch,
      airRoll: this.airRoll,
      boostCap: this.boostCap,
    };
    stepDrive(s, player, input, heightAt, this.attribs);
    this.heading = s.heading;
    this.velAngle = s.velAngle;
    this.steer = s.steer;
    this.speed = s.speed;
    this.drifting = s.drifting;
    this.driftState = s.driftState;
    this.boosting = s.boosting;
    this.boostMeter = s.boostMeter;
    this.boostHeld = s.boostHeld;
    this.kickLeft = s.kickLeft;
    this.burnout = s.burnout;
    this.burnoutArmed = s.burnoutArmed;
    this.burnoutWasFull = s.burnoutWasFull;
    this.burnoutChain = s.burnoutChain;
    this.gear = s.gear;
    this.shiftT = s.shiftT;
    this.rpm = s.rpm;
    this.visualPitch = s.visualPitch;
    this.visualRoll = s.visualRoll;
    this.steerAngle = s.steerAngle;
    this.throttling = s.throttling;
    this.braking = s.braking;
    this.yawVel = s.yawVel;
    this.grip = s.grip;
    this.recentBrake = s.recentBrake;
    this.brakeWasDown = s.brakeWasDown;
    this.tighten = s.tighten;
    this.nearMissFill = s.nearMissFill;
    this.hadAirLastFrame = s.hadAirLastFrame;
    this.timeInAir = s.timeInAir;
    this.takeoffHeading = s.takeoffHeading;
    this.landingSettleT = s.landingSettleT;
    this.steerSoftenT = s.steerSoftenT;
    this.airPitch = s.airPitch;
    this.airRoll = s.airRoll;
  }
}
