# AttribSys Vehicle-Handling Analysis (real shipped data)

Source: the per-vehicle attribute bundles that ship with Burnout Paradise
(`VEH_*_AT.BIN`). Each bundle carries an **AttribSys Vault** resource
(resource type `0x1C`): a small object database keyed by class hash, holding the
tuning constants the physics engine reads at runtime. These are the *authentic*
numbers the game shipped with — extracted by parsing the on-disk vaults, not
invented.

- **Vehicles parsed:** 48
- **Vehicles failed:** 1 — `VEH_CUST205_AT.BIN` (its resource block fails a zlib
  data-integrity check on this local copy; it is a custom/edited file, not a
  retail bundle, so it is excluded rather than guessed at).
- **Class coverage:** every one of the 48 parsed vehicles contains all 13
  attribute classes (engine, drift, collision, suspension, steering, handling,
  boost, two camera behaviours, two car-asset descriptors, body-roll, base).

All numbers below are the literal `f32` values stored in the bundles. Floats are
shown rounded for readability; the raw medians (full precision) are in the
recommended-defaults block at the end.

---

## 1. Airborne / jump physics — min / median / max across all 48 cars

These are the fields that govern how a car behaves in the air (after a jump or
launch) and how it settles on landing. The **median** column is the
representative default to seed a clone with.

### `physicsvehiclebaseattribs` (per-vehicle, read while airborne and on the ground)

| Field | min | median | max |
|---|---|---|---|
| DrivingMass | 721 | 1330 | 4250 |
| MaxSpeed | 112 | 161 | 180 |
| DownForce | 8 | 18.52 | 24 |
| DownForceZOffset | 0 | 0 | 0.5 |
| AngularDrag | 0 | 0.05 | 0.05 |
| HighSpeedAngularDamping | 0.02 | 0.1375 | 0.15 |
| LinearDrag | 0.1 | 0.225 | 0.8 |
| PitchDampingOnTakeOff | 0.75 | 0.9 | 0.95 |
| YawDampingOnTakeOff | 0 | 0.04 | 0.04 |
| RollDampingOnTakeOff | 0 | 0.00125 | 0.075 |
| RollLimitOnTakeOff | 0.65 | 0.8 | 1.1 |
| CrashExtraPitchVelocityFactor | 0 | 0 | 0 |
| CrashExtraRollVelocityFactor | 0.3 | 0.3 | 0.3 |
| CrashExtraYawVelocityFactor | 0.3 | 0.3 | 0.3 |
| CrashExtraLinearVelocityFactor | 0.3 | 0.3 | 0.3 |

### `physicsvehiclesuspensionattribs` (spring + landing-damp behaviour)

| Field | min | median | max |
|---|---|---|---|
| InAirDamping | 30 | 30 | 30 |
| TimeToDampAfterLanding | 0 | 0.1 | 0.1 |
| MaxPitchDampingOnLanding | 0 | 0.6 | 0.6 |
| MaxYawDampingOnLanding | 0 | 1 | 1 |
| MaxRollDampingOnLanding | 0 | 1 | 1 |
| MaxVertVelocityDampingOnLanding | 0 | 0.1 | 0.1 |
| Strength | 0.1 | 0.1 | 0.1 |
| SpringLength | 0.075 | 0.1 | 0.2 |
| Dampening | 2.75 | 3 | 5 |
| FrontHeight | -0.05 | -0.01 | 0.1 |
| RearHeight | -0.1 | -0.01 | 0.04 |
| UpwardMovement | 0.055 | 0.09 | 0.15 |
| DownwardMovement | 0.065 | 0.11 | 0.165 |

### What the airborne fields mean

- **`*DampingOnTakeOff` / `RollLimitOnTakeOff`** — when the wheels leave the
  ground the car's angular velocity is bled off per axis. `PitchDampingOnTakeOff`
  ~0.9 means pitch rotation is strongly damped (the nose doesn't keep tumbling),
  `YawDampingOnTakeOff` ~0.04 is light (the car can still yaw mid-air), and roll
  is barely damped at all but **clamped** by `RollLimitOnTakeOff` so the car
  can't roll past ~0.8 of a full rotation while airborne. These are
  multiplicative damping factors, not torques.
- **`InAirDamping` = 30 (universal)** — a hard constant across the whole roster;
  the in-air orientation settling rate. A clone should treat this as fixed.
- **`Max*DampingOnLanding` + `TimeToDampAfterLanding`** — on touchdown the car
  spends `TimeToDampAfterLanding` (~0.1 s) bleeding off pitch/yaw/roll/vertical
  velocity by up to the `Max*` caps. Median caps: pitch 0.6, yaw 1.0, roll 1.0,
  vertical 0.1. This is what stops a car from bouncing or spinning out after a
  big jump. The heavy SUV (`SVK`) is the outlier that *lowers* these caps so it
  lands heavily and keeps momentum.
- **`DownForce` / `DownForceZOffset`** — aerodynamic down-force pressing the car
  onto the road (median ~18.5, applied at a small rear Z offset on a few cars).
  Higher = more planted at speed.
- **`LinearDrag` / `AngularDrag` / `HighSpeedAngularDamping`** — straight-line
  air resistance, rotational resistance, and an extra rotational damp that kicks
  in at high speed. `AngularDrag` is almost always 0.05 (two cars use 0).
- **`DrivingMass`** — the chassis mass used by the solver. Spread is huge
  (721 → 4250); see units note below.
- **`CrashExtra*VelocityFactor`** — extra spin/launch energy injected on a crash.
  Pitch is always 0; roll/yaw/linear are a flat 0.3 across the entire roster.
  These are effectively global constants, not per-car tuning.

---

## 2. Recommended defaults (the medians)

Use the **median** of each airborne field as the representative default for a
generic clone car. Full-precision raw values are in the structured output
accompanying this doc. Notable ones: `DrivingMass` 1330, `MaxSpeed` 161,
`DownForce` 18.52, `InAirDamping` 30, `PitchDampingOnTakeOff` 0.9,
`RollLimitOnTakeOff` 0.8.

Fields that are **constant or near-constant** across the roster (treat as fixed,
not tunable): `InAirDamping` (30), `CrashExtraRoll/Yaw/LinearVelocityFactor`
(0.3), `CrashExtraPitchVelocityFactor` (0), `Strength` (0.1),
`MaxYaw/RollDampingOnLanding` (1.0 for all but the heavy SUV).

---

## 3. Representative cars (full airborne field values)

Six cars spanning the mass/speed spread, so a synthesis step can sanity-check
that the medians sit in a sensible middle. (Internal `VEH_*` codenames; the
public car names are not stored in these particular fields.)

### Light / agile — `VEH_PCCBR01` (mass 721, the lightest)
- BASE: MaxSpeed 128, DownForce 9, LinearDrag 0.25, AngularDrag 0.05,
  HighSpeedAngularDamping 0.15, PitchDampingOnTakeOff 0.9, YawDampingOnTakeOff 0,
  RollDampingOnTakeOff 0, RollLimitOnTakeOff 0.9
- SUSP: InAirDamping 30, TimeToDampAfterLanding 0.1, MaxPitch/Yaw/Roll 0.6/1/1,
  MaxVert 0.1, Strength 0.1, SpringLength 0.1, Dampening 3.5, Front/RearHeight 0/0,
  Up/DownMovement 0.075/0.085

### Light sports — `VEH_CARBRWDS` (mass 900, top speed 180 — fastest)
- BASE: MaxSpeed 180, DownForce 20.75, LinearDrag 0.25, AngularDrag 0.05,
  HighSpeedAngularDamping 0.12, PitchDampingOnTakeOff 0.9, YawDampingOnTakeOff 0,
  RollDampingOnTakeOff 0.0045, RollLimitOnTakeOff 1.0
- SUSP: InAirDamping 30, Damp-on-land 0.6/1/1, MaxVert 0.1, SpringLength 0.11,
  Dampening 3, Up/DownMovement 0.09/0.1

### Balanced (near the medians) — `VEH_PASC01` (mass 1293)
- BASE: MaxSpeed 165, DownForce 18.52, LinearDrag 0.1, AngularDrag 0.05,
  HighSpeedAngularDamping 0.15, PitchDampingOnTakeOff 0.9, YawDampingOnTakeOff 0.04,
  RollDampingOnTakeOff 0.0075, RollLimitOnTakeOff 1.0
- SUSP: InAirDamping 30, Damp-on-land 0.6/1/1, MaxVert 0.1, SpringLength 0.08,
  Dampening 3, Front/RearHeight -0.02/-0.02, Up/DownMovement 0.09/0.12

### Mid-heavy sedan — `VEH_PASBS01` (mass 1560)
- BASE: MaxSpeed 126, DownForce 10, DownForceZOffset 0.07, LinearDrag 0.1,
  AngularDrag 0 (one of two cars with zero), HighSpeedAngularDamping 0.125,
  PitchDampingOnTakeOff 0.75 (softest pitch damp), RollLimitOnTakeOff 0.8
- SUSP: InAirDamping 30, Damp-on-land 0.6/1/1, SpringLength 0.1, Dampening 3,
  Front/RearHeight 0.04/0.04, Up/DownMovement 0.0725/0.125

### Heavy — `VEH_PCCBC01` (mass 2410)
- BASE: MaxSpeed 136, DownForce 11.5, LinearDrag 0.2, AngularDrag 0.05,
  HighSpeedAngularDamping 0.15, PitchDampingOnTakeOff 0.9, RollLimitOnTakeOff 1.0
- SUSP: InAirDamping 30, Damp-on-land 0.6/1/1, SpringLength 0.2 (longest travel),
  Dampening 2.75, FrontHeight 0.05, Up/DownMovement 0.13/0.15

### Very heavy SUV — `VEH_PBTSVK01` (mass 4250, the heaviest)
- BASE: MaxSpeed 178, DownForce 24 (max), DownForceZOffset 0.5 (max), LinearDrag 0.5,
  AngularDrag 0.05, PitchDampingOnTakeOff 0.95 (stiffest), RollDampingOnTakeOff 0.075
  (max), RollLimitOnTakeOff 0.65 (min)
- SUSP: InAirDamping 30, **landing damps lowered** — MaxPitch 0, MaxYaw 0.3,
  MaxRoll 0.1, MaxVert 0 — so it lands heavy and keeps momentum; SpringLength 0.16,
  Dampening 5 (max)

The SUV is the clearest "this car was tuned differently" case: it keeps almost
all of its airborne rotation through the landing instead of snapping upright.

---

## 4. Overview of ALL AttribSys classes

The vault holds 13 classes per vehicle. Eight are physics/camera tuning; the
rest are wiring (the `physicsvehiclehandling` record is just reference pointers
to the other physics records, and the two `burnoutcar*` records are asset/colour
descriptors with no handling numbers). Ranges below are min / median / max over
the 48 cars.

### `physicsvehiclebaseattribs` — the core chassis/tyre model
The biggest class (~70 fields). Covers mass, top speed, down-force, drag, the
airborne-damp fields above, brake factors, centre-of-mass and wheel positions,
power split front/rear, and a full set of front/rear tyre grip-curve
coefficients (peak/floor slip ratios, static/dynamic friction, adhesive limits).
This is where a clone gets most of its feel.

### `physicsvehiclesuspensionattribs` — spring + landing
Spring `Strength` is a flat 0.1 everywhere; `Dampening` 2.75–5; `SpringLength`
0.075–0.2 (travel). Plus all the landing-damp fields covered in section 1.
Front/RearHeight are small ride-height offsets (−0.1 … +0.1).

### `physicsvehicleengineattribs` — drivetrain
| Field | min / median / max |
|---|---|
| MaxRPM | 4510 / 8000 / 8800 |
| MaxTorque | 187 / 350 / 500 |
| TorqueFallOffRPM | 2800 / 4400 / 6000 |
| EngineBraking | 125 / 500 / 500 |
| Differential | 2.25 / 3.85 / 5.7 |
| TransmissionEfficiency | 0.5 / 0.5 / 1 |
| LSDMGearUpSpeed | 20 / 20 / 30 |

Also holds per-gear ratio/up-RPM/torque-scale tables (stored as vec4 pairs, i.e.
up to 8 gears). `GearChangeTime` is 0 across the whole roster (instant shifts in
this arcade model).

### `physicsvehicledriftattribs` — drifting
| Field | min / median / max |
|---|---|
| DriftMaxAngle | 45 / 60 / 90 |
| MinSpeedForDrift | 40 / 40 / 60 |
| SideForceMagnitude | 15 / 27 / 35 |
| NaturalYawTorque | 3000 / 7000 / 15000 |
| WheelSlip | 0.1 / 0.25 / 0.4 |
| DriftAngularDamping | 0.05 / 0.125 / 0.2 |

`MinSpeedForDrift` ~40 is the same speed scale as `MaxSpeed` (~112–180), another
hint those are game units, not MPH. `GripFromBrake`/`GripFromSteering` are 0 for
all cars (those grip-recovery channels are unused in retail tuning).

### `physicsvehiclesteeringattribs` — steering + AI driving
| Field | min / median / max |
|---|---|
| MaxAngle | 10 / 15 / 17 |
| MinAngle | 1.2 / 1.5 / 2.5 |
| SpeedForMaxAngle | 30 / 30 / 30 |
| SpeedForMinAngle | 90 / 150 / 180 |
| TimeForLock | 0.2 / 0.4 / 0.55 |
| StraightReactionBias | 1.25 / 2.5 / 5 |

Steering lock interpolates from `MaxAngle` (deg) at low speed down to `MinAngle`
at high speed, between `SpeedForMaxAngle` and `SpeedForMinAngle`. This class also
carries the AI's PID-controller coefficients (normal + drift) and look-ahead
distances — useful reference if the clone's rival AI wants authentic feel.

### `physicsvehicleboostattribs` — boost
| Field | min / median / max |
|---|---|
| MaxBoostSpeed | 126 / 185 / 200 |
| BoostAcceleration | 0 / 8 / 15 |
| BoostBase | 0.2 / 1 / 1.5 |
| BoostKickAcceleration | 0 / 16 / 30 |
| BlueMaxBoostSpeed | 170 / 175 / 180 |

`BoostRule` is an integer enum (always 1 in this roster). `MaxBoostSpeed`
(median 185) sits above `MaxSpeed` (median 161) — boost raises the speed ceiling,
as expected. The "blue"/`Blue*` fields are the perfect-/chained-boost variant.

### `physicsvehiclebodyrollattribs` — cosmetic chassis lean
`RollSpringStiffness` 0.3, `RollSpringDampening` 0.8, `PitchSpringStiffness` 0.3,
`PitchSpringDampening` 0.1 are constant across every car. Only the
`FactorOfWeightX/Z` weight-transfer factors vary (X 0.01–0.15, Z 0–0.3). This is
the visible body-lean in corners, layered on top of the rigid-body physics.

### `physicsvehiclecollisionattribs` — collision box
A single `BodyBox` vec4 (half-extents). (It is a vector, so it does not appear in
the scalar range tables above, but it is present for all 48 cars.)

### `camerabumperbehaviour` — bumper/hood camera
Almost entirely constant: FieldOfView 80, BoostFieldOfView 105, PitchSpring 0.5,
YawSpring 0.7, RollSpring 1.0. Plus body-roll/pitch scale and acceleration
response.

### `cameraexternalbehaviour` — chase camera
FieldOfView 60–80, BoostFieldOfView 80–95, PivotLength 6.6–7.8 (chase distance),
PivotHeight 0.9–1.4, DownAngle 0–5. Notably contains the field
**`ZAndTiltCutoffSpeedMPH` = 100** — explicitly named in MPH (see units note).

### Wiring classes (no handling numbers)
- `physicsvehiclehandling` — eight reference pointers tying a car to its
  suspension/steering/engine/drift/collision/boost/body-roll/base records.
- `burnoutcarasset` / `burnoutcargraphicsasset` — vehicle ID, in-game name hash,
  sound/graphics/camera asset references, traffic-colour palette indices, and
  the 12 "offence" references. Identity/asset metadata, not physics.

---

## 5. Units and caveats

- **`MaxSpeed` is in game units (~m/s-scaled), not MPH.** Reasoning: the values
  cluster 112–180. If those were MPH, every economy hatchback and sedan in the
  roster would be a 110–180 MPH supercar, which doesn't match the vehicle mix.
  The class that *is* explicitly in MPH — `cameraexternalbehaviour
  .ZAndTiltCutoffSpeedMPH = 100` — sits *below* the MaxSpeed numbers, and the
  steering/drift speed thresholds (`SpeedForMaxAngle` 30, `SpeedForMinAngle`
  ~150, `MinSpeedForDrift` ~40) live on the same scale as MaxSpeed. So MaxSpeed,
  the boost speeds, and the steering/drift speed thresholds are all one internal
  unit; only the one `*MPH`-suffixed field is in MPH. A clone should treat
  MaxSpeed as an internal speed unit and convert to whatever its own sim uses,
  rather than reading 161 as "161 MPH".
- **`DrivingMass`** is the solver mass in the engine's mass unit (not kg in any
  obvious way — 721 for the lightest car is too low for kg, 4250 for the SUV is
  plausible-ish; the scale is internal). Use the ratios between cars, not the
  absolute number, when porting.
- **Damping fields are unitless multiplicative factors** (mostly 0–1), except
  `InAirDamping` (30) and `NaturalYawTorque` (thousands), which are rate/torque
  values on the engine's internal scale.
- **Constant-across-roster fields** (`InAirDamping`, the `CrashExtra*` trio,
  `Strength`, the body-roll spring constants, camera springs) are global design
  choices, not per-car tuning — a clone can hardcode them.
- **Zero-everywhere fields are reported as 0 honestly:**
  `CrashExtraPitchVelocityFactor` is 0 for all 48 cars;
  `GripFromBrake`/`GripFromSteering` (drift) and `GearChangeTime` (engine) are
  likewise 0 for all cars. These are genuinely zero in the shipped data, not
  missing.
- **Sample = 48 retail vehicles** from the local `example/` fixtures (a subset of
  the full ~70-car game roster). Medians are robust but the absolute min/max
  could widen if the full roster were sampled. One file
  (`VEH_CUST205_AT.BIN`) was excluded due to a failed integrity check.
