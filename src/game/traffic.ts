import { FIXED_DT } from './constants';
import { GameState, type Actor } from './types';
import type { HeightSampler } from './suspension';

// Scripted traffic AI. Cars cruise their lane, brake behind anything in it,
// yield at the junction box to crossing traffic and wrecks, and loop back
// to the far edge once they leave the map — so the junction never runs dry
// no matter when the player arrives. Traffic never wrecks itself: only the
// player (or the chaos the player caused) crashes it. The AI is
// deliberately blind to the player — Burnout traffic never dodges you.

const ACCEL = 7;
const BRAKE = 16;
const JUNCTION = 9.5; // half-extent of the yield box around the crossing
const LOOP_AT = 105; // recycle distance from the center (deep in the fog)

export function updateTraffic(actors: Actor[], state: GameState, simTime: number, heightAt: HeightSampler): void {
  for (const a of actors) {
    if (a.kind !== 'vehicle' || a.isPlayer || a.crashed || !a.scripted) continue;
    if (state === GameState.Idle) continue;
    if (simTime < a.scripted.delay) continue;
    if (!a.started) {
      a.started = true;
      a.body.wakeUp();
    }
    const b = a.body;
    const d = a.scripted.dir;
    const along = b.position.x * d.x + b.position.z * d.z;

    // recycle: off one edge, back in from the other (only if the slot is free)
    if (along > LOOP_AT && a.scripted.speed > 0) {
      const sx = b.position.x - 2 * LOOP_AT * d.x;
      const sz = b.position.z - 2 * LOOP_AT * d.z;
      let blocked = false;
      for (const o of actors) {
        if (o === a || o.kind !== 'vehicle') continue;
        const dx = o.body.position.x - sx;
        const dz = o.body.position.z - sz;
        if (dx * dx + dz * dz < 14 * 14) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        b.position.set(sx, a.spec ? a.spec.rideHeight : 0.8, sz);
        b.quaternion.copy(a.q0);
        b.velocity.set(d.x * a.curSpeed, 0, d.z * a.curSpeed);
        b.angularVelocity.set(0, 0, 0);
      }
    }

    // pick a target speed: cruise, unless something says brake
    let target = a.scripted.speed;
    const myHalf = (a.spec?.length ?? 4.6) / 2;

    // keep distance to whoever is ahead in my lane (wrecks included —
    // traffic stops short of a pileup instead of feeding it on its own)
    for (const o of actors) {
      if (o === a || o.kind !== 'vehicle' || o.isPlayer) continue;
      const rx = o.body.position.x - b.position.x;
      const rz = o.body.position.z - b.position.z;
      const ahead = rx * d.x + rz * d.z;
      if (ahead <= 0) continue;
      const lat = Math.abs(rx * d.z - rz * d.x);
      if (lat > 2.2) continue;
      const gap = ahead - myHalf - (o.spec?.length ?? 4.6) / 2;
      if (gap < 2.5) target = 0;
      else if (gap < 7) target = Math.min(target, a.scripted.speed * 0.4);
    }

    // approaching the junction: wait for crossing traffic and for wrecks
    const inBox = Math.abs(b.position.x) < JUNCTION && Math.abs(b.position.z) < JUNCTION;
    if (!inBox && target > 0) {
      const distToBox = -JUNCTION - along; // lanes run through the origin
      if (distToBox > 0 && distToBox < 12) {
        for (const o of actors) {
          if (o === a || o.kind !== 'vehicle' || o.isPlayer) continue;
          const op = o.body.position;
          if (Math.abs(op.x) > JUNCTION + 2 || Math.abs(op.z) > JUNCTION + 2) continue;
          const crossing = o.scripted
            ? Math.abs(o.scripted.dir.x * d.x + o.scripted.dir.z * d.z) < 0.5
            : true;
          if (o.crashed || crossing) {
            target = 0;
            break;
          }
        }
      }
    }

    a.curSpeed += Math.max(-BRAKE * FIXED_DT, Math.min(ACCEL * FIXED_DT, target - a.curSpeed));
    if (a.curSpeed < 0) a.curSpeed = 0;
    b.velocity.set(d.x * a.curSpeed, b.velocity.y, d.z * a.curSpeed);

    // on flat ground, hard-lock the heading; on a ramp or airborne, let the
    // suspension pitch the car naturally and only pin the yaw
    const slope = Math.abs(
      heightAt(b.position.x + d.x * 1.6, b.position.z + d.z * 1.6) -
        heightAt(b.position.x - d.x * 1.6, b.position.z - d.z * 1.6),
    );
    const grounded = a.susp.some((sp) => sp.grounded);
    if (grounded && slope < 0.02) {
      b.angularVelocity.set(0, 0, 0);
      b.quaternion.copy(a.q0);
    } else {
      b.angularVelocity.y = 0;
      b.angularVelocity.x *= 0.99;
      b.angularVelocity.z *= 0.99;
    }
  }
}
