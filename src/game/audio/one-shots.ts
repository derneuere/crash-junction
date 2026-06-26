// Event one-shots: crashes, glass, explosions, payday stings, slow-mo dive,
// landings, and the synthesized fallbacks. Each is a small free function over
// the AudioCore voice engine — pulled out of GameAudio so the high-level API
// stays a thin orchestrator. All of it is presentation: it reads sim state,
// never writes it, and rolls Math.random (never simRand), so audio can never
// desync a replay.

import type { AudioCore } from './core';
import type { XYZ } from './types';

/** Pitch-dropping sine — the body weight under crashes and landings. */
export function subThump(c: AudioCore, gain: number, from: number, dur: number): void {
  if (!c.ready()) return;
  const ctx = c.ctx!;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(from * c.warp, t);
  o.frequency.exponentialRampToValueAtTime(28, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.05);
  o.connect(g);
  g.connect(c.masterIn!);
  o.start(t);
  o.stop(t + dur + 0.1);
}

/** The old synthesized thump — still the sound while clips stream in. */
export function fallbackThump(c: AudioCore, intensity: number): void {
  const ctx = c.ctx!;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = c.noise!;
  src.playbackRate.value = c.warp;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 500 + Math.random() * 900;
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.min(0.45, intensity / 26), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  src.connect(f);
  f.connect(g);
  g.connect(c.masterIn!);
  src.start(t, Math.random());
  src.stop(t + 0.45);
  subThump(c, Math.min(0.35, intensity / 30), 85, 0.3);
}

export function synthWhoosh(c: AudioCore, gain: number, rate: number): void {
  const ctx = c.ctx!;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = c.noise!;
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
  g.connect(c.masterIn!);
  src.start(t, Math.random());
  src.stop(t + 0.6);
}

/** Collision of strength `impact` (m/s along the normal). Tiers pick the
 *  recording; a synthesized sub-thump carries the weight on big ones. */
export function crash(c: AudioCore, impact: number, pos: XYZ | null, scenery: boolean): void {
  if (!c.ready()) return;
  try {
    if (c.now - c.lastCrashAt < 0.035 || c.crashVoices >= 8) return;
    c.lastCrashAt = c.now;
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
      played = c.play('hit', { gain: gain * 0.7, rate: 0.8 * jitter, pos, crash: true });
    } else if (impact < 4.5) {
      played = c.play('hit', { gain, rate: jitter, pos, crash: true });
    } else if (impact < 9.5) {
      // a ram: pure crunch + low body — no clank layer, the bell-like
      // ring of struck plate reads as a kitchen "pling", not a wreck
      played = c.play('crash_med', { gain, rate: jitter, pos, send: 0.05 + 0.12 * loud, crash: true });
      subThump(c, 0.1 + 0.45 * loud, 75, 0.24);
    } else {
      played = c.play('crash_big', { gain, rate: jitter, pos, send: 0.06 + 0.16 * loud, crash: true });
      // pitched well down the clank stops ringing and becomes wreckage
      c.play('clank', { gain: 0.3 * loud, rate: 0.75 * jitter, pos, delay: 0.02, crash: true });
      subThump(c, 0.55 * loud, 85, 0.35);
    }
    if (!played) fallbackThump(c, impact); // clips still loading
  } catch {
    /* audio is best-effort */
  }
}

export function glassBreak(c: AudioCore, pos: XYZ | null, big = false): void {
  c.play('glass', { gain: big ? 0.4 : 0.26, rate: 0.9 + Math.random() * 0.2, pos, send: 0.1 });
}

/** A body panel tears off. */
export function clank(c: AudioCore, pos: XYZ | null): void {
  c.play('clank', { gain: 0.3, rate: 0.95 + Math.random() * 0.15, pos });
}

export function wheelPop(c: AudioCore, pos: XYZ | null): void {
  c.play('hit', { gain: 0.3, rate: 1.3 + Math.random() * 0.15, pos });
  subThump(c, 0.12, 130, 0.12);
}

export function explosion(c: AudioCore, power: number, pos: XYZ | null): void {
  if (!c.ready()) return;
  try {
    const rate = (0.95 - 0.04 * (power - 1)) * (0.96 + Math.random() * 0.08);
    c.play('explosion_big', { gain: Math.min(0.95, 0.55 + 0.15 * power), rate, pos, send: 0.4 });
    c.play('boom', { gain: 0.5, rate: 0.95 + Math.random() * 0.1, pos, delay: 0.012, send: 0.25 });
    c.play('boom_sub', { gain: Math.min(0.9, 0.45 + 0.2 * power), rate: 0.8, pos });
    // synthesized weight under the recordings: the sub drop + crack
    const ctx = c.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90 * c.warp, t);
    o.frequency.exponentialRampToValueAtTime(24, t + 0.8);
    const og = ctx.createGain();
    og.gain.setValueAtTime(Math.min(0.8, 0.3 + 0.16 * power), t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    o.connect(og);
    og.connect(c.masterIn!);
    o.start(t);
    o.stop(t + 1.1);
    const crack = ctx.createBufferSource();
    crack.buffer = c.noise!;
    crack.playbackRate.value = 1.4 * c.warp;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.25, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    crack.connect(hp);
    hp.connect(g2);
    g2.connect(c.masterIn!);
    crack.start(t, Math.random());
    crack.stop(t + 0.14);
  } catch {
    /* audio is best-effort */
  }
}

export function slowmoDive(c: AudioCore): void {
  c.play('whoosh', { gain: 0.45, rate: 0.55, send: 0.3, noWarp: true });
  if (!c.ready()) return;
  const ctx = c.ctx!;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(400, t);
  o.frequency.exponentialRampToValueAtTime(70, t + 0.45);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  o.connect(g);
  g.connect(c.masterIn!);
  o.start(t);
  o.stop(t + 0.55);
}

export function slowmoRise(c: AudioCore): void {
  c.play('whoosh', { gain: 0.14, rate: 1.3, noWarp: true });
}

export function landing(c: AudioCore, vy: number, pos: XYZ | null): void {
  subThump(c, Math.min(0.3, 0.1 + vy * 0.012), 90, 0.16);
  c.play('hit', { gain: Math.min(0.25, 0.08 + vy * 0.01), rate: 0.75, pos });
}
