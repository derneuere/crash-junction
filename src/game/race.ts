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

/** Catmull-Rom through the waypoints, finely sampled. Closed wraps the
 *  control points around the seam; open clamps them at the ends (the
 *  standard clamped spline) and lands exactly on the last waypoint. */
function catmullFine(waypoints: [number, number][], closed: boolean): [number, number][] {
  const n = waypoints.length;
  const at = (i: number) => waypoints[closed ? ((i % n) + n) % n : clamp(i, 0, n - 1)];
  const fine: [number, number][] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
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
  if (!closed) fine.push([waypoints[n - 1][0], waypoints[n - 1][1]]);
  return fine;
}

/** Walk the fine polyline's arc length, dropping a point every `spacing`
 *  metres. Closed wraps back to the seam (and drops a too-close duplicate);
 *  open must END at the final waypoint — that's where the exit gate lives. */
function resampleEvery(fine: [number, number][], spacing: number, closed: boolean): [number, number][] {
  const pts: [number, number][] = [];
  let acc = 0;
  let prev = fine[0];
  pts.push(prev);
  const last = closed ? fine.length : fine.length - 1;
  for (let i = 1; i <= last; i++) {
    const cur = fine[closed ? i % fine.length : i];
    acc += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
    if (acc >= spacing) {
      pts.push(cur);
      acc = 0;
    }
  }
  if (closed) {
    if (pts.length > 2 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < spacing * 0.6) {
      pts.pop(); // don't double up the seam
    }
  } else {
    const end = fine[fine.length - 1];
    const tail = pts[pts.length - 1];
    const d = Math.hypot(end[0] - tail[0], end[1] - tail[1]);
    if (d < spacing * 0.5 && pts.length > 1) pts[pts.length - 1] = end; // snap, don't stutter
    else if (d > 1e-6) pts.push(end);
  }
  return pts;
}

/** Shared tail of both resamplers: evenly spaced points → sections with
 *  curvature speed classes and backward brake propagation. `closed` only
 *  controls whether index math wraps (a loop) or clamps (an open branch) —
 *  the clamped next() makes the open brake pass a self-min no-op at the
 *  last section, so the same passes serve both shapes. */
function finishSections(pts: [number, number][], spacing: number, closed: boolean): RaceSection[] {
  const N = pts.length;
  const next = (i: number) => (closed ? (i + 1) % N : Math.min(i + 1, N - 1));
  const secs: RaceSection[] = pts.map((p, i) => {
    const q = pts[next(i)];
    const dx = q[0] - p[0];
    const dz = q[1] - p[1];
    const l = Math.hypot(dx, dz) || 1;
    return { x: p[0], z: p[1], dirX: dx / l, dirZ: dz / l, v: 0 };
  });
  if (!closed && N >= 2) {
    // the final section has no portal of its own — keep the previous
    // direction so the chain's last gate still faces down the branch
    secs[N - 1].dirX = secs[N - 2].dirX;
    secs[N - 1].dirZ = secs[N - 2].dirZ;
  }
  // curvature → corner speed (v = sqrt(a_lat · R)), then brake backwards.
  // the lateral-accel budget is generous: corners are meant to be taken
  // flat-out (with a drift), never on the brakes
  for (let i = 0; i < N; i++) {
    const h0 = Math.atan2(secs[i].dirX, secs[i].dirZ);
    const h1 = Math.atan2(secs[next(i)].dirX, secs[next(i)].dirZ);
    const R = spacing / Math.max(1e-4, Math.abs(wrapAngle(h1 - h0)));
    secs[i].v = clamp(Math.sqrt(16 * R), 18, 38);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      secs[i].v = Math.min(secs[i].v, secs[next(i)].v + 4); // brake zone
    }
  }
  return secs;
}

/** Resample a closed waypoint polygon into evenly spaced sections with
 *  curvature-derived speed classes (slow apex, fast straight), brake
 *  distance propagated backwards so the AI slows BEFORE the corner. */
export function buildLoopSections(waypoints: [number, number][], spacing: number): RaceSection[] {
  return finishSections(resampleEvery(catmullFine(waypoints, true), spacing, true), spacing, true);
}

/** The same resampler for an OPEN polyline (shortcut branch ribbons):
 *  clamped spline endpoints, no wrap — the final section keeps the previous
 *  section's direction so its gate still faces down the branch. */
export function buildOpenSections(waypoints: [number, number][], spacing: number): RaceSection[] {
  return finishSections(resampleEvery(catmullFine(waypoints, false), spacing, false), spacing, false);
}

/** Section spacing for shortcut chains — the GDD's main-loop request, so a
 *  branch corridor samples about as densely as the road it forks from.
 *  environment.ts builds the visual ribbons from the same chains. */
export const SHORTCUT_SPACING = 8;

const AI_YAW = 1.35; // rad/s steering authority (a touch under the player's drift)
const AI_ACC = 13;
const AI_BRAKE = 20;
const RESPAWN_AFTER = 2.5; // s wrecked before the reset pair kicks in
const RESET_SPEED = 10; // "SLOW" EResetSpeedType
const SHORTCUT_SLACK = 4; // corridor slack (m) — same half-spacing slack as the main road

/** A shortcut's resampled section chain plus where it hands progress back.
 *  Player-only: rivals NEVER take shortcuts — BP-style, the AI owns the
 *  main racing line; branches are the player's knowledge reward (and risk),
 *  so AI paths and the pack's pace are untouched by them. */
interface ShortcutChain {
  exit: number; // main-loop section index where the branch rejoins
  halfW: number;
  secs: RaceSection[];
}

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
  private shortcuts: ShortcutChain[] = [];
  private onShortcut = -1; // index into shortcuts while the player runs a branch

  constructor(
    race: RaceDef,
    private player: Actor,
    rivals: { actor: Actor; skill: number }[],
    private events: Emitter<GameEvents>,
    private onFinish: (position: number) => void,
    private repair: (a: Actor) => void,
  ) {
    this.laps = race.laps;
    this.secs = race.sections;
    this.N = this.secs.length;
    this.width = race.width;
    // shortcut chains: same Catmull resample as the loop, open-ended —
    // built here (plain numbers in, deterministic out) so player tracking
    // and the off-track rescue can measure against them every step
    for (const sc of race.shortcuts ?? []) {
      this.shortcuts.push({ exit: sc.exit, halfW: sc.width / 2, secs: buildOpenSections(sc.waypoints, SHORTCUT_SPACING) });
    }
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
      // initial target: the first portal plane still ahead of this slot. A
      // deep grid (gantry runs five slots, 35 m) outreaches section 1's
      // gate radius — a racer whose only gate is BEHIND it U-turns off the
      // grid at full throttle and finds the barrier.
      const bx = actor.body.position.x;
      const bz = actor.body.position.z;
      let target = 1;
      while (target + 1 < this.N && (bx - this.secs[target].x) * this.secs[target].dirX + (bz - this.secs[target].z) * this.secs[target].dirZ > 0) {
        target++;
      }
      this.racers.push({ a: actor, heading, speed: 0, target, lap: 1, respawnT: 0, skill, progress: 0, loose: false });
    });
  }

  /** One fixed physics step of race logic. */
  step(dt: number, state: GameState): void {
    if (state === GameState.Idle || this.finished) return;
    const racing = state === GameState.Launch || state === GameState.Crash || state === GameState.Settle;
    if (!racing) return;

    for (const r of this.racers) this.stepRival(r, dt);
    this.updatePlayerShortcut();
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
        this.repair(r.a); // a taken-down rival comes back good as new
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
    // gate-reached radius: roughly the half-width, but never multiple
    // section spacings — on a wide track that would skip targets and pull
    // the racing line off the sections entirely
    if (Math.hypot(dx, dz) < Math.min(this.width * 0.8, 13)) {
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

  /** Gate-reached test, shared by main-loop tracking and shortcut rejoin:
   *  a drift can sweep wide of a section centre, so crossing the section's
   *  portal plane (within track width) counts too. */
  private reachedGate(s: RaceSection, x: number, z: number): boolean {
    const dx = x - s.x;
    const dz = z - s.z;
    const along = dx * s.dirX + dz * s.dirZ;
    const lat = Math.abs(dx * s.dirZ - dz * s.dirX);
    return Math.hypot(dx, dz) < this.width * 0.9 || (along > 0 && along < 14 && lat < this.width);
  }

  /** Nearest-centre distance from the player to a shortcut chain. */
  private chainDistance(c: ShortcutChain): number {
    const p = this.player.body.position;
    let best = Infinity;
    for (const s of c.secs) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < best) best = d;
    }
    return best;
  }

  /** Branch progress hand-back. trackPlayer only scans 2 sections ahead, so
   *  a long cut (Harbor Run skips ~37) would strand playerTarget at the
   *  entry forever; and the corridor sits well off the main centreline, so
   *  without the on-branch flag the 5 s off-track rescue in modes/race.ts
   *  would teleport the player mid-shortcut. */
  private updatePlayerShortcut(): void {
    if (this.finished || this.player.crashed) {
      // a wreck in the cut pays the documented price: the reset pair drops
      // you back on the MAIN loop at the fork, at SLOW — the detour wins
      this.onShortcut = -1;
      return;
    }
    const b = this.player.body;
    if (this.onShortcut < 0) {
      for (let i = 0; i < this.shortcuts.length; i++) {
        const c = this.shortcuts[i];
        if (this.chainDistance(c) <= c.halfW + SHORTCUT_SLACK) {
          this.onShortcut = i;
          break;
        }
      }
      if (this.onShortcut < 0) return;
    }
    const c = this.shortcuts[this.onShortcut];
    // rejoin: test main sections exit-1 … exit+3 for gate-reach (a jump cut
    // can land PAST its exit section — the Flyover carries ~43 m) and snap
    // playerTarget to just past the reached gate. The ShortcutDef contract
    // (entry < exit, both ≥4 from the line) guarantees exit+3 < N, so the
    // snap never crosses section 0 — lap counting (which only increments in
    // trackPlayer's one-by-one walk through target 1) stays safe.
    for (let k = 3; k >= -1; k--) {
      const idx = c.exit + k;
      if (idx >= this.N || !this.reachedGate(this.secs[idx], b.position.x, b.position.z)) continue;
      const target = (idx + 1) % this.N;
      const ahead = (target - this.playerTarget + this.N) % this.N;
      // forward-only: re-entering the corridor mouth from the main road
      // must never drag an already-advanced target backwards
      if (ahead > 0 && ahead < this.N / 2) this.playerTarget = target;
      this.onShortcut = -1;
      return;
    }
    // drifted out of the corridor without rejoining — back on the main road
    // (trackPlayer picks them up) or in the weeds (the rescue timer runs)
    if (this.chainDistance(c) > c.halfW + SHORTCUT_SLACK) this.onShortcut = -1;
  }

  private trackPlayer(): void {
    if (this.finished || this.player.crashed) return;
    const b = this.player.body;
    // scan a couple of sections ahead so a wide arc can't lose race progress
    for (let k = 2; k >= 0; k--) {
      const idx = (this.playerTarget + k) % this.N;
      if (this.reachedGate(this.secs[idx], b.position.x, b.position.z)) {
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

  /** Reset-pair for the player: back into the section before their target.
   *  `speed` lets the takedown-cam handback keep the player's earned pace
   *  instead of the crash respawn's SLOW start. */
  respawnPlayer(control: PlayerControl, speed = RESET_SPEED): void {
    this.onShortcut = -1; // every reset pair lands on the MAIN loop
    const idx = (this.playerTarget - 1 + this.N) % this.N;
    this.placeAt(this.player, idx);
    const heading = Math.atan2(this.secs[idx].dirX, this.secs[idx].dirZ);
    control.reset(heading);
    control.speed = speed;
    const s = this.secs[idx];
    this.player.body.velocity.set(s.dirX * speed, 0, s.dirZ * speed);
    this.player.crashed = false;
    this.player.destabilized = 0;
    this.player.destabilizedByPlayer = false;
    this.player.body.collisionFilterMask = ~GROUP_DECOR;
  }

  /** Metres the player sits beyond the road edge (0 = on the track). The
   *  centreline is sampled at section spacing, so the nearest-centre check
   *  carries a half-spacing slack. A player inside a shortcut corridor is
   *  ON a road: without the on-branch zero the Harbor lane (20-30 m off the
   *  main centreline) would read as stranded and the 5 s rescue in
   *  modes/race.ts would teleport them mid-shortcut. */
  playerOffTrackDistance(): number {
    if (this.onShortcut >= 0) return 0;
    const p = this.player.body.position;
    let best = Infinity;
    for (const s of this.secs) {
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      if (d < best) best = d;
    }
    return Math.max(0, best - this.width / 2 - 4);
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
