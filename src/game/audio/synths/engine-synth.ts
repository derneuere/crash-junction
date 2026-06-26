// The fully-synthesized engine voice — the fallback that always plays while
// the recorded clips decode, and the chest/grit recipe the recorded engine
// borrows. Also the shared upshift "whump" + turbo psst.

import { EXHAUST_H, RUMBLE_H, VGEAR_TOPS, startNoise } from './shared';

/** Engine firing frequency across a virtual-gear band (Hz, before slow-mo
 *  warp). Deliberately low — the fundamental lives at 45..160 Hz and the
 *  character comes from the harmonics, not a screaming root note. */
const engineF0 = (vrpm: number): number => 38 + 120 * vrpm * vrpm;

export class EngineSynth {
  private built = false;
  private oscA!: OscillatorNode; // exhaust tone
  private oscB!: OscillatorNode; // block rumble, one octave down
  private oscC!: OscillatorNode; // detuned shimmer an octave up
  private sub!: OscillatorNode; // clean sine under everything — the chest
  private subGain!: GainNode;
  private modOsc!: OscillatorNode; // gates the rasp at the firing rate
  private modDepth!: GainNode;
  private raspVCA!: GainNode;
  private intake!: AudioBufferSourceNode;
  private intakeBp!: BiquadFilterNode;
  private intakeGain!: GainNode;
  private lp!: BiquadFilterNode;
  private gain!: GainNode;
  private drive!: WaveShaperNode;
  private preDrive!: GainNode;
  private lastVGear = 0;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
  ) {}

  private build(): void {
    const ctx = this.ctx;
    const wave = (h: number[]) => ctx.createPeriodicWave(new Float32Array(h.length), new Float32Array(h));
    this.oscA = ctx.createOscillator();
    this.oscA.setPeriodicWave(wave(EXHAUST_H));
    this.oscB = ctx.createOscillator();
    this.oscB.setPeriodicWave(wave(RUMBLE_H));
    this.oscC = ctx.createOscillator();
    this.oscC.type = 'sawtooth';

    // soft-clip the summed tone — the grit that separates an engine from
    // an organ. Drive (preDrive gain) rises with throttle: load = growl.
    this.preDrive = ctx.createGain();
    this.drive = ctx.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < 257; i++) curve[i] = Math.tanh((i / 128 - 1) * 3);
    this.drive.curve = curve;

    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 700;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    // the block outweighs the exhaust; the shimmer is barely a garnish
    const gA = ctx.createGain();
    gA.gain.value = 0.75;
    const gB = ctx.createGain();
    gB.gain.value = 1.2;
    const gC = ctx.createGain();
    gC.gain.value = 0.04;
    this.oscA.connect(gA);
    gA.connect(this.preDrive);
    this.oscB.connect(gB);
    gB.connect(this.preDrive);
    this.oscC.connect(gC);
    gC.connect(this.preDrive);
    this.preDrive.connect(this.drive);
    this.drive.connect(this.lp);
    this.lp.connect(this.gain);
    this.gain.connect(this.out);

    // exhaust rasp: low noise GATED AT THE FIRING RATE (a square into the
    // VCA's gain — audio-rate AM). This is the "blat" that keeps the tone
    // from sounding like an organ pipe; it saturates with the rest.
    const rasp = startNoise(ctx, this.noise);
    const raspLp = ctx.createBiquadFilter();
    raspLp.type = 'lowpass';
    raspLp.frequency.value = 520;
    this.raspVCA = ctx.createGain();
    this.raspVCA.gain.value = 0;
    this.modOsc = ctx.createOscillator();
    this.modOsc.type = 'square';
    this.modDepth = ctx.createGain();
    this.modDepth.gain.value = 0;
    this.modOsc.connect(this.modDepth);
    this.modDepth.connect(this.raspVCA.gain);
    rasp.connect(raspLp);
    raspLp.connect(this.raspVCA);
    this.raspVCA.connect(this.preDrive);

    // clean sub an octave under the exhaust, bypassing the distortion —
    // tanh would eat the fundamental exactly where the bass lives
    this.sub = ctx.createOscillator();
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.55;
    this.sub.connect(this.subGain);
    this.subGain.connect(this.gain);

    // intake hiss: bandpassed noise that opens with the revs (kept faint —
    // it reads "clean" fast)
    this.intake = startNoise(ctx, this.noise);
    this.intakeBp = ctx.createBiquadFilter();
    this.intakeBp.type = 'bandpass';
    this.intakeBp.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intake.connect(this.intakeBp);
    this.intakeBp.connect(this.intakeGain);
    this.intakeGain.connect(this.gain);

    this.oscA.start();
    this.oscB.start();
    this.oscC.start();
    this.sub.start();
    this.modOsc.start();
    this.built = true;
  }

  update(speed: number, vol: number, throttle: boolean, warp: number): void {
    if (!this.built) {
      if (vol <= 0) return; // stay silent (and free) until first needed
      this.build();
    }
    let g = 0;
    while (g < VGEAR_TOPS.length - 1 && speed > VGEAR_TOPS[g]) g++;
    const lo = g === 0 ? 0 : VGEAR_TOPS[g - 1];
    const vrpm = Math.max(0.25, Math.min(1, 0.25 + (0.75 * (speed - lo)) / (VGEAR_TOPS[g] - lo)));

    const t = this.ctx.currentTime;
    const f0 = engineF0(vrpm) * warp;
    this.oscA.frequency.setTargetAtTime(f0, t, 0.04);
    this.oscB.frequency.setTargetAtTime(f0 * 0.5, t, 0.04);
    this.oscC.frequency.setTargetAtTime(f0 * 2.013, t, 0.04);
    this.sub.frequency.setTargetAtTime(f0 * 0.5, t, 0.04);
    this.modOsc.frequency.setTargetAtTime(f0 * 0.5, t, 0.04);
    const rasp = throttle ? 0.42 : 0.18;
    this.raspVCA.gain.setTargetAtTime(rasp * 0.5, t, 0.08);
    this.modDepth.gain.setTargetAtTime(rasp * 0.5, t, 0.08);
    this.preDrive.gain.setTargetAtTime(throttle ? 1.25 : 0.5, t, 0.08);
    this.lp.frequency.setTargetAtTime((420 + 1300 * vrpm) * warp, t, 0.06);
    this.intakeBp.frequency.setTargetAtTime((1100 + 1600 * vrpm) * warp, t, 0.05);
    this.intakeGain.gain.setTargetAtTime(throttle ? 0.02 + 0.04 * vrpm : 0.008 * vrpm, t, 0.1);
    this.gain.gain.setTargetAtTime(vol, t, 0.08);

    if (g > this.lastVGear && vol > 0) this.shiftPop(t, warp);
    this.lastVGear = g;
  }

  /** Upshift: a beat of torque-cut silence (the rpm drop is already in the
   *  pitch signal) plus the exhaust "whump" and a turbo-ish psst. */
  private shiftPop(t: number, warp: number): void {
    const g = this.gain.gain;
    const held = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(held, t);
    g.linearRampToValueAtTime(held * 0.25, t + 0.03);
    g.setTargetAtTime(held, t + 0.09, 0.05);
    playShiftPop(this.ctx, this.out, this.noise, warp);
  }
}

/** The upshift exhaust "whump" + turbo psst — shared by both engines. */
export function playShiftPop(ctx: AudioContext, out: AudioNode, noise: AudioBuffer, warp: number): void {
  const t = ctx.currentTime;
  const pop = ctx.createBufferSource();
  pop.buffer = noise;
  pop.playbackRate.value = 0.7;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 260 * warp;
  bp.Q.value = 1.2;
  const pg = ctx.createGain();
  pg.gain.setValueAtTime(0.16, t);
  pg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  pop.connect(bp);
  bp.connect(pg);
  pg.connect(out);
  pop.start(t, Math.random());
  pop.stop(t + 0.12);

  const psst = ctx.createBufferSource();
  psst.buffer = noise;
  psst.playbackRate.value = 1.6;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3800;
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.035, t);
  sg.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  psst.connect(hp);
  hp.connect(sg);
  sg.connect(out);
  psst.start(t, Math.random());
  psst.stop(t + 0.16);
}
