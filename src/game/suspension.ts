import * as CANNON from 'cannon-es';
import {
  DOWNFORCE,
  DOWNFORCE_CAP,
  FIXED_DT,
  GRAVITY,
  LAND_VY_ABSORB,
  RAMP_LAUNCH_VY_MAX,
  SUSP_DROOP,
  SUSP_MAX_COMP,
  WRECK_GRIP,
} from './constants';
import { GameState, type Actor } from './types';

// Four virtual wheel rays per car, solved analytically against the level's
// height field (road-base elevation + ramp/kerb features). Each applies
// F = preload + k·compression − c·railVelocity along the chassis-up axis at
// the wheel anchor (clamped to [0, fmax] so hard landings can't trampoline).
// Flipped cars get no suspension — their rays point away from the road — so
// wrecks tumble on the chassis box. While driving, speed² downforce adds
// grip; once crashed, downforce is off (wrecks may fly) and Coulomb friction
// from the spring load slows upright sliding wrecks.

const _sUp = new CANNON.Vec3();
const _sAnchor = new CANNON.Vec3();
const _sR = new CANNON.Vec3();
const _sPv = new CANNON.Vec3();
const _sF = new CANNON.Vec3();
const Y_AXIS = new CANNON.Vec3(0, 1, 0);

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
    let fSum = 0;

    for (const s of a.susp) {
      s.grounded = false;
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
      if (f <= 0) continue; // springs can't pull
      if (f > s.fmax) f = s.fmax;
      _sUp.scale(f, _sF);
      b.applyForce(_sF, _sR); // cannon-es: world-oriented offset from COM
      s.grounded = true;
      grounded++;
      fSum += f;
    }

    // aero downforce while driving (off once crashed, so wrecks can fly)
    if (!a.crashed && state !== GameState.Idle && grounded >= 3) {
      const v = b.velocity;
      const v2 = v.x * v.x + v.z * v.z;
      b.force.y -= Math.min(DOWNFORCE * v2, DOWNFORCE_CAP * Math.abs(GRAVITY)) * b.mass;
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

    // crashed cars riding on springs: tire-scrub friction from the normal load
    if (a.crashed && fSum > 0) {
      const v = b.velocity;
      const vh = Math.hypot(v.x, v.z);
      if (vh > 0.05) {
        const fr = Math.min(WRECK_GRIP * fSum, ((vh * b.mass) / FIXED_DT) * 0.85);
        b.force.x -= (v.x / vh) * fr;
        b.force.z -= (v.z / vh) * fr;
      }
      b.angularVelocity.y *= 1 - Math.min(0.5, 1.8 * FIXED_DT); // spin-down
    }
  }
}
