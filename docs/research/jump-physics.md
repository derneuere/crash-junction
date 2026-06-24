# Airborne / Jump Physics — Burnout Paradise model ported into Crash Junction

This document specifies how Crash Junction reproduces Burnout Paradise's
ramp-jump and landing feel, using the per-vehicle airborne tuning extracted
from the 48 retail vehicle attribute vaults (see
`attribsys-handling-analysis.md` for the raw min/median/max numbers). It
covers the target behaviour, the constants chosen, the mapping rationale, and
the test/guardrail plan the implementation must satisfy.

Crash Junction is a deterministic, fixed-step game (`FIXED_DT = 1/120`). All
physics runs inside the fixed step; replays are hashed and diff-checked, so
every value here is a compile-time constant and every formula is pure (no
`Math.random`, no `Date`/wall-clock). The airborne attitude is written through
`PlayerControl.update` (`control.ts`), the same place the on-ground orientation
pin lives today.

---

## 1. The target behaviour (what BP does)

BP separates a jump into three phases, each reading a small set of per-vehicle
fields:

**On takeoff** (the frame the wheels leave the ground)
- Gravity stays a plain constant — never scaled in air.
- Launch keeps the car's velocity, rotated by the ramp; the car leaves the lip
  with the attitude the ramp gave it.
- A one-shot per-axis damp is multiplied into the angular velocity using
  `PitchDampingOnTakeOff`, `YawDampingOnTakeOff`, `RollDampingOnTakeOff`. Roll
  in particular is almost entirely killed (median `0.00125`), which is what
  makes a car leave a ramp **composed** instead of tumbling.
- The initial roll is capped by `RollLimitOnTakeOff`.
- The launch attitude is snapshotted.

**In air** (sustained)
- Roll is actively corrected back toward level past a small dead-band, so the
  car lands on its wheels.
- Pitch eases toward the trajectory (nose follows the velocity vector).
- Player input nudges attitude as a torque, not a teleport.
- Nose-up "wheelie" pitch is clamped to a max angle.
- `InAirDamping` bleeds general spin.

**On landing** (the frame the wheels re-touch)
- Incoming **downward** velocity is absorbed (landing squash) using
  `MaxVertVelocityDampingOnLanding`, only while descending.
- Pitch/yaw/roll angular velocity is clamped to the `Max*DampingOnLanding`
  caps, run for `TimeToDampAfterLanding` seconds.
- Steering is briefly softened after a hard landing.

---

## 2. The BP fields → CJ model mapping

| BP field | median | CJ use |
|---|---|---|
| PitchDampingOnTakeOff | 0.90 | one-shot multiplier on pitch angular rate at takeoff |
| YawDampingOnTakeOff | 0.04 | one-shot multiplier on yaw rate at takeoff |
| RollDampingOnTakeOff | 0.00125 | one-shot multiplier on roll rate at takeoff (near-total kill → composed) |
| RollLimitOnTakeOff | 0.80 rad (~46°) | cap on snapshot roll magnitude at takeoff |
| InAirDamping | 30 (internal scale) | general in-air spin bleed, remapped to a sane per-second easing rate |
| TimeToDampAfterLanding | 0.10 s | length of the landing settle window |
| MaxVertVelocityDampingOnLanding | 0.10 | fraction of downward vy absorbed across the settle |
| MaxPitch/Yaw/RollDampingOnLanding | 0.6 / 1 / 1 | (informational) settle blends attitude to road, so these caps are absorbed into the blend |

**Why takeoff damps map directly.** BP's `*DampingOnTakeOff` are dimensionless
multipliers applied as a single multiply at the takeoff instant — `rate < 1`
means "keep this fraction of the spin". CJ reuses them verbatim as one-shot
multipliers on the angular velocity at the takeoff edge. No `factor^dt`
conversion is needed because they are one-shot, not sustained.

**Why `InAirDamping=30` is remapped, not used raw.** 30 is on BP's internal
angular scale, not a CJ per-second easing rate. Fed into CJ's
`min(1, rate*dt)` easing it would clamp to 1 every frame (`30/120 = 0.25`,
killing a quarter of all spin per frame — all rotation gone in ~4 frames),
which would make airborne attitude feel frozen and rigid. We map the *intent*
("bleed general spin gently") to a sane CJ rate of `2.0/s`, which removes
spin over ~0.5 s — fast enough to settle, slow enough to keep the airborne arc
readable.

**Why trajectory-follow and steer-nudge are invented values.** BP gets
nose-follow and air steering from its full rigid-body solver; there is no
single scalar to copy. CJ picks gentle easing/torque rates that read as "the
nose chases the arc" and "you can lean the car a little", tuned to stay inside
the stat envelopes of the two real ramp-jump fixtures.

**Why `RollLimitOnTakeOff` is read as radians.** 0.80 as a roll *angle* cap is
~46°, a sane "don't leave the ramp already half-rolled" limit. Interpreting it
as anything else (a fraction, a rate) produces nonsense here, so it is used as
a radian magnitude clamp on the snapshot roll.

---

## 3. Chosen CJ constants

All added to `constants.ts`. Each cites the BP field it derives from.

```ts
// ---- airborne / jump attitude (BP AttribSys medians → CJ per-frame model) ----
export const AIR_PITCH_FOLLOW_RATE = 3.0;
export const AIR_ROLL_CORRECTION = 2.2;
export const AIR_MIN_ROLL_TO_CORRECT = 0.06;
export const TAKEOFF_PITCH_DAMP = 0.9;
export const TAKEOFF_YAW_DAMP = 0.04;
export const TAKEOFF_ROLL_DAMP = 0.00125;
export const TAKEOFF_ROLL_LIMIT = 0.8;
export const AIR_DAMP = 2.0;
export const MAX_WHEELIE_ANGLE = 0.38;
export const AIR_STEER_TORQUE = 0.9;
export const LAND_SETTLE_SECS = 0.1;
export const LAND_VY_ABSORB = 0.1;
export const LAND_STEER_SOFTEN_SECS = 0.25;
```

Rationale per constant:

- **AIR_PITCH_FOLLOW_RATE = 3.0** — invented; `PitchDampingOnTakeOff` (0.9) sets
  the takeoff attitude, this governs the *sustained* chase of the trajectory.
  `~0.3 s` to take up the arc reads as the nose following the jump without
  snapping.
- **AIR_ROLL_CORRECTION = 2.2** — from the BP intent that the car auto-levels
  to land on its wheels (`RollDampingOnTakeOff` near-zero + active in-air
  correction). `~0.45 s` to level.
- **AIR_MIN_ROLL_TO_CORRECT = 0.06** (~3.4°) — small dead-band so banking on a
  ramp lip and float noise don't fight the level-out.
- **TAKEOFF_PITCH/YAW/ROLL_DAMP = 0.9 / 0.04 / 0.00125** — BP medians, used
  verbatim as one-shot multipliers (§2). Roll near-zero is the "composed" key.
- **TAKEOFF_ROLL_LIMIT = 0.8** rad (~46°) — BP `RollLimitOnTakeOff` median.
- **AIR_DAMP = 2.0** — remapped from `InAirDamping=30` (§2).
- **MAX_WHEELIE_ANGLE = 0.38** rad (~22°) — clamp on nose-up; BP clamps wheelie
  pitch, no single field, chosen for a believable air pose.
- **AIR_STEER_TORQUE = 0.9** — invented player-nudge magnitude; small enough
  that input *leans* the car (torque), never teleports it.
- **LAND_SETTLE_SECS = 0.1** — BP `TimeToDampAfterLanding` median, verbatim.
- **LAND_VY_ABSORB = 0.1** — BP `MaxVertVelocityDampingOnLanding` median: the
  fraction of incoming **downward** vy removed across the settle (squash). Only
  while descending; never adds upward velocity.
- **LAND_STEER_SOFTEN_SECS = 0.25** — invented; brief steering softening after
  a hard landing so the player doesn't snap-turn out of the squash.

---

## 4. Where the change lands in CJ

Today, the airborne case in `control.ts` is weak: the orientation write
(`control.ts` ~428-465) **instantly re-pins** the chassis to the road plane the
moment the measured feature slope drops below `0.02`, and zeroes angular
velocity. That instant snap is what we replace with a **time-blended landing
settle**. The airborne branch currently only pins yaw and lightly decays the
other axes — it has no trajectory-follow, no auto-level, no takeoff damp, and
no landing absorb.

The work is staged:

1. **Foundation** — constants + air-state bookkeeping + takeoff/landing edge
   detection from the existing `airborne` flag. No behaviour change.
2. **Airborne attitude** — replace the airborne orientation handling with
   trajectory-follow pitch, auto-level roll, one-shot takeoff damp, player
   steer-nudge, wheelie clamp.
3. **Landing** — replace the instant slope re-pin with a `LAND_SETTLE_SECS`
   blend to the road plane, and absorb downward vy on the landing edge.

The detailed file-by-file edit spec is delivered separately to the
implementers.

---

## 5. Determinism + test plan (guardrails)

The change must keep every existing replay invariant. The two real ramp-jump
fixtures (`junction-main-ramp-jump.json`, `pad-jump-line.json`) carry
**required** checksums that will diverge by design once the physics changes —
they are re-recorded **only after the user approves the feel**, never in the
implementation workflow. Their stat envelopes must still hold.

Invariants:

- **Determinism** — no `Math.random`, no `Date`/wall-clock; all new state and
  math inside the fixed step; new fields seeded in `PlayerControl.reset`.
- **Flat ground stays flat** — `boost-jump-flat-pad.json`: boosting on flat
  ground must not launch or tilt (`maxAltitude < 4`, `maxUpwardSpeed < 8`,
  `maxTiltDeg < 60`). Airborne attitude code acts **only when genuinely
  airborne** and never adds upward velocity.
- **Contact is not a ramp** — `ram-launch.json`, `corner-pileup-planted.json`:
  `maxUpwardSpeed <= 3`, `maxAltitude <= 3.5`. The new code adds no upward
  velocity; the `Game.ts` vy clamps (`LIVE_VY_GAIN_PER_STEP`,
  `LIVE_CAR_CONTACT_VY`, `RAMP_LAUNCH_VY_MAX`) stay intact.
- **Real ramps still launch sanely** — `junction-main-ramp-jump.json`
  (`maxAltitude` 1.4-8, `upSpeed <= 14`, `tilt <= 181`) and
  `pad-jump-line.json` (`maxAltitude` 5-11, `upSpeed` 7-12.5, `tilt <= 181`).
  Don't kill the launch or wildly over/under-rotate.
- **The flat-ground re-pin no-op is preserved** — on flat ground both
  fore/aft and lateral base differentials are exactly 0; the settle's blend
  target must remain the bit-identical no-op there.

No commits and no fixture re-records are part of this work.
