import type * as CANNON from 'cannon-es';
import type { Actor } from '../types';
import type { LoosePart } from '../vehicles';
import type { BodySnap } from './types';

// ---------- world-state checksum ----------

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);

function hashFloat(h: number, v: number): number {
  _f64[0] = v;
  h = Math.imul(h ^ _u32[0], 16777619);
  h = Math.imul(h ^ _u32[1], 16777619);
  return h >>> 0;
}

function hashBody(h: number, b: CANNON.Body): number {
  h = hashFloat(h, b.position.x);
  h = hashFloat(h, b.position.y);
  h = hashFloat(h, b.position.z);
  h = hashFloat(h, b.quaternion.x);
  h = hashFloat(h, b.quaternion.y);
  h = hashFloat(h, b.quaternion.z);
  h = hashFloat(h, b.quaternion.w);
  h = hashFloat(h, b.velocity.x);
  h = hashFloat(h, b.velocity.y);
  h = hashFloat(h, b.velocity.z);
  h = hashFloat(h, b.angularVelocity.x);
  h = hashFloat(h, b.angularVelocity.y);
  h = hashFloat(h, b.angularVelocity.z);
  return h;
}

/** FNV-style hashes over every dynamic body, in stable registration order:
 *  one aggregate plus one per body, so a divergence names its first body. */
export function worldHash(
  actors: readonly Actor[],
  looseParts: readonly LoosePart[],
): { h: number; bodies: number[] } {
  let h = 2166136261;
  const bodies: number[] = [];
  for (const a of actors) {
    h = hashBody(h, a.body);
    bodies.push(hashBody(2166136261, a.body));
  }
  for (const lp of looseParts) {
    h = hashBody(h, lp.body);
    bodies.push(hashBody(2166136261, lp.body));
  }
  return { h, bodies };
}

export function bodySnap(b: CANNON.Body): BodySnap {
  return {
    p: [b.position.x, b.position.y, b.position.z],
    q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
    v: [b.velocity.x, b.velocity.y, b.velocity.z],
    w: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z],
    sleep: b.sleepState,
  };
}
