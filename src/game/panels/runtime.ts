import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CRUSH_SCALE } from '../constants';
import type { Actor, PanelState } from '../types';
import { simRand } from '../rng';

const _pw = new THREE.Vector3();

/** Feed an impact into nearby panels. Calls onDetach the moment one tears. */
export function accumulatePanelDamage(
  actor: Actor,
  worldPoint: THREE.Vector3,
  strength: number,
  onDetach: (actor: Actor, panel: PanelState) => void,
): void {
  if (!actor.panels.length) return;
  actor.group.updateMatrixWorld(true);
  const R = 0.9 + strength * 0.16; // same falloff family as deformActor
  for (const p of actor.panels) {
    if (p.detached) continue;
    p.mesh.getWorldPosition(_pw);
    const d = _pw.distanceTo(worldPoint);
    if (d > R) continue;
    const f = 1 - d / R;
    p.damage += strength * CRUSH_SCALE * f * f;
    if (p.damage > p.threshold) {
      p.detached = true;
      onDetach(actor, p);
    }
  }
}

/** Loose panels swing toward their hinge limit as damage accrues. */
export function updatePanelFlap(actors: Actor[], dt: number): void {
  for (const a of actors) {
    for (const p of a.panels) {
      if (p.detached) continue;
      const t = Math.max(0, Math.min(1, (p.damage - 0.4 * p.threshold) / (0.6 * p.threshold)));
      const target = p.maxAngle * t;
      if (target <= 0 && p.angle <= 0) continue;
      p.angle += (target - p.angle) * Math.min(1, dt * 7);
      p.pivot.quaternion.setFromAxisAngle(p.hingeAxis, p.angle * p.flapDir);
    }
  }
}

const _out = new THREE.Vector3();
const _wq = new THREE.Quaternion();

/** Turn a torn-off panel into a free rigid body. Returns the new body. */
export function makePanelBody(actor: Actor, p: PanelState, matCar: CANNON.Material): CANNON.Body {
  const mass = p.kind === 'door' ? 16 : p.kind === 'bumper' ? 8 : 12;
  const body = new CANNON.Body({ mass, material: matCar });
  body.addShape(
    new CANNON.Box(
      new CANNON.Vec3(Math.max(p.size.x, 0.08) / 2, Math.max(p.size.y, 0.08) / 2, Math.max(p.size.z, 0.08) / 2),
    ),
  );
  p.mesh.getWorldPosition(_pw);
  p.mesh.getWorldQuaternion(_wq);
  body.position.set(_pw.x, _pw.y, _pw.z);
  body.quaternion.set(_wq.x, _wq.y, _wq.z, _wq.w);
  _out.copy(p.outward).applyQuaternion(actor.group.quaternion);
  const v = actor.body.velocity;
  body.velocity.set(
    v.x + _out.x * (3 + simRand() * 3) + (simRand() - 0.5) * 2,
    Math.abs(v.y) * 0.3 + 2.5 + simRand() * 3 + _out.y * 3,
    v.z + _out.z * (3 + simRand() * 3) + (simRand() - 0.5) * 2,
  );
  body.angularVelocity.set((simRand() - 0.5) * 14, (simRand() - 0.5) * 14, (simRand() - 0.5) * 14);
  body.linearDamping = 0.12;
  body.angularDamping = 0.12;
  body.allowSleep = true;
  body.sleepSpeedLimit = 0.4;
  body.sleepTimeLimit = 0.6;
  return body;
}
