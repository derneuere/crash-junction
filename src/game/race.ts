import * as CANNON from 'cannon-es';
import type { Actor, RaceDef } from './types';
import { GameState } from './types';
import type { GameEvents } from './events';
import type { Emitter } from './emitter';
import type { PlayerControl } from './control';
import { GROUP_DECOR } from './physics';

// Race navigation modeled on BP's AISections resource (AIMapData 0x10001):
// the track is an ordered loop of quad sections — each with a centre, a
// direction and a speed class — and the link from one section to the next
// is the portal. Rivals steer toward a look-ahead section (BP drives its
// AI with a PID on a look-ahead point) and brake for the slowest section
// coming up. Respawns follow the SectionResetPair semantics: crash in
// section X → placed back into its mapped section at SLOW speed, facing
// down the track.

export interface RaceSection {
  x: number;
  z: number;
  dirX: number; // unit direction toward the next section (the portal)
  dirZ: number;
  v: number; // section speed class, m/s (VERY_SLOW … VERY_FAST)
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Resample a closed waypoint polygon into evenly spaced sections with
 *  curvature-derived speed classes (slow apex, fast straight), brake
 *  distance propagated backwards so the AI slows BEFORE the corner. */
export function buildLoopSections(waypoints: [number, number][], spacing: number): RaceSection[] {
  // Catmull-Rom through the closed loop, finely sampled
  const n = waypoints.length;
  const fine: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = waypoints[(i - 1 + n) % n];
    const p1 = waypoints[i];
    const p2 = waypoints[(i + 1) % n];
    const p3 = waypoints[(i + 2) % n];
    for (let s = 0; s < 20; s++) {
      const t = s / 20;
      const t2 = t * t;
      const t3 = t2 * t;
      fine.push([
        0.5 * (2 * p1[0] + (p2[0] - p0[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (3 * p1[0] - p0[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (p2[1] - p0[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (3 * p1[1] - p0[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  // walk the arc length, dropping a section every `spacing` metres
  const pts: [number, number][] = [];
  let acc = 0;
  let prev = fine[0];
  pts.push(prev);
  for (let i = 1; i <= fine.length; i++) {
    const cur = fine[i % fine.length];
    acc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
    if (acc >= spacing) {
      pts.push(cur);
      acc = 0;
    }
  }
  if (pts.length > 2 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < spacing * 0.6) {
    pts.pop(); // don't double up the seam
  }
  const N = pts.length;
  const secs: RaceSection[] = pts.map((p, i) => {
    const q = pts[(i + 1) % N];
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return { x: p[0], z: p[1], dirX: dx / l, dirZ: dz / l, v: 0 };
  });
  // curvature → corner speed (v = sqrt(a_lat · R)), then brake backwards.
  // the lateral-accel budget is generous: corners are meant to be taken
  // flat-out (with a drift), never on the brakes
  for (let i = 0; i < N; i++) {
    const h0 = Math.atan2(secs[i].dirX, secs[i].dirZ);
    const h1 = Math.atan2(secs[(i + 1) % N].dirX, secs[(i + 1) % N].dirZ);
    const R = spacing / Math.max(1e-4, Math.abs(wrapAngle(h1 - h0)));
    secs[i].v = clamp(Math.sqrt(16 * R), 18, 38);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      secs[i].v = Math.min(secs[i].v, secs[(i + 1) % N].v + 4); // brake zone
    }
  }
  return secs;
}

const AI_YAW = 1.35; // rad/s steering authority (a touch under the player's drift)
const AI_ACC = 13;
const AI_BRAKE = 20;
const RESPAWN_AFTER = 2.5; // s wrecked before the reset pair kicks in
const RESET_SPEED = 10; // "SLOW" EResetSpeedType

interface RacerState {
  a: Actor;
  heading: number;
  speed: number;
  target: number; // section index we're driving toward
  lap: number;
  respawnT: number;
  skill: number; // corner-speed multiplier <1 — what makes them beatable
  progress: number;
  loose: boolean; // was destabilized last step — resync AI on recovery
}

export class RaceDirector {
  readonly laps: number;
  private secs: RaceSection[];
  private N: number;
  private width: number;
  private racers: RacerState[] = [];
  private playerTarget = 1;
  private playerLap = 1;
  private playerPos = 1;
  private finished = false;
  private lastEmit = '';

  constructor(
    race: RaceDef,
    private player: Actor,
    rivals: { actor: Actor; skill: number }[],
    private events: Emitter<GameEvents>,
    private onFinish: (position: number) => void,
  ) {
    this.laps = race.laps;
    this.secs = race.sections;
    this.N = this.secs.length;
    this.width = race.width;
    // grid: stagger the rivals AHEAD of the start line (section 0) — the
    // player starts last and fights their way to the top
    const s0 = this.secs[0];
    const px = -s0.dirZ; // perpendicular
    const pz = s0.dirX;
    rivals.forEach(({ actor, skill }, i) => {
      const back = 7 + i * 7;
      const side = (i % 2 === 0 ? 1 : -1) * 2.6;
      const heading = Math.atan2(s0.dirX, s0.dirZ);
      actor.body.position.set(s0.x + s0.dirX * back + px * side, actor.spec?.rideHeight ?? 0.8, s0.z + s0.dirZ * back + pz * side);
      actor.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading + Math.PI);
      actor.q0.copy(actor.body.quaternion);
      actor.body.wakeUp();
      actor.started = true;
      this.racers.push({ a: actor, heading, speed: 0, target: 1, lap: 1, respawnT: 0, skill, progress: 0, loose: false });
    });
  }

  /** One fixed physics step of race logic. */
  step(dt: number, state: GameState): void {
    if (state === GameState.Idle || this.finished) return;
    const racing = state === GameState.Launch || state === GameState.Crash || state === GameState.Settle;
    if (!racing) return;

    for (const r of this.racers) this.stepRival(r, dt);
    this.trackPlayer();
    this.rank();

    const key = `${this.playerLap}|${this.playerPos}`;
    if (key !== this.lastEmit) {
      this.lastEmit = key;
      this.events.emit('race', {
        lap: Math.min(this.playerLap, this.laps),
        laps: this.laps,
        pos: this.playerPos,
        racers: this.racers.length + 1,
      });
    }
  }

  private stepRival(r: RacerState, dt: number): void {
    const b = r.a.body;
    if (r.a.crashed) {
      // SectionResetPair: after a beat, reset into the section behind the
      // target, facing down the track, at SLOW speed
      r.respawnT += dt;
      if (r.respawnT > RESPAWN_AFTER) {
        r.respawnT = 0;
        const idx = (r.target - 1 + this.N) % this.N;
        this.placeAt(r.a, idx);
        r.heading = Math.atan2(this.secs[idx].dirX, this.secs[idx].dirZ);
        r.speed = RESET_SPEED;
        r.a.crashed = false;
        r.a.destabilized = 0;
        r.a.destabilizedByPlayer = false;
        r.loose = false;
        r.a.body.collisionFilterMask = ~GROUP_DECOR;
      }
      return;
    }
    if (r.a.destabilized > 0) {
      // shunt mode: nobody's steering — physics carries the slide (into the
      // wall, if the shove was good)
      r.loose = true;
      return;
    }
    if (r.loose) {
      // gathered it up — resume the racing line from wherever we slid to
      r.loose = false;
      const sp = Math.hypot(b.velocity.x, b.velocity.z);
      if (sp > 2) r.heading = Math.atan2(b.velocity.x / sp, b.velocity.z / sp);
      r.speed = sp;
    }

    const t = this.secs[r.target];
    const dx = t.x - b.position.x;
    const dz = t.z - b.position.z;
    if (Math.hypot(dx, dz) < this.width * 0.8) {
      r.target = (r.target + 1) % this.N;
      if (r.target === 1) r.lap++;
    }

    // steer at a look-ahead section, BP AI-PID style (P only — arcade)
    const look = this.secs[(r.target + 1) % this.N];
    const aim = Math.atan2((look.x + t.x) / 2 - b.position.x, (look.z + t.z) / 2 - b.position.z);
    const err = wrapAngle(aim - r.heading);
    r.heading = wrapAngle(r.heading + clamp(err * 3, -AI_YAW, AI_YAW) * dt);

    // speed: brake for the slowest of the next few sections; hold a gap to
    // the car ahead so the pack doesn't rear-end itself
    let target = Math.min(t.v, this.secs[(r.target + 1) % this.N].v + 2, this.secs[(r.target + 2) % this.N].v + 6) * r.skill;
    const holdGap = (ox: number, oz: number, oSpeed: number) => {
      const rx = ox - b.position.x;
      const rz = oz - b.position.z;
      const ahead = rx * Math.sin(r.heading) + rz * Math.cos(r.heading);
      const lat = Math.abs(rx * Math.cos(r.heading) - rz * Math.sin(r.heading));
      if (ahead > 0 && ahead < 9 && lat < 2.4) target = Math.min(target, oSpeed * 0.95);
    };
    for (const o of this.racers) {
      if (o !== r && !o.a.crashed) holdGap(o.a.body.position.x, o.a.body.position.z, o.speed);
    }
    if (!this.player.crashed) {
      const pv = this.player.body.velocity;
      holdGap(this.player.body.position.x, this.player.body.position.z, Math.hypot(pv.x, pv.z));
    }
    r.speed += clamp(target - r.speed, -AI_BRAKE * dt, AI_ACC * dt);

    b.velocity.set(Math.sin(r.heading) * r.speed, b.velocity.y, Math.cos(r.heading) * r.speed);
    b.angularVelocity.set(0, 0, 0);
    b.quaternion.setFromAxisAngle(UP, r.heading + Math.PI); // hull forward is -z
  }

  private trackPlayer(): void {
    if (this.finished || this.player.crashed) return;
    const b = this.player.body;
    // a drift can sweep wide of a section centre — count crossing the
    // section's portal plane (within track width) too, and scan a couple
    // of sections ahead so a wide arc can't lose race progress
    for (let k = 2; k >= 0; k--) {
      const idx = (this.playerTarget + k) % this.N;
      const s = this.secs[idx];
      const dx = b.position.x - s.x;
      const dz = b.position.z - s.z;
      const along = dx * s.dirX + dz * s.dirZ;
      const lat = Math.abs(dx * s.dirZ - dz * s.dirX);
      if (Math.hypot(dx, dz) < this.width * 0.9 || (along > 0 && along < 14 && lat < this.width)) {
        for (let j = 0; j <= k; j++) {
          this.playerTarget = (this.playerTarget + 1) % this.N;
          if (this.playerTarget === 1) {
            this.playerLap++;
            if (this.playerLap > this.laps) {
              this.finished = true;
              this.onFinish(this.playerPos);
              return;
            }
          }
        }
        break;
      }
    }
  }

  private progressOf(lap: number, target: number, x: number, z: number): number {
    const t = this.secs[target];
    const d = Math.hypot(t.x - x, t.z - z);
    return lap * this.N + ((target - 1 + this.N) % this.N) - Math.min(1, d / 40);
  }

  private rank(): void {
    const pb = this.player.body.position;
    const mine = this.progressOf(this.playerLap, this.playerTarget, pb.x, pb.z);
    let ahead = 0;
    for (const r of this.racers) {
      if (this.progressOf(r.lap, r.target, r.a.body.position.x, r.a.body.position.z) > mine) ahead++;
    }
    this.playerPos = ahead + 1;
  }

  /** Heading toward the middle of the road ahead — the takedown-cam
   *  autopilot steers the player along this while the camera is away. */
  playerAimHeading(): number {
    const t = this.secs[this.playerTarget];
    const look = this.secs[(this.playerTarget + 1) % this.N];
    const b = this.player.body;
    return Math.atan2((look.x + t.x) / 2 - b.position.x, (look.z + t.z) / 2 - b.position.z);
  }

  /** Reset-pair for the player: back into the section before their target. */
  respawnPlayer(control: PlayerControl): void {
    const idx = (this.playerTarget - 1 + this.N) % this.N;
    this.placeAt(this.player, idx);
    const heading = Math.atan2(this.secs[idx].dirX, this.secs[idx].dirZ);
    control.reset(heading);
    control.speed = RESET_SPEED;
    const s = this.secs[idx];
    this.player.body.velocity.set(s.dirX * RESET_SPEED, 0, s.dirZ * RESET_SPEED);
    this.player.crashed = false;
    this.player.destabilized = 0;
    this.player.destabilizedByPlayer = false;
    this.player.body.collisionFilterMask = ~GROUP_DECOR;
  }

  private placeAt(a: Actor, idx: number): void {
    const s = this.secs[idx];
    const b = a.body;
    b.position.set(s.x, (a.spec?.rideHeight ?? 0.8) + 0.05, s.z);
    b.quaternion.setFromAxisAngle(UP, Math.atan2(s.dirX, s.dirZ) + Math.PI);
    b.velocity.set(s.dirX * RESET_SPEED, 0, s.dirZ * RESET_SPEED);
    b.angularVelocity.set(0, 0, 0);
    b.wakeUp();
  }
}

const UP = new CANNON.Vec3(0, 1, 0);
