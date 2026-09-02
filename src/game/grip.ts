// Tire grip-curve sampler (Feature C of the physics overhaul —
// docs/research/physics-overhaul-spec.md). This is the CJ port of BP's
// Burnout's tire grip curve: a
// sign-symmetric, rise-then-fall (Pacejka-like) coefficient curve. BP packs each
// curve as one Vector4 `{peakSlipRatio, floorSlipRatio, peakCoeff, fallCoeff}`
// and bundles THREE per tyre — longitudinal, lateral, and a separate, flatter
// `mDriftLatGripCurve`. That dedicated drift-lateral curve is "the mechanical
// basis for Burnout's switch from grippy cornering to a looser drift handling
// model". We mirror exactly that: one generic sampler + two
// curve-builders (normal lateral, drift lateral) that read the per-variant
// coefficients from HANDLING[variant].grip.
//
// PURE & DETERMINISTIC: no module state, no RNG, no wall-clock — `grip(slip,c)`
// is a referentially-transparent function of its args, safe to call inside the
// fixed step and to plot in a debug overlay (BP's only caller of the sampler was
// `GripCurveDebugGraph::PlotCurrentValue`; we add the same readout).

import type { HandlingAttribs } from './handling';

/** One rise-then-fall grip curve. Mirrors BP's TireGripCurve Vector4 lanes
 *  `{peakSlipRatio, floorSlipRatio, peakCoeff, fallCoeff}`. */
export interface GripCurve {
  /** Slip at which the coefficient reaches its peak (the rise region's top). */
  peakSlip: number;
  /** Coefficient at the peak — the most grip this tyre develops. */
  peakCoeff: number;
  /** Slip at which the fall has bottomed out onto the plateau. */
  floorSlip: number;
  /** Plateau coefficient held for |slip| ≥ floorSlip (the slide regime). */
  fallCoeff: number;
}

/** Smoothstep on a value already normalised to 0..1 (3t²−2t³). Cheap stand-in
 *  for BP's per-region cubic-Hermite/rational evaluator (the exact polynomial is
 *  inferred, not algebraically pinned — so smoothstep is a
 *  faithful, monotone, C¹ choice). */
const smooth = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

/**
 * Sample a grip curve at signed slip `s`. Sign-symmetric (BP splits |S| and
 * sign(S), evaluates the magnitude curve, then re-applies the sign), so a left
 * and a right slide develop mirror-image grip. Three regions over |s|:
 *   - rise   (|s| < peakSlip):           0 → peakCoeff via smoothstep
 *   - fall   (peakSlip..floorSlip):       peakCoeff → fallCoeff via smoothstep
 *   - plateau(|s| ≥ floorSlip):           fallCoeff
 * Returns the signed coefficient (same sign as `s`). The returned magnitude is a
 * pure 0..peakCoeff scalar — a MULTIPLIER the caller scales an existing response
 * by; it never sets a force directly (the integration stays kinematic-
 * compatible, per the Feature C guard rails).
 */
export function grip(s: number, c: GripCurve): number {
  const sign = s < 0 ? -1 : 1;
  const a = Math.abs(s);
  let coeff: number;
  if (a <= 0) {
    coeff = 0;
  } else if (a < c.peakSlip) {
    // rise toward peak
    coeff = c.peakCoeff * smooth(a / c.peakSlip);
  } else if (a < c.floorSlip) {
    // fall from peak toward the plateau
    const t = (a - c.peakSlip) / Math.max(1e-6, c.floorSlip - c.peakSlip);
    coeff = c.peakCoeff + (c.fallCoeff - c.peakCoeff) * smooth(t);
  } else {
    coeff = c.fallCoeff; // slide plateau
  }
  return sign * coeff;
}

/** The on-grip (cornering) lateral curve for a variant — the grippy regime the
 *  car corners in before it breaks loose. Reads the `lat*` block. */
export function latGripCurve(h: HandlingAttribs): GripCurve {
  const g = h.grip;
  return {
    peakSlip: g.latPeakSlip,
    peakCoeff: g.latPeakCoeff,
    floorSlip: g.latFloorSlip,
    fallCoeff: g.latFallCoeff,
  };
}

/** The dedicated, lower/flatter DRIFT lateral curve (BP `mDriftLatGripCurve`).
 *  Shares the lateral slip geometry but uses the looser `driftLat*` peak/fall —
 *  this is what makes a drifting car feel slippery instead of hooked-up. */
export function driftLatGripCurve(h: HandlingAttribs): GripCurve {
  const g = h.grip;
  return {
    peakSlip: g.latPeakSlip,
    peakCoeff: g.driftLatPeakCoeff,
    floorSlip: g.latFloorSlip,
    fallCoeff: g.driftLatFallCoeff,
  };
}

/** The longitudinal (traction/braking) curve — provided for completeness and
 *  for the debug plotter; the kinematic driving model uses the lateral curves,
 *  longitudinal grip is folded into the existing engine/brake accel tables. */
export function longGripCurve(h: HandlingAttribs): GripCurve {
  const g = h.grip;
  return {
    peakSlip: g.peakSlip,
    peakCoeff: g.peakCoeff,
    floorSlip: g.floorSlip,
    fallCoeff: g.fallCoeff,
  };
}
