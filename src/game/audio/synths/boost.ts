// Boost afterburner: a looped rocket-thrust recording behind a lowpass that
// swells open on ignite, over a slow-vibrato sub. Filtered-noise fallback
// while the clip decodes.

import { makeSeamlessLoop, startNoise } from './shared';

/** Boost: a looped rocket-thrust recording behind a lowpass that swells
 *  open on ignite — the Burnout afterburner — over a slow-vibrato sub.
 *  Falls back to filtered noise while the clip decodes. */
export class BoostLoop {
  private mode: 'sample' | 'synth' | null = null;
  private src: AudioBufferSourceNode | null = null;
  private noiseSrc: AudioBufferSourceNode | null = null;
  private norm = 1;
  private lp!: BiquadFilterNode;
  private gain!: GainNode;
  private subGain!: GainNode;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
    private getClip: () => { buffer: AudioBuffer; offset: number; norm: number } | null,
  ) {}

  private build(): void {
    const ctx = this.ctx;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 400;
    this.lp.Q.value = 1.1;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.lp.connect(this.gain);
    this.gain.connect(this.out);

    const sub = ctx.createOscillator();
    sub.frequency.value = 56;
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.2;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = 3.5;
    vib.connect(vibAmt);
    vibAmt.connect(sub.frequency);
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    sub.connect(this.subGain);
    this.subGain.connect(this.out);
    sub.start();
    vib.start();
    if (!this.buildSample()) {
      this.noiseSrc = startNoise(ctx, this.noise);
      this.noiseSrc.connect(this.lp);
      this.mode = 'synth';
    }
  }

  private buildSample(): boolean {
    const clip = this.getClip();
    if (!clip) return false;
    const loop = makeSeamlessLoop(this.ctx, clip.buffer, clip.offset + 0.05, 0.05, 0.2);
    this.src = this.ctx.createBufferSource();
    this.src.buffer = loop.buffer;
    this.src.loop = true;
    this.src.loopEnd = loop.loopEnd;
    this.src.connect(this.lp);
    this.src.start();
    this.norm = clip.norm;
    this.mode = 'sample';
    return true;
  }

  update(on: boolean, warp: number): void {
    if (!this.mode) {
      if (!on) return;
      this.build();
    }
    const t = this.ctx.currentTime;
    if (this.mode === 'synth' && !on && this.gain.gain.value < 0.005 && this.getClip()) {
      // clip decoded since the fallback was built — swap sources in a
      // silent moment
      if (this.buildSample() && this.noiseSrc) {
        this.noiseSrc.stop();
        this.noiseSrc.disconnect();
        this.noiseSrc = null;
      }
    }
    // the swell: cutoff chases its target slowly, so a fresh burn opens up
    this.lp.frequency.setTargetAtTime((on ? 3400 : 380) * warp, t, 0.22);
    const level = this.mode === 'sample' ? 0.32 * this.norm : 0.15;
    this.gain.gain.setTargetAtTime(on ? level : 0, t, on ? 0.09 : 0.16);
    this.subGain.gain.setTargetAtTime(on ? 0.085 : 0, t, on ? 0.09 : 0.16);
    if (this.src) this.src.playbackRate.setTargetAtTime((on ? 1 : 0.85) * warp, t, 0.15);
  }
}
