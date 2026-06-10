// Tiny synthesized audio — crash thumps and explosion booms.
// Pitch follows the slow-mo timescale.

export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: DynamicsCompressorNode | null = null;
  private engA: OscillatorNode | null = null;
  private engB: OscillatorNode | null = null;
  private engGain: GainNode | null = null;

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
    } catch {
      this.ctx = null;
    }
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
        this.engGain.connect(this.master);
        this.engA.start();
        this.engB.start();
      }
      const t = ctx.currentTime;
      const f0 = 62 * (1 + 2.5 * rpm);
      this.engA.frequency.setTargetAtTime(f0, t, 0.03);
      this.engB!.frequency.setTargetAtTime(f0 * 0.5, t, 0.03);
      this.engGain!.gain.setTargetAtTime(vol, t, 0.08);
    } catch {
      /* audio is best-effort */
    }
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
