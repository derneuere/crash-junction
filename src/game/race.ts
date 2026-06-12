import * as CANNON from 'cannon-es';
import type { Actor, RaceDef } from './types';
import { GameState } from './types';
import type { GameEvents } from './events';
import type { Emitter } from './emitter';
import type { PlayerControl } from './control';
import { GROUP_DECOR } from './physics';
import { simRand } from './rng';

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

// ---- the catch-up band, Burnout 3 style ----
// B3 keeps the pack glued to the player both ways: rivals behind run hot
// (the infamous "AI boost"), rivals ahead breathe out — close enough to
// fight, never gifted the lead. The band is a multiplier on the section
// speed classes, eased over distance so pace never reads as a switch.
const RUBBER_MAX = 1.32; // flat-out factor when far behind
const RUBBER_BEHIND_FULL = 110; // m behind the player for the full boost
const RUBBER_MIN = 0.93; // leaders coast, they don't park
const RUBBER_AHEAD_FULL = 90; // m ahead where the coast bottoms out
const AI_TOP = 46; // hard ceiling, catch-up included (player: 39, boost 48)

// ---- aggression ----
// B3 rivals don't just race — they hunt. A rival with a clean shot picks an
// attack run: a SHUNT (ram the bumper, surge through them) when the victim
// sits dead ahead, a SLAM (lean through their door, ideally into a wall)
// when door-to-door. Runs are time-boxed, abort for braking zones and wall
// margins, and respect a cooldown so combat comes in beats, not a grind.
const DECIDE_EVERY = 0.5; // s between attack decisions
const ATTACK_AHEAD = 17; // engagement envelope in the rival's frame (m)
const ATTACK_BEHIND = 6;
const ATTACK_LAT = 5.5;
const SHUNT_LAT = 2.0; // inside this beam width the victim is "dead ahead"
const SHUNT_TIME = 1.7; // s an attack run is pressed before giving up
const SLAM_TIME = 1.3;
const ATTACK_COOLDOWN = 4; // base s between runs, scaled by aggression
const LANE_RATE = 3.5; // m/s of lateral line adjustment
const WANDER = 2.2; // m of line wander around the preferred lane

const PLAYER = -1; // victim index sentinel

interface RacerState {
  a: Actor;
  heading: number;
  speed: number;
  target: number; // section index we're driving toward
  lap: number;
  respawnT: number;
  skill: number; // corner-speed multiplier <1 — what makes them beatable
  aggression: number; // 0 clean … 1 bully — gates attack rolls and cooldowns
  lane: number; // preferred lateral offset off the section centre (m)
  laneNow: number; // smoothed actual offset — the line they're driving
  phase: number; // per-rival wander phase, fixed at spawn
  attackT: number; // s left pressing the current attack (0 = not attacking)
  attackKind: 'shunt' | 'slam';
  victim: number; // racers index, or PLAYER, valid while attackT > 0
  cooldown: number; // s until the next attack roll
  decideT: number; // s until the next decision tick (staggered per rival)
  rubber: number; // smoothed catch-up factor — also scales acceleration
  heat: number; // B3 hostility: ≥1, rises when the player roughs this rival up
  offT: number; // s spent beyond the road edge — combat can throw a rival
  //               over the barrier, and there's no driving back in
  progress: number;
  loose: boolean; // was destabilized last step — resync AI on recovery
}

export class RaceDirector {
  readonly laps: number;
  /** Dev/probe counters — read via window.__raceAI in bug reports and the
   *  headless AI probe. Display-only; the sim never reads them back. */
  readonly tele = { shunts: 0, slams: 0 };
  private secs: RaceSection[];
  private N: number;
  private width: number;
  private spacing: number; // mean portal spacing — progress × this ≈ metres
  private racers: RacerState[] = [];
  private playerTarget = 1;
  private playerLap = 1;
  private playerPos = 1;
  private playerProg = 0; // cached once per step, before the rivals read it
  private finished = false;
  private lastEmit = '';

  constructor(
    race: RaceDef,
    private player: Actor,
    rivals: { actor: Actor; skill: number; aggression: number }[],
    private events: Emitter<GameEvents>,
    private onFinish: (position: number) => void,
    private repair: (a: Actor) => void,
  ) {
    this.laps = race.laps;
    this.secs = race.sections;
    this.N = this.secs.length;
    this.width = race.width;
    let len = 0;
    for (let i = 0; i < this.N; i++) {
      const a = this.secs[i];
      const b = this.secs[(i + 1) % this.N];
      len += Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.spacing = len / this.N;
    // grid: stagger the rivals AHEAD of the start line (section 0) — the
    // player starts last and fights their way to the top
    const s0 = this.secs[0];
    const px = -s0.dirZ; // perpendicular
    const pz = s0.dirX;
    rivals.forEach(({ actor, skill, aggression }, i) => {
      const back = 7 + i * 7;
      const side = (i % 2 === 0 ? 1 : -1) * 2.6;
      const heading = Math.atan2(s0.dirX, s0.dirZ);
      actor.body.position.set(s0.x + s0.dirX * back + px * side, actor.spec?.rideHeight ?? 0.8, s0.z + s0.dirZ * back + pz * side);
      actor.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), heading + Math.PI);
      actor.q0.copy(actor.body.quaternion);
      actor.body.wakeUp();
      actor.started = true;
      // spread the preferred lanes across the road so the pack doesn't ride
      // a single rail; the wander phase staggers how each line breathes
      const lane = rivals.length > 1 ? ((i / (rivals.length - 1)) * 2 - 1) * 5.5 : 0;
      this.racers.push({
        a: actor, heading, speed: 0, target: 1, lap: 1, respawnT: 0, skill,
        aggression, lane, laneNow: lane, phase: i * 2.4,
        attackT: 0, attackKind: 'shunt', victim: PLAYER, cooldown: 2.5, decideT: 0.3 + i * 0.17,
        rubber: 1, heat: 1, offT: 0, progress: 0, loose: false,
      });
    });
    (window as unknown as { __raceAI?: object }).__raceAI = this.tele;
  }

  /** One fixed physics step of race logic. */
  step(dt: number, state: GameState): void {
    if (state === GameState.Idle || this.finished) return;
    const racing = state === GameState.Launch || state === GameState.Crash || state === GameState.Settle;
    if (!racing) return;

    const pb = this.player.body.position;
    this.playerProg = this.progressOf(this.playerLap, this.playerTarget, pb.x, pb.z);
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
        r.a.destabilizedBy = 0;
        r.loose = false;
        r.attackT = 0;
        r.cooldown = 1.5; // settle in before swinging again
        r.rubber = 1;
        r.laneNow = 0; // reset pairs drop the car on the centre line
        r.a.body.collisionFilterMask = ~GROUP_DECOR;
        this.repair(r.a); // a taken-down rival comes back good as new
        // heat survives the respawn: a rival the player wrecked comes back
        // hunting — B3's revenge rival, red arrow and all
      }
      return;
    }
    if (r.a.destabilized > 0) {
      // shunt mode: nobody's steering — physics carries the slide (into the
      // wall, if the shove was good)
      if (!r.loose && r.a.destabilizedByPlayer) {
        // the player started this — B3 hostility: rivals remember
        r.heat = Math.min(2.2, r.heat + 0.6);
      }
      r.loose = true;
      r.attackT = 0; // the run died with the slide
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
    r.progress = this.progressOf(r.lap, r.target, b.position.x, b.position.z);
    r.heat = Math.max(1, r.heat - 0.05 * dt); // grudges cool off slowly

    // off-track rescue: a slam can throw a rival clean over the barrier,
    // and there is no driving back in — after a beat, the same reset pair
    // the player gets puts it back into the race
    let nearRoad = Infinity;
    for (const s of this.secs) {
      const d = Math.hypot(b.position.x - s.x, b.position.z - s.z);
      if (d < nearRoad) nearRoad = d;
    }
    r.offT = nearRoad > this.width / 2 + 4 ? r.offT + dt : 0;
    if (r.offT > 3) {
      r.offT = 0;
      const idx = (r.target - 1 + this.N) % this.N;
      this.placeAt(r.a, idx);
      r.heading = Math.atan2(this.secs[idx].dirX, this.secs[idx].dirZ);
      r.speed = RESET_SPEED;
      r.attackT = 0;
      r.laneNow = 0;
      return;
    }

    // ---- the catch-up band: pace from the gap to the player. The dead
    // zone keeps the cheat invisible in close combat, and the final
    // stretch runs honest — a player lead is never stolen by the band.
    // Pack glue (Melder's leader rule, generalized): everyone also bands
    // gently toward the nearest car ahead of them, so the field stays a
    // brawling pack instead of stringing out by skill when the player is
    // out of the picture ----
    const gap = (r.progress - this.playerProg) * this.spacing; // m ahead (+) of the player
    const eased = Math.max(0, Math.abs(gap) - 18);
    let band =
      gap < 0
        ? 1 + (RUBBER_MAX - 1) * Math.min(1, eased / RUBBER_BEHIND_FULL)
        : 1 - (1 - RUBBER_MIN) * Math.min(1, eased / RUBBER_AHEAD_FULL);
    let gapAhead = Infinity; // m to the nearest car (rival or player) ahead
    for (const o of this.racers) {
      if (o !== r && !o.a.crashed && o.progress > r.progress) {
        gapAhead = Math.min(gapAhead, (o.progress - r.progress) * this.spacing);
      }
    }
    if (!this.player.crashed && this.playerProg > r.progress) {
      gapAhead = Math.min(gapAhead, (this.playerProg - r.progress) * this.spacing);
    }
    if (gapAhead < Infinity) {
      band = Math.max(band, 1 + 0.08 * clamp((gapAhead - 20) / 60, 0, 1));
    }
    if (r.lap >= this.laps && r.target / this.N > 0.8) band = Math.min(band, 1);
    r.rubber += (band - r.rubber) * Math.min(1, dt * 1.5);

    // ---- pick (and press) fights ----
    const next = this.secs[(r.target + 1) % this.N];
    const next2 = this.secs[(r.target + 2) % this.N];
    const cornerClose = Math.min(next.v, next2.v) < r.speed - 5; // braking zone — no knife work
    this.runAttack(r, dt, cornerClose);

    // ---- aim: the victim while attacking, the (offset) line otherwise ----
    const victim = r.attackT > 0 ? this.victimOf(r) : null;
    let aimX: number;
    let aimZ: number;
    if (victim) {
      // shunts chase a lead point on the bumper; slams steer through the door
      const lead = r.attackKind === 'shunt' ? 0.28 : 0.1;
      aimX = victim.body.position.x + victim.body.velocity.x * lead;
      aimZ = victim.body.position.z + victim.body.velocity.z * lead;
    } else {
      // steer at a look-ahead section, BP AI-PID style (P only — arcade),
      // displaced sideways onto this rival's own line
      const px = -t.dirZ; // section-left — the lane offset axis
      const pz = t.dirX;
      this.steerLane(r, t, px, pz, dt);
      aimX = (next.x + t.x) / 2 + px * r.laneNow;
      aimZ = (next.z + t.z) / 2 + pz * r.laneNow;
    }
    const aim = Math.atan2(aimX - b.position.x, aimZ - b.position.z);
    const err = wrapAngle(aim - r.heading);
    r.heading = wrapAngle(r.heading + clamp(err * 3, -AI_YAW, AI_YAW) * dt);

    // ---- speed: brake for the slowest of the next few sections, paced by
    // the band; hold a gap to the car ahead so the pack doesn't rear-end
    // itself — unless that car is the one we're attacking. The band is
    // capped additively (+7 m/s over honest pace): multiplied into a
    // corner's speed class it out-runs the AI's steering authority and
    // launches rivals over the sweeper kerbs ----
    const honest = Math.min(t.v, next.v + 2, next2.v + 6) * r.skill;
    let target = Math.min(honest * r.rubber, honest + 7);
    const holdGap = (a: Actor, oSpeed: number) => {
      if (a === victim) return; // pressing the attack — no polite gap
      const rx = a.body.position.x - b.position.x;
      const rz = a.body.position.z - b.position.z;
      const ahead = rx * Math.sin(r.heading) + rz * Math.cos(r.heading);
      const lat = Math.abs(rx * Math.cos(r.heading) - rz * Math.sin(r.heading));
      if (ahead > 0 && ahead < 9 && lat < 2.4) target = Math.min(target, oSpeed * 0.95);
    };
    for (const o of this.racers) {
      if (o !== r && !o.a.crashed) holdGap(o.a, o.speed);
    }
    if (!this.player.crashed) {
      const pv = this.player.body.velocity;
      holdGap(this.player, Math.hypot(pv.x, pv.z));
    }
    if (victim) {
      // the surge: shunts run the victim down, slams keep station on the door
      const vv = victim.body.velocity;
      target = Math.max(target, Math.hypot(vv.x, vv.z) + (r.attackKind === 'shunt' ? 8 : 1.5));
    }
    target = Math.min(target, AI_TOP);
    r.speed += clamp(target - r.speed, -AI_BRAKE * dt, AI_ACC * Math.max(1, r.rubber) * dt);

    b.velocity.set(Math.sin(r.heading) * r.speed, b.velocity.y, Math.cos(r.heading) * r.speed);
    b.angularVelocity.set(0, 0, 0);
    b.quaternion.setFromAxisAngle(UP, r.heading + Math.PI); // hull forward is -z
  }

  /** Position of an actor in the rival's frame: m ahead of the nose and m
   *  abeam (sign only matters for picking sides consistently). */
  private relTo(r: RacerState, x: number, z: number): { ahead: number; lat: number } {
    const b = r.a.body;
    const rx = x - b.position.x;
    const rz = z - b.position.z;
    return {
      ahead: rx * Math.sin(r.heading) + rz * Math.cos(r.heading),
      lat: rx * Math.cos(r.heading) - rz * Math.sin(r.heading),
    };
  }

  /** The rival's own lateral offset from its target section centre (m). */
  private sectionLatOf(r: RacerState): number {
    const t = this.secs[r.target];
    const b = r.a.body;
    return (b.position.x - t.x) * -t.dirZ + (b.position.z - t.z) * t.dirX;
  }

  private victimOf(r: RacerState): Actor | null {
    const a = r.victim === PLAYER ? this.player : this.racers[r.victim]?.a;
    // a downed or sliding victim is a finished job, not a target
    if (!a || a.crashed || a.destabilized > 0) return null;
    return a;
  }

  /** The attack state machine: keep pressing a live run (with abort rules
   *  so nobody follows a victim into a braking zone or the wall), or roll
   *  for a new one on the decision tick. */
  private runAttack(r: RacerState, dt: number, cornerClose: boolean): void {
    r.cooldown = Math.max(0, r.cooldown - dt);
    r.decideT -= dt;
    if (r.attackT > 0) {
      const victim = this.victimOf(r);
      let live = victim !== null && !cornerClose;
      if (live && Math.abs(this.sectionLatOf(r)) > this.width / 2 - 1.3) live = false; // wall margin
      if (live && victim) {
        const rel = this.relTo(r, victim.body.position.x, victim.body.position.z);
        // a generous keep-pressing envelope — once they slip it, let go
        if (rel.ahead < -ATTACK_BEHIND * 1.4 || rel.ahead > ATTACK_AHEAD * 1.4 || Math.abs(rel.lat) > ATTACK_LAT * 1.4) live = false;
      }
      r.attackT = live ? r.attackT - dt : 0;
      if (r.attackT <= 0) {
        r.attackT = 0;
        r.cooldown = ATTACK_COOLDOWN * (1.5 - r.aggression) + simRand() * 2;
      }
      return;
    }
    if (r.decideT > 0) return;
    r.decideT = DECIDE_EVERY;
    if (r.cooldown > 0 || cornerClose) return;

    // candidates: anyone in the envelope; the player preferred (B3 rivals
    // hunt YOU), doubly so with a grudge on. Geometry picks the move —
    // dead ahead is a shunt, door-to-door a slam. Side contests go to the
    // faster car (judgeAggressor), so only start a slam we'd win, and
    // prefer a victim nearer the wall: that's what the slam is FOR.
    const myLat = Math.abs(this.sectionLatOf(r));
    const t = this.secs[r.target];
    let best: { victim: number; kind: 'shunt' | 'slam'; score: number } | null = null;
    const consider = (idx: number, a: Actor, speed: number) => {
      if (a.crashed || a.destabilized > 0) return;
      const rel = this.relTo(r, a.body.position.x, a.body.position.z);
      if (rel.ahead < -ATTACK_BEHIND || rel.ahead > ATTACK_AHEAD || Math.abs(rel.lat) > ATTACK_LAT) return;
      let kind: 'shunt' | 'slam';
      if (rel.ahead > 1.5 && Math.abs(rel.lat) < SHUNT_LAT) kind = 'shunt';
      else if (Math.abs(rel.ahead) < 8 && r.speed >= speed - 1.5) kind = 'slam';
      else return;
      let score = (idx === PLAYER ? 0.6 + (r.heat - 1) : 0) + 1 - Math.hypot(rel.ahead, rel.lat) / 20;
      if (kind === 'slam') {
        const vLat = Math.abs((a.body.position.x - t.x) * -t.dirZ + (a.body.position.z - t.z) * t.dirX);
        if (vLat > myLat) score += 0.25; // they're between us and the wall
      }
      if (!best || score > best.score) best = { victim: idx, kind, score };
    };
    if (!this.player.crashed && this.player.destabilized <= 0) {
      const pv = this.player.body.velocity;
      consider(PLAYER, this.player, Math.hypot(pv.x, pv.z));
    }
    this.racers.forEach((o, i) => {
      if (o !== r) consider(i, o.a, o.speed);
    });
    if (!best) return;
    const pick = best as { victim: number; kind: 'shunt' | 'slam'; score: number };
    // the roll: aggression is the appetite, heat the temper. A 0.9 bully
    // commits within a tick of lining up; a 0.3 cruiser mostly minds its
    // racing line until the player makes it personal.
    if (simRand() > 0.15 + 0.75 * Math.min(1, r.aggression * r.heat)) return;
    r.attackT = pick.kind === 'shunt' ? SHUNT_TIME : SLAM_TIME;
    r.attackKind = pick.kind;
    r.victim = pick.victim;
    this.tele[pick.kind === 'shunt' ? 'shunts' : 'slams']++;
  }

  /** Lateral line keeping while racing clean: a per-rival preferred lane
   *  with a slow wander (nobody rides the rail), pulling out to pass a car
   *  parked on the nose, and — for the aggressive — mirroring the player's
   *  line to shut the door when defending the spot ahead. */
  private steerLane(r: RacerState, t: RaceSection, px: number, pz: number, dt: number): void {
    // corners pull everyone toward the centre line; straights spread the pack
    const cornerScale = clamp(t.v / 34, 0.4, 1);
    let lane = (r.lane + WANDER * Math.sin(r.target * 0.31 + r.phase)) * cornerScale;
    let blockerLat: number | null = null; // section-frame lat of a car on our nose
    const scan = (a: Actor) => {
      if (a === r.a || a.crashed) return;
      const rel = this.relTo(r, a.body.position.x, a.body.position.z);
      if (rel.ahead > 0 && rel.ahead < 11 && Math.abs(rel.lat) < 2.4) {
        blockerLat = (a.body.position.x - t.x) * px + (a.body.position.z - t.z) * pz;
      }
    };
    for (const o of this.racers) scan(o.a);
    scan(this.player);
    if (blockerLat !== null) {
      // somebody's parked on the nose: the hungry line up dead behind them
      // (that's what arms the shunt), the patient pull out and around
      const hunting = r.aggression > 0.45 && r.cooldown <= 0;
      lane = hunting ? (blockerLat as number) : r.laneNow + ((blockerLat as number) >= r.laneNow ? -3.4 : 3.4);
    } else if (
      r.aggression > 0.55 &&
      !this.player.crashed &&
      r.progress > this.playerProg &&
      (r.progress - this.playerProg) * this.spacing < 16
    ) {
      // defend the lead, B3 style: cover the player's line
      const p = this.player.body.position;
      lane = (p.x - t.x) * px + (p.z - t.z) * pz;
    }
    const maxLane = this.width / 2 - 2.4;
    lane = clamp(lane, -maxLane, maxLane);
    r.laneNow += clamp(lane - r.laneNow, -LANE_RATE * dt, LANE_RATE * dt);
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

  /** Reset-pair for the player: back into the section before their target.
   *  `speed` lets the takedown-cam handback keep the player's earned pace
   *  instead of the crash respawn's SLOW start. */
  respawnPlayer(control: PlayerControl, speed = RESET_SPEED): void {
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
   *  carries a half-spacing slack. */
  playerOffTrackDistance(): number {
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
