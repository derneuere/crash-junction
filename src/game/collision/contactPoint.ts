import type * as THREE from 'three';
import type { Actor, CollideEvent } from '../types';

/** World contact point of a collision, written into `out`. */
export function contactPointOf(self: Actor, e: CollideEvent, out: THREE.Vector3): THREE.Vector3 {
  const c = e.contact;
  if (c.bi === self.body) {
    out.set(c.bi.position.x + c.ri.x, c.bi.position.y + c.ri.y, c.bi.position.z + c.ri.z);
  } else {
    out.set(c.bj.position.x + c.rj.x, c.bj.position.y + c.rj.y, c.bj.position.z + c.rj.z);
  }
  return out;
}
