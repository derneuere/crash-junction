// Game audio: recorded one-shots (samples.ts) + synthesized loops
// (synths.ts) over a positioned 3D mix.
//
// The mix architecture:
//
//   one-shots → [panner] ─┬→ masterIn → slow-mo lowpass → compressor
//   loops ────────────────┘     ↑                              ↓
//   reverb send → convolver ────┘                     masterOut (mute) → out
//
// Every sound is positional where it has a world position (the camera is
// the listener), every active sample is pitch-warped by the crashtime
// timescale, and the master lowpass closes as time slows — the underwater
// cinematic dive, Burnout style. All of it is presentation: it reads sim
// state, never writes it, and rolls Math.random (never simRand), so audio
// can never desync a replay. High-level API + per-frame orchestrator: the
// mix graph and clip playback live in core.ts, the synthesized one-shots in
// one-shots.ts / stings.ts, shared types/constants in types.ts. Importers
// still get GameAudio / AudioFrameState / EngineFlavor from here.

import type { Actor } from '../types';
import { AudioCore } from './core';
import * as OneShots from './one-shots';
import * as Stings from './stings';
import { BoostLoop, EngineSound, type EngineFlavor, SkidLoop, TrafficHum, WindLoop } from './synths';
import { NEAR_MISS_DIST2, NEAR_MISS_REL, TRACKSIDE_DIST2, TRACKSIDE_SPEED, type AudioFrameState, type XYZ } from './types';

export type { AudioFrameState } from './types';
export type { EngineFlavor };

export class GameAudio {
  private core = new AudioCore();

  private engine: EngineSound | null = null;
  private engineFlavor: EngineFlavor = 'stock'; // App may set it before init()
  private skid: SkidLoop | null = null;
  private boost: BoostLoop | null = null;
  private wind: WindLoop | null = null;
  private traffic: TrafficHum | null = null;

  private muted = false;

  // frame-edge trackers (all presentation state)
  private prevTs = 1;
  private wasBoosting = false;
  private airTime = 0;
  private slipEnv = 0; // squeal envelope — fast attack, slow release
  private lastVy = 0;
  private nearMissAt = new Map<number, number>(); // body id → core.now of last whoosh
  private lastNearMiss = -1;
  private trackside: XYZ[] = []; // static furniture for pass-by whooshes
  private tracksideAt: number[] = []; // per-object core.now of last whoosh
  private lastTrackside = -1;

  /** Fetch sample bytes — no AudioContext needed, call from the game
   *  constructor so clips are ready by the first gesture. */
  prefetch(): void {
    this.core.prefetch();
  }

  /** Static near-track furniture (gantry legs, flag poles, lamp posts…) for
   *  pass-by whooshes — the pitched one-shot fake doppler the genre actually
   *  ships (sense-of-speed A5). Positions in, sound out: presentation only. */
  setTrackside(points: XYZ[]): void {
    this.trackside = points;
    this.tracksideAt = new Array<number>(points.length).fill(-9);
    this.lastTrackside = -1;
  }

  /** Call from a user gesture (autoplay policy). Safe to call repeatedly. */
  init(): void {
    if (this.core.ctx) return;
    if (!this.core.build()) return;
    try {
      const ctx = this.core.ctx!;
      const masterIn = this.core.masterIn!;
      const noise = this.core.noise!;
      this.engine = new EngineSound(ctx, masterIn, noise, (n) => this.core.bank.pick(n));
      this.engine.setFlavor(this.engineFlavor);
      this.skid = new SkidLoop(ctx, masterIn, noise, () => this.core.bank.pick('skid'));
      this.boost = new BoostLoop(ctx, masterIn, noise, () => this.core.bank.pick('boost_loop'));
      this.wind = new WindLoop(ctx, masterIn, noise);
      this.traffic = new TrafficHum(ctx, masterIn);

      this.core.bank.decode(ctx);
    } catch {
      this.core.ctx = null;
    }
  }

  resume(): void {
    if (this.core.ctx?.state === 'suspended') void this.core.ctx.resume();
  }

  /** Which recorded engine the player's car runs (HUD toggle). Live-swaps
   *  the loop set; safe before init() too — the choice is applied when the
   *  engine voice is built. */
  setEngineFlavor(f: EngineFlavor): void {
    this.engineFlavor = f;
    this.engine?.setFlavor(f);
  }

  /** HMR remounts must not leak contexts — browsers cap them per page. */
  dispose(): void {
    const ctx = this.core.ctx;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
    this.core.ctx = null;
  }

  /** M key. Returns the new muted state. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    const out = this.core.masterOut;
    if (out && this.core.ctx) out.gain.setTargetAtTime(this.muted ? 0 : 1, this.core.ctx.currentTime, 0.03);
    return this.muted;
  }

  /** Master RMS 0..1 — dev/verification aid. */
  levels(): number {
    return this.core.levels();
  }

  /** Decoded clip count — dev/verification aid. */
  samplesLoaded(): number {
    return this.core.samplesLoaded();
  }

  // -------------------------------------------------------------------------
  // per-frame update

  frame(f: AudioFrameState): void {
    if (!this.core.ready()) return;
    try {
      this.core.now += f.dt;
      const ctx = this.core.ctx!;
      const t = ctx.currentTime;
      const ts = f.timeScale;
      this.core.warp = 0.55 + 0.45 * ts;

      // listener = camera (manual quaternion math — no three import)
      const { x: qx, y: qy, z: qz, w: qw } = f.cam.quaternion;
      const l = ctx.listener;
      const p = f.cam.position;
      if (l.positionX) {
        l.positionX.value = p.x;
        l.positionY.value = p.y;
        l.positionZ.value = p.z;
        l.forwardX.value = -2 * (qw * qy + qx * qz);
        l.forwardY.value = 2 * (qw * qx - qy * qz);
        l.forwardZ.value = -1 + 2 * (qx * qx + qy * qy);
        l.upX.value = 2 * (qx * qy - qw * qz);
        l.upY.value = 1 - 2 * (qx * qx + qz * qz);
        l.upZ.value = 2 * (qy * qz + qw * qx);
      }

      // slow-mo: the master lowpass closes and every live sample drops pitch
      const tsN = Math.max(0, Math.min(1, (ts - 0.3) / 0.7));
      this.core.slowLP!.frequency.setTargetAtTime(1100 + 18900 * Math.pow(tsN, 1.3), t, 0.07);
      for (const v of this.core.live) v.src.playbackRate.value = v.rate * this.core.warp;
      if (this.prevTs > 0.85 && ts <= 0.85) OneShots.slowmoDive(this.core);
      else if (this.prevTs < 0.95 && ts >= 0.95) OneShots.slowmoRise(this.core);
      this.prevTs = ts;

      // continuous layers
      const vol = f.driving ? (f.boosting ? 0.16 : f.throttle ? 0.125 : 0.07) : 0;
      this.engine!.update(f.speed, vol, f.driving && (f.throttle || f.boosting), this.core.warp, f.dt);
      // squeal continuity: drift chains pass through zero slip and curbs
      // flick the suspension airborne for a frame — neither should chop the
      // squeal. A floor while drifting + a coyote window over ground gaps
      // + a slow-release envelope keep one slide sounding like one slide.
      const contact = f.grounded || this.airTime < 0.22;
      const rawSlip = f.driving && contact ? (f.drifting ? Math.max(f.slip, 0.3) : f.slip) : 0;
      this.slipEnv = Math.max(rawSlip, this.slipEnv - f.dt / 0.5);
      this.skid!.update(this.slipEnv, f.speed, this.core.warp);
      this.boost!.update(f.driving && f.boosting, this.core.warp);
      this.wind!.update(f.driving ? f.speed : 0, f.boosting, this.core.warp);
      this.traffic!.update(f.actors, f.player, f.cam.position, this.core.warp);

      // boost ignite (rising edge) — the drift squeal needs no entry
      // one-shot: the loop IS the same recording and they'd phase
      const boosting = f.driving && f.boosting;
      if (boosting && !this.wasBoosting) this.core.play('whoosh', { gain: 0.32, rate: 1.18, send: 0.1 });
      this.wasBoosting = boosting;

      // landing thump after real airtime (driven car only — wrecks land
      // through collision events and already crash())
      if (f.driving && !f.grounded) this.airTime += f.dt;
      else {
        if (f.driving && this.airTime > 0.35) OneShots.landing(this.core, Math.abs(this.lastVy), f.player?.body.position ?? null);
        this.airTime = 0;
      }
      this.lastVy = f.vy;

      if (f.driving && f.actors && f.player) this.scanNearMisses(f.actors, f.player);
      if (f.driving && f.speed > TRACKSIDE_SPEED && f.player) this.scanTrackside(f.player, f.speed);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Flashing past static furniture at speed: a positioned whoosh at the
   *  object, pitch rising with speed — passed objects are what make speed
   *  audible, and SILVER LAKE's new flag line finally gives them to us. */
  private scanTrackside(player: Actor, v: number): void {
    if (this.core.now - this.lastTrackside < 0.5) return;
    const pb = player.body.position;
    for (let i = 0; i < this.trackside.length; i++) {
      const o = this.trackside[i];
      const dx = o.x - pb.x;
      const dz = o.z - pb.z;
      if (dx * dx + dz * dz > TRACKSIDE_DIST2) continue;
      // per-object cooldown keeps a slow scrape along one gantry from
      // machine-gunning; the global 0.5 s spaces a dense flag line
      if (this.core.now - this.tracksideAt[i] < 2.5) continue;
      this.tracksideAt[i] = this.core.now;
      this.lastTrackside = this.core.now;
      this.core.play('whoosh', { gain: 0.2, rate: 0.8 + v / 60, pos: o });
      break;
    }
  }

  /** Traffic passing within arm's reach at speed: the near-miss whoosh —
   *  and sometimes the other guy leans on his horn. */
  private scanNearMisses(actors: Actor[], player: Actor): void {
    if (this.core.now - this.lastNearMiss < 0.4) return;
    const pb = player.body;
    for (const a of actors) {
      if (a === player || a.kind !== 'vehicle' || a.crashed) continue;
      const dx = a.body.position.x - pb.position.x;
      const dz = a.body.position.z - pb.position.z;
      if (dx * dx + dz * dz > NEAR_MISS_DIST2) continue;
      const rvx = a.body.velocity.x - pb.velocity.x;
      const rvz = a.body.velocity.z - pb.velocity.z;
      const rel = Math.hypot(rvx, rvz);
      if (rel < NEAR_MISS_REL) continue;
      if (this.core.now - (this.nearMissAt.get(a.body.id) ?? -9) < 2.5) continue;
      this.nearMissAt.set(a.body.id, this.core.now);
      this.lastNearMiss = this.core.now;
      const gain = Math.min(0.42, 0.15 + rel / 60);
      if (!this.core.play('whoosh', { gain, rate: 0.85 + rel / 90, pos: a.body.position })) {
        OneShots.synthWhoosh(this.core, gain, 0.9);
      }
      if (Math.random() < 0.3) {
        this.core.play('horn', { gain: 0.3, rate: 0.96 + Math.random() * 0.08, pos: a.body.position, delay: 0.05 + Math.random() * 0.08 });
      }
      break; // one whoosh per scan — the global cooldown spaces the rest
    }
  }

  // -------------------------------------------------------------------------
  // one-shots (delegated to one-shots.ts over the voice engine)

  /** Collision of strength `impact` (m/s along the normal). Tiers pick the
   *  recording; a synthesized sub-thump carries the weight on big ones. */
  crash(impact: number, pos: XYZ | null, scenery: boolean): void {
    OneShots.crash(this.core, impact, pos, scenery);
  }

  glassBreak(pos: XYZ | null, big = false): void {
    OneShots.glassBreak(this.core, pos, big);
  }

  /** A body panel tears off. */
  clank(pos: XYZ | null): void {
    OneShots.clank(this.core, pos);
  }

  wheelPop(pos: XYZ | null): void {
    OneShots.wheelPop(this.core, pos);
  }

  explosion(power: number, pos: XYZ | null): void {
    OneShots.explosion(this.core, power, pos);
  }

  /** Multiplier ring: a three-note shimmer climbing the harmonic. */
  ding(pos: XYZ | null = null): void {
    Stings.ding(this.core, pos);
  }

  /** Takedown payday. */
  kaching(): void {
    Stings.kaching(this.core);
  }

  /** Wreckage-report sting, sized to the medal. */
  fanfare(medal: 'GOLD' | 'SILVER' | 'BRONZE' | 'NONE'): void {
    Stings.fanfare(this.core, medal);
  }

  /** Run start. */
  launch(): void {
    Stings.launch(this.core);
  }

  /** Smoldering wreck pops (positioned, very quiet). */
  crackle(pos: XYZ | null): void {
    Stings.crackle(this.core, pos);
  }
}
