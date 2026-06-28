import * as CANNON from 'cannon-es';
import {
  FIXED_DT,
  LAND_SETTLE_SECS,
} from '../constants';
import type { HeightSampler } from '../suspension';
import type { Actor } from '../types';
import {
  SLOPE_FOLLOW_RATE,
  SLOPE_MIN_GROUNDED,
  SLOPE_MIN_NY,
  SLOPE_MIN_UP_Y,
  UP_AXIS,
  X_AXIS,
  Z_AXIS,
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


// ---- slope-following chassis tilt -----------------------------------------
// A stateless post-`world.step` body fixup (called from core.ts's advance loop,
// after the vy/contact-cap clamps): resample the grounded corners' ground
// heights, fit the wheel-plane / contact-up normal, and slerp the chassis
// ROLL+PITCH ONLY toward it. The EMERGENT yaw is preserved exactly (the target
// is built as qYaw·qPitch·qRoll where qYaw comes from the CURRENT body forward —
// the orientation.ts CASE 1/2 idiom, NOT a world-frame qLevel·qYaw, which would
// shift heading ~0.01 rad and feed a phantom steering input into the re-derived
// loop). angularFactor is never touched (stays (0,1,0)); ω is never written, so
// the next grounded stepDrive still hard-zeros ωx/ωz. Visual hull lean
// (visualPitch/visualRoll) still composes correctly: it post-multiplies the
// group quaternion (synced from this body) in the body-local frame, so it reads
// as load ON TOP of the now-physical slope tilt.
const _slUp = new CANNON.Vec3(); // chassis up (local — not driving.ts scratch)
const _slFwd = new CANNON.Vec3();
const _slAnchor = new CANNON.Vec3();
const _slFront = new CANNON.Vec3();
const _slRear = new CANNON.Vec3();
const _slLeft = new CANNON.Vec3();
const _slRight = new CANNON.Vec3();
const _slFA = new CANNON.Vec3(); // front−rear contact (fore/aft tangent)
const _slLR = new CANNON.Vec3(); // right−left contact (lateral tangent)
const _slN = new CANNON.Vec3(); // fitted contact-plane up-normal (world)
const _slNL = new CANNON.Vec3(); // that normal in the yaw-only body frame
const _qYaw = new CANNON.Quaternion();
const _qYawInv = new CANNON.Quaternion();
const _qSlope = new CANNON.Quaternion();
const _qSlopeT = new CANNON.Quaternion();
const SL_FWD_L = new CANNON.Vec3(0, 0, -1); // hull forward is -z local
const SL_UP_L = new CANNON.Vec3(0, 1, 0);

/**
 * Tilt a GROUNDED chassis to follow the local ground slope — roll + pitch only,
 * yaw stays emergent, the angularFactor lock is never released. Stateless: it
 * only reads the body pose + the height field and writes `body.quaternion`. The
 * caller gates on grounded & non-crashed; tipped cars and degenerate plane fits
 * bail out here. Skips entirely on flat ground only in the sense that the fitted
 * normal is then world-up and the slerp target ≈ the current pose (the slerp is
 * a near-no-op), so flat levels are effectively unaffected.
 */
export function pinChassisSlope(actor: Actor, heightAt: HeightSampler): void {
  if (actor.crashed) return;
  const b = actor.body;
  // chassis up — a tipped / on-its-side car is left to its physical tumble
  b.quaternion.vmult(SL_UP_L, _slUp);
  if (_slUp.y < SLOPE_MIN_UP_Y) return;

  // resample the grounded corners with the FULL body quaternion (matching
  // suspension.ts), accumulating front/rear and left/right contact points. The
  // contact point is the anchor's world (x,z) at the field height there.
  let nFront = 0;
  let nRear = 0;
  let nLeft = 0;
  let nRight = 0;
  let grounded = 0;
  _slFront.set(0, 0, 0);
  _slRear.set(0, 0, 0);
  _slLeft.set(0, 0, 0);
  _slRight.set(0, 0, 0);
  for (const su of actor.susp) {
    // Sample ALL 4 corners' height-field points, not just grounded ones: a
    // flat-locked chassis on a slope only gets 2 wheels DOWN (the suspension
    // can't span the grade), so a grounded-only plane fit can never span the
    // slope and the chassis would never tilt onto it (chicken-and-egg). Sampling
    // the field at every anchor (x,z) always fits the plane and lets the chassis
    // settle onto the slope — the caller already gates on ≥1 wheel grounded.
    grounded++;
    _slAnchor.set(su.ax, 0, su.az);
    b.quaternion.vmult(_slAnchor, _slAnchor); // anchor offset from COM, world axes
    _slAnchor.vadd(b.position, _slAnchor); // anchor world position
    _slAnchor.y = heightAt(_slAnchor.x, _slAnchor.z); // drop to the field → contact point
    if (su.az < 0) {
      _slFront.vadd(_slAnchor, _slFront);
      nFront++;
    } else {
      _slRear.vadd(_slAnchor, _slRear);
      nRear++;
    }
    if (su.ax < 0) {
      _slLeft.vadd(_slAnchor, _slLeft);
      nLeft++;
    } else {
      _slRight.vadd(_slAnchor, _slRight);
      nRight++;
    }
  }
  // need a real plane: ≥3 corners and at least one sample on each side of both
  // axes (any 3 of the 4 sign-distinct corners satisfy this; a 2-corner edge or
  // a single-axle contact does not, and would yield a garbage normal).
  if (grounded < SLOPE_MIN_GROUNDED || nFront === 0 || nRear === 0 || nLeft === 0 || nRight === 0) {
    return;
  }
  _slFront.scale(1 / nFront, _slFront);
  _slRear.scale(1 / nRear, _slRear);
  _slLeft.scale(1 / nLeft, _slLeft);
  _slRight.scale(1 / nRight, _slRight);

  // contact-plane up-normal = (front−rear) × (right−left).  Front−rear ≈ body
  // forward, right−left ≈ body right, and forward × right = up (verified for the
  // (sin h,0,cos h)/(cos h,0,−sin h) frame). Flip if it points down, then floor.
  _slFront.vsub(_slRear, _slFA);
  _slRight.vsub(_slLeft, _slLR);
  _slFA.cross(_slLR, _slN);
  if (_slN.y < 0) _slN.scale(-1, _slN);
  const nLen = _slN.length();
  if (nLen < 1e-6) return; // degenerate (collinear samples)
  _slN.scale(1 / nLen, _slN);
  if (_slN.y < SLOPE_MIN_NY) return; // too steep / unreliable → don't fling the car

  // yaw-only frame from the CURRENT body forward (CASE 1: hull forward is -z, so
  // qYaw = yaw(heading + π)). Transform the normal into it and read pitch/roll
  // SCALARS — heading is reproduced exactly, only roll+pitch move.
  b.quaternion.vmult(SL_FWD_L, _slFwd);
  const heading = Math.atan2(_slFwd.x, _slFwd.z);
  _qYaw.setFromAxisAngle(UP_AXIS, heading + Math.PI);
  _qYaw.conjugate(_qYawInv); // qYaw is unit → conjugate == inverse
  _qYawInv.vmult(_slN, _slNL); // normal in the yaw-only body frame
  // In this frame the body-up of qPitch(X)·qRoll(Z) is ≈ (−roll, 1, pitch), so
  // matching it to the fitted normal gives pitch = atan2(nz, ny), roll =
  // atan2(−nx, ny) — the same nose-up-the-grade / bank-with-camber senses CASE 1
  // builds from its fore/aft & lateral base differentials.
  const ny = _slNL.y > 1e-4 ? _slNL.y : 1e-4; // floor avoids a NaN atan2 on a vertical normal
  const pitch = Math.atan2(_slNL.z, ny);
  const roll = Math.atan2(-_slNL.x, ny);
  if (!Number.isFinite(pitch) || !Number.isFinite(roll)) return; // poison guard

  // compose target = qYaw · qPitch(X) · qRoll(Z) (CASE 1/2 post-multiply order),
  // then low-pass the body toward it. The slerp + the ≥3-grounded & n.y gates
  // damp resample feedback on a kerb lip (no limit-cycle at speed).
  _qSlope.copy(_qYaw);
  _qSlopeT.setFromAxisAngle(X_AXIS, pitch);
  _qSlope.mult(_qSlopeT, _qSlope);
  _qSlopeT.setFromAxisAngle(Z_AXIS, roll);
  _qSlope.mult(_qSlopeT, _qSlope);
  b.quaternion.slerp(_qSlope, SLOPE_FOLLOW_RATE, b.quaternion);
}
