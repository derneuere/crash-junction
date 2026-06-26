// Reward + UI stings: the oscillator-based payday/medal music and the
// positioned wreck crackle. Split out of one-shots.ts (which keeps the
// physics-impact family) purely for size. Each is a small free function over
// the AudioCore voice engine; all presentation, all rolling Math.random.

import type { AudioCore } from './core';
import type { XYZ } from './types';

/** Multiplier ring: a three-note shimmer climbing the harmonic. */
export function ding(c: AudioCore, pos: XYZ | null = null): void {
  if (!c.ready()) return;
  try {
    const ctx = c.ctx!;
    const t = ctx.currentTime;
    const out = pos ? c.panner(pos) : c.masterIn!;
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
    tss.buffer = c.noise!;
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
export function kaching(c: AudioCore): void {
  if (c.play('kaching', { gain: 0.5, rate: 1, noWarp: true })) return;
  // fallback: two-tone register bell
  if (!c.ready()) return;
  try {
    const ctx = c.ctx!;
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
      g.connect(c.masterIn!);
      o.start(t + at);
      o.stop(t + at + 0.3);
    }
  } catch {
    /* audio is best-effort */
  }
}

/** Wreckage-report sting, sized to the medal. */
export function fanfare(c: AudioCore, medal: 'GOLD' | 'SILVER' | 'BRONZE' | 'NONE'): void {
  if (!c.ready()) return;
  try {
    const notes: Record<typeof medal, number[]> = {
      GOLD: [523.25, 659.25, 783.99, 1046.5],
      SILVER: [523.25, 659.25, 783.99],
      BRONZE: [440, 554.37, 659.25],
      NONE: [330, 233.08],
    };
    const ctx = c.ctx!;
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
        og.connect(c.masterIn!);
        o.start(at);
        o.stop(at + (last ? 1 : 0.4));
      }
    });
    if (medal === 'GOLD') c.play('kaching', { gain: 0.4, delay: 0.25, noWarp: true });
  } catch {
    /* audio is best-effort */
  }
}

/** Run start. */
export function launch(c: AudioCore): void {
  c.play('whoosh', { gain: 0.28, rate: 1.3, noWarp: true });
}

/** Smoldering wreck pops (positioned, very quiet). */
export function crackle(c: AudioCore, pos: XYZ | null): void {
  if (!c.ready()) return;
  try {
    const ctx = c.ctx!;
    const out = pos ? c.panner(pos) : c.masterIn!;
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const at = ctx.currentTime + Math.random() * 0.3;
      const src = ctx.createBufferSource();
      src.buffer = c.noise!;
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
