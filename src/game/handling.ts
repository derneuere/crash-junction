// Per-variant grouped handling attribs — the Feature A foundation of the
// physics overhaul (docs/research/physics-overhaul-spec.md). BP's lesson is
// "the sim is generic, the feel is DATA": one solver, a per-vehicle vault of
// tuning constants (the AttribSys classes documented in
// docs/research/attribsys-handling-analysis.md). CJ had that feel scattered as
// global constants in constants.ts + control/constants.ts, varied per car only
// by mass/size. This module gathers it into one grouped, per-variant block that
// every later feature reads.
//
// CONTRACT (this phase): `sedan` reproduces TODAY exactly — every sedan field
// below is copied verbatim from the live global constants, so wiring a consumer
// to HANDLING.sedan.* changes nothing. `bus`/`tanker` are derived as the BP
// heavy-SUV deltas (heavier, less steering lock, less grip, more yaw inertia,
// lands heavy and keeps its rotation through touchdown). Nothing yet reads the
// new bus/tanker-specific values beyond what already varied by mass, so this
// phase is behaviour-identical; the feature agents (driving, speed, suspension,
// collision) consume specific fields as they land.

import type { Variant } from './types';

/** Grouped tuning constants for one handling variant, mirroring BP's AttribSys
 *  vault classes (base / steering / drift / engine / suspension / body-roll /
 *  grip / collision). Fields are SI / CJ-native units (m, s, m/s, rad), NOT the
 *  raw BP internal units — the ratios and character are ported, not the
 *  integers (see the spec's units note + attribsys-handling-analysis.md §5). */
export interface HandlingAttribs {
  /** Chassis aero + drag + the high-speed angular damp (BP
   *  physicsvehiclebaseattribs subset). */
  base: {
    downforce: number; // down-accel per (m/s)²  (DOWNFORCE)
    downforceCap: number; // downforce ceiling in g  (DOWNFORCE_CAP)
    linearDrag: number; // straight-line coast rolloff (m/s²)  (COAST_DRAG)
    angularDrag: number; // rotational resistance (1/s) — BP AngularDrag intent
    highSpeedAngularDamping: number; // extra spin bleed at speed — BP HighSpeedAngularDamping
  };
  /** Speed-sensitive steering lock + ramp (BP physicsvehiclesteeringattribs). */
  steering: {
    lockLow: number; // low-speed lock (rad)  (STEER_LOCK_LOW)
    lockHigh: number; // high-speed lock (rad)  (STEER_LOCK_HIGH)
    speedFullBelow: number; // below this speed lock = lockLow (m/s)  (STEER_FULL_BELOW)
    speedMinAt: number; // at/above this speed lock = lockHigh (m/s)  (STEER_MIN_AT)
    ramp: number; // rate to take up lock (1/s)  (STEER_RAMP)
    visualGain: number; // presentation-only render-angle gain  (VISUAL_STEER_GAIN)
    /** Cap on the front-wheel angle while DRIFTING (rad). In a slide the
     *  fronts track the velocity vector (countersteer) plus the stick's
     *  modulation; this bounds that so a deep slide can't crank the wheels
     *  past what the geometry allows — Burnout's max steering angle during
     *  drift. */
    driftMaxAngle: number;
  };
  /** Drift entry/sustain/exit (BP physicsvehicledriftattribs + CJ's slip-chase). */
  drift: {
    maxSlip: number; // capped slip angle (rad)  (DRIFT_MAX_SLIP)
    minSpeed: number; // min speed to initiate (m/s)  (DRIFT_MIN_SPEED)
    sideForce: number; // sideways step-out magnitude — BP SideForceMagnitude
    naturalYawTorque: number; // self-aligning yaw — BP NaturalYawTorque
    wheelSlip: number; // tyre slip while drifting — BP WheelSlip
    angularDamping: number; // excess-spin bleed while drifting — BP DriftAngularDamping
    deepen: number; // slip chases a deeper angle (1/s)  (DRIFT_DEEPEN)
    relax: number; // straightening rate (1/s)  (DRIFT_RELAX)
    exitSlip: number; // slip at/under which tyres hook up (rad)  (DRIFT_EXIT_SLIP)
    scrub: number; // speed bleed at full slip (m/s²)  (DRIFT_SCRUB)
    carve: number; // path bend per rad of slip (1/s)  (DRIFT_CARVE)
  };
  /** Drivetrain: speed tiers, gear tables, brake, power split (BP
   *  physicsvehicleengineattribs + CJ's per-gear accel table). */
  engine: {
    cruiseSpeed: number; // engine-only ceiling (m/s)  (TOP_CRUISE)
    launchSpeed: number; // regular-boost ceiling (m/s)  (BOOST_TOP)
    burnoutSpeed: number; // sustained-Burnout ceiling (m/s)  (BURNOUT_TOP)
    launchAccel: number; // launch shove (m/s²)  (LAUNCH_ACCEL)
    gearTops: number[]; // per-gear speed ceilings (m/s)  (GEAR_TOPS)
    gearAccel: number[]; // per-gear engine shove (m/s²)  (GEAR_ACCEL)
    brakeDecel: number; // brake deceleration (m/s²)  (BRAKE_DECEL)
    powerToRear: number; // drive split (1 = RWD) — BP PowerToRear intent
  };
  /** Spring + downforce squat + landing settle (BP
   *  physicsvehiclesuspensionattribs). */
  suspension: {
    sag: number; // compression that doubles spring force (m)  (SUSP_SAG)
    zeta: number; // damping ratio (1 = critical)  (SUSP_ZETA)
    droop: number; // wheel reach below ride height (m)  (SUSP_DROOP)
    maxComp: number; // max compression (m)  (SUSP_MAX_COMP)
    springStrengthMult: number; // per-variant spring-strength scalar (1 = today)
  };
  /** Weight-transfer factors + the visual roll/pitch springs (BP
   *  physicsvehiclebodyrollattribs). See Feature B. */
  bodyroll: {
    factorOfWeightX: number; // lateral weight transfer — BP FactorOfWeightX
    factorOfWeightZ: number; // longitudinal weight transfer — BP FactorOfWeightZ
    rollStiffness: number; // visual roll spring — BP RollSpringStiffness
    rollDamping: number; // visual roll damp — BP RollSpringDampening
    pitchStiffness: number; // visual pitch spring — BP PitchSpringStiffness
    pitchDamping: number; // visual pitch damp — BP PitchSpringDampening
  };
  /** Pacejka-like rise-then-fall grip coefficients, longitudinal + lateral +
   *  a flatter drift-lateral curve (BP base-attribs grip block). See Features
   *  C/D. Defaults are the BP medians; sedan = today is "curve disabled / a
   *  no-op modulation" via the consuming feature's blend scalar. */
  grip: {
    peakSlip: number; // longitudinal peak-grip slip ratio
    peakCoeff: number; // longitudinal peak coefficient
    floorSlip: number; // longitudinal slip where grip has fallen to the floor
    fallCoeff: number; // longitudinal plateau coefficient past floorSlip
    latPeakSlip: number; // lateral peak-grip slip angle
    latPeakCoeff: number; // lateral peak coefficient
    latFloorSlip: number; // lateral slip where grip has fallen to the floor
    latFallCoeff: number; // lateral plateau coefficient
    driftLatPeakCoeff: number; // drift lateral peak (lower/flatter — ~0.72× peak)
    driftLatFallCoeff: number; // drift lateral plateau
    adhesiveLimit: number; // static-friction adhesion ceiling — BP AdhesiveLimit
    /** Friction-ellipse semi-axes as multiples of the corner's spring load
     *  (the force model's tire limit = load × mu × adhesiveLimit). Lateral
     *  sets how hard the car corners before the grip curve breaks it loose;
     *  longitudinal is generous (arcade) so the per-gear accel table survives
     *  and only gates drive once cornering eats the budget. */
    latMu: number;
    longMu: number;
  };
  /** Extra spin/launch energy injected on a crash — BP CrashExtra*Factor (flat
   *  0.3 across the whole roster) — PLUS the per-variant car-on-car CONTACT
   *  response: the anisotropic body-axis friction scales (the controlled
   *  non-crashing projection) and the closing-speed tangential restitution. */
  collision: {
    crashExtraRoll: number; // BP CrashExtraRollVelocityFactor
    crashExtraYaw: number; // BP CrashExtraYawVelocityFactor
    crashExtraLinear: number; // BP CrashExtraLinearVelocityFactor
    /** Anisotropic car-car friction bleed per BODY axis (fraction of the
     *  along-axis velocity removed per contact): forward slides freely, lateral
     *  GRIPS (the door-to-door directional crash feel), vertical chatter damps
     *  hard. Heavier variants grip/damp harder. */
    frictionFwd: number; // along travel — slides, low grip
    frictionUp: number; // vertical chatter — damped hard
    frictionLat: number; // sideways — grips, the directional crash feel
    /** Closing-speed tangential restitution: restitutionHigh for the GENTLER
     *  hit (closing < 0.65 m/s), restitutionLow at/above. Near-vestigial at CJ
     *  speeds (resolves to restitutionLow). */
    restitutionLow: number; // e for a harder hit (closing ≥ 0.65 m/s)
    restitutionHigh: number; // e for the gentler hit (closing < 0.65 m/s)
  };
}

// ---- SEDAN = TODAY ----------------------------------------------------------
// Every value here is copied verbatim from the live globals so that wiring a
// consumer to HANDLING.sedan.* is a pure no-op. Cross-reference (file → const):
//   control/constants.ts : STEER_*, VISUAL_STEER_GAIN, DRIFT_*, GEAR_*, BRAKE_DECEL,
//                           COAST_DRAG, TOP_CRUISE, BOOST_TOP, BURNOUT_TOP
//   constants.ts         : DOWNFORCE, DOWNFORCE_CAP, SUSP_*, LAUNCH_ACCEL
//   constants.ts (F)     : CrashExtra* live as the flat-0.3 BP literals here
// (Re-stated as literals rather than imported so this module stays the single
// home for handling tuning and the feature agents have one place to edit.)
const SEDAN: HandlingAttribs = {
  base: {
    downforce: 0.009, // DOWNFORCE
    downforceCap: 1.0, // DOWNFORCE_CAP
    linearDrag: 4.5, // COAST_DRAG (m/s² coast rolloff)
    angularDrag: 0.05, // BP AngularDrag median
    highSpeedAngularDamping: 0.15, // BP HighSpeedAngularDamping (sedan ≈ PASC01)
  },
  steering: {
    lockLow: (22.5 * Math.PI) / 180, // STEER_LOCK_LOW
    lockHigh: (3.6 * Math.PI) / 180, // STEER_LOCK_HIGH
    speedFullBelow: 13.4, // STEER_FULL_BELOW
    speedMinAt: 38, // STEER_MIN_AT
    ramp: 1 / 0.4, // STEER_RAMP
    visualGain: 1.8, // VISUAL_STEER_GAIN
    driftMaxAngle: (35 * Math.PI) / 180, // fronts may countersteer up to 35° in a slide
  },
  drift: {
    maxSlip: (40 * Math.PI) / 180, // DRIFT_MAX_SLIP
    minSpeed: 18, // DRIFT_MIN_SPEED
    sideForce: 27, // BP SideForceMagnitude median (27/48 cars)
    naturalYawTorque: 7000, // BP NaturalYawTorque median
    wheelSlip: 0.25, // BP WheelSlip median
    angularDamping: 0.125, // BP DriftAngularDamping median
    deepen: 1 / 0.45, // DRIFT_DEEPEN
    relax: 1 / 0.28, // DRIFT_RELAX
    exitSlip: (7 * Math.PI) / 180, // DRIFT_EXIT_SLIP
    scrub: 3.5, // DRIFT_SCRUB
    carve: 1.6, // DRIFT_CARVE
  },
  engine: {
    cruiseSpeed: 32, // TOP_CRUISE (= CRUISE_SPEED)
    launchSpeed: 44, // BOOST_TOP (= LAUNCH_SPEED)
    burnoutSpeed: 48, // BURNOUT_TOP (= BURNOUT_SPEED)
    launchAccel: 34, // LAUNCH_ACCEL
    gearTops: [7, 13, 21, 29, 32, 48], // GEAR_TOPS (last two = TOP_CRUISE, BURNOUT_TOP)
    gearAccel: [23, 20.5, 17.5, 15, 13, 10.5], // GEAR_ACCEL
    brakeDecel: 26, // BRAKE_DECEL
    powerToRear: 1, // RWD — BP PowerToRear intent
  },
  suspension: {
    sag: 0.055, // SUSP_SAG
    zeta: 0.6, // SUSP_ZETA
    droop: 0.18, // SUSP_DROOP
    maxComp: 0.12, // SUSP_MAX_COMP
    springStrengthMult: 1, // today (factory.ts derives spring k from mass)
  },
  bodyroll: {
    factorOfWeightX: 0.08, // spec Feature A table (sedan ≈ BP X median)
    factorOfWeightZ: 0.15, // spec Feature A table (sedan ≈ BP Z median)
    rollStiffness: 0.3, // BP RollSpringStiffness (const across roster)
    rollDamping: 0.8, // BP RollSpringDampening (const)
    pitchStiffness: 0.3, // BP PitchSpringStiffness (const)
    pitchDamping: 0.1, // BP PitchSpringDampening (const)
  },
  grip: {
    peakSlip: 0.12, // BP longitudinal peak-slip median
    peakCoeff: 1.0, // BP peak friction median
    floorSlip: 0.55, // BP floor-slip median
    fallCoeff: 0.7, // BP dynamic-friction median
    latPeakSlip: 0.12, // lateral mirrors longitudinal at the median
    latPeakCoeff: 1.0,
    latFloorSlip: 0.55,
    latFallCoeff: 0.7,
    driftLatPeakCoeff: 0.72, // ~0.72× peak — the flatter drift curve
    driftLatFallCoeff: 0.6,
    adhesiveLimit: 1.0, // BP AdhesiveLimit intent
    latMu: 1.7, // = the force model's former global LAT_MU (today)
    longMu: 3.2, // = former global LONG_MU (today)
  },
  collision: {
    crashExtraRoll: 0.3, // BP CrashExtraRollVelocityFactor (flat 0.3 roster-wide)
    crashExtraYaw: 0.3, // BP CrashExtraYawVelocityFactor
    crashExtraLinear: 0.3, // BP CrashExtraLinearVelocityFactor
    frictionFwd: 0.04, // = old global CAR_FRICTION_FWD (today)
    frictionUp: 0.25, // = old global CAR_FRICTION_UP (today)
    frictionLat: 0.18, // = old global CAR_FRICTION_LAT (today)
    restitutionLow: 0.65, // inline literals (closing ≥ 0.65 m/s)
    restitutionHigh: 0.7, // (closing < 0.65 m/s)
  },
};

// ---- BUS (11500 kg) — heavy, sluggish, low grip, high yaw inertia -----------
// Deltas off the sedan baseline, mirroring the BP heavy-class character: less
// down-force per speed, more drag, narrower steering lock that fades sooner,
// harder to break loose (higher drift min-speed, lower side-force) but once
// loose needs far more yaw torque to come around, stiffer springs, more visible
// body lean, lower grip floor, lands heavier. Nothing reads the bus-specific
// values yet beyond what already varied by mass, so this stays inert this phase.
const BUS: HandlingAttribs = {
  base: {
    downforce: 0.007, // less planted (spec table)
    downforceCap: 1.0,
    linearDrag: 6.0, // bulkier — coasts down faster
    angularDrag: 0.05,
    highSpeedAngularDamping: 0.13, // BP heavy median
  },
  steering: {
    lockLow: (18 * Math.PI) / 180, // less lock (spec MaxAngle 15→18° band)
    lockHigh: (3 * Math.PI) / 180,
    speedFullBelow: 13.4,
    speedMinAt: 34, // lock fades sooner (spec SpeedForMinAngle scales w/ mass)
    ramp: 1 / 0.5, // slower to take up lock (heavier hydraulics)
    visualGain: 1.6,
    driftMaxAngle: (28 * Math.PI) / 180, // long wheelbase — less countersteer range
  },
  drift: {
    maxSlip: (35 * Math.PI) / 180, // harder to hold a big slide
    minSpeed: 22, // needs more speed to break loose (BP MinSpeedForDrift up)
    sideForce: 20, // steps out less for its mass (scaled BP SideForceMagnitude)
    naturalYawTorque: 11000, // far more torque to rotate the mass (BP up to 15000)
    wheelSlip: 0.2, // BP WheelSlip lower for heavy
    angularDamping: 0.16, // bleeds spin harder (more inertia to settle)
    deepen: 1 / 0.6, // slip builds slower
    relax: 1 / 0.4, // and unwinds slower
    exitSlip: (8 * Math.PI) / 180,
    scrub: 4.5, // a heavy slide scrubs more speed
    carve: 1.3, // a given slip bends the path less (long wheelbase)
  },
  engine: {
    cruiseSpeed: 28, // lower top (heavier hauls torque but less accel)
    launchSpeed: 39,
    burnoutSpeed: 42,
    launchAccel: 22,
    gearTops: [5, 10, 17, 24, 28, 42],
    gearAccel: [16, 14, 12, 10, 8.5, 7], // slower per gear
    brakeDecel: 20, // longer to haul down
    powerToRear: 1,
  },
  suspension: {
    sag: 0.07, // softer-loading but stiffer-damped (taller spring)
    zeta: 0.75, // stiffer damping (BP Dampening up)
    droop: 0.2,
    maxComp: 0.14,
    springStrengthMult: 1, // factory.ts already scales spring k by mass
  },
  bodyroll: {
    factorOfWeightX: 0.12, // more weight transfer / visible lean (spec table)
    factorOfWeightZ: 0.25,
    rollStiffness: 0.3,
    rollDamping: 0.8,
    pitchStiffness: 0.3,
    pitchDamping: 0.1,
  },
  grip: {
    peakSlip: 0.13,
    peakCoeff: 0.9, // lower peak grip
    floorSlip: 0.55,
    fallCoeff: 0.62,
    latPeakSlip: 0.13,
    latPeakCoeff: 0.9,
    latFloorSlip: 0.55,
    latFallCoeff: 0.62,
    driftLatPeakCoeff: 0.65,
    driftLatFallCoeff: 0.55,
    adhesiveLimit: 0.95,
    latMu: 1.5, // less lateral bite per tonne — a heavy pushes wide
    longMu: 3.0,
  },
  collision: {
    crashExtraRoll: 0.3, // flat 0.3 roster-wide
    crashExtraYaw: 0.3,
    crashExtraLinear: 0.3,
    frictionFwd: 0.03, // a heavy slides a little more freely along travel
    frictionUp: 0.3, // damps vertical chatter harder (more mass to settle)
    frictionLat: 0.22, // grips harder sideways — a heavy contact plants
    restitutionLow: 0.65,
    restitutionHigh: 0.7,
  },
};

// ---- TANKER (15000 kg) — the BP heavy-SUV (SVK) extreme ----------------------
// The clearest "tuned differently" case in BP: sluggish steering, lowest grip,
// highest yaw inertia, stiffest damping (BP Dampening 5 = the SUV), and — the
// signature — it LANDS HEAVY and keeps its rotation through touchdown (BP SVK
// lowers the Max*DampingOnLanding caps; those landing damps live as globals in
// constants.ts for now, this group carries the steering/grip/yaw character).
const TANKER: HandlingAttribs = {
  base: {
    downforce: 0.006, // least planted (spec table)
    downforceCap: 1.0,
    linearDrag: 7.0, // highest (BP LinearDrag 0.5 = SUV)
    angularDrag: 0.05,
    highSpeedAngularDamping: 0.1,
  },
  steering: {
    lockLow: (15 * Math.PI) / 180, // least lock (spec MaxAngle 17 → ours 15°)
    lockHigh: (2.5 * Math.PI) / 180,
    speedFullBelow: 13.4,
    speedMinAt: 30, // lock fades soonest
    ramp: 1 / 0.55, // slowest to take up lock (BP TimeForLock up to 0.55)
    visualGain: 1.5,
    driftMaxAngle: (24 * Math.PI) / 180, // the least countersteer range
  },
  drift: {
    maxSlip: (30 * Math.PI) / 180, // barely drifts — a heave, not a slide
    minSpeed: 26, // highest break-loose speed (BP MinSpeedForDrift up to 60)
    sideForce: 16, // steps out least for its mass (BP SideForceMagnitude low end)
    naturalYawTorque: 15000, // the most torque to rotate the mass (BP max)
    wheelSlip: 0.15, // BP WheelSlip min
    angularDamping: 0.2, // BP DriftAngularDamping max — settles its spin hard
    deepen: 1 / 0.75, // slip builds slowest
    relax: 1 / 0.5, // and unwinds slowest
    exitSlip: (9 * Math.PI) / 180,
    scrub: 5.5, // heaviest slide scrubs the most speed
    carve: 1.1, // longest wheelbase bends the path least per slip
  },
  engine: {
    cruiseSpeed: 26, // lowest top
    launchSpeed: 36,
    burnoutSpeed: 39,
    launchAccel: 18,
    gearTops: [4, 9, 15, 21, 26, 39],
    gearAccel: [13, 11.5, 10, 8.5, 7, 5.5], // slowest per gear
    brakeDecel: 17, // takes the longest to haul down
    powerToRear: 1,
  },
  suspension: {
    sag: 0.08, // tallest, softest-loading spring
    zeta: 0.85, // stiffest damping (BP Dampening 5 = SUV)
    droop: 0.22,
    maxComp: 0.15,
    springStrengthMult: 1, // factory.ts already scales spring k by mass
  },
  bodyroll: {
    factorOfWeightX: 0.15, // most weight transfer / lean (spec table, BP X max)
    factorOfWeightZ: 0.3, // BP Z max
    rollStiffness: 0.3,
    rollDamping: 0.8,
    pitchStiffness: 0.3,
    pitchDamping: 0.1,
  },
  grip: {
    peakSlip: 0.14,
    peakCoeff: 0.85, // lowest peak grip
    floorSlip: 0.55,
    fallCoeff: 0.58,
    latPeakSlip: 0.14,
    latPeakCoeff: 0.85,
    latFloorSlip: 0.55,
    latFallCoeff: 0.58,
    driftLatPeakCoeff: 0.6,
    driftLatFallCoeff: 0.5,
    adhesiveLimit: 0.9,
    latMu: 1.35, // the lowest lateral bite — a tanker heaves, it doesn't carve
    longMu: 2.8,
  },
  collision: {
    crashExtraRoll: 0.3, // flat 0.3 roster-wide
    crashExtraYaw: 0.3,
    crashExtraLinear: 0.3,
    frictionFwd: 0.025, // slides most freely along travel for its mass
    frictionUp: 0.34, // hardest vertical chatter damp (heaviest to settle)
    frictionLat: 0.26, // strongest sideways grip — contacts plant dead
    restitutionLow: 0.65,
    restitutionHigh: 0.7,
  },
};

/** Per-variant handling vault. Resolve once per car (PlayerControl caches
 *  HANDLING[variant]); feature modules may also import HANDLING directly. */
export const HANDLING: Record<Variant, HandlingAttribs> = {
  sedan: SEDAN,
  bus: BUS,
  tanker: TANKER,
};
