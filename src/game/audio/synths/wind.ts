// Wind-at-speed: the broadband rush that fades in past ~20 m/s and keeps
// climbing through boost — most of what "fast" sounds like between engine
// notes.

import { startNoise } from './shared';

/** Wind-at-speed (sense-of-speed A4): broadband rush that fades in past
 *  ~20 m/s and keeps climbing through boost — it's most of what "fast"
 *  sounds like between engine notes. The old linear curve topped out at
 *  44 m/s and peaked at a whisper, so flat-out and cruise sounded alike.
 *  Reshape: gain 0.09·((v−14)/34)^1.6 (×1.5 boosting), the highpass swept
 *  300→950 Hz, a 0.5–2 Hz ±15 % gain LFO for buffeting, and a thin
 *  boost-only "air-tear" band (1.2–2.4 kHz) above 40 m/s. */
export class WindLoop {
  private built = false;
  private hp!: BiquadFilterNode;
  private gain!: GainNode;
  private lfo!: OscillatorNode;
  private lfoGain!: GainNode;
  private tear!: BiquadFilterNode;
  private tearGain!: GainNode;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
  ) {}

  private build(): void {
    const ctx = this.ctx;
    const src = startNoise(ctx, this.noise);
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 300;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2800;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    src.connect(this.hp);
    this.hp.connect(lp);
    lp.connect(this.gain);
    this.gain.connect(this.out);
    // buffeting: a slow sine ADDS onto the gain AudioParam (audio-rate
    // modulation), so the rush gusts instead of holding a flat shelf.
    // Depth tracks the base gain, so the sum can never swing negative.
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.5;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.gain.gain);
    this.lfo.start();
    // air-tear: a narrow band of the same noise well above the rush —
    // the windscreen-edge scream that only exists at boost speeds
    this.tear = ctx.createBiquadFilter();
    this.tear.type = 'bandpass';
    this.tear.frequency.value = 1200;
    this.tear.Q.value = 1.4;
    this.tearGain = ctx.createGain();
    this.tearGain.gain.value = 0;
    src.connect(this.tear);
    this.tear.connect(this.tearGain);
    this.tearGain.connect(this.out);
    this.built = true;
  }

  update(speed: number, boosting: boolean, warp: number): void {
    // onset 14 m/s, full at 48: exponent 1.6 keeps town speeds quiet and
    // makes the last 10 m/s audibly count (the A1 FOV curve's audio twin)
    const t01 = Math.max(0, Math.min(1, (speed - 14) / 34));
    const target = 0.09 * Math.pow(t01, 1.6) * (boosting ? 1.5 : 1);
    if (!this.built) {
      if (target <= 0) return;
      this.build();
    }
    const t = this.ctx.currentTime;
    this.hp.frequency.setTargetAtTime((300 + 650 * t01) * warp, t, 0.1);
    this.gain.gain.setTargetAtTime(target, t, 0.12);
    // gusts quicken and deepen with speed: 0.5→2 Hz, ±15 % of the base gain
    this.lfo.frequency.setTargetAtTime(0.5 + 1.5 * t01, t, 0.2);
    this.lfoGain.gain.setTargetAtTime(0.15 * target, t, 0.2);
    const tearT = Math.max(0, Math.min(1, (speed - 40) / 8));
    this.tear.frequency.setTargetAtTime((1200 + 1200 * tearT) * warp, t, 0.15);
    this.tearGain.gain.setTargetAtTime(boosting ? 0.035 * tearT : 0, t, 0.15);
  }
}
