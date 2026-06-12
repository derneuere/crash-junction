// Tiny synthesized audio — crash thumps and explosion booms — plus real
// engine loops sampled from AngeTheGreat's engine simulator (see
// public/sounds/ENGINE_SOURCES.md). Pitch follows the slow-mo timescale.

export type EngineFlavor = 'v10' | 'v8';

/** A seamless engine loop: url + the fundamental it was recorded at.
 *  Decoded buffers are cached module-wide (AudioBuffers are context-free,
 *  so they survive Game remounts). */
interface EngineLayer {
  url: string;
  f0: number;
  buffer?: AudioBuffer;
}

interface EngineSpec {
  layers: EngineLayer[];
  fLo: number; // perceived fundamental at rpm 0 …
  fHi: number; // … and at rpm 1
}

const ENGINES: Record<EngineFlavor, EngineSpec> = {
  // V10: lumpy idle + steady high-rev loop, crossfaded across the band
  v10: {
    layers: [
      { url: '/sounds/engine_v10_low.wav', f0: 47.5 },
      { url: '/sounds/engine_v10_high.wav', f0: 90 },
    ],
    fLo: 46,
    fHi: 120,
  },
  // V8: one rumbly loop swept across the whole rev range
  v8: {
    layers: [{ url: '/sounds/engine_v8.wav', f0: 46 }],
    fLo: 44,
    fHi: 96,
  },
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: DynamicsCompressorNode | null = null;
  private engA: OscillatorNode | null = null;
  private engB: OscillatorNode | null = null;
  private engGain: GainNode | null = null;
  private engFlavor: EngineFlavor = 'v10';
  private engSrcs: { src: AudioBufferSourceNode; gain: GainNode; f0: number }[] = [];
  private smpGain: GainNode | null = null;

  /** Call from a user gesture (autoplay policy). Safe to call repeatedly. */
  init(): void {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      this.master = this.ctx.createDynamicsCompressor();
      this.master.connect(this.ctx.destination);
      void this.loadEngines();
    } catch {
      this.ctx = null;
    }
  }

  /** Fetch + decode the engine loops; until they land (or if they fail,
   *  e.g. offline) engine() keeps the synth fallback. */
  private async loadEngines(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    await Promise.all(
      Object.values(ENGINES)
        .flatMap((spec) => spec.layers)
        .filter((layer) => !layer.buffer)
        .map(async (layer) => {
          try {
            const res = await fetch(layer.url);
            layer.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
          } catch {
            /* missing file → the synth engine keeps running */
          }
        }),
    );
  }

  /** Which recorded engine the player's car runs. Pure audio — the sim,
   *  and so replay determinism, never sees it. */
  setEngineFlavor(f: EngineFlavor): void {
    if (f === this.engFlavor) return;
    this.engFlavor = f;
    for (const l of this.engSrcs) {
      try {
        l.src.stop();
      } catch {
        /* already stopped */
      }
      l.gain.disconnect();
    }
    this.engSrcs = []; // engine() rebuilds from the new flavor's loops
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume();
  }

  /** Continuous engine loop — call every frame. rpm 0..1 (within the
   *  current gear band, so the pitch saws through each gear and drops on
   *  every upshift); vol 0 fades it out. */
  engine(rpm: number, vol: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.master) return;
    try {
      const spec = ENGINES[this.engFlavor];
      if (spec.layers.every((l) => l.buffer)) this.sampleEngine(ctx, spec, rpm, vol);
      else this.synthEngine(ctx, rpm, vol);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Recorded loops: sweep the perceived fundamental log-linearly with
   *  rpm; each layer pitch-shifts toward the target and the layers
   *  crossfade (equal-power) by log-pitch distance. */
  private sampleEngine(ctx: AudioContext, spec: EngineSpec, rpm: number, vol: number): void {
    if (!this.smpGain) {
      this.smpGain = ctx.createGain();
      this.smpGain.gain.value = 0;
      this.smpGain.connect(this.master!);
    }
    if (!this.engSrcs.length) {
      for (const layer of spec.layers) {
        const src = ctx.createBufferSource();
        src.buffer = layer.buffer!;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(this.smpGain);
        src.start();
        this.engSrcs.push({ src, gain, f0: layer.f0 });
      }
    }
    const t = ctx.currentTime;
    this.engGain?.gain.setTargetAtTime(0, t, 0.05); // hand over from the synth
    const target = spec.fLo * Math.pow(spec.fHi / spec.fLo, Math.min(1, Math.max(0, rpm)));
    let total = 0;
    const w: number[] = [];
    for (const l of this.engSrcs) {
      const wi =
        this.engSrcs.length === 1
          ? 1
          : Math.max(0.0001, 1 - Math.abs(Math.log2(target / l.f0)) / 1.2);
      w.push(wi);
      total += wi;
    }
    for (let i = 0; i < this.engSrcs.length; i++) {
      const l = this.engSrcs[i];
      const rate = Math.min(2.5, Math.max(0.5, target / l.f0));
      l.src.playbackRate.setTargetAtTime(rate, t, 0.03);
      l.gain.gain.setTargetAtTime(Math.sqrt(w[i] / total), t, 0.06);
    }
    // loops are loudness-normalized well below the raw oscillators —
    // scale vol so both paths sit at a comparable level
    this.smpGain.gain.setTargetAtTime(vol * 2.5, t, 0.08);
  }

  /** Oscillator fallback while the loops load (or if they never do). */
  private synthEngine(ctx: AudioContext, rpm: number, vol: number): void {
    if (!this.engA) {
      this.engA = ctx.createOscillator();
      this.engA.type = 'sawtooth';
      this.engB = ctx.createOscillator();
      this.engB.type = 'square';
      this.engGain = ctx.createGain();
      this.engGain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 850;
      this.engA.connect(lp);
      this.engB.connect(lp);
      lp.connect(this.engGain);
      this.engGain.connect(this.master!);
      this.engA.start();
      this.engB.start();
    }
    const t = ctx.currentTime;
    const f0 = 62 * (1 + 2.5 * rpm);
    this.engA.frequency.setTargetAtTime(f0, t, 0.03);
    this.engB!.frequency.setTargetAtTime(f0 * 0.5, t, 0.03);
    this.engGain!.gain.setTargetAtTime(vol, t, 0.08);
  }

  thump(intensity: number, timeScale: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.noise || !this.master) return;
    try {
      const t = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.min(0.45, intensity / 26), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.45 + 0.55 * timeScale;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 500 + Math.random() * 900;
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);

      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(85, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.3);
      const og = ctx.createGain();
      og.gain.setValueAtTime(Math.min(0.35, intensity / 30), t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(og);
      og.connect(this.master);
      o.start(t);
      o.stop(t + 0.4);
    } catch {
      /* audio is best-effort */
    }
  }

  /** Bright two-note chime for pickups. */
  ding(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.master) return;
    try {
      const t = ctx.currentTime;
      for (const [freq, at] of [
        [880, 0],
        [1318, 0.07],
      ] as const) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.16, t + at);
        g.gain.exponentialRampToValueAtTime(0.001, t + at + 0.28);
        o.connect(g);
        g.connect(this.master);
        o.start(t + at);
        o.stop(t + at + 0.3);
      }
    } catch {
      /* audio is best-effort */
    }
  }

  boom(power: number, timeScale: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.noise || !this.master) return;
    try {
      const t = ctx.currentTime;

      // sub drop
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(24, t + 0.8);
      const og = ctx.createGain();
      og.gain.setValueAtTime(Math.min(0.9, 0.35 + 0.18 * power), t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      o.connect(og);
      og.connect(this.master);
      o.start(t);
      o.stop(t + 1.1);

      // body rumble: the 0.5s noise buffer stretched low
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.22 + 0.5 * timeScale;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(320 + 140 * power, t);
      f.frequency.exponentialRampToValueAtTime(90, t + 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.min(1, 0.5 + 0.25 * power), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t);

      // crack transient
      const src2 = ctx.createBufferSource();
      src2.buffer = this.noise;
      src2.playbackRate.value = 1.4;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200;
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.3, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      src2.connect(hp);
      hp.connect(g2);
      g2.connect(this.master);
      src2.start(t);
    } catch {
      /* audio is best-effort */
    }
  }
}
