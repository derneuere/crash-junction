import * as CANNON from 'cannon-es';
import type { Actor, RaceDef } from '../types';
import { GameState } from '../types';
import type { GameEvents } from '../events';
import type { Emitter } from '../emitter';
import type { PlayerControl } from '../control';
import { GROUP_DECOR } from '../physics';
import { simRand } from '../rng';
import { HANDLING } from '../handling';
import { createForceState, stepVehicleForces } from '../control/driving';
import type { ControlInput } from '../control/input';
import type { HeightSampler } from '../suspension';
import type { RaceSection } from './sections';
import { buildOpenSections, SHORTCUT_SPACING, wrapAngle, clamp } from './sections';
import type { ShortcutChain, RacerState } from './types';
import {
  AI_YAW,
  AI_STEER_GAIN,
  AI_ACC,
  AI_BRAKE,
  RESPAWN_AFTER,
  RESET_SPEED,
  SHORTCUT_SLACK,
  RUBBER_MAX,
  RUBBER_BEHIND_FULL,
  RUBBER_MIN,
  RUBBER_AHEAD_FULL,
  AI_TOP,
  DECIDE_EVERY,
  ATTACK_AHEAD,
  ATTACK_BEHIND,
  ATTACK_LAT,
  SHUNT_LAT,
  SHUNT_TIME,
  SLAM_TIME,
  SLAM_ALONGSIDE,
  SLAM_CUT,
  SLAM_ALONG_BAND,
  SLAM_BESIDE,
  ATTACK_COOLDOWN,
  LANE_RATE,
  WANDER,
  PLAYER,
  UP,
} from './constants';

// force-port scratch: derive the rival's heading from its body each frame.
const FWD_LOCAL = new CANNON.Vec3(0, 0, -1); // hull forward is -z local
const _aiFwd = new CANNON.Vec3();

export class RaceDirector {
  readonly laps: number;
  /** Dev/probe counters — read via window.__raceAI in bug reports and the
   *  headless AI probe. Display-only; the sim never reads them back. */
  readonly tele = { shunts: 0, slams: 0 };
  /** Height sampler (set by the host right after construction) so rivals can
   *  run the shared force solver. Same sampler the player controller uses. */
  heightAt!: HeightSampler;
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
  private shortcuts: ShortcutChain[] = [];
  private onShortcut = -1; // index into shortcuts while the player runs a branch

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
    // shortcut chains: same Catmull resample as the loop, open-ended —
    // built here (plain numbers in, deterministic out) so player tracking
    // and the off-track rescue can measure against them every step
    for (const sc of race.shortcuts ?? []) {
      this.shortcuts.push({ exit: sc.exit, halfW: sc.width / 2, secs: buildOpenSections(sc.waypoints, SHORTCUT_SPACING) });
    }
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
      actor.body.position.set(s0.x + s0.dirX * back + px * side, s0.y + (actor.spec?.rideHeight ?? 0.8), s0.z + s0.dirZ * back + pz * side);
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
      // spread the preferred lanes across the road so the pack doesn't ride
      // a single rail; the wander phase staggers how each line breathes
      const lane = rivals.length > 1 ? ((i / (rivals.length - 1)) * 2 - 1) * 5.5 : 0;
      this.racers.push({
        a: actor, heading, speed: 0, target, lap: 1, respawnT: 0, skill,
        aggression, lane, laneNow: lane, phase: i * 2.4,
        attackT: 0, attackKind: 'shunt', slamCut: false, victim: PLAYER, cooldown: 2.5, decideT: 0.3 + i * 0.17,
        rubber: 1, heat: 1, offT: 0, progress: 0, loose: false,
        fs: createForceState(actor.spec?.variant ?? 'sedan', heading, 0),
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
    }

    // ---- force-port: heading/speed are now DERIVED from the body (the solver
    // owns the orientation). Re-seed the rival's decision geometry from the
    // body FIRST so relTo/slamTarget/holdGap/aim/cornerClose all read reality,
    // not a stale kinematic heading. (Replaces the old loose-recovery resync +
    // every later `r.heading =`/`r.speed =` author.) --------------------------
    {
      b.quaternion.vmult(FWD_LOCAL, _aiFwd); // hull forward is -z local
      r.heading = Math.atan2(_aiFwd.x, _aiFwd.z);
      r.speed = Math.hypot(b.velocity.x, b.velocity.z);
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
      // shunts chase a lead point on the bumper; slams line up alongside the
      // victim then cut through the door (Burnout-style, see slamTarget)
      if (r.attackKind === 'slam') {
        const s = this.slamTarget(r, victim);
        aimX = s.x;
        aimZ = s.z;
        r.slamCut = s.cut;
      } else {
        aimX = victim.body.position.x + victim.body.velocity.x * 0.28;
        aimZ = victim.body.position.z + victim.body.velocity.z * 0.28;
        r.slamCut = false;
      }
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
    // ---- force-port: scripted STEER command (not a heading write). The solver
    // turns the body; we hand it a steer in [-1,1] off the heading error. NOT
    // divided by the steer lock (the solver already scales by it). -------------
    const steerErr = wrapAngle(aim - r.heading);
    const aiSteer = clamp(-steerErr * AI_STEER_GAIN, -1, 1);

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
      // the surge: shunts run the victim down; a slam keeps station while it
      // lines up alongside, then leans on the throttle to barge through once
      // it's beside them (slamCut)
      const vv = victim.body.velocity;
      const surge = r.attackKind === 'shunt' ? 8 : r.slamCut ? 3.5 : 1.5;
      target = Math.max(target, Math.hypot(vv.x, vv.z) + surge);
    }
    target = Math.min(target, AI_TOP);
    // ---- force-port: turn the desired target speed into throttle/brake bangs
    // for the solver instead of writing velocity. The rival's engine economy +
    // tire grip (stepVehicleForces) realise the pace through the gears; the
    // catch-up band (r.rubber) still shapes `target` above, so the AI boost is
    // preserved as faster TARGET pace, not a teleport. ------------------------
    const wantFaster = target > r.speed + 0.4;
    const wantSlower = target < r.speed - 0.4;
    const aiInput: ControlInput = {
      steer: aiSteer,
      throttle: wantFaster,
      boost: false, // rivals lean on the rubber band, not the player's boost bar
      brake: wantSlower && r.speed > 6, // don't ride the brake to a dead stop
    };
    // re-seed the solver state from the body each frame (heading/speed derived),
    // then bank this rival's forces. attribs = the rival's own variant vault.
    r.fs.heading = r.heading;
    r.fs.velAngle = r.heading;
    r.fs.speed = r.speed;
    r.fs.variant = r.a.spec?.variant ?? 'sedan';
    stepVehicleForces(r.fs, r.a, aiInput, this.heightAt, HANDLING[r.a.spec?.variant ?? 'sedan']);
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

  /** Burnout-style slam lineup. Reads the victim's travel axis and its
   *  RIGHT vector, finds which side the rival sits, and returns a world aim
   *  point: while still closing it aims ALONGSIDE on the rival's own side
   *  (+offset) so the car draws even; once it's level and close abeam — the
   *  commit gate (|alongSep| < band, |latSep| < beside) — it aims THROUGH the
   *  victim to the far side (−offset) so the steering drives across into the
   *  door. `cut` reports the barge phase so the surge can lean in. */
  private slamTarget(r: RacerState, victim: Actor): { x: number; z: number; cut: boolean } {
    const vp = victim.body.position;
    const vv = victim.body.velocity;
    const vsp = Math.hypot(vv.x, vv.z);
    // victim travel axis (heading-forward if it's crawling) and a perpendicular
    // — the side sign derived from latSep is self-consistent with this choice
    const fx = vsp > 2 ? vv.x / vsp : Math.sin(r.heading);
    const fz = vsp > 2 ? vv.z / vsp : Math.cos(r.heading);
    const rx = fz;
    const rz = -fx;
    const dx = r.a.body.position.x - vp.x;
    const dz = r.a.body.position.z - vp.z;
    const alongSep = dx * fx + dz * fz; // + = rival ahead of the victim
    const latSep = dx * rx + dz * rz; // signed side the rival sits on
    const side = latSep >= 0 ? 1 : -1;
    const cut = Math.abs(alongSep) < SLAM_ALONG_BAND && Math.abs(latSep) < SLAM_BESIDE;
    const off = cut ? -side * SLAM_CUT : side * SLAM_ALONGSIDE;
    // a touch of the victim's own motion so we creep up to the door, not behind
    return { x: vp.x + rx * off + vv.x * 0.06, z: vp.z + rz * off + vv.z * 0.06, cut };
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
    // s.y: reset pairs land ON the road, which carries the elevation
    // profile on the north arc of GANTRY POINT (+0 on every flat track —
    // bit-identical to the pre-elevation math). Respawning INTO a climb at
    // RESET_SPEED is fine: the ground-follow picks the car up first step.
    b.position.set(s.x, s.y + ((a.spec?.rideHeight ?? 0.8) + 0.05), s.z);
    b.quaternion.setFromAxisAngle(UP, Math.atan2(s.dirX, s.dirZ) + Math.PI);
    b.velocity.set(s.dirX * RESET_SPEED, 0, s.dirZ * RESET_SPEED);
    b.angularVelocity.set(0, 0, 0);
    b.wakeUp();
  }
}
