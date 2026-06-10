import * as THREE from 'three';
import { GameState, type Actor } from './types';

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Cinematic camera: idle orbit → chase cam → crash follow/orbit with shake.
 *
 *  The chase cam is modeled on BP's CameraExternalBehaviour: the boom
 *  follows the car's NOSE yaw on a spring — a stiff one normally, a much
 *  softer one while drifting (DriftYawSpring), so in a slide the car
 *  rotates inside the frame and you watch the drift from mostly-behind,
 *  rather than the camera hard-locking to the velocity direction. */
export class CameraDirector {
  readonly focusTarget = new THREE.Vector3(0, 1, 0);
  private focus = new THREE.Vector3(0, 1, 0);
  private orbitA = 0;
  private shakeMag = 0;
  private desired = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shakeVec = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private camYaw = 0;
  private camYawLive = false; // false → snap to the nose next chase frame

  addShake(amount: number): void {
    this.shakeMag = Math.min(1.8, this.shakeMag + amount);
  }

  beginOrbit(camera: THREE.PerspectiveCamera): void {
    this.orbitA = Math.atan2(camera.position.z - this.focusTarget.z, camera.position.x - this.focusTarget.x);
  }

  reset(): void {
    this.focus.set(0, 1, 0);
    this.focusTarget.set(0, 1, 0);
    this.orbitA = 0;
    this.shakeMag = 0;
    this.camYawLive = false;
  }

  update(
    dt: number,
    t: number,
    camera: THREE.PerspectiveCamera,
    state: GameState,
    player: Actor | null,
    boosting = false,
    drifting = false,
  ): void {
    let fovTarget = 55;
    let chaseRate = 3.5; // how hard the camera position clings to `desired`
    const pv = player?.body.velocity;
    const wreckSpeed = player?.crashed && pv ? Math.hypot(pv.x, pv.z) : 0;

    if (state === GameState.Idle) {
      // radius 34 keeps the orbit outside every building footprint
      const a = t * 0.12;
      this.desired.set(Math.cos(a) * 34, 12.5, Math.sin(a) * 34);
      this.look.set(0, 0.8, 0);
      this.camYawLive = false;
    } else if (state === GameState.Launch && player && !player.crashed) {
      const p = player.body.position;
      const bq = player.body.quaternion;
      this.q.set(bq.x, bq.y, bq.z, bq.w);
      this.fwd.set(0, 0, -1).applyQuaternion(this.q); // hull forward is -z
      const noseYaw = Math.atan2(this.fwd.x, this.fwd.z);
      if (!this.camYawLive) {
        this.camYaw = noseYaw;
        this.camYawLive = true;
      }
      // nose-yaw spring: soft while drifting so the slide reads at an angle
      const spring = drifting ? 3.2 : 7.5;
      this.camYaw = wrapAngle(this.camYaw + wrapAngle(noseYaw - this.camYaw) * (1 - Math.exp(-spring * dt)));
      this.fwd.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      // close and low, like the BP chase cam — the camera only drops back
      // (and rises a touch) under boost, to sell the speed
      const dist = boosting ? 9.2 : 7.0;
      const height = boosting ? 2.8 : 2.35;
      this.desired.set(p.x - this.fwd.x * dist, p.y + height, p.z - this.fwd.z * dist);
      this.look.set(p.x + this.fwd.x * 8, p.y + 1.2, p.z + this.fwd.z * 8);
      fovTarget = boosting ? 71 : drifting ? 65 : 62;
      chaseRate = 9;
    } else if (player && player.crashed && state !== GameState.Done && wreckSpeed > 3.5) {
      // the wreck is still flying: stay behind it so aftertouch has eyes
      const p = player.body.position;
      this.fwd.set(pv!.x / wreckSpeed, 0, pv!.z / wreckSpeed);
      this.desired.set(p.x - this.fwd.x * 11, p.y + 4.6, p.z - this.fwd.z * 11);
      this.look.set(p.x, p.y + 0.8, p.z);
      this.focus.set(p.x, p.y, p.z);
      this.focusTarget.copy(this.focus);
      // keep the orbit angle synced for a seamless handoff once it stops
      this.orbitA = Math.atan2(camera.position.z - p.z, camera.position.x - p.x);
      fovTarget = 58;
      chaseRate = 5;
      this.camYawLive = false;
    } else {
      this.orbitA += dt * (state === GameState.Done ? 0.1 : 0.22);
      this.focus.lerp(this.focusTarget, 1 - Math.exp(-2.2 * dt));
      const rr = 13.5;
      this.desired.set(
        this.focus.x + Math.cos(this.orbitA) * rr,
        5.6 + Math.sin(t * 0.7) * 0.5,
        this.focus.z + Math.sin(this.orbitA) * rr,
      );
      this.look.copy(this.focus);
      fovTarget = state === GameState.Crash ? 60 : 55;
      this.camYawLive = false;
    }
    // the chase cam clings tightly while driving; crash orbits stay floaty
    camera.position.lerp(this.desired, 1 - Math.exp(-chaseRate * dt));

    this.shakeMag *= Math.exp(-3.2 * dt);
    this.shakeVec
      .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .multiplyScalar(this.shakeMag * 0.6);
    camera.position.add(this.shakeVec);
    this.look.addScaledVector(this.shakeVec, 1.5);
    camera.lookAt(this.look);

    camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * 3);
    camera.updateProjectionMatrix();
  }
}
