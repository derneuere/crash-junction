// Synthesized continuous layers: the engine note, the drift squeal, the
// boost afterburner and wind-at-speed. Loops want exact pitch control over
// a continuous rpm/slip range, which one-shot recordings can't give — so
// these stay synthesized while the impacts (samples.ts) come from
// recordings. Everything is built lazily on first use and updated once per
// rendered frame with smoothed AudioParam targets.

import type { Actor } from '../types';

/** 2 s of looped white noise — the raw material for every noise layer. */
export function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Procedural impulse response: a short city-street slapback for the
 *  reverb send — noise with a fast exponential decay, slightly darker in
 *  the tail. Makes explosions ring off the buildings. */
export function makeImpulseResponse(ctx: AudioContext): AudioBuffer {
  const dur = 1.6;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const decay = Math.pow(1 - t, 2.4);
      // one-pole lowpass that closes over time — high end dies first
      const k = 0.25 + 0.6 * t;
      lp += ((Math.random() * 2 - 1) - lp) * (1 - k);
      d[i] = lp * decay * 0.9;
    }
  }
  return buf;
}

const startNoise = (ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode => {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start();
  return src;
};

// ---------------------------------------------------------------------------
// engine

// Harmonic recipes (PeriodicWave imag parts). The exhaust wave carries the
// firing-order character — energy bumps at the 4th and 7th harmonics read
// as a big lazy V8; the rumble wave is the block an octave down.
const EXHAUST_H = [0, 1, 0.62, 0.35, 0.62, 0.28, 0.2, 0.36, 0.12, 0.07, 0.12, 0.04];
const RUMBLE_H = [0, 1, 0.45, 0.18, 0.07];

// The engine's own VIRTUAL gearbox. The sim shifts its six tight gears in
// under three seconds (gameplay tuning, and pinned by the replay suite) —
// heard literally it's a frantic two-stroke. The note instead saws through
// four wide audio-only bands, so shifts land at a relaxed big-engine
// cadence while the sim keeps its quick torque steps.
const VGEAR_TOPS = [11, 22, 34, 48]; // m/s ceiling per heard gear

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
function playShiftPop(ctx: AudioContext, out: AudioNode, noise: AudioBuffer, warp: number): void {
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

// ---------------------------------------------------------------------------
// recorded engine

interface EngineClip {
  buffer: AudioBuffer;
  offset: number;
  norm: number;
}

/** RPM layers: each recorded hold owns a band of the virtual-rpm range
 *  ([fade-in start/end, fade-out start/end]) and bends ±~25% inside it.
 *  Crossfades are equal-power; the recordings come from ONE onboard take,
 *  so the timbre matches across the seams. */
const ENGINE_LAYERS = [
  { name: 'engine_low' as const, fade: [0, 0, 0.38, 0.58] as const, rate: (v: number) => 0.85 + 1.0 * (v - 0.25) },
  { name: 'engine_mid' as const, fade: [0.38, 0.58, 0.72, 0.88] as const, rate: (v: number) => 0.78 + 0.85 * (v - 0.38) },
  { name: 'engine_high' as const, fade: [0.72, 0.88, 9, 9] as const, rate: (v: number) => 0.8 + 0.9 * (v - 0.72) },
];

type EngineLayerName = (typeof ENGINE_LAYERS)[number]['name'];

/** Selectable engine voices, all feeding the same virtual gearbox.
 *
 *  Two layer models, because the recordings differ in kind:
 *  - 'banded' (STOCK): three RPM holds cut from one onboard take; each
 *    layer OWNS a band of the vrpm range (fade windows above) and bends
 *    only ±~25%, so no clip ever strays far from its native pitch.
 *  - 'swept' (V10/V8, sampled from AngeTheGreat's engine simulator — see
 *    public/sounds/ENGINE_SOURCES.md): one or two flat-pitch holds with a
 *    known fundamental f0. The perceived fundamental sweeps log-linearly
 *    fLo→fHi across the band and every layer pitch-chases that target,
 *    crossfaded (equal-power) by log2-pitch distance — fewer recordings,
 *    wider bends.
 *  Swept loops ship as 24 kHz mono WAV with the seam crossfade baked in
 *  (mp3 encoder padding breaks gapless decodeAudioData loops), so they
 *  loop raw — no makeSeamlessLoop re-cut, which would eat the baked seam. */
const ENGINE_FLAVORS = {
  stock: { kind: 'banded' } as const,
  v10: {
    kind: 'swept' as const,
    fLo: 31,
    fHi: 120,
    layers: [
      { name: 'engine_v10_low' as const, f0: 30.2 },
      { name: 'engine_v10_high' as const, f0: 90.3 },
    ],
  },
  v8: {
    kind: 'swept' as const,
    fLo: 44,
    fHi: 96,
    layers: [{ name: 'engine_v8' as const, f0: 47.7 }],
  },
};

export type EngineFlavor = keyof typeof ENGINE_FLAVORS;

type EngineClipName =
  | EngineLayerName
  | (typeof ENGINE_FLAVORS.v10.layers)[number]['name']
  | (typeof ENGINE_FLAVORS.v8.layers)[number]['name'];

const layerWeight = (v: number, [a, b, c, d]: readonly [number, number, number, number]): number => {
  if (v <= a) return 0;
  if (v < b) return (v - a) / (b - a);
  if (v <= c) return 1;
  if (v < d) return 1 - (v - c) / (d - c);
  return 0;
};

/** The real-recording engine: steady RPM holds looped seamlessly and
 *  crossfaded/pitch-bent across the virtual-gear band, with a clean synth
 *  sub underneath for chest. The recording set is a selectable FLAVOR
 *  (ENGINE_FLAVORS) — switching stops the running loop sources and
 *  rebuilds from the new set on the next frame, no AudioContext rebuild.
 *  Falls back to (and upgrades from) the EngineSynth while clips decode. */
export class EngineSound {
  private synth: EngineSynth;
  private built = false;
  private flavor: EngineFlavor = 'stock';
  private layers: { src: AudioBufferSourceNode; gain: GainNode; norm: number }[] = [];
  private lp: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  private sub!: OscillatorNode;
  private lastVGear = 0;

  constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private noise: AudioBuffer,
    private getClip: (name: EngineClipName | 'shift') => EngineClip | null,
  ) {
    this.synth = new EngineSynth(ctx, out, noise);
  }

  /** Swap the recording set. Presentation only — the sim never sees it. */
  setFlavor(f: EngineFlavor): void {
    if (f === this.flavor) return;
    this.flavor = f;
    if (!this.built) return; // nothing running — the next build reads this.flavor
    // stop the old loops; the shared lp/gain/sub graph stays up, so the
    // next update() rebuilds layers from the new set without a gap (or
    // hands back to the synth if the new clips are still decoding)
    for (const l of this.layers) {
      try {
        l.src.stop();
      } catch {
        /* already stopped */
      }
      l.src.disconnect();
      l.gain.disconnect();
    }
    this.layers = [];
    this.built = false;
    // the sub oscillator shares the persistent output gain — duck it so
    // it can't drone alone if the new flavor's clips are still decoding
    this.gain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  /** Upshift exhale: the recorded blow-off "pssht" (synth pop while the
   *  clips are still decoding). */
  private playShift(warp: number): void {
    const clip = this.getClip('shift');
    if (!clip) {
      playShiftPop(this.ctx, this.out, this.noise, warp);
      return;
    }
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.playbackRate.value = (0.92 + Math.random() * 0.2) * warp;
    const g = ctx.createGain();
    g.gain.value = 0.4 * clip.norm;
    src.connect(g);
    g.connect(this.out);
    src.start(ctx.currentTime, clip.offset);
  }

  private tryBuild(): boolean {
    const spec = ENGINE_FLAVORS[this.flavor];
    const names: EngineClipName[] = spec.kind === 'banded' ? ENGINE_LAYERS.map((l) => l.name) : spec.layers.map((l) => l.name);
    const clips = names.map((n) => this.getClip(n));
    if (clips.some((c) => !c)) return false;
    const ctx = this.ctx;
    if (!this.gain || !this.lp) {
      // the shared tail of the graph survives flavor swaps — only the
      // loop sources are per-flavor
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.lp = ctx.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 1500;
      this.lp.connect(this.gain);
      this.gain.connect(this.out);
      this.sub = ctx.createOscillator();
      const subG = ctx.createGain();
      subG.gain.value = 0.32;
      this.sub.connect(subG);
      subG.connect(this.gain);
      this.sub.start();
    }
    for (const clip of clips as EngineClip[]) {
      const src = ctx.createBufferSource();
      if (spec.kind === 'banded') {
        // generous 0.25 s seam — engine cycles are long, short seams thump
        const loop = makeSeamlessLoop(ctx, clip.buffer, clip.offset + 0.05, 0.05, 0.25);
        src.buffer = loop.buffer;
        src.loopEnd = loop.loopEnd;
      } else {
        src.buffer = clip.buffer; // WAV loops arrive seamless — play raw
      }
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(this.lp);
      src.start();
      this.layers.push({ src, gain: g, norm: clip.norm });
    }
    this.built = true;
    return true;
  }

  update(speed: number, vol: number, throttle: boolean, warp: number): void {
    if (!this.built && (vol <= 0 || !this.tryBuild())) {
      this.synth.update(speed, vol, throttle, warp);
      return;
    }
    // sampler active — if the synth fallback ever sounded, this fades it out
    this.synth.update(speed, 0, false, warp);

    let g = 0;
    while (g < VGEAR_TOPS.length - 1 && speed > VGEAR_TOPS[g]) g++;
    const lo = g === 0 ? 0 : VGEAR_TOPS[g - 1];
    const vrpm = Math.max(0.25, Math.min(1, 0.25 + (0.75 * (speed - lo)) / (VGEAR_TOPS[g] - lo)));

    const t = this.ctx.currentTime;
    const spec = ENGINE_FLAVORS[this.flavor];
    let subF0: number;
    if (spec.kind === 'banded') {
      for (let i = 0; i < ENGINE_LAYERS.length; i++) {
        const def = ENGINE_LAYERS[i];
        const layer = this.layers[i];
        const w = Math.sin(layerWeight(vrpm, def.fade) * Math.PI * 0.5); // equal-power
        layer.gain.gain.setTargetAtTime(w * layer.norm, t, 0.07);
        layer.src.playbackRate.setTargetAtTime(def.rate(vrpm) * warp, t, 0.05);
      }
      subF0 = 38 + 120 * vrpm * vrpm; // the synth-engine formula — same chest
    } else {
      // perceived fundamental sweeps log-linearly across the band; each
      // layer chases it and the blend leans toward whichever recording
      // needs the smaller bend
      const target = spec.fLo * Math.pow(spec.fHi / spec.fLo, (vrpm - 0.25) / 0.75);
      const w = spec.layers.map((l) => Math.max(0.0001, 1 - Math.abs(Math.log2(target / l.f0))));
      const total = w.reduce((a, b) => a + b, 0);
      for (let i = 0; i < spec.layers.length; i++) {
        const layer = this.layers[i];
        const rate = Math.min(2.5, Math.max(0.5, target / spec.layers[i].f0));
        layer.gain.gain.setTargetAtTime(Math.sqrt(w[i] / total) * layer.norm, t, 0.07);
        layer.src.playbackRate.setTargetAtTime(rate * warp, t, 0.05);
      }
      subF0 = target; // the recording's actual fundamental — keep them fused
    }
    // off-throttle the engine breathes through a closed box
    this.lp!.frequency.setTargetAtTime((throttle ? 4200 : 1400) * warp, t, 0.15);
    this.sub.frequency.setTargetAtTime(subF0 * 0.5 * warp, t, 0.04);
    this.gain!.gain.setTargetAtTime(vol, t, 0.08);

    if (g > this.lastVGear && vol > 0) {
      // torque-cut dip + the blow-off exhale
      const held = this.gain!.gain.value;
      this.gain!.gain.cancelScheduledValues(t);
      this.gain!.gain.setValueAtTime(held, t);
      this.gain!.gain.linearRampToValueAtTime(held * 0.3, t + 0.03);
      this.gain!.gain.setTargetAtTime(vol, t + 0.09, 0.05);
      this.playShift(warp);
    }
    this.lastVGear = g;
  }
}

// ---------------------------------------------------------------------------
// traffic engines

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

// ---------------------------------------------------------------------------
// drift squeal

/** Carve a seamless loop out of a one-shot recording: copy a region and
 *  crossfade the tail onto the head, so wrapping at loopEnd lands on
 *  blended material instead of a click. */
function makeSeamlessLoop(
  ctx: AudioContext,
  src: AudioBuffer,
  start: number,
  tailTrim: number,
  xfade: number,
): { buffer: AudioBuffer; loopEnd: number } {
  const sr = src.sampleRate;
  const s0 = Math.min(Math.floor(start * sr), src.length - 1);
  const n = Math.max(0, src.length - Math.floor(tailTrim * sr) - s0);
  const xf = Math.floor(xfade * sr);
  if (n <= xf * 2) return { buffer: src, loopEnd: src.duration }; // too short to seam — loop raw
  const buffer = ctx.createBuffer(1, n, sr);
  const d = buffer.getChannelData(0);
  const a = src.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = a[s0 + i];
  for (let i = 0; i < xf; i++) {
    const w = i / xf;
    d[i] = d[i] * w + d[n - xf + i] * (1 - w);
  }
  return { buffer, loopEnd: (n - xf) / sr };
}

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

// ---------------------------------------------------------------------------
// boost afterburner

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

// ---------------------------------------------------------------------------
// wind

/** Wind-at-speed: broadband rush that fades in past ~18 m/s. Quiet, but
 *  it's most of what "fast" sounds like between engine notes. */
export class WindLoop {
  private built = false;
  private hp!: BiquadFilterNode;
  private gain!: GainNode;

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
    this.hp.frequency.value = 350;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2800;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    src.connect(this.hp);
    this.hp.connect(lp);
    lp.connect(this.gain);
    this.gain.connect(this.out);
    this.built = true;
  }

  update(speed: number, boosting: boolean, warp: number): void {
    const target = Math.max(0, Math.min(1, (speed - 18) / 26));
    if (!this.built) {
      if (target <= 0) return;
      this.build();
    }
    const t = this.ctx.currentTime;
    this.hp.frequency.setTargetAtTime((350 + 500 * target) * warp, t, 0.1);
    this.gain.gain.setTargetAtTime(target * (boosting ? 0.085 : 0.055), t, 0.12);
  }
}
