// Force-based tire model — the heart of the Burnout-faithful rewrite. Each
// wheel turns its slip + its spring NORMAL LOAD into a contact
// force; the controller applies that force AT THE CONTACT POINT, so yaw / slide
// / spin-out emerge from the off-centre `r × F` instead of being scripted.
//
// This module is PURE & DETERMINISTIC (scalar in, scalar out — no Vec3, no
// module state, no RNG, no wall-clock), so it is safe inside the fixed step and
// can be plotted in a debug overlay exactly like BP's `GripCurveDebugGraph`.
// The caller (control/driving.ts) owns the world-space vector math: it
// decomposes the contact velocity into the wheel's longitudinal/lateral axes,
// calls this, and rebuilds `fLong·forward + fLat·lateral` to apply.
//
// THREE design pillars (the reasons a force vehicle is hard, solved here):
//  1. WEIGHT-ON-TIRE GRIP. The friction limit scales with `load` (the spring
//     force this corner reported this step). Brake → front springs load → front
//     grip grows → the car rotates in. This is the loop CJ computed but threw
//     away; it is what makes braking/cornering read like a real car.
//  2. ANTI-JITTER. A naive lateral force oscillates at low speed (the classic
//     force-vehicle standstill buzz). We cap every force so it can at most
//     CANCEL the slip it opposes this step (impulse ≤ m·|v|), never reverse it.
//     Grip dominates at speed; the cap only bites in the sub-0.2 m/s regime.
//  3. ARCADE-PRESERVING + EMERGENT. Longitudinal engine drive is mostly
//     pass-through (CJ's tuned per-gear accel stays), but a friction ELLIPSE
//     couples it to lateral load: hard cornering bleeds drive (power-oversteer,
//     trail-braking) and the rise-then-fall grip curve owns break-loose.

import { grip, type GripCurve } from './grip';

/** One wheel's per-step kinematics + drive request, all in the wheel's own
 *  longitudinal/lateral frame (the caller projects world velocity onto the
 *  wheel axes). */
export interface WheelInput {
  /** Normal force this corner's spring reported this step (N). 0 = airborne →
   *  no force. Larger = more grip available (the friction-ellipse radius). */
  load: number;
  /** Contact-point velocity along the wheel's forward (roll) axis (m/s).
   *  + = rolling forward. */
  vLong: number;
  /** Contact-point velocity along the wheel's lateral axis (m/s). + = the
   *  contact is sliding toward the wheel's right → the tire pushes left. */
  vLat: number;
  /** Engine drive force requested along forward (N, signed; + accelerate,
   *  − reverse). Already the per-wheel share (the caller splits by axle). */
  driveForce: number;
  /** Brake force magnitude requested (N, ≥ 0). Always opposes vLong. */
  brakeForce: number;
}

/** Per-wheel tuning, mostly from the variant's `HANDLING[*].grip` plus the
 *  surface and the body's per-corner mass share. */
export interface TireParams {
  /** Lateral (cornering) grip curve — `latGripCurve` normally,
   *  `driftLatGripCurve` while the rear is sliding. */
  latCurve: GripCurve;
  /** Longitudinal grip curve (used for the combined-slip / wheelspin shaping). */
  longCurve: GripCurve;
  /** Lateral friction coefficient — the ellipse's lateral semi-axis is
   *  `load · latMu · surfaceGrip`. Tunes how hard the car corners before the
   *  curve breaks it loose. */
  latMu: number;
  /** Longitudinal friction coefficient — the ellipse's forward semi-axis.
   *  Generous (arcade) so CJ's tuned straight-line accel survives; it only
   *  gates drive once lateral load eats the budget. */
  longMu: number;
  /** Surface multiplier (1 = dry road, <1 = wet/dirt) — the per-surface grip. */
  surfaceGrip: number;
  /** This corner's share of the body mass (kg) — the anti-jitter cap basis. */
  cornerMass: number;
  /** Fixed timestep (s). */
  dt: number;
}

export interface TireForceOut {
  /** Force along the wheel forward axis (N, signed). */
  fLong: number;
  /** Force along the wheel lateral axis (N, signed; opposes vLat). */
  fLat: number;
  /** Diagnostic: lateral grip-curve coefficient sampled this step (debug plot). */
  latCoeff: number;
  /** Diagnostic: fraction of the lateral grip budget in use (0..1+, >1 before
   *  the ellipse clamp = the tire is past its limit → sliding). */
  latSat: number;
}

const EPS = 1e-4;

/**
 * Resolve one wheel's contact force. See the module header for the model.
 *
 * Order: lateral grip (curve × load, anti-jitter capped) → longitudinal
 * drive/brake (brake anti-reverse capped) → friction-ellipse coupling so the
 * two share one budget (combined slip).
 */
export function tireForce(w: WheelInput, p: TireParams): TireForceOut {
  if (w.load <= 0) return { fLong: 0, fLat: 0, latCoeff: 0, latSat: 0 };

  const latMax = w.load * p.latMu * p.surfaceGrip; // ellipse lateral semi-axis (N)
  const longMax = w.load * p.longMu * p.surfaceGrip; // ellipse longitudinal semi-axis (N)

  // ---- lateral (cornering) ---------------------------------------------------
  // Slip angle = angle between where the wheel points and where the contact is
  // actually travelling. Guard the low-speed denominator so a near-stopped wheel
  // can't report a huge slip angle from tiny lateral noise.
  const slipAngle = Math.atan2(w.vLat, Math.max(Math.abs(w.vLong), 0.5));
  const latCoeff = Math.abs(grip(slipAngle, p.latCurve)); // 0..peakCoeff (rise-then-fall)
  // Grip force opposes the slide, sized by the curve × the (weight-loaded) limit.
  let fLat = -Math.sign(w.vLat) * latCoeff * latMax;
  // ANTI-JITTER: a tire can at most cancel the lateral sliding this step, never
  // reverse it. fLat·dt/m ≤ |vLat|. Below ~0.2 m/s of slip this caps the force,
  // so a stationary/near-stationary car never buzzes.
  const fLatStable = (p.cornerMass * Math.abs(w.vLat)) / p.dt;
  if (Math.abs(fLat) > fLatStable) fLat = -Math.sign(w.vLat) * fLatStable;
  const latSat = latMax > EPS ? Math.abs(fLat) / latMax : 0;

  // ---- longitudinal (drive / brake) -----------------------------------------
  // Engine drive passes through (arcade accel preserved); the ellipse below is
  // what couples it to cornering load.
  let fLong = w.driveForce;
  // Brake always opposes motion, anti-reverse capped (a brake can stop you, not
  // throw you into reverse).
  if (w.brakeForce > 0 && Math.abs(w.vLong) > EPS) {
    let fb = w.brakeForce;
    const fbMax = (p.cornerMass * Math.abs(w.vLong)) / p.dt;
    if (fb > fbMax) fb = fbMax;
    fLong -= Math.sign(w.vLong) * fb;
  }

  // ---- friction ellipse (combined slip) -------------------------------------
  // One grip budget shared between forward and sideways. Lateral has
  // priority (it is grip-curve-limited already); drive gets whatever forward
  // budget the lateral load left. So a hard corner bleeds power (oversteer on
  // throttle) and braking-while-turning trades stopping for rotation.
  if (latSat >= 1) {
    // Already at/over the lateral limit → almost no forward budget; let the
    // wheel spin/lock rather than develop drive (the break-loose feel).
    const room = Math.max(0, longMax * 0.15);
    if (Math.abs(fLong) > room) fLong = Math.sign(fLong) * room;
  } else {
    // Ellipse: forward budget shrinks as lateral load grows.
    const forwardBudget = longMax * Math.sqrt(1 - latSat * latSat);
    if (Math.abs(fLong) > forwardBudget) fLong = Math.sign(fLong) * forwardBudget;
  }

  return { fLong, fLat, latCoeff, latSat };
}
