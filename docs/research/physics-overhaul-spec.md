# Physics Overhaul — implementation brief

Source of truth for the BP-derived handling/crash improvements. Grounded in the
reverse-engineered model (`burnout-pr/docs/RaceCarPhysics_findings.md`) and the
authentic per-vehicle vault numbers (`attribsys-handling-analysis.md`). Read
both before implementing.

## Ground rules (apply to EVERY feature)

1. **Determinism is sacred.** Everything runs inside the `FIXED_DT = 1/120`
   step. No `Math.random` (use `simRand` from `rng.ts` for sim randomness, and
   only where a draw already happens), no `Date`/`performance.now`/wall-clock in
   sim code. Reorder nothing that changes results outside the feature.
2. **Guarded & reversible.** Each new force/curve is gated behind a per-variant
   attrib and/or a tunable strength scalar so feel can be dialed to zero
   (= today's behaviour). Default the scalars so the **sedan stays close to its
   current feel**; bus/tanker may diverge more (they barely had distinct feel
   before).
3. **Do NOT re-record replay fixtures.** Physics changes will diverge the
   `tests/replays/*.json` checksums **by design**. Per the determinism contract
   in `jump-physics.md`, fixtures are re-recorded only after the user approves
   the feel — never in this work. Expect `npm test` physics fixtures to FAIL
   after these changes; that is acceptable and must be called out in the PR.
4. **New tuning constants live with their feature** (or in the per-variant
   attribs block), not scattered into the shared `constants.ts`, to keep the
   modules cohesive after the refactor.
5. **Units:** SI internally (m, s, m/s, rad, kg via cannon). BP `MaxSpeed`/speed
   thresholds are an internal unit (~m/s-scaled), NOT mph — port the *ratios and
   character*, not the raw integer. CJ already uses m/s (LAUNCH_SPEED 44 etc.).
6. The roster is **three handling variants**: `sedan` (1450 kg), `bus`
   (11500 kg), `tanker` (15000 kg). "Per-car attribs" = giving these three
   distinct, BP-grounded profiles.

---

## Feature A — Per-variant grouped handling attribs (FOUNDATION, do first, alone)

Today handling is global constants in `constants.ts` + `control.ts`; only
mass/size differ per variant (`vehicles.ts` SPECS). Introduce a grouped,
per-variant attribs block — the BP "the sim is generic, the feel is data"
lesson — that every later feature reads.

**Deliverable:** a new module exporting `HANDLING: Record<Variant, HandlingAttribs>`
with groups mirroring BP's vault classes:

```
interface HandlingAttribs {
  base:       { downforce; downforceCap; linearDrag; angularDrag; highSpeedAngularDamping }
  steering:   { lockLow; lockHigh; speedFullBelow; speedMinAt; ramp; visualGain }
  drift:      { maxSlip; minSpeed; sideForce; naturalYawTorque; wheelSlip; angularDamping;
                deepen; relax; exitSlip; scrub; carve }
  engine:     { cruiseSpeed; launchSpeed; burnoutSpeed; launchAccel; gearTops[]; gearAccel[];
                brakeDecel; powerToRear }   // see Feature E for torque-curve option
  suspension: { sag; zeta; droop; maxComp; springStrengthMult }
  bodyroll:   { factorOfWeightX; factorOfWeightZ; rollStiffness; rollDamping;
                pitchStiffness; pitchDamping }   // see Feature B
  grip:       { peakSlip; peakCoeff; floorSlip; fallCoeff;            // longitudinal
                latPeakSlip; latPeakCoeff; latFloorSlip; latFallCoeff; // lateral
                driftLatPeakCoeff; driftLatFallCoeff; adhesiveLimit }  // see Features C/D
  collision:  { crashExtraRoll; crashExtraYaw; crashExtraLinear }     // see Feature F
}
```

**Wiring:** `control.ts`/`suspension.ts`/`collision.ts` read `HANDLING[variant].*`
instead of the bare module constants. Keep the module constants as the **default
fallback / sedan baseline** so the sedan reproduces today's numbers; derive bus
& tanker as deltas. Plumb the active variant's attribs into `PlayerControl`
(it already knows its spec/variant).

**BP-grounded values (port ratios, then tune):**

| group/field | sedan (≈BP PASC01 median) | bus (heavy) | tanker (≈BP SVK SUV) | BP basis |
|---|---|---|---|---|
| base.downforce | keep current DOWNFORCE 0.009 | 0.007 | 0.006 | DownForce med 18.5; heavy SUV max 24 but proportionally less planted |
| base.linearDrag | low | higher | highest | LinearDrag 0.1/0.2/0.5 |
| steering.lockLow / lockHigh | keep 22.5°/3.6° | 18°/3° | 15°/2.5° | MaxAngle 10/15/17, MinAngle 1.2–2.5; heavier = less lock |
| steering.speedMinAt | keep 38 | 34 | 30 | SpeedForMinAngle scales with mass class |
| drift.minSpeed | keep | higher | highest | MinSpeedForDrift 40–60 |
| drift.sideForce | med | low | lowest | SideForceMagnitude 15/27/35 (scaled per mass) |
| drift.naturalYawTorque | med | high (heavy) | highest | NaturalYawTorque 3000/7000/15000 — heavier needs more |
| drift.wheelSlip | 0.25 | 0.2 | 0.15 | WheelSlip 0.1–0.4 |
| engine.* | keep current tables | lower top, slower | lowest top, slowest | MaxTorque 187/350/500; heavier hauls more torque but less accel |
| suspension.zeta/damp | keep 0.6 | stiffer | stiffest (Dampening 5 = SUV) | Dampening 2.75/3/5 |
| bodyroll.factorOfWeightX/Z | 0.08 / 0.15 | 0.12 / 0.25 | 0.15 / 0.30 | FactorOfWeightX 0.01–0.15, Z 0–0.3 |
| collision.crashExtra{Roll,Yaw,Linear} | 0.3 / 0.3 / 0.3 | 0.3 | 0.3 | flat 0.3 across whole BP roster |
| landing damps (already in constants) | median | median | **lowered** (lands heavy, keeps momentum) | SVK lowers Max*DampingOnLanding |

Tanker/bus mirror the BP heavy-SUV character: sluggish steering, low grip, high
yaw inertia, lands heavy and keeps its rotation through touchdown.

---

## Feature B — Weight transfer as additive external spring force

BP injects a **clamped weight-transfer vector as additive `F_ext` onto each
spring** — it never moves the COM. CJ today only adds downforce to the springs;
brake-dive / throttle-squat / corner-lean are visual-only.

**Implement:** in the suspension corner force, add an external load term derived
from the body's longitudinal & lateral acceleration this step:
`Fext_corner = clamp(massLoad * (aLong*signFrontRear*kZ + aLat*signLeftRight*kX))`
where `kX = bodyroll.factorOfWeightX`, `kZ = bodyroll.factorOfWeightZ`. Front
corners load under braking, rear under throttle, outside under cornering — so
those tyres press harder (→ more grip once Feature C lands). Clamp to a sane
fraction of static load. Acceleration can be read from the change in the
controller's speed/heading state (already tracked) or body velocity delta.

Keep the existing visual roll/pitch; this is the *physics* coupling underneath
it. Gate behind a `WEIGHT_TRANSFER_STRENGTH` scalar (default ~1, set 0 to
disable).

---

## Feature C — Tire grip curve (guarded; rear lateral force model)

The biggest feel lever and the one architectural extension. Add a Pacejka-like
**rise-then-fall coefficient curve** evaluated per direction:

```
grip(slip) = peakCoeff * smoothstep(slip/peakSlip)              // slip < peakSlip (rise)
           = lerp(peakCoeff, fallCoeff, smoothstep(t))          // peakSlip..floorSlip (fall)
           = fallCoeff                                          // plateau
```

Sign-symmetric. A **separate, lower/flatter drift lateral curve**
(`driftLatPeakCoeff`, `driftLatFallCoeff`) for when drifting (Feature D).

**Integration (kinematic-compatible, guarded):** CJ's player is kinematic
(scalar speed/heading written to the body). Do NOT rip that out. Instead derive
a **lateral slip estimate** (from steer vs. heading-vs-velocity) and feed it
through the lateral grip curve to modulate:
- the lateral force / yaw response in the gripped model, and
- the drift entry/sustain (couples to Feature D).
Apply tyre force at the contact patch as `r × F` torque where it makes sense
(BP applies friction as torque, not a linear shove), reusing cannon
`applyImpulse(J, r)` / `applyForce(F, r)`. Blend new-vs-old behaviour with a
`GRIP_CURVE_BLEND` scalar (default chosen so sedan ≈ today; raise to taste).
This must compile and stay deterministic; if full force-based lateral proves
unstable, keep it as a *modulation* of the existing kinematic lateral rate
rather than a replacement — the curve still drives the feel.

Per-variant coefficients from BP base-attribs grip block (front/rear peak/floor
slip, static/dynamic friction, adhesive limit); medians ≈ `peakSlip 0.12,
peakCoeff 1.0, floorSlip 0.55, fallCoeff 0.7`, drift lat ≈ 0.72×peak / flatter.

**Add a debug grip-curve readout** to the DebugOverlay (BP's only caller of the
sampler was a debug plotter — mirror that so the curve can be tuned).

---

## Feature D — Drift as an explicit finite-state machine

Today drift is a boolean + kinematic slip-chase. Harden to BP's model:

- Tri-state `DriftState = NONE | LEFT | RIGHT`. `EnterDrift` **latches the
  direction from the sign of the steering input at entry**; that sign then signs
  every drift force. `ExitDrift` on the existing guards.
- Scripted, ground-tangent-projected forces while drifting, each gated:
  - **MaintainDriftSpeed** — impulse along the velocity blend so a slide doesn't
    scrub speed (replaces / augments raw DRIFT_SCRUB).
  - **DriftScale/Yaw** — grow slide toward `drift.maxSlip`; add self-aligning
    yaw via `drift.naturalYawTorque`.
  - **DriftLatForce** — sideways force (`drift.sideForce`) stepping the rear out,
    using the Feature-C drift lateral curve.
  - `drift.angularDamping` bleeds excess spin.
- Keep handbrake/entry conditions; just route them through the FSM.

Values from BP drift attribs (DriftMaxAngle 45/60/90°, SideForceMagnitude
15/27/35, NaturalYawTorque 3000/7000/15000, WheelSlip 0.1–0.4,
DriftAngularDamping 0.05–0.2), per variant from Feature A.

---

## Feature E — Engine depth (guarded)

CJ's engine is a per-gear accel table. Add an opt-in **torque-curve model**:
- `torque(rpm)` rising to `MaxTorque` then falling past `TorqueFallOffRPM`.
- Flywheel-ish integration (smoothed power delivery), automatic gearbox from
  gear ratios + up-RPM thresholds, rev limiter from `MaxRPM`, limited-slip diff
  clamp (mean ± spread), `powerToRear` split (RWD default).
- Non-linear brake curve (soft start, sharp end) replacing flat `BRAKE_DECEL`.

Gate behind `ENGINE_TORQUE_MODEL` per variant (default may stay the proven accel
table for sedan to protect feel; enable richer model for bus/tanker, or expose
the scalar). BP engine attribs: MaxRPM 4510/8000/8800, MaxTorque 187/350/500,
TorqueFallOffRPM 2800/4400/6000, Differential 2.25/3.85/5.7, GearChangeTime 0
(instant), TransmissionEfficiency 0.5.

---

## Feature F — Crash layer (impulse/restitution + spin + slam envelope)

CJ crashes are gate-driven state machines + the (good) shunt-kick rework. Add
the BP contact richness:

- **CrashExtra spin injection:** on entering a wreck/crash, inject extra angular
  velocity = `crashExtra{Roll,Yaw,Linear}` (flat **0.3** in BP) scaled by impact
  — the tumble energy. From Feature A collision group.
- **Slam as a parabolic one-shot:** model the takedown slam steering kick with
  the BP envelope `env = r − r²` (r = normalised life, peaks at midpoint),
  rate-limited (~2/s) — a smooth wallop that ramps in and fades. Distinct from
  the AI attack-run targeting already in `race.ts`.
- **Restitution by closing speed:** wall/contact bounce uses `e = 0.65` normal,
  `0.70` for harder hits (BP inline literals).
- **Anisotropic car-to-car friction:** remove velocity along the three body axes
  with different per-axis scales (slides one way, grips another) — directional
  crash feel.
- **Crash master switch:** ensure one `isCrashing`/`crashed` gate cleanly swaps
  controlled-contact behaviour for the raw tumble (per-axis exponential damping)
  — CJ has `crashed`/`destabilized`; formalise the swap.

Keep the existing shunt rework intact; layer these on top. Respect the existing
fixtures' INTENT (a faster door-to-door win is a shunt not a SLAM; debris isn't
a wall; planted contact stays on track) — don't regress those rules.

---

## Feature G — Water = kill switch

BP zeroes linear+angular velocity and the force rows when deep in water (a fail
state, no buoyancy). CJ has a visual sea but no water death. Add: if a car is
below sea level and deep enough, zero its velocities and trigger the existing
off-track/respawn (or a sink) path. Small, self-contained; keep it deterministic
and gated by a sea-level constant from the level/sea config.

---

## Verification expectations

- `npx tsc --noEmit` clean.
- `npm run build` succeeds.
- `npm test`: the **2 pre-existing** failures remain; **physics fixtures will
  additionally diverge by design** (document which) — do NOT re-record them.
- The conductor (main loop) drives the dev server and screenshots sedan/bus/
  tanker handling, a drift, a jump, and a crash to confirm nothing is broken.
</content>
</invoke>
