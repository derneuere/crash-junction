// Feature E — engine depth (docs/research/physics-overhaul-spec.md §Feature E).
//
// CJ's stock engine is a per-gear ACCEL TABLE: each gear shoves a fixed m/s²
// (HANDLING[variant].engine.gearAccel), an upshift cuts torque for a beat, and
// the speed tiers clamp the top. It is proven and tuned for the sedan's feel.
// This module adds the OPT-IN richer model BP actually ran — a torque(rpm)
// curve through a differential + gearbox, smoothed (flywheel-ish) delivery, a
// rev limiter, a limited-slip clamp and an RWD power split — plus a non-linear
// brake curve. It is the home for the BP engine-vault numbers that the Feature A
// HANDLING block does not carry (MaxRPM / MaxTorque / TorqueFallOffRPM /
// Differential / TransmissionEfficiency / gear ratios); speed.ts still reads the
// SPEED TIERS and gear ceilings from HANDLING[variant].engine.
//
// GUARDED & REVERSIBLE (the spec's non-negotiable): every car has an
// `EngineModel` with a `torqueModel` flag. The SEDAN ships with it OFF — it keeps
// the proven accel-table path verbatim, so the sedan's feel (and its replay
// checksums) are untouched. The bus/tanker enable it (they barely had distinct
// engine feel before). A per-model `torqueStrength` scalar blends the curve
// toward the old per-gear shove (0 = exactly the accel table, 1 = full curve),
// and `brakeCurve` independently gates the non-linear brake. Dial either to its
// off value and the variant is byte-for-byte the old behaviour.
//
// DETERMINISM: pure functions of the sim state; no Math.random / Date / wall
// clock; all integration is on the caller's FIXED_DT. The flywheel/gearbox
// carry-over state lives on optional SpeedState fields (engine.ts owns their
// meaning) so an un-plumbed caller simply runs the sedan accel-table path.

import type { Variant } from './types';

/** The BP drivetrain numbers for one variant — the engine-vault fields the
 *  HANDLING block does not carry (attribsys-handling-analysis.md §
 *  physicsvehicleengineattribs) plus the CJ-side smoothing/limited-slip tuning.
 *  Numbers are PORTED RATIOS/CHARACTER, not the raw BP integers (the spec's
 *  units note): the torque values keep BP's 187/350/500 spread but are used as a
 *  unitless shape that is normalised back onto CJ's per-gear m/s² shove, so the
 *  curve modulates the proven accel table rather than replacing its scale. */
export interface EngineModel {
  /** Master switch: false = keep the per-gear accel table verbatim (sedan).
   *  true = run the torque-curve model (bus/tanker). */
  torqueModel: boolean;
  /** Blend of curve vs. flat per-gear shove, 0..1 (0 = accel table, 1 = full
   *  curve). Only consulted when `torqueModel` is true. */
  torqueStrength: number;
  /** Master switch for the non-linear (soft-start, sharp-end) brake curve.
   *  false = the flat HANDLING.engine.brakeDecel (sedan). */
  brakeCurve: boolean;

  maxRPM: number; // BP MaxRPM — the rev-limiter ceiling (4510 / 8000 / 8800)
  maxTorque: number; // BP MaxTorque — curve peak (187 / 350 / 500), used as a shape
  torqueFallOffRPM: number; // BP TorqueFallOffRPM — rpm where torque starts falling
  idleTorqueFrac: number; // torque at 0 rpm as a fraction of peak (off-idle pull)
  fallOffFrac: number; // torque at maxRPM as a fraction of peak (top-end droop)
  differential: number; // BP Differential — final-drive multiplier (2.25 / 3.85 / 5.7)
  transmissionEfficiency: number; // BP TransmissionEfficiency (0.5 across the roster)

  /** Per-gear ratios (BP GearRatios vec slots). Higher = more torque, lower top
   *  per gear. Index-aligned with HANDLING[variant].engine.gearTops. */
  gearRatios: number[];
  /** Normalised rpm (0..1 within a gear band) at which the auto-box upshifts.
   *  BP shifts at 4500–7900 rpm; expressed here as a band fraction. */
  upShiftRPM: number;

  flywheelTau: number; // s — power-delivery smoothing (flywheel inertia); 0 = instant
  revLimitCut: number; // delivered-torque scale while bouncing off the limiter (0..1)
  lsdSpread: number; // limited-slip diff clamp half-width about the mean (m/s²)
  powerToRear: number; // drive split, 1 = RWD (BP PowerToRear intent; modelled as a
  //                      delivery scale so a split axle launches a touch softer)

  brakeSoft: number; // brake-curve shape: pedal fraction below which bite is soft
  brakeEndGain: number; // extra bite at full pedal (sharp end), as a multiplier
}

// ---- SEDAN — torque model OFF (keeps the proven accel-table feel) -----------
// The numbers are present so the model CAN be switched on for tuning, but
// `torqueModel:false` means speed.ts never reads them for the sedan: it stays on
// the verbatim per-gear path and its checksums hold. BP basis: a ~PASC01-class
// mid engine (MaxRPM ~7000, MaxTorque ~250) scaled toward the median.
const SEDAN: EngineModel = {
  torqueModel: false,
  torqueStrength: 1,
  brakeCurve: false,
  maxRPM: 7000,
  maxTorque: 250,
  torqueFallOffRPM: 4400, // BP TorqueFallOffRPM median
  idleTorqueFrac: 0.55,
  fallOffFrac: 0.62,
  differential: 3.85, // BP Differential median
  transmissionEfficiency: 0.5, // BP TransmissionEfficiency (flat 0.5)
  gearRatios: [1, 1, 1, 1, 1, 1], // flat — the accel table already carries the steps
  upShiftRPM: 0.95,
  flywheelTau: 0.06,
  revLimitCut: 0.4,
  lsdSpread: 6,
  powerToRear: 1,
  brakeSoft: 0.35,
  brakeEndGain: 1.4,
};

// ---- BUS (11500 kg) — torque model ON: a big, low-revving lump -------------
// Low MaxRPM, big torque off idle that falls away early — it hauls its mass off
// the line and runs out of breath up top. A longer flywheel tau (heavy
// rotating mass) smooths the delivery so it never feels snappy.
const BUS: EngineModel = {
  torqueModel: true,
  torqueStrength: 0.8, // blend most of the way to the curve, keep some accel-table base
  brakeCurve: true,
  maxRPM: 4510, // BP MaxRPM min — a low-revving diesel lump
  maxTorque: 350, // BP MaxTorque median
  torqueFallOffRPM: 2800, // BP TorqueFallOffRPM min — torque dies early
  idleTorqueFrac: 0.7, // strong off-idle pull (hauls the mass)
  fallOffFrac: 0.45, // and a steep top-end droop
  differential: 2.25, // BP Differential min — tall final drive
  transmissionEfficiency: 0.5,
  gearRatios: [1.25, 1.12, 1.02, 0.95, 0.9, 0.85], // a real low-gear advantage
  upShiftRPM: 0.85, // shifts early — never holds a gear to the limiter
  flywheelTau: 0.16, // heavy rotating mass — slow to spool, slow to fall
  revLimitCut: 0.35,
  lsdSpread: 4,
  powerToRear: 1,
  brakeSoft: 0.45, // a soft initial pedal — air brakes bite progressively
  brakeEndGain: 1.6,
};

// ---- TANKER (15000 kg) — torque model ON: the BP heavy-SUV extreme ---------
// The highest MaxRPM/MaxTorque in the roster paired with the tallest final
// drive (Differential 5.7) — vast torque but it has to drag the most mass, so
// the delivered accel still lands the slowest. The longest flywheel tau and the
// softest brake bite complete the supertanker feel.
const TANKER: EngineModel = {
  torqueModel: true,
  torqueStrength: 0.9,
  brakeCurve: true,
  maxRPM: 8800, // BP MaxRPM max
  maxTorque: 500, // BP MaxTorque max
  torqueFallOffRPM: 6000, // BP TorqueFallOffRPM max — pulls high before dropping
  idleTorqueFrac: 0.75,
  fallOffFrac: 0.5,
  differential: 5.7, // BP Differential max — tallest final drive
  transmissionEfficiency: 0.5,
  gearRatios: [1.35, 1.18, 1.05, 0.96, 0.9, 0.84],
  upShiftRPM: 0.88,
  flywheelTau: 0.22, // the slowest-spooling lump
  revLimitCut: 0.3,
  lsdSpread: 3,
  powerToRear: 1,
  brakeSoft: 0.5,
  brakeEndGain: 1.8,
};

/** Per-variant drivetrain models. Resolved by speed.ts from the active variant
 *  (default sedan when the caller has not plumbed one — sedan reproduces today). */
export const ENGINE_MODELS: Record<Variant, EngineModel> = {
  sedan: SEDAN,
  bus: BUS,
  tanker: TANKER,
};

/**
 * Torque output (as a fraction of `maxTorque`) at a normalised engine speed.
 * `rpmNorm` is 0..1 across the rev range. The curve RISES from `idleTorqueFrac`
 * at idle to the peak at `TorqueFallOffRPM`, then FALLS toward `fallOffFrac` at
 * the limiter — the rise-then-fall shape the spec calls for. Pure; the only
 * caller besides the speed step is a debug plotter (mirroring BP, whose only
 * torque-curve caller was a debug grapher).
 */
export function torqueFraction(rpmNorm: number, m: EngineModel): number {
  const r = rpmNorm < 0 ? 0 : rpmNorm > 1 ? 1 : rpmNorm;
  const peakAt = m.torqueFallOffRPM / m.maxRPM; // band fraction where torque peaks
  if (r <= peakAt) {
    // rise: idle → peak, eased (smoothstep) so off-idle pull is meaty
    const t = peakAt > 0 ? r / peakAt : 1;
    const s = t * t * (3 - 2 * t);
    return m.idleTorqueFrac + (1 - m.idleTorqueFrac) * s;
  }
  // fall: peak → top-end droop, eased the same way
  const t = (r - peakAt) / (1 - peakAt);
  const s = t * t * (3 - 2 * t);
  return 1 + (m.fallOffFrac - 1) * s;
}

/**
 * The per-gear accel (m/s²) the torque-curve model delivers this step, BEFORE
 * flywheel smoothing and the limited-slip clamp. It takes the proven per-gear
 * shove `baseAccel` (HANDLING.engine.gearAccel[gear]) as the SCALE so the model
 * stays anchored to CJ's tuned feel, then MODULATES it by:
 *   torque(rpm) × gearRatio × differential-normalised × transmissionEfficiency
 * blended against the flat shove by `torqueStrength`. At torqueStrength 0 it
 * returns `baseAccel` exactly (the accel table), so the blend is a true dial.
 */
export function curveAccel(
  rpmNorm: number,
  gear: number,
  baseAccel: number,
  m: EngineModel,
): number {
  const tq = torqueFraction(rpmNorm, m); // 0..~1 fraction of peak
  const ratio = m.gearRatios[gear] ?? 1;
  // Normalise the final-drive contribution so a tall vs. short diff shifts
  // CHARACTER (low-end vs. top-end) without rescaling the overall accel away
  // from the tuned baseAccel: a reference diff of 3.85 (the median) maps to 1.
  const driveNorm = m.differential / 3.85;
  // transmissionEfficiency is a flat 0.5 in BP, i.e. a constant — fold it in as
  // a 2× so the median efficiency lands back at unity (efficiency 0.5 → 1.0).
  const effNorm = m.transmissionEfficiency * 2;
  // The wheel always sees the median torque on average, so divide by an idle-to-
  // peak mean (~0.85) to keep the curve centred on baseAccel rather than below.
  const curved = baseAccel * (tq / 0.85) * (0.85 + 0.15 * ratio) * effNorm * driveNorm;
  return baseAccel + (curved - baseAccel) * m.torqueStrength;
}

/**
 * Limited-slip differential clamp: the delivered accel is held within
 * `lsdSpread` of a rolling mean (the smoothed delivery), so a sudden torque
 * spike (e.g. dropping into the meat of the curve) can't snap the drive open —
 * it ramps. `mean` is the flywheel-smoothed value carried across steps.
 */
export function lsdClamp(accel: number, mean: number, m: EngineModel): number {
  const lo = mean - m.lsdSpread;
  const hi = mean + m.lsdSpread;
  return accel < lo ? lo : accel > hi ? hi : accel;
}

/**
 * Non-linear brake deceleration (m/s²) for a full-pedal stop. CJ's stock brake
 * is a flat `brakeDecel`; BP's pedal bites SOFT then SHARP. Modelled as: below
 * `brakeSoft` pedal the bite eases in (squared), at full pedal it adds
 * `brakeEndGain`. The brake is binary in CJ's input (input.brake), so the
 * "pedal" here is a synthetic ramp the caller advances — at full ramp this
 * returns `flatDecel × brakeEndGain` (a sharper end), at the start it is gentle.
 */
export function brakeDecelCurve(flatDecel: number, pedal: number, m: EngineModel): number {
  const p = pedal < 0 ? 0 : pedal > 1 ? 1 : pedal;
  // soft start: below brakeSoft the bite is the squared ramp (gentle), above it
  // ramps linearly up to the sharp end.
  let bite: number;
  if (p <= m.brakeSoft) {
    const t = m.brakeSoft > 0 ? p / m.brakeSoft : 1;
    bite = (t * t) * m.brakeSoft; // squared, scaled back to the soft band height
  } else {
    bite = m.brakeSoft + (p - m.brakeSoft) * m.brakeEndGain;
  }
  return flatDecel * bite;
}
