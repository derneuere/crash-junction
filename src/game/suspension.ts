import * as CANNON from 'cannon-es';
import {
  DOWNFORCE,
  DOWNFORCE_CAP,
  FIXED_DT,
  GRAVITY,
  SUSP_DROOP,
  SUSP_MAX_COMP,
  WRECK_GRIP,
} from './constants';
import { GameState, type Actor } from './types';

// Four virtual wheel rays per car, solved analytically against the level's
// height field (flat road + ramps). Each applies
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

export type HeightSampler = (x: number, z: number) => number;

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
      let f = s.preload + s.k * comp - s.c * _sPv.dot(_sUp);
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
