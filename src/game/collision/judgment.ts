import type { Actor } from '../types';
import { TBONE_MIN_CLOSING, TBONE_MAX_ALIGN } from '../constants';
import type { ImpactJudgment } from './types';

/** The Burnout crash rules (burnout wiki: Takedown / Traffic Check / Wreck):
 *  ramming a same-direction lighter vehicle is a SHUNT — they wreck, you
 *  power through and the boost bar refills. Walls, oncoming traffic and
 *  heavies wreck YOU. Pure judgment: reads bodies and the shunt-grace map,
 *  mutates nothing — the caller applies the consequences. */
export function judgePlayerImpact(
  self: Actor,
  other: Actor | undefined,
  isWall: boolean,
  impact: number,
  simTime: number,
  shuntGrace: ReadonlyMap<number, number>, // bodyId → simTime of the shunt
): ImpactJudgment {
  let crashes = isWall && impact > 5;
  let takedown = false;
  if (other?.kind === 'vehicle') {
    const v = self.body.velocity;
    const sp = Math.hypot(v.x, v.z);
    const ov = other.body.velocity;
    const osp = Math.hypot(ov.x, ov.z);
    // their direction of travel — facing, if they're sitting still
    const odx = osp > 3 ? ov.x / osp : (other.scripted?.dir.x ?? 0);
    const odz = osp > 3 ? ov.z / osp : (other.scripted?.dir.z ?? 0);
    const align = sp > 2 ? ((v.x / sp) * odx + (v.z / sp) * odz) : 1;
    const heavy = (other.spec?.mass ?? 0) > (self.spec?.mass ?? 1) * 1.6;
    // a car we just shunted is still tumbling clear — Revenge launches the
    // checked car harmlessly, so it can't wreck us for a beat
    const graced = simTime - (shuntGrace.get(other.body.id) ?? -9) < 1.2;
    if ((align > 0.35 && !heavy) || graced) {
      takedown = impact > 4 && !other.crashed; // shunt: no crash for the player
    } else if (align < -0.35 && osp > 3) {
      crashes = impact > 5; // head-on with oncoming
    } else if (heavy) {
      crashes = impact > 5; // the bus always wins
    } else {
      crashes = impact > 6.5; // T-boned by crossing traffic
    }
  }
  return { playerCrashes: crashes, takedown };
}

/** Who is driving into whom. Longitudinal hits (rear-ends): the harder
 *  pusher along the line between the cars wins — that's the shunt. But for
 *  DOOR-TO-DOOR contact (the line between the cars sits mostly abeam of the
 *  pair's travel) the push comparison judges by whose racing line happened
 *  to converge harder — which hands the AI a SLAMMED against a faster
 *  player it merely drifted into. Burnout resolves side contests by
 *  authority: the faster car wins. */
export function judgeAggressor(self: Actor, other: Actor): 'self' | 'other' {
  const dx = other.body.position.x - self.body.position.x;
  const dz = other.body.position.z - self.body.position.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d;
  const nz = dz / d;
  const sv = self.body.velocity;
  const ov = other.body.velocity;
  const selfPush = sv.x * nx + sv.z * nz; // how hard self drives into other
  const otherPush = -(ov.x * nx + ov.z * nz); // and vice versa
  const sSpeed = Math.hypot(sv.x, sv.z);
  const oSpeed = Math.hypot(ov.x, ov.z);
  // |n · combined travel direction|: ~1 = one car behind the other, ~0 = abeam
  const tx = sv.x + ov.x;
  const tz = sv.z + ov.z;
  const tl = Math.hypot(tx, tz) || 1;
  const alongTravel = Math.abs(nx * (tx / tl) + nz * (tz / tl));
  if (alongTravel < 0.55 && Math.abs(sSpeed - oSpeed) > 2) {
    return sSpeed > oSpeed ? 'self' : 'other';
  }
  return selfPush >= otherPush ? 'self' : 'other';
}

/** T-BONE: is `self` ramming `other` in the FLANK, fast enough to wreck them
 *  outright? The spec's two gates, read straight off the bodies:
 *    (a) FAST — self's velocity projected onto the self→other line (how hard
 *        it's driving into the victim) clears TBONE_MIN_CLOSING. Below it the
 *        contact is a shunt/nudge, not a kill.
 *    (b) FLANK — the angle between self's heading and the victim's travel axis
 *        is in the T-bone window (~45°…135°): |cos| < TBONE_MAX_ALIGN. A
 *        near-parallel door-to-door (|cos| ≈ 1) and a head-on (cos ≈ -1) are
 *        both outside it, so they stay shunts.
 *  Pure read: velocities + positions in, a boolean out. No mutation, no RNG. */
export function isTboneTakedown(self: Actor, other: Actor): boolean {
  const sv = self.body.velocity;
  const sSpeed = Math.hypot(sv.x, sv.z);
  if (sSpeed < 1e-3) return false;
  // self→other unit line (the contact direction the ram drives along)
  const dx = other.body.position.x - self.body.position.x;
  const dz = other.body.position.z - self.body.position.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d;
  const nz = dz / d;
  // (a) closing: self's velocity component INTO the victim. Must be driving
  // toward them (positive) and hard enough to be a kill, not a tap.
  const closing = sv.x * nx + sv.z * nz;
  if (closing < TBONE_MIN_CLOSING) return false;
  // (b) flank angle: rammer heading vs victim travel axis (facing if stopped).
  const ov = other.body.velocity;
  const oSpeed = Math.hypot(ov.x, ov.z);
  const ox = oSpeed > 2 ? ov.x / oSpeed : (other.scripted?.dir.x ?? nx);
  const oz = oSpeed > 2 ? ov.z / oSpeed : (other.scripted?.dir.z ?? nz);
  const hx = sv.x / sSpeed;
  const hz = sv.z / sSpeed;
  const align = Math.abs(hx * ox + hz * oz);
  return align < TBONE_MAX_ALIGN;
}

/** How hard and how square a vehicle is closing on a wall. Uses the wall's
 *  own side normal when known; falls back to the engine impact otherwise. */
export function wallApproach(
  self: Actor,
  wallDir: { x: number; z: number } | null,
  impact: number,
): { closing: number; steep: number } {
  const v = self.body.velocity;
  const sp = Math.hypot(v.x, v.z);
  let closing = impact;
  if (wallDir) closing = Math.abs(v.x * -wallDir.z + v.z * wallDir.x);
  return { closing, steep: sp > 0.5 ? closing / sp : 1 };
}
