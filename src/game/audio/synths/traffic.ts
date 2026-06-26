// Traffic engines: a small pool of positional engine-hum voices that
// attach to the nearest moving cars each frame.

import type { Actor } from '../../types';
import { RUMBLE_H } from './shared';

const HUM_VOICES = 4;
const HUM_RANGE2 = 70 * 70; // m² — beyond this traffic is fog, not sound

interface HumVoice {
  osc: OscillatorNode;
  sub: OscillatorNode;
  gain: GainNode;
  pan: PannerNode;
  actor: Actor | null;
}

/** The other cars: a small pool of positional engine-hum voices that
 *  attach to the nearest moving traffic each frame. Each voice is a
 *  rumble-wave oscillator + sub through its own panner; reassignment
 *  crossfades through the smoothed gain, so cars hand voices over without
 *  clicks. Wrecks fall silent — a dead engine is part of the payout. */
export class TrafficHum {
  private built = false;
  private voices: HumVoice[] = [];

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
  ) {}

  private build(): void {
    const ctx = this.ctx;
    const wave = ctx.createPeriodicWave(new Float32Array(RUMBLE_H.length), new Float32Array(RUMBLE_H));
    for (let i = 0; i < HUM_VOICES; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      const sub = ctx.createOscillator();
      const subG = ctx.createGain();
      subG.gain.value = 0.6;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 420;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = 7;
      pan.maxDistance = 120;
      pan.rolloffFactor = 1.1;
      osc.connect(lp);
      sub.connect(subG);
      subG.connect(lp);
      lp.connect(gain);
      gain.connect(pan);
      pan.connect(this.out);
      osc.start();
      sub.start();
      this.voices.push({ osc, sub, gain, pan, actor: null });
    }
    this.built = true;
  }

  update(actors: Actor[] | null, player: Actor | null, camPos: { x: number; y: number; z: number }, warp: number): void {
    const t = this.ctx.currentTime;
    // candidates: live traffic with a running engine, near enough to hear
    const cands: Actor[] = [];
    if (actors) {
      for (const a of actors) {
        if (a.kind !== 'vehicle' || a === player || a.crashed || a.exploded) continue;
        const v = a.body.velocity;
        if (v.x * v.x + v.z * v.z < 2) continue;
        const dx = a.body.position.x - camPos.x;
        const dz = a.body.position.z - camPos.z;
        if (dx * dx + dz * dz < HUM_RANGE2) cands.push(a);
      }
    }
    if (!this.built) {
      if (!cands.length) return;
      this.build();
    }

    // keep voices whose car still qualifies; hand the free ones to the
    // nearest unclaimed cars (n is tiny — a linear scan per voice is fine)
    for (const v of this.voices) if (v.actor && !cands.includes(v.actor)) v.actor = null;
    const claimed = new Set(this.voices.map((v) => v.actor).filter(Boolean));
    for (const v of this.voices) {
      if (v.actor) continue;
      let best: Actor | null = null;
      let bestD = Infinity;
      for (const c of cands) {
        if (claimed.has(c)) continue;
        const dx = c.body.position.x - camPos.x;
        const dz = c.body.position.z - camPos.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best) {
        v.actor = best;
        claimed.add(best);
      }
    }

    for (const v of this.voices) {
      const a = v.actor;
      if (!a) {
        v.gain.gain.setTargetAtTime(0, t, 0.15);
        continue;
      }
      const vel = a.body.velocity;
      const speed = Math.hypot(vel.x, vel.z);
      // a per-car offset keeps a queue of sedans from phase-locking into one
      const f0 = (52 + 4.5 * speed + (a.body.id % 7)) * warp;
      v.osc.frequency.setTargetAtTime(f0, t, 0.1);
      v.sub.frequency.setTargetAtTime(f0 * 0.5, t, 0.1);
      v.gain.gain.setTargetAtTime(0.05, t, 0.18);
      const p = v.pan;
      if (p.positionX) {
        p.positionX.value = a.body.position.x;
        p.positionY.value = a.body.position.y;
        p.positionZ.value = a.body.position.z;
      }
    }
  }
}
