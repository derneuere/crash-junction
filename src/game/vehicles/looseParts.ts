import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { Actor } from '../types';
import { simRand } from '../rng';

export interface LoosePart {
  mesh: THREE.Mesh;
  body: CANNON.Body;
}

const _wp = new THREE.Vector3();

/** Detach the wheel nearest the impact and hand it to physics. */
export function popWheel(actor: Actor, worldPoint: THREE.Vector3, scene: THREE.Scene, world: CANNON.World, matCar: CANNON.Material): LoosePart | null {
  if (!actor.wheels.length || !actor.spec) return null;
  actor.popped++;
  let best = 0;
  let bestD = Infinity;
  actor.wheels.forEach((w, i) => {
    w.getWorldPosition(_wp);
    const d = _wp.distanceToSquared(worldPoint);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const wheel = actor.wheels.splice(best, 1)[0];
  actor.susp.splice(best, 1); // that corner loses its spring
  scene.attach(wheel); // keep world transform

  const b = new CANNON.Body({ mass: 14, material: matCar });
  b.addShape(new CANNON.Sphere(actor.spec.wheelRadius - 0.01));
  b.position.set(wheel.position.x, wheel.position.y, wheel.position.z);
  const v = actor.body.velocity;
  b.velocity.set(
    v.x + (simRand() - 0.5) * 6,
    Math.abs(v.y) * 0.4 + 3 + simRand() * 4,
    v.z + (simRand() - 0.5) * 6,
  );
  b.angularVelocity.set((simRand() - 0.5) * 16, (simRand() - 0.5) * 16, (simRand() - 0.5) * 16);
  b.linearDamping = 0.15;
  b.angularDamping = 0.15;
  world.addBody(b);
  return { mesh: wheel, body: b };
}
