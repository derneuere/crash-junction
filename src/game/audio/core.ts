// The mix graph + voice engine: AudioContext, the master chain, the reverb
// send, the sample bank, and clip playback. The high-level GameAudio API
// (index.ts) and the synthesized one-shots (one-shots.ts) both drive sound
// through this — it owns everything that touches the WebAudio nodes and the
// live-voice bookkeeping.
//
//   one-shots → [panner] ─┬→ masterIn → slow-mo lowpass → compressor
//   loops ────────────────┘     ↑                              ↓
//   reverb send → convolver ────┘                     masterOut (mute) → out

import { SampleBank, type SampleName } from './samples';
import { makeImpulseResponse, makeNoiseBuffer } from './synths';
import type { PlayOpts, XYZ } from './types';

export class AudioCore {
  ctx: AudioContext | null = null;
  noise: AudioBuffer | null = null;
  masterIn: GainNode | null = null;
  masterOut: GainNode | null = null;
  slowLP: BiquadFilterNode | null = null;
  reverb: ConvolverNode | null = null;
  analyser: AnalyserNode | null = null;
  bank = new SampleBank();

  // live one-shots, re-pitched every frame while time is slowed
  live = new Set<{ src: AudioBufferSourceNode; rate: number }>();
  warp = 1;

  // accumulated audio-frame time (one-shot cooldowns read it)
  now = 0;
  crashVoices = 0;
  lastCrashAt = -1;

  /** Fetch sample bytes — no AudioContext needed, call from the game
   *  constructor so clips are ready by the first gesture. */
  prefetch(): void {
    this.bank.prefetch();
  }

  /** Build the AudioContext + mix graph. Returns false if construction
   *  failed (autoplay policy / unsupported) so the caller can stay silent. */
  build(): boolean {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = (this.ctx = new Ctx());
      this.noise = makeNoiseBuffer(ctx);

      this.masterIn = ctx.createGain();
      this.slowLP = ctx.createBiquadFilter();
      this.slowLP.type = 'lowpass';
      this.slowLP.frequency.value = 20000;
      // gentle: the compressor catches pileup peaks, but a hard ratio
      // would iron the crash-loudness dynamic flat again
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -13;
      comp.knee.value = 20;
      comp.ratio.value = 3.5;
      this.masterOut = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.masterIn.connect(this.slowLP);
      this.slowLP.connect(comp);
      comp.connect(this.masterOut);
      this.masterOut.connect(this.analyser);
      this.analyser.connect(ctx.destination);

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = makeImpulseResponse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      this.reverb.connect(wet);
      wet.connect(this.masterIn);

      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !!this.masterIn && !!this.noise;
  }

  /** Master RMS 0..1 — dev/verification aid. */
  levels(): number {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(d);
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return Math.sqrt(s / d.length);
  }

  /** Decoded clip count — dev/verification aid. */
  samplesLoaded(): number {
    return this.bank.loadedCount();
  }

  panner(pos: XYZ): PannerNode {
    const ctx = this.ctx!;
    const pan = ctx.createPanner();
    pan.panningModel = 'equalpower';
    pan.distanceModel = 'inverse';
    pan.refDistance = 10;
    pan.maxDistance = 220;
    pan.rolloffFactor = 0.9;
    if (pan.positionX) {
      pan.positionX.value = pos.x;
      pan.positionY.value = pos.y;
      pan.positionZ.value = pos.z;
    } else {
      pan.setPosition(pos.x, pos.y, pos.z);
    }
    pan.connect(this.masterIn!);
    return pan;
  }

  /** Play a recorded clip. Returns false when no variant has decoded yet
   *  (callers with a synth fallback use that). */
  play(name: SampleName, o: PlayOpts & { crash?: boolean }): boolean {
    if (!this.ready()) return false;
    try {
      const clip = this.bank.pick(name);
      if (!clip) return false;
      if (this.live.size > 28 && o.gain < 0.3) return true; // full mix — drop the small stuff
      const ctx = this.ctx!;
      const t = ctx.currentTime + (o.delay ?? 0);
      const src = ctx.createBufferSource();
      src.buffer = clip.buffer;
      const rate = o.rate ?? 1;
      src.playbackRate.value = o.noWarp ? rate : rate * this.warp;
      const g = ctx.createGain();
      g.gain.value = o.gain * clip.norm;
      src.connect(g);
      g.connect(o.pos ? this.panner(o.pos) : this.masterIn!);
      if (o.send && this.reverb) {
        const s = ctx.createGain();
        s.gain.value = o.send * o.gain * clip.norm;
        g.connect(s);
        s.connect(this.reverb);
      }
      const entry = { src, rate };
      if (!o.noWarp) this.live.add(entry);
      if (o.crash) this.crashVoices++;
      src.onended = () => {
        this.live.delete(entry);
        if (o.crash) this.crashVoices--;
      };
      src.start(t, clip.offset);
      return true;
    } catch {
      return false;
    }
  }
}
