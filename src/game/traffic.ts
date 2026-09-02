import * as CANNON from 'cannon-es';
import { FIXED_DT } from './constants';
import { GameState, type Actor } from './types';
import type { HeightSampler } from './suspension';
import { createForceState, stepVehicleForces, type VehicleForceState } from './control/driving';
import type { ControlInput } from './control/input';
import { HANDLING } from './handling';
import { clamp, wrapAngle } from './control/constants';

const X_AXIS = new CANNON.Vec3(1, 0, 0);
const Z_AXIS = new CANNON.Vec3(0, 0, 1);
const _qTilt = new CANNON.Quaternion();

// ---- force-port: traffic now drives the SAME force solver as the player ----
// Each traffic car carries a lightweight VehicleForceState (createForceState),
// seeded the first frame it is stepped (deterministic: from its spawn dir +
// current speed). A scripted ControlInput (steer/throttle/brake) computed from
// the cruise/brake/yield decision below is fed to stepVehicleForces, replacing
// the old velocity/quaternion writes. At junction crawl speed the steering lock
// fades and the car loses lateral authority to hold its lane, so a gentle
// DAMPED YAW-ASSIST TORQUE (not a quaternion pin) nudges the heading back onto
// the lane axis — honoring the grounded yaw-only lock (it is a pure yaw torque).
const _trafficForce = new WeakMap<Actor, VehicleForceState>();
const _tFwd = new CANNON.Vec3();
const FWD_LOCAL_T = new CANNON.Vec3(0, 0, -1);
const _yawAssist = new CANNON.Vec3();
// Lane-hold PD (N·m, scaled by mass/1450). STARTING values — re-tune: lane
// drift through the box = too low; oscillation = too high.
const LANE_HOLD_KP = 2.5;
const LANE_HOLD_KD = 1.4;

/** Heading the car should hold = its spawn lane direction (dir is unit). */
function laneHeading(dir: { x: number; z: number }): number {
  return Math.atan2(dir.x, dir.z);
}

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

export function updateTraffic(actors: readonly Actor[], state: GameState, simTime: number, heightAt: HeightSampler): void {
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

    // ---- force-port: drive the body via the shared solver instead of writing
    // velocity/quaternion. a.curSpeed is the cruise/brake/yield TARGET pace
    // (unchanged decision logic above); turn it into throttle/brake bangs and a
    // lane-holding steer for stepVehicleForces. ------------------------------
    b.quaternion.vmult(FWD_LOCAL_T, _tFwd); // hull forward, world
    const bodyHeading = Math.atan2(_tFwd.x, _tFwd.z);
    const planar = Math.hypot(b.velocity.x, b.velocity.z);
    const fwdSpeed = b.velocity.x * _tFwd.x + b.velocity.z * _tFwd.z; // signed
    const lane = laneHeading(d);
    const headErr = wrapAngle(lane - bodyHeading); // + = lane is to our left

    let fs = _trafficForce.get(a);
    if (!fs) {
      fs = createForceState(a.spec?.variant ?? 'sedan', lane, a.curSpeed);
      _trafficForce.set(a, fs);
    }
    fs.heading = bodyHeading;
    fs.velAngle = planar > 0.05 ? Math.atan2(b.velocity.x, b.velocity.z) : bodyHeading;
    fs.speed = Math.max(0, fwdSpeed);
    fs.variant = a.spec?.variant ?? 'sedan';

    const tInput: ControlInput = {
      steer: clamp(-headErr * 1.8, -1, 1), // hold the lane axis; sign per +1=right
      throttle: a.curSpeed > fwdSpeed + 0.3,
      boost: false,
      brake: a.curSpeed < fwdSpeed - 0.3 || a.curSpeed <= 0.01,
      noDrift: true, // traffic never drifts on purpose
    };
    stepVehicleForces(fs, a, tInput, heightAt, HANDLING[a.spec?.variant ?? 'sedan']);

    // crawl-speed lateral authority: below the steering lock's effective band
    // the steer command alone can't hold the lane, so add a damped yaw-assist
    // TORQUE toward the lane axis (pure yaw -> honors the grounded lock). Gated
    // off when nearly stopped (a parked car at a red shouldn't creep-rotate).
    const grounded = a.susp.some((sp) => sp.grounded);
    if (grounded && a.curSpeed > 0.5) {
      const mScale = b.mass / 1450;
      const tau = (LANE_HOLD_KP * headErr - LANE_HOLD_KD * b.angularVelocity.y) * mScale;
      _yawAssist.set(0, tau, 0);
      b.applyTorque(_yawAssist);
    }
  }
}
