import * as CANNON from 'cannon-es';
import {
  FIXED_DT,
  GRAVITY,
  LAND_VY_ABSORB,
  RAMP_LAUNCH_VY_MAX,
  SUSP_DROOP,
  SUSP_MAX_COMP,
  WRECK_SCRUB_DECAY,
  WRECK_RIM_SAG,
  WRECK_SCRUB_LOAD_CAP,
  WRECK_SCRUB_SLIP,
} from './constants';
import { HANDLING } from './handling';
import { GameState, type Actor } from './types';

// Four virtual wheel rays per car, solved analytically against the level's
// height field (road-base elevation + ramp/kerb features). Each applies
// F = preload + k·compression − c·railVelocity along the chassis-up axis at
// the wheel anchor (clamped to [0, fmax] so hard landings can't trampoline).
// Flipped cars get no suspension — their rays point away from the road — so
// wrecks tumble on the chassis box. While driving, speed² downforce adds
// grip; once crashed, downforce is off (wrecks may fly) and each wheel still
// on the road scrubs from its own spring load (applyWreckScrub), so an upright
// sliding wreck settles by yawing on its tires rather than dragging as a lump.

const _sUp = new CANNON.Vec3();
const _sAnchor = new CANNON.Vec3();
const _sR = new CANNON.Vec3();
const _sPv = new CANNON.Vec3();
const _sF = new CANNON.Vec3();
const Y_AXIS = new CANNON.Vec3(0, 1, 0);

// Feature B — weight transfer as additive external spring force
// (docs/research/physics-overhaul-spec.md). BP injects a clamped weight-transfer
// vector as additive F_ext onto each spring (Burnout's weight-transfer model) —
// it NEVER moves the COM. CJ until now only
// added speed²-downforce; brake-dive / throttle-squat / corner-lean were
// visual-only. Here each corner spring gains an external load term derived from
// the body's longitudinal & lateral acceleration THIS step:
//   Fext = clamp( load * (aLong·signFrontRear·kZ + aLat·signLeftRight·kX) )
// so the front corners press harder under braking, the rear under throttle, and
// the outside under cornering (→ more grip once the Feature-C grip curve lands).
// kX/kZ are the per-variant body-roll weight factors (HANDLING[variant].bodyroll).

// Master strength scalar — dial to 0 to reproduce the old (downforce-only)
// behaviour exactly; ~1 is the BP-grounded feel. Sedan defaults keep the feel
// close to today (small kX/kZ); bus/tanker diverge more (heavier transfer).
const WEIGHT_TRANSFER_STRENGTH = 1;
// Clamp each corner's external load to this fraction of its STATIC load
// (s.preload = mass/4·g). Keeps a hard brake or a sharp swerve from lifting a
// corner spring to absurd force / spiking the contact solver — BP likewise
// clamps mWeightTransfer to a bounded 3-vector before distributing it.
const WEIGHT_TRANSFER_CLAMP = 0.6;

// Previous-frame world velocity per actor, so longitudinal/lateral acceleration
// can be differenced INSIDE this module without a new caller argument or an
// edit to the Actor type (this is where the suspension/spring state lives). A
// WeakMap keyed by the actor is deterministic — population order follows the
// fixed-step actor list, no wall-clock / RNG involved — and self-cleans when an
// actor is dropped. First frame for an actor has no previous sample → zero
// accel → zero transfer (a clean, side-effect-free warm-up).
const _prevVel = new WeakMap<Actor, CANNON.Vec3>();
const _sFwd = new CANNON.Vec3(); // body forward axis (−z local), world space
const _sRight = new CANNON.Vec3(); // body right axis (+x local), world space
const FWD_LOCAL = new CANNON.Vec3(0, 0, -1);
const X_AXIS = new CANNON.Vec3(1, 0, 0);

/** The driving surface, decomposed (elevation.md Phase 1):
 *    total(x, z)  = base(x, z) + feature(x, z)   — what the wheels ride
 *    base(x, z)   — the smooth road-grade elevation field. FOLLOW it,
 *                   never fling off it: profile slopes are design-bounded
 *                   (metres over tens of metres), so its rise rate passes
 *                   to the car uncapped (the absolute roof still applies).
 *    feature(x,z) — ramps, kerb plinths, ramp side-skirts. LAUNCHABLE,
 *                   capped by the feature's own height above the road.
 *  The split exists because the per-surface launch cap must read FEATURE
 *  height, not absolute height: at +6 m of base elevation a 0.16 m kerb
 *  read as a 6.16 m surface and flung cars at the 12 m/s roof — the same
 *  edge-launch bug class the constants.ts scar comments document, with a
 *  new trigger. On flat levels base() is exactly 0 and every output of
 *  this contract is bit-identical to the pre-elevation sampler. */
export interface HeightSampler {
  (x: number, z: number): number;
  base(x: number, z: number): number;
  feature(x: number, z: number): number;
}

export function applySuspension(actors: Actor[], state: GameState, heightAt: HeightSampler): void {
  for (const a of actors) {
    if (a.kind !== 'vehicle' || !a.spec || a.body.sleepState === CANNON.Body.SLEEPING) continue;
    const b = a.body;
    const ride = a.spec.rideHeight;
    b.quaternion.vmult(Y_AXIS, _sUp); // chassis up, world space
    let grounded = 0;

    // ---- Feature B: this step's body-frame acceleration -> weight transfer ---
    // Difference world velocity against last frame's stored sample, project onto
    // the body forward/right axes for longitudinal (aLong) & lateral (aLat)
    // accel. Like the downforce below it only runs while DRIVING (a wreck tumbles
    // free; the start line is inert), and it's gated to zero by the strength
    // scalar. kZ/kX are the per-variant body-roll weight factors. Computed once
    // per car here, consumed per corner in the spring loop. prevVel is refreshed
    // at the END of the car's iteration so the difference always spans one frame.
    const roll = HANDLING[a.spec.variant].bodyroll;
    let aLong = 0;
    let aLat = 0;
    const wtActive = WEIGHT_TRANSFER_STRENGTH > 0 && !a.crashed && state !== GameState.Idle;
    if (wtActive) {
      const prev = _prevVel.get(a);
      if (prev) {
        b.quaternion.vmult(FWD_LOCAL, _sFwd); // forward (−z local), world
        b.quaternion.vmult(X_AXIS, _sRight); // right (+x local), world
        // world Δv/dt projected onto each body axis (reuse _sPv as scratch)
        _sPv.copy(b.velocity);
        _sPv.vsub(prev, _sPv);
        _sPv.scale(1 / FIXED_DT, _sPv);
        aLong = _sPv.dot(_sFwd); // +accelerating forward, − braking
        aLat = _sPv.dot(_sRight); // +accelerating rightward
      }
    }

    for (const s of a.susp) {
      s.grounded = false;
      s.load = 0; // normal force this corner reports to the tire model (0 = airborne)
      if (_sUp.y < 0.35) {
        s.dist = ride + SUSP_DROOP; // tipped over
        continue;
      }
      _sAnchor.set(s.ax, 0, s.az);
      b.quaternion.vmult(_sAnchor, _sAnchor);
      _sR.copy(_sAnchor); // anchor offset from COM (world axes)
      _sAnchor.vadd(b.position, _sAnchor);
      const ground = heightAt(_sAnchor.x, _sAnchor.z);
      const dist = (_sAnchor.y - ground) / _sUp.y; // ray along -up to the local ground plane
      s.dist = dist;
      if (dist > ride + SUSP_DROOP) continue; // wheel in the air
      const comp = Math.min(ride - dist, SUSP_MAX_COMP);
      b.angularVelocity.cross(_sR, _sPv);
      _sPv.vadd(b.velocity, _sPv); // wheel-anchor velocity
      // sag < 1 = crash-bent corner carrying less load (axle sag lean)
      let f = (s.preload + s.k * comp) * s.sag - s.c * _sPv.dot(_sUp);
      // Feature B: additive external load. signFrontRear = sign(az) (front az<0
      // loads under braking, rear az>0 under throttle); signLeftRight = −sign(ax)
      // (the OUTSIDE corner loads in a turn). massLoad = the corner's STATIC load
      // (s.preload), so the transfer is a fraction of the weight the spring
      // already carries. Clamped to ±WEIGHT_TRANSFER_CLAMP of that static load so
      // a hard brake / sharp swerve can't pole-vault or null a corner spring.
      // Folded in only while driving (aLong/aLat are 0 otherwise) — never on a
      // wreck — and scaled by the master strength scalar (0 = old behaviour).
      if (wtActive) {
        const signFR = Math.sign(s.az); // front −1, rear +1
        const signLR = -Math.sign(s.ax); // outside-loads-in-a-turn
        let fext =
          s.preload * (aLong * signFR * roll.factorOfWeightZ + aLat * signLR * roll.factorOfWeightX);
        fext *= WEIGHT_TRANSFER_STRENGTH * s.sag; // a bent corner transfers less
        const cap = s.preload * WEIGHT_TRANSFER_CLAMP;
        if (fext > cap) fext = cap;
        else if (fext < -cap) fext = -cap;
        f += fext;
      }
      if (f <= 0) continue; // springs can't pull
      if (f > s.fmax) f = s.fmax;
      _sUp.scale(f, _sF);
      b.applyForce(_sF, _sR); // cannon-es: world-oriented offset from COM
      s.grounded = true;
      s.load = f; // the friction-circle radius for this corner's tire this step
      grounded++;
    }

    // aero downforce while driving (off once crashed, so wrecks can fly) —
    // the textbook quadratic, coefficient + cap per variant (sedan = the old
    // DOWNFORCE / DOWNFORCE_CAP globals; the heavies get less per speed)
    if (!a.crashed && state !== GameState.Idle && grounded >= 3) {
      const aero = HANDLING[a.spec.variant].base;
      const v = b.velocity;
      const v2 = v.x * v.x + v.z * v.z;
      b.force.y -= Math.min(aero.downforce * v2, aero.downforceCap * Math.abs(GRAVITY)) * b.mass;
    }

    // kinematic ground-follow for driven cars: the spring/damper alone can't
    // track a rising wedge at speed (the damper saturates above ~2 m/s of
    // ascent and force caps at fmax), so a fast car would plow THROUGH a
    // ramp instead of riding it. Hold the chassis at full stroke above the
    // field and hand it the field's rise rate — the lip then releases it
    // ballistically, which is what makes ramp jumps reach the rings.
    if (!a.crashed && _sUp.y > 0.5) {
      const ground = heightAt(b.position.x, b.position.z);
      // the floor must also clear the chassis box off the physical ground
      // plane (halfY > ride − stroke on every spec!) — holding the box even
      // centimetres into the plane feeds the contact solver a sustained
      // lever and hard landings slowly pole-vault the car into a flip
      const minY = ground + Math.max(ride - SUSP_MAX_COMP, a.spec.halfY + 0.01);
      if (b.position.y < minY) {
        b.position.y = minY;
        const v = b.velocity;
        // landing absorb (squash): whenever the kinematic floor catches a
        // descending chassis (v.y < 0) — which is exactly the post-air landing
        // frame, and also any other moment the chassis is pushed down into the
        // floor — damp the DOWNWARD velocity so a slam is absorbed instead of
        // bouncing. This only REDUCES the magnitude of a negative vy; it can
        // never produce upward velocity, so the vy clamps in Game.ts and the
        // per-surface launch cap below are unaffected. The v.y < 0 guard is the
        // whole gate — no separate landing flag is needed.
        if (v.y < 0) v.y *= 1 - LAND_VY_ABSORB;
        const ax = b.position.x + v.x * FIXED_DT;
        const az = b.position.z + v.z * FIXED_DT;
        const ahead = heightAt(ax, az);
        const rise = (ahead - ground) / FIXED_DT;
        if (rise > 0) {
          // a FEATURE can fling you no higher than ~2× its own height: full
          // ramps launch for real, kerbs and ramp side-skirts only blip —
          // their sub-metre blend zones read as 20+ m/s rises at speed.
          // The cap measures the feature ABOVE the local road base, never
          // absolute height (elevation.md: a kerb at +6 m of road elevation
          // must still blip at √(4·g·0.16) ≈ 2.7 m/s, not fling at the
          // roof). The base-grade share of the rise passes through uncapped
          // — profile slopes are gentle by design — under the absolute
          // RAMP_LAUNCH_VY_MAX roof. On flat ground base ≡ 0, so baseRise
          // is exactly 0 and this is bit-for-bit the old per-surface cap.
          const featAhead = heightAt.feature(ax, az);
          const featRise = (featAhead - heightAt.feature(b.position.x, b.position.z)) / FIXED_DT;
          const baseRise = Math.max(0, rise - featRise);
          const featCap = Math.sqrt(4 * Math.abs(GRAVITY) * featAhead);
          v.y = Math.max(v.y, Math.min(rise, baseRise + featCap, RAMP_LAUNCH_VY_MAX));
        }
      }
    }

    // crashed cars riding on springs: per-wheel tire scrub from each corner's
    // own load, applied AT the wheel — a wreck settles by yawing on its tires
    // (the sideways scrub at an off-centre corner is a torque), not by one lump
    // of friction dragging the whole car and a scripted spin-down
    if (a.crashed) applyWreckScrub(a, b);

    // Feature B: store THIS frame's incoming velocity for next frame's accel
    // difference. Captured fresh each call (not the intra-frame-mutated value —
    // the landing-absorb above only touches v.y) so the difference always spans
    // exactly one fixed step. Stored unconditionally so the sample never goes
    // stale (a car that was crashed/idle then resumes driving warms up from a
    // current sample rather than a frame-old one → no transfer spike on resume).
    let store = _prevVel.get(a);
    if (!store) {
      store = new CANNON.Vec3();
      _prevVel.set(a, store);
    }
    store.copy(b.velocity);
  }
}

/** A crashed car's wheels keep scrubbing on the road (Burnout's crashing cars
 *  keep reacting to the ground per wheel): each grounded corner turns its
 *  contact slip into a Coulomb-limited force from ITS OWN spring load, split
 *  into the wheel's rolling and sideways axes (per-variant limits,
 *  HANDLING.collision.wreckScrub*), applied AT the wheel so an off-centre
 *  reaction yaws the wreck into settling. A corner that leaves the ground keeps
 *  applying a fading copy of its last force (×WRECK_SCRUB_DECAY per step)
 *  rather than cutting to zero — a bouncing wreck keeps a fading grip on the
 *  road. Anchors sit at COM height, so the scrub is pure yaw + linear (no roll
 *  moment: a sliding wreck doesn't trip itself over). Deterministic. */
function applyWreckScrub(a: Actor, b: CANNON.Body): void {
  const col = HANDLING[a.spec!.variant].collision;
  b.quaternion.vmult(FWD_LOCAL, _sFwd);
  // wheel axes flattened onto the road plane — a wreck's tires scrub along the
  // road whatever its roof is doing. A nose pointing straight up or down (a
  // wreck on its end) has no rolling axis: only the fading memory applies.
  const fl = Math.hypot(_sFwd.x, _sFwd.z);
  const canScrub = fl > 0.2;
  const fx = canScrub ? _sFwd.x / fl : 0;
  const fz = canScrub ? _sFwd.z / fl : 0;
  const rx = -fz; // right of forward in the road plane
  const rz = fx;
  const mw = b.mass / 4;
  for (const s of a.susp) {
    _sR.set(s.ax, 0, s.az);
    b.quaternion.vmult(_sR, _sR); // wheel anchor offset from COM, world axes
    if (s.grounded && canScrub && s.load > 0) {
      b.angularVelocity.cross(_sR, _sPv);
      _sPv.vadd(b.velocity, _sPv); // contact-point velocity
      const vLong = _sPv.x * fx + _sPv.z * fz;
      const vLat = _sPv.x * rx + _sPv.z * rz;
      // the grip load is the corner's spring load, bounded near its STATIC
      // load: a wreck rocking on its springs (the crash-entry tumble, a hard
      // landing) spikes the spring toward fmax, and letting that spike into the
      // scrub stopped a 20 m/s wreck in half a second — tire grip, not a brick
      // wall. Ramps to the Coulomb limit over WRECK_SCRUB_SLIP of slip; capped
      // so a corner's impulse can never reverse the slip it opposes in a step.
      const load = Math.min(s.load, s.preload * WRECK_SCRUB_LOAD_CAP);
      const kSlip = load / WRECK_SCRUB_SLIP;
      // a corner on its RIM (the wheel torn off) or on a badly bent axle
      // doesn't roll — it grinds, so it scrubs sideways-hard along travel too
      const muLong = s.sag <= WRECK_RIM_SAG ? col.wreckScrubLat : col.wreckScrubLong;
      const fLong =
        -Math.sign(vLong) * Math.min(Math.abs(vLong) * kSlip, muLong * load, (Math.abs(vLong) * mw) / FIXED_DT);
      const fLat =
        -Math.sign(vLat) * Math.min(Math.abs(vLat) * kSlip, col.wreckScrubLat * load, (Math.abs(vLat) * mw) / FIXED_DT);
      s.scrubX = fLong * fx + fLat * rx;
      s.scrubZ = fLong * fz + fLat * rz;
    } else {
      s.scrubX *= WRECK_SCRUB_DECAY;
      s.scrubZ *= WRECK_SCRUB_DECAY;
      if (Math.abs(s.scrubX) + Math.abs(s.scrubZ) < 1) {
        s.scrubX = 0;
        s.scrubZ = 0;
        continue;
      }
    }
    _sF.set(s.scrubX, 0, s.scrubZ);
    b.applyForce(_sF, _sR);
  }
}
