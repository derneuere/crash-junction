// Drift squeal: the real tire-squeal recording looped seamlessly, with a
// two-resonant-bands synth fallback while the clip streams in.

import { makeSeamlessLoop, startNoise } from './shared';

/** Tire squeal: the real recording (samples.ts 'skid'), looped seamlessly —
 *  slip drives the level, speed and slip lean on the playback rate. The
 *  old two-resonant-bands synth stays as the fallback while clips stream
 *  in (filtered noise alone reads ghostly, not rubbery). */
export class SkidLoop {
  private mode: 'sample' | 'synth' | null = null;
  private gain!: GainNode;
  private src: AudioBufferSourceNode | null = null;
  private norm = 1;
  private bp1: BiquadFilterNode | null = null;
  private bp2: BiquadFilterNode | null = null;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
    private getClip: () => { buffer: AudioBuffer; offset: number; norm: number } | null,
  ) {}

  private build(): void {
    const ctx = this.ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(this.out);
    if (!this.buildSample()) this.buildSynth();
  }

  private buildSample(): boolean {
    const clip = this.getClip();
    if (!clip) return false;
    const ctx = this.ctx;
    // skip the cut's fade-in and faded tail; ~70 ms seam
    const loop = makeSeamlessLoop(ctx, clip.buffer, clip.offset + 0.05, 0.18, 0.07);
    this.src = ctx.createBufferSource();
    this.src.buffer = loop.buffer;
    this.src.loop = true;
    this.src.loopEnd = loop.loopEnd;
    this.src.connect(this.gain);
    this.src.start();
    this.norm = clip.norm;
    this.mode = 'sample';
    return true;
  }

  private buildSynth(): void {
    const ctx = this.ctx;
    const src = startNoise(ctx, this.noise);
    this.bp1 = ctx.createBiquadFilter();
    this.bp1.type = 'bandpass';
    this.bp1.frequency.value = 550;
    this.bp1.Q.value = 7;
    this.bp2 = ctx.createBiquadFilter();
    this.bp2.type = 'bandpass';
    this.bp2.frequency.value = 1320;
    this.bp2.Q.value = 9;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6.3;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 150;
    lfo.connect(lfoAmt);
    lfoAmt.connect(this.bp2.frequency);
    lfo.start();
    src.connect(this.bp1);
    src.connect(this.bp2);
    this.bp1.connect(this.gain);
    this.bp2.connect(this.gain);
    this.mode = 'synth';
  }

  /** slip 0..1 (0 = silent); speed in m/s tilts the squeal's pitch up. */
  update(slip: number, speed: number, warp: number): void {
    if (!this.mode) {
      if (slip <= 0) return;
      this.build();
    }
    const t = this.ctx.currentTime;
    if (this.mode === 'synth' && slip <= 0 && this.gain.gain.value < 0.005 && this.getClip()) {
      // clips finished decoding since the fallback was built — upgrade in
      // a silent moment (the synth nodes idle behind their muted gain)
      this.bp1?.disconnect();
      this.bp2?.disconnect();
      if (this.buildSample()) this.bp1 = this.bp2 = null;
    }
    if (this.mode === 'sample') {
      const rate = (0.86 + 0.14 * Math.min(1, speed / 40) + 0.08 * slip) * warp;
      this.src!.playbackRate.setTargetAtTime(rate, t, 0.08);
      this.gain.gain.setTargetAtTime(slip > 0 ? (0.12 + 0.22 * slip) * this.norm : 0, t, slip > 0 ? 0.06 : 0.12);
    } else {
      const pitch = (0.9 + 0.2 * Math.min(1, speed / 40)) * warp;
      this.bp1!.frequency.setTargetAtTime(550 * pitch, t, 0.06);
      this.bp2!.frequency.setTargetAtTime(1320 * pitch, t, 0.06);
      this.gain.gain.setTargetAtTime(slip > 0 ? 0.07 + 0.17 * slip : 0, t, slip > 0 ? 0.05 : 0.12);
    }
  }
}
