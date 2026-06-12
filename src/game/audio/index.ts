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
// can never desync a replay.

import type { Actor } from '../types';
import { SampleBank, type SampleName } from './samples';
import { BoostLoop, EngineSound, type EngineFlavor, SkidLoop, TrafficHum, WindLoop, makeImpulseResponse, makeNoiseBuffer } from './synths';

export type { EngineFlavor };

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Per-frame sim readout — one persistent object, mutated by Game. */
export interface AudioFrameState {
  dt: number;
  timeScale: number;
  cam: { position: XYZ; quaternion: { x: number; y: number; z: number; w: number } };
  driving: boolean; // engine audible: launched, alive, not a wreck
  speed: number;
  throttle: boolean;
  boosting: boolean;
  drifting: boolean;
  slip: number; // 0..1 — how sideways the drift is (drives squeal level)
  grounded: boolean;
  vy: number; // player vertical speed (landing thump strength)
  actors: Actor[] | null; // near-miss scan
  player: Actor | null;
}

interface PlayOpts {
  gain: number;
  rate?: number;
  pos?: XYZ | null;
  send?: number; // reverb send (fraction of voice gain)
  delay?: number;
  noWarp?: boolean; // UI sounds skip the slow-mo pitch warp
}

const NEAR_MISS_DIST2 = 4.6 * 4.6;
const NEAR_MISS_REL = 9; // m/s relative speed to count as a "whoosh"

export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private masterIn: GainNode | null = null;
  private masterOut: GainNode | null = null;
  private slowLP: BiquadFilterNode | null = null;
  private reverb: ConvolverNode | null = null;
  private analyser: AnalyserNode | null = null;
  private bank = new SampleBank();

  private engine: EngineSound | null = null;
  private engineFlavor: EngineFlavor = 'stock'; // App may set it before init()
  private skid: SkidLoop | null = null;
  private boost: BoostLoop | null = null;
  private wind: WindLoop | null = null;
  private traffic: TrafficHum | null = null;

  // live one-shots, re-pitched every frame while time is slowed
  private live = new Set<{ src: AudioBufferSourceNode; rate: number }>();
  private warp = 1;
  private muted = false;

  // frame-edge trackers (all presentation state)
  private now = 0; // accumulated audio-frame time
  private prevTs = 1;
  private wasBoosting = false;
  private airTime = 0;
  private slipEnv = 0; // squeal envelope — fast attack, slow release
  private lastVy = 0;
  private lastCrashAt = -1;
  private crashVoices = 0;
  private nearMissAt = new Map<number, number>(); // body id → this.now of last whoosh
  private lastNearMiss = -1;

  /** Fetch sample bytes — no AudioContext needed, call from the game
   *  constructor so clips are ready by the first gesture. */
  prefetch(): void {
    this.bank.prefetch();
  }

  /** Call from a user gesture (autoplay policy). Safe to call repeatedly. */
  init(): void {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = (this.ctx = new Ctx());
      this.noise = makeNoiseBuffer(ctx);

      this.masterIn = ctx.createGain();
      this.slowLP = ctx.createBiquadFilter();
      this.slowLP.type = 'lowpass';
      this.slowLP.frequency.value = 20000;
      // gentle: the compressor catches pileup peaks, but a hard ratio
      // would iron the crash-loudness dynamic flat again
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -13;
      comp.knee.value = 20;
      comp.ratio.value = 3.5;
      this.masterOut = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.masterIn.connect(this.slowLP);
      this.slowLP.connect(comp);
      comp.connect(this.masterOut);
      this.masterOut.connect(this.analyser);
      this.analyser.connect(ctx.destination);

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeImpulseResponse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      this.reverb.connect(wet);
      wet.connect(this.masterIn);

      this.engine = new EngineSound(ctx, this.masterIn, this.noise, (n) => this.bank.pick(n));
      this.engine.setFlavor(this.engineFlavor);
      this.skid = new SkidLoop(ctx, this.masterIn, this.noise, () => this.bank.pick('skid'));
      this.boost = new BoostLoop(ctx, this.masterIn, this.noise, () => this.bank.pick('boost_loop'));
      this.wind = new WindLoop(ctx, this.masterIn, this.noise);
      this.traffic = new TrafficHum(ctx, this.masterIn);

      this.bank.decode(ctx);
    } catch {
      this.ctx = null;
    }
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
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
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  /** M key. Returns the new muted state. */
  toggleMute(): boolean {
    this.muted = !this.muted;
    const out = this.masterOut;
    if (out && this.ctx) out.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.03);
    return this.muted;
  }

  /** Master RMS 0..1 — dev/verification aid. */
  levels(): number {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(d);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / d.length);
  }

  /** Decoded clip count — dev/verification aid. */
  samplesLoaded(): number {
    return this.bank.loadedCount();
  }

  private ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !!this.masterIn && !!this.noise;
  }

  // -------------------------------------------------------------------------
  // per-frame update

  frame(f: AudioFrameState): void {
    if (!this.ready()) return;
    try {
      this.now += f.dt;
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      const ts = f.timeScale;
      this.warp = 0.55 + 0.45 * ts;

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
      this.slowLP!.frequency.setTargetAtTime(1100 + 18900 * Math.pow(tsN, 1.3), t, 0.07);
      for (const v of this.live) v.src.playbackRate.value = v.rate * this.warp;
      if (this.prevTs > 0.85 && ts <= 0.85) this.slowmoDive();
      else if (this.prevTs < 0.95 && ts >= 0.95) this.slowmoRise();
      this.prevTs = ts;

      // continuous layers
      const vol = f.driving ? (f.boosting ? 0.16 : f.throttle ? 0.125 : 0.07) : 0;
      this.engine!.update(f.speed, vol, f.driving && (f.throttle || f.boosting), this.warp, f.dt);
      // squeal continuity: drift chains pass through zero slip and curbs
      // flick the suspension airborne for a frame — neither should chop the
      // squeal. A floor while drifting + a coyote window over ground gaps
      // + a slow-release envelope keep one slide sounding like one slide.
      const contact = f.grounded || this.airTime < 0.22;
      const rawSlip = f.driving && contact ? (f.drifting ? Math.max(f.slip, 0.3) : f.slip) : 0;
      this.slipEnv = Math.max(rawSlip, this.slipEnv - f.dt / 0.5);
      this.skid!.update(this.slipEnv, f.speed, this.warp);
      this.boost!.update(f.driving && f.boosting, this.warp);
      this.wind!.update(f.driving ? f.speed : 0, f.boosting, this.warp);
      this.traffic!.update(f.actors, f.player, f.cam.position, this.warp);

      // boost ignite (rising edge) — the drift squeal needs no entry
      // one-shot: the loop IS the same recording and they'd phase
      const boosting = f.driving && f.boosting;
      if (boosting && !this.wasBoosting) this.play('whoosh', { gain: 0.32, rate: 1.18, send: 0.1 });
      this.wasBoosting = boosting;

      // landing thump after real airtime (driven car only — wrecks land
      // through collision events and already crash())
      if (f.driving && !f.grounded) this.airTime += f.dt;
      else {
        if (f.driving && this.airTime > 0.35) this.landing(Math.abs(this.lastVy), f.player?.body.position ?? null);
        this.airTime = 0;
      }
      this.lastVy = f.vy;

      if (f.driving && f.actors && f.player) this.scanNearMisses(f.actors, f.player);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Traffic passing within arm's reach at speed: the near-miss whoosh —
   *  and sometimes the other guy leans on his horn. */
  private scanNearMisses(actors: Actor[], player: Actor): void {
    if (this.now - this.lastNearMiss < 0.4) return;
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
      if (this.now - (this.nearMissAt.get(a.body.id) ?? -9) < 2.5) continue;
      this.nearMissAt.set(a.body.id, this.now);
      this.lastNearMiss = this.now;
      const gain = Math.min(0.42, 0.15 + rel / 60);
      if (!this.play('whoosh', { gain, rate: 0.85 + rel / 90, pos: a.body.position })) {
        this.synthWhoosh(gain, 0.9);
      }
      if (Math.random() < 0.3) {
        this.play('horn', { gain: 0.3, rate: 0.96 + Math.random() * 0.08, pos: a.body.position, delay: 0.05 + Math.random() * 0.08 });
      }
      break; // one whoosh per scan — the global cooldown spaces the rest
    }
  }

  // -------------------------------------------------------------------------
  // one-shots

  /** Collision of strength `impact` (m/s along the normal). Tiers pick the
   *  recording; a synthesized sub-thump carries the weight on big ones. */
  crash(impact: number, pos: XYZ | null, scenery: boolean): void {
    if (!this.ready()) return;
    try {
      if (this.now - this.lastCrashAt < 0.035 || this.crashVoices >= 8) return;
      this.lastCrashAt = this.now;
      // ONE loudness curve across the whole impact range — the tier only
      // picks which recording. A 6 m/s shunt and a 22 m/s T-bone are ~14 dB
      // apart (clips are peak-normalized at decode, so gain IS the dynamic);
      // per-tier offsets would let the tier floor mask how hard you hit.
      const loud = Math.min(1, Math.pow(impact / 26, 1.25)) * (scenery ? 0.55 : 1);
      const gain = 0.07 + 0.83 * loud;
      // harder hits also land a touch slower and deeper — mass, not pitch
      const jitter = (0.96 + Math.random() * 0.16) * (1.04 - 0.14 * loud);
      let played: boolean;
      if (scenery && impact < 5) {
        // wreck scraping along the road — felt, not headline news
        played = this.play('hit', { gain: gain * 0.7, rate: 0.8 * jitter, pos, crash: true });
      } else if (impact < 4.5) {
        played = this.play('hit', { gain, rate: jitter, pos, crash: true });
      } else if (impact < 9.5) {
        // a ram: pure crunch + low body — no clank layer, the bell-like
        // ring of struck plate reads as a kitchen "pling", not a wreck
        played = this.play('crash_med', { gain, rate: jitter, pos, send: 0.05 + 0.12 * loud, crash: true });
        this.subThump(0.1 + 0.45 * loud, 75, 0.24);
      } else {
        played = this.play('crash_big', { gain, rate: jitter, pos, send: 0.06 + 0.16 * loud, crash: true });
        // pitched well down the clank stops ringing and becomes wreckage
        this.play('clank', { gain: 0.3 * loud, rate: 0.75 * jitter, pos, delay: 0.02, crash: true });
        this.subThump(0.55 * loud, 85, 0.35);
      }
      if (!played) this.fallbackThump(impact); // clips still loading
    } catch {
      /* audio is best-effort */
    }
  }

  glassBreak(pos: XYZ | null, big = false): void {
    this.play('glass', { gain: big ? 0.4 : 0.26, rate: 0.9 + Math.random() * 0.2, pos, send: 0.1 });
  }

  /** A body panel tears off. */
  clank(pos: XYZ | null): void {
    this.play('clank', { gain: 0.3, rate: 0.95 + Math.random() * 0.15, pos });
  }

  wheelPop(pos: XYZ | null): void {
    this.play('hit', { gain: 0.3, rate: 1.3 + Math.random() * 0.15, pos });
    this.subThump(0.12, 130, 0.12);
  }

  explosion(power: number, pos: XYZ | null): void {
    if (!this.ready()) return;
    try {
      const rate = (0.95 - 0.04 * (power - 1)) * (0.96 + Math.random() * 0.08);
      this.play('explosion_big', { gain: Math.min(0.95, 0.55 + 0.15 * power), rate, pos, send: 0.4 });
      this.play('boom', { gain: 0.5, rate: 0.95 + Math.random() * 0.1, pos, delay: 0.012, send: 0.25 });
      this.play('boom_sub', { gain: Math.min(0.9, 0.45 + 0.2 * power), rate: 0.8, pos });
      // synthesized weight under the recordings: the sub drop + crack
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(90 * this.warp, t);
      o.frequency.exponentialRampToValueAtTime(24, t + 0.8);
      const og = ctx.createGain();
      og.gain.setValueAtTime(Math.min(0.8, 0.3 + 0.16 * power), t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      o.connect(og);
      og.connect(this.masterIn!);
      o.start(t);
      o.stop(t + 1.1);
      const crack = ctx.createBufferSource();
      crack.buffer = this.noise!;
      crack.playbackRate.value = 1.4 * this.warp;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.25, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      crack.connect(hp);
      hp.connect(g2);
      g2.connect(this.masterIn!);
      crack.start(t, Math.random());
      crack.stop(t + 0.14);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Multiplier ring: a three-note shimmer climbing the harmonic. */
  ding(pos: XYZ | null = null): void {
    if (!this.ready()) return;
    try {
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      const out = pos ? this.panner(pos) : this.masterIn!;
      for (const [freq, at, g] of [
        [880, 0, 0.14],
        [1318.5, 0.06, 0.12],
        [1760, 0.12, 0.09],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        const og = ctx.createGain();
        og.gain.setValueAtTime(g, t + at);
        og.gain.exponentialRampToValueAtTime(0.001, t + at + 0.3);
        o.connect(og);
        og.connect(out);
        o.start(t + at);
        o.stop(t + at + 0.32);
      }
      const tss = ctx.createBufferSource();
      tss.buffer = this.noise!;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6000;
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.03, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      tss.connect(hp);
      hp.connect(tg);
      tg.connect(out);
      tss.start(t, Math.random());
      tss.stop(t + 0.2);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Takedown payday. */
  kaching(): void {
    if (this.play('kaching', { gain: 0.5, rate: 1, noWarp: true })) return;
    // fallback: two-tone register bell
    if (!this.ready()) return;
    try {
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      for (const [freq, at] of [
        [2093, 0],
        [2637, 0.05],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.08, t + at);
        g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.25);
        o.connect(g);
        g.connect(this.masterIn!);
        o.start(t + at);
        o.stop(t + at + 0.3);
      }
    } catch {
      /* audio is best-effort */
    }
  }

  /** Wreckage-report sting, sized to the medal. */
  fanfare(medal: 'GOLD' | 'SILVER' | 'BRONZE' | 'NONE'): void {
    if (!this.ready()) return;
    try {
      const notes: Record<typeof medal, number[]> = {
        GOLD: [523.25, 659.25, 783.99, 1046.5],
        SILVER: [523.25, 659.25, 783.99],
        BRONZE: [440, 554.37, 659.25],
        NONE: [330, 233.08],
      };
      const ctx = this.ctx!;
      const t = ctx.currentTime;
      const seq = notes[medal];
      const step = medal === 'NONE' ? 0.22 : 0.11;
      seq.forEach((freq, i) => {
        const at = t + i * step;
        const last = i === seq.length - 1;
        for (const [type, det, g] of [
          ['triangle', 0, 0.16],
          ['square', 3, 0.05],
        ] as const) {
          const o = ctx.createOscillator();
          o.type = type;
          o.frequency.value = freq;
          o.detune.value = det;
          const og = ctx.createGain();
          og.gain.setValueAtTime(g, at);
          og.gain.exponentialRampToValueAtTime(0.001, at + (last ? 0.9 : 0.35));
          o.connect(og);
          og.connect(this.masterIn!);
          o.start(at);
          o.stop(at + (last ? 1 : 0.4));
        }
      });
      if (medal === 'GOLD') this.play('kaching', { gain: 0.4, delay: 0.25, noWarp: true });
    } catch {
      /* audio is best-effort */
    }
  }

  /** Run start. */
  launch(): void {
    this.play('whoosh', { gain: 0.28, rate: 1.3, noWarp: true });
  }

  /** Smoldering wreck pops (positioned, very quiet). */
  crackle(pos: XYZ | null): void {
    if (!this.ready()) return;
    try {
      const ctx = this.ctx!;
      const out = pos ? this.panner(pos) : this.masterIn!;
      const n = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const at = ctx.currentTime + Math.random() * 0.3;
        const src = ctx.createBufferSource();
        src.buffer = this.noise!;
        src.playbackRate.value = 1 + Math.random();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1500 + Math.random() * 2200;
        bp.Q.value = 4;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.05, at);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
        src.connect(bp);
        bp.connect(g);
        g.connect(out);
        src.start(at, Math.random());
        src.stop(at + 0.07);
      }
    } catch {
      /* audio is best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // internals

  private slowmoDive(): void {
    this.play('whoosh', { gain: 0.45, rate: 0.55, send: 0.3, noWarp: true });
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(400, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g);
    g.connect(this.masterIn!);
    o.start(t);
    o.stop(t + 0.55);
  }

  private slowmoRise(): void {
    this.play('whoosh', { gain: 0.14, rate: 1.3, noWarp: true });
  }

  private landing(vy: number, pos: XYZ | null): void {
    this.subThump(Math.min(0.3, 0.1 + vy * 0.012), 90, 0.16);
    this.play('hit', { gain: Math.min(0.25, 0.08 + vy * 0.01), rate: 0.75, pos });
  }

  /** Pitch-dropping sine — the body weight under crashes and landings. */
  private subThump(gain: number, from: number, dur: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(from * this.warp, t);
    o.frequency.exponentialRampToValueAtTime(28, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.05);
    o.connect(g);
    g.connect(this.masterIn!);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  /** The old synthesized thump — still the sound while clips stream in. */
  private fallbackThump(intensity: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = this.warp;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500 + Math.random() * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.45, intensity / 26), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    src.connect(f);
    f.connect(g);
    g.connect(this.masterIn!);
    src.start(t, Math.random());
    src.stop(t + 0.45);
    this.subThump(Math.min(0.35, intensity / 30), 85, 0.3);
  }

  private synthWhoosh(gain: number, rate: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise!;
    src.playbackRate.value = rate;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(2200, t + 0.18);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.5);
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.15);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterIn!);
    src.start(t, Math.random());
    src.stop(t + 0.6);
  }

  private panner(pos: XYZ): PannerNode {
    const ctx = this.ctx!;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 10;
    pan.maxDistance = 220;
    pan.rolloffFactor = 0.9;
    if (pan.positionX) {
      pan.positionX.value = pos.x;
      pan.positionY.value = pos.y;
      pan.positionZ.value = pos.z;
    } else {
      pan.setPosition(pos.x, pos.y, pos.z);
    }
    pan.connect(this.masterIn!);
    return pan;
  }

  /** Play a recorded clip. Returns false when no variant has decoded yet
   *  (callers with a synth fallback use that). */
  private play(name: SampleName, o: PlayOpts & { crash?: boolean }): boolean {
    if (!this.ready()) return false;
    try {
      const clip = this.bank.pick(name);
      if (!clip) return false;
      if (this.live.size > 28 && o.gain < 0.3) return true; // full mix — drop the small stuff
      const ctx = this.ctx!;
      const t = ctx.currentTime + (o.delay ?? 0);
      const src = ctx.createBufferSource();
      src.buffer = clip.buffer;
      const rate = o.rate ?? 1;
      src.playbackRate.value = o.noWarp ? rate : rate * this.warp;
      const g = ctx.createGain();
      g.gain.value = o.gain * clip.norm;
      src.connect(g);
      g.connect(o.pos ? this.panner(o.pos) : this.masterIn!);
      if (o.send && this.reverb) {
        const s = ctx.createGain();
        s.gain.value = o.send * o.gain * clip.norm;
        g.connect(s);
        s.connect(this.reverb);
      }
      const entry = { src, rate };
      if (!o.noWarp) this.live.add(entry);
      if (o.crash) this.crashVoices++;
      src.onended = () => {
        this.live.delete(entry);
        if (o.crash) this.crashVoices--;
      };
      src.start(t, clip.offset);
      return true;
    } catch {
      return false;
    }
  }
}
