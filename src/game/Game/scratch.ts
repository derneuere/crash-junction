import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { type Actor } from '../types';
import { type Command } from '../replay';
import { type ControlInput } from '../control';

export interface DeformJob {
  actor: Actor;
  p: THREE.Vector3;
  strength: number;
  /** World direction the hitting matter travels — folds the crumple zone
   *  along the hit (BP-style); null falls back to core-inward shrink. */
  dir: THREE.Vector3 | null;
}

export const _impact = new THREE.Vector3();
export const _panelPos = new THREE.Vector3();
export const _sagLp = new THREE.Vector3();
export const _lean = new THREE.Euler();
export const _leanQ = new THREE.Quaternion();
export const _skidL = new THREE.Vector3();
export const _skidR = new THREE.Vector3();
export const _fwd = new THREE.Vector3();
export const _right = new THREE.Vector3();
export const _wFwd = new THREE.Vector3();
export const _hood = new THREE.Vector3();
export const _pp = new THREE.Vector3();
export const UP = new THREE.Vector3(0, 1, 0);
export const _atF = new CANNON.Vec3();
export const _kickJ = new CANNON.Vec3(); // shunt impulse vector (J = j·n), reused per contact
export const _kickR = new CANNON.Vec3(); // shunt contact point relative to victim COM
export const _ctrlInput: ControlInput = { steer: 0, throttle: false, boost: false, brake: false }; // reused per fixed step
export const _contactIds = new Set<number>(); // bodies with solver contacts this step
export const NO_CMDS: Command[] = []; // shared empty — never mutated
export const _shadowOrigin = new THREE.Vector3();
export const _shadowRight = new THREE.Vector3();
export const _shadowUp = new THREE.Vector3();
export const _shadowTarget = new THREE.Vector3();
// translational motion-blur scratch: the camera world-position delta and the
// two clip-space points used to project it to a screen-space smear direction.
export const _camDelta = new THREE.Vector3();
export const _mbA = new THREE.Vector3();
export const _mbB = new THREE.Vector3();
