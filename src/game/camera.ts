import * as THREE from 'three';
import { GameState, type Actor } from './types';
import { simRand } from './rng';

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Cinematic camera: idle orbit → chase cam → crash follow/orbit with shake.
 *
 *  The chase cam is modeled on BP's CameraExternalBehaviour: the boom
 *  follows the car's NOSE yaw on a spring — a stiff one normally, a much
 *  softer one while drifting (DriftYawSpring), so in a slide the car
 *  rotates inside the frame and you watch the drift from mostly-behind,
 *  rather than the camera hard-locking to the velocity direction. */
export class CameraDirector {
  /** Idle-orbit framing — the junction reads best tight, a circuit wide. */
  idleRadius = 34;
  idleHeight = 12.5;
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
  // FOV state (sense-of-speed A1/A2). PRESENTATION, not sim: camera.fov
  // only feeds the projection matrix — never getWorldDirection, so never
  // the aftertouch axes — and worldHash (replay.ts) hashes dynamic bodies
  // only. The determinism pins cannot see any of this.
  private fovKick = 0; // boost-ignite overshoot, degrees above the steady curve
  private fovWasBoosting = false;
  // Chase speed-dolly bookkeeping. The chase cam is PRESENTED at a smooth,
  // speed-driven distance/height, but the SPRING STATE that persists across
  // frames (and into the crash handoff) and the ORIENTATION the sim reads must
  // stay the byte-identical binary-dolly state the determinism pins recorded —
  // aftertouch (Game.ts) steers the wreck along camera.getWorldDirection().
  // So we hold the spring's true (pre-re-seat) position here: each chase frame
  // restores it into camera.position before the lerp, then re-seats the visible
  // camera afterwards. Null when the last frame wasn't a chase frame.
  private chaseAnchor: THREE.Vector3 | null = null;
  private chaseAnchorV = new THREE.Vector3();
  private chaseHeightDelta = 0; // render-only Y shift (smooth − binary height)

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
    this.fovKick = 0;
    this.fovWasBoosting = false;
    this.chaseAnchor = null;
  }

  update(
    dt: number,
    t: number,
    camera: THREE.PerspectiveCamera,
    state: GameState,
    player: Actor | null,
    boosting = false,
    drifting = false,
    aftertouch = false,
    takedownFocus: THREE.Vector3 | null = null,
  ): void {
    let fovTarget = 55;
    let fovRate = 3; // base FOV lerp; boost attacks faster (A2 in/out asymmetry)
    let chaseRate = 3.5; // how hard the camera position clings to `desired`
    // chase-cam speed dolly: the Launch branch sets these, the post-lerp/shake
    // tail consumes them. chaseReseat gates the orientation-neutral re-seat.
    let chaseReseat = false;
    let chaseDist = 0;
    let chaseHeight = 0;
    const pv = player?.body.velocity;
    const wreckSpeed = player?.crashed && pv ? Math.hypot(pv.x, pv.z) : 0;

    // Restore the true (un-re-seated) chase spring before any branch lerps from
    // camera.position. This keeps the spring — and every handoff out of the
    // chase cam — byte-identical to the binary-dolly run the pins recorded; the
    // visible speed-dolly re-seat below never leaks into the persistent state.
    if (this.chaseAnchor) {
      camera.position.copy(this.chaseAnchor);
      this.chaseAnchor = null;
    }

    if (state === GameState.Idle) {
      // default radius 34 keeps the orbit outside every building footprint
      const a = t * 0.12;
      this.desired.set(Math.cos(a) * this.idleRadius, this.idleHeight, Math.sin(a) * this.idleRadius);
      this.look.set(0, 0.8, 0);
      this.camYawLive = false;
    } else if (takedownFocus && state === GameState.Launch && player && !player.crashed) {
      // takedown cam: hang near the victim hitting the wall, the player's
      // car driving off in frame — the autopilot has the wheel meanwhile
      const p = player.body.position;
      let ox = p.x - takedownFocus.x;
      let oz = p.z - takedownFocus.z;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      this.desired.set(takedownFocus.x + ox * 9, takedownFocus.y + 4.5, takedownFocus.z + oz * 9);
      this.look.set(takedownFocus.x, takedownFocus.y + 0.6, takedownFocus.z);
      fovTarget = 52;
      chaseRate = 5;
      this.camYawLive = false; // snap back behind the nose when it ends
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
      // Close and low, like the BP chase cam. The dolly is a SMOOTH function of
      // SPEED, not a binary boost flag: boost on/off is already read off the
      // boost bar + the blue nitrous flame, so the camera mustn't re-signal it
      // by snapping back. Instead it eases out a touch as the car accelerates
      // (a sense of speed/acceleration) and CAPS at the old boost-era distance
      // (9.2 / height 2.8) — that was "the most the car gets away", so it's the
      // ceiling now: never exceeded, never popped on a boost toggle. s ramps
      // 0→1 from CRUISE_SPEED (engine-only top, 32) to BURNOUT_SPEED (48, the
      // true top of the ladder), smoothstepped so there's no kink at the cruise
      // threshold; below cruise the camera sits at the close 7.0.
      //
      // DETERMINISM. Aftertouch (Game.ts) steers the wreck along the camera's
      // flattened heading — getWorldDirection() with y zeroed — and the sim
      // step that reads it runs the frame AFTER director.update, so the camera
      // ORIENTATION (and the spring state next frame's lerp starts from) must
      // stay byte-exact. The boost pins T-bone with ArrowUp held → aftertouch
      // live → the recorded checksums bake in the old BINARY 9.2/7.0 dolly. Two
      // traps: (1) feeding the lerp a different XZ distance lands it on a
      // different azimuth (lerp lag is off the look-ray); (2) a different Y
      // changes lookAt's PITCH, and getWorldDirection's pre-Y-zero X/Z then
      // shift by a ULP. So the lerp + lookAt see the BINARY distance AND height;
      // the smooth distance/height are applied as a render-only re-seat below
      // (after lookAt, no second lookAt), so the sim's orientation is untouched.
      const speed = pv ? Math.hypot(pv.x, pv.z) : 0;
      const sRaw = Math.min(1, Math.max(0, (speed - 32) / (48 - 32)));
      const s = sRaw * sRaw * (3 - 2 * sRaw); // smoothstep — gentle ease, no snap
      chaseDist = 7.0 + (9.2 - 7.0) * s; // 7.0 at cruise → 9.2 cap flat-out
      chaseHeight = 2.35 + (2.8 - 2.35) * s; // 2.35 at cruise → 2.8 cap flat-out
      const lerpDist = boosting ? 9.2 : 7.0; // heading-preserving lerp input (pins)
      const lerpHeight = boosting ? 2.8 : 2.35; // heading-preserving (pitch) (pins)
      this.desired.set(p.x - this.fwd.x * lerpDist, p.y + lerpHeight, p.z - this.fwd.z * lerpDist);
      this.look.set(p.x + this.fwd.x * 8, p.y + 1.2, p.z + this.fwd.z * 8);
      // render-only height delta: shift the sprung Y by (smooth − binary) so the
      // rendered height eases with speed while keeping the binary spring's lag.
      this.chaseHeightDelta = chaseHeight - lerpHeight;
      chaseReseat = true; // do the XZ + Y re-seat after lerp + shake
      // FOV is the Burnout 3 speed lever (sense-of-speed A1/A2): perceived
      // speed scales ~linearly with FOV. Like the dolly, the STEADY FOV is now
      // a continuous function of SPEED (62° at ≤18 m/s rising on a speed² curve
      // to ~74° at the 48 m/s top) rather than a flat boost bucket — so a boost
      // toggle no longer SNAPS the FOV either; it just tracks the car getting
      // faster (boost on/off is read off the bar + flame). We keep the +4°
      // IGNITE KICK (a brief overshoot decaying at dt·4 → ~0.3 s, attacked at
      // dt·8) because that overshoot reads as ACCELERATION, not steady boost
      // state — the Walley "feels 50% faster" cue. FOV is presentation only:
      // it feeds the projection matrix, never getWorldDirection, so the pins
      // never see it.
      const st = Math.min(1, Math.max(0, (speed - 18) / (48 - 18)));
      const fovCurve = 62 + 12 * st * st; // 62 → ~74 across the speed band
      if (boosting && !this.fovWasBoosting) this.fovKick = 4; // ignite edge
      fovTarget = drifting ? Math.max(fovCurve, 65) : fovCurve + this.fovKick;
      if (this.fovKick > 0.25) fovRate = 8; // attack fast only while the kick rides
      chaseRate = 9;
    } else if (player && player.crashed && state !== GameState.Done && wreckSpeed > 3.5 && aftertouch) {
      // only follow the flying wreck while the player is actively steering
      // it with aftertouch — otherwise the camera holds its crash orbit
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

    // seeded, not Math.random: aftertouch forces are camera-relative, so the
    // shaken camera orientation feeds back into the sim and must replay
    this.shakeMag *= Math.exp(-3.2 * dt);
    this.shakeVec
      .set(simRand() - 0.5, simRand() - 0.5, simRand() - 0.5)
      .multiplyScalar(this.shakeMag * 0.6);
    camera.position.add(this.shakeVec);
    this.look.addScaledVector(this.shakeVec, 1.5);
    // Orient from the BINARY-dolly spring position — the orientation the pins
    // recorded, and the state that survives the frame: next frame the sim step
    // runs BEFORE director.update and reads aftertouch's axes off
    // camera.getWorldDirection() (the quaternion lookAt sets here), so that
    // quaternion must stay byte-exact. We lookAt() on the binary position
    // FIRST, then re-seat the POSITION for rendering only (no second lookAt →
    // the quaternion the sim reads is untouched).
    camera.lookAt(this.look);
    // Chase speed-dolly re-seat (render only): stash the un-re-seated spring so
    // next frame restores it, then ease the camera's HEIGHT and HORIZONTAL
    // DISTANCE from `look` to the smooth speed curve. Scaling (camPos − look)
    // uniformly in XZ keeps atan2(dx,dz) intact, and Y/height never touch the
    // already-set quaternion — so the player sees the speed dolly while the
    // sim's orientation and spring stay byte-exact and the pins hold.
    if (chaseReseat) {
      this.chaseAnchor = this.chaseAnchorV.copy(camera.position);
      camera.position.y += this.chaseHeightDelta; // ease render height with speed
      const dx = camera.position.x - this.look.x;
      const dz = camera.position.z - this.look.z;
      const horiz = Math.hypot(dx, dz);
      if (horiz > 1e-4) {
        // `look` sits 8 m AHEAD of the car along +fwd; the camera 7–9.2 m
        // BEHIND it, so the look→cam horizontal span is chaseDist + 8.
        const k = (chaseDist + 8) / horiz;
        camera.position.x = this.look.x + dx * k;
        camera.position.z = this.look.z + dz * k;
      }
    }

    // the ignite kick decays whatever the state — a boost that ends mid-kick
    // must not bank the overshoot for the next burn
    this.fovKick *= Math.exp(-4 * dt);
    this.fovWasBoosting = boosting;
    camera.fov += (fovTarget - camera.fov) * Math.min(1, dt * fovRate);
    camera.updateProjectionMatrix();
  }
}
