import type * as CANNON from 'cannon-es';
import {
  AIR_DAMP,
  AIR_MIN_ROLL_TO_CORRECT,
  AIR_PITCH_FOLLOW_RATE,
  AIR_ROLL_CORRECTION,
  AIR_STEER_TORQUE,
  FIXED_DT,
  LAND_SETTLE_SECS,
  MAX_WHEELIE_ANGLE,
  TAKEOFF_ROLL_LIMIT,
} from '../constants';
import type { HeightSampler } from '../suspension';
import {
  UP_AXIS,
  X_AXIS,
  Z_AXIS,
  _qAir,
  _qLand,
  _qTilt,
  clamp,
} from './constants';

/** Inputs the chassis-orientation pin reads from PlayerControl. */
export interface OrientationState {
  heading: number;
  landingSettleT: number;
  airPitch: number;
  airRoll: number;
  steer: number;
}

/**
 * Pin the chassis orientation onto the body — the four cases the driving model
 * resolves each frame after the velocity write. Mutates only `airPitch` and
 * `airRoll` on `s` (the same fields the loop carries between frames); every
 * number, branch, and order of operations is preserved verbatim from the
 * inlined version so the determinism pins still hold bit-for-bit.
 */
export function applyChassisOrientation(
  b: CANNON.Body,
  airborne: boolean,
  heightAt: HeightSampler,
  s: OrientationState,
): void {
  const dt = FIXED_DT;
  // The orientation pin judges FEATURE slope only (elevation.md): the
  // old absolute test read any real road grade as "a ramp", so on a hill
  // the chassis never re-pinned after a knock and its orientation
  // drifted. Road grade is something to pin TO, not bail out over —
  // ramps and kerbs (features) keep the free-pitching branch below.
  const fx = Math.sin(s.heading) * 1.6;
  const fz = Math.cos(s.heading) * 1.6;
  const baseF = heightAt.base(b.position.x + fx, b.position.z + fz);
  const baseA = heightAt.base(b.position.x - fx, b.position.z - fz);
  const slope = Math.abs(
    heightAt(b.position.x + fx, b.position.z + fz) - baseF -
      (heightAt(b.position.x - fx, b.position.z - fz) - baseA),
  );
  if (!airborne && s.landingSettleT <= 0 && slope < 0.02) {
    // CASE 1 — steady-state on-ground pin (instant). This is the END state
    // the landing settle (case 2) blends toward; the `landingSettleT <= 0`
    // guard routes a fresh landing to case 2 first. Preserved verbatim: on
    // flat ground both base differentials are exactly 0, so this is the
    // bit-identical no-op the determinism pins require.
    b.angularVelocity.set(0, 0, 0);
    b.quaternion.setFromAxisAngle(UP_AXIS, s.heading + Math.PI); // hull forward is -z
    // pin to the sampled local ROAD plane, not world-flat: pitch from the
    // fore/aft base differential, roll from the lateral one.
    const cxs = Math.cos(s.heading) * 1.6;
    const czs = Math.sin(s.heading) * 1.6;
    const baseR = heightAt.base(b.position.x - cxs, b.position.z + czs); // car's right
    const baseL = heightAt.base(b.position.x + cxs, b.position.z - czs);
    if (baseF !== baseA || baseR !== baseL) {
      _qTilt.setFromAxisAngle(X_AXIS, Math.atan2(baseF - baseA, 3.2)); // nose up the grade
      b.quaternion.mult(_qTilt, b.quaternion);
      _qTilt.setFromAxisAngle(Z_AXIS, Math.atan2(baseR - baseL, 3.2)); // bank with the camber
      b.quaternion.mult(_qTilt, b.quaternion);
    }
  } else if (!airborne && s.landingSettleT > 0) {
    // CASE 2 — landing settle: just touched down. Instead of snapping to the
    // road plane, BLEND the current (airborne) attitude toward the exact pose
    // case 1 computes, over LAND_SETTLE_SECS. Build that pose into _qLand the
    // same way case 1 builds the body quaternion, then slerp into it. On flat
    // ground the differentials are 0 so _qLand is the pure-yaw quaternion and
    // the slerp endpoint equals the old no-op — once the timer elapses the
    // next frame routes to case 1 and the determinism pin holds.
    _qLand.setFromAxisAngle(UP_AXIS, s.heading + Math.PI);
    const cxs = Math.cos(s.heading) * 1.6;
    const czs = Math.sin(s.heading) * 1.6;
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
    const t = clamp(1 - s.landingSettleT / LAND_SETTLE_SECS, 0, 1);
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
    s.airPitch += (pitchTarget - s.airPitch) * Math.min(1, AIR_PITCH_FOLLOW_RATE * dt);
    // roll: the player leans the car as a RATE (a nudge, not a teleport), and
    // past a small dead-band it eases back toward level so a released stick
    // lands the car rubber-down. Clamped to the takeoff roll limit.
    s.airRoll += s.steer * AIR_STEER_TORQUE * dt;
    if (Math.abs(s.airRoll) > AIR_MIN_ROLL_TO_CORRECT) {
      s.airRoll -= s.airRoll * Math.min(1, AIR_ROLL_CORRECTION * dt);
    }
    s.airRoll = clamp(s.airRoll, -TAKEOFF_ROLL_LIMIT, TAKEOFF_ROLL_LIMIT);
    // build yaw→pitch→roll exactly the way case 1 builds the on-ground pose
    _qAir.setFromAxisAngle(UP_AXIS, s.heading + Math.PI);
    _qTilt.setFromAxisAngle(X_AXIS, s.airPitch);
    _qAir.mult(_qTilt, _qAir);
    _qTilt.setFromAxisAngle(Z_AXIS, s.airRoll);
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
