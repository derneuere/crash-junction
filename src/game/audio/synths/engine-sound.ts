// The real-recording engine voice: steady RPM holds looped and crossfaded
// across the virtual-gear band, with a selectable recording FLAVOR and a
// synth fallback (EngineSynth) while the clips decode.

import { HEARD_ACCEL, HEARD_DECEL, VGEAR_TOPS, makeSeamlessLoop } from './shared';
import { EngineSynth, playShiftPop } from './engine-synth';

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
  private heardSpeed = 0; // rate-limited copy of the sim speed (HEARD_ACCEL)
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

  update(speed: number, vol: number, throttle: boolean, warp: number, dt: number): void {
    // the heard gearbox pulls, it doesn't teleport: chase the sim speed
    // under the rate limits, and feed the result to whichever voice plays
    const d = speed - this.heardSpeed;
    this.heardSpeed += Math.max(-HEARD_DECEL * dt, Math.min(HEARD_ACCEL * dt, d));
    const heard = this.heardSpeed;

    if (!this.built && (vol <= 0 || !this.tryBuild())) {
      this.synth.update(heard, vol, throttle, warp);
      return;
    }
    // sampler active — if the synth fallback ever sounded, this fades it out
    this.synth.update(heard, 0, false, warp);

    let g = 0;
    while (g < VGEAR_TOPS.length - 1 && heard > VGEAR_TOPS[g]) g++;
    const lo = g === 0 ? 0 : VGEAR_TOPS[g - 1];
    const vrpm = Math.max(0.25, Math.min(1, 0.25 + (0.75 * (heard - lo)) / (VGEAR_TOPS[g] - lo)));

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
