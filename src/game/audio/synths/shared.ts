// Shared building blocks for the synthesized loop layers: the raw noise
// buffers, the looped-noise source helper, the seamless-loop re-cut used by
// the recorded layers, and the few constants/harmonic recipes that more
// than one layer leans on.

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

export const startNoise = (ctx: AudioContext, buf: AudioBuffer): AudioBufferSourceNode => {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.start();
  return src;
};

// Harmonic recipes (PeriodicWave imag parts). The exhaust wave carries the
// firing-order character — energy bumps at the 4th and 7th harmonics read
// as a big lazy V8; the rumble wave is the block an octave down.
export const EXHAUST_H = [0, 1, 0.62, 0.35, 0.62, 0.28, 0.2, 0.36, 0.12, 0.07, 0.12, 0.04];
export const RUMBLE_H = [0, 1, 0.45, 0.18, 0.07];

// The engine's own VIRTUAL gearbox. The sim shifts its six tight gears in
// under three seconds (gameplay tuning, and pinned by the replay suite) —
// heard literally it's a frantic two-stroke. The note instead saws through
// four wide audio-only bands, so shifts land at a relaxed big-engine
// cadence while the sim keeps its quick torque steps.
export const VGEAR_TOPS = [11, 22, 34, 48]; // m/s ceiling per heard gear

// …and its own ACCELERATION. Mapping the bands onto the raw sim speed
// still machine-gunned every launch — the car is flat-out in under 3 s
// (1.5 s on boost), so all three audible upshifts landed in the first
// couple of seconds. The note instead follows a rate-limited copy of the
// sim speed: it pulls up through the bands at HEARD_ACCEL, each gear
// holding a real rev window, and the last gear only arrives once the car
// has genuinely been flat-out for a while. Downward it chases faster than
// the hardest brake (26 m/s²) so slowing never sounds laggy. Presentation
// only — the sim speed itself is untouched.
export const HEARD_ACCEL = 6.5; // m/s² — heard climb 0→top ~6 s, 0→boost-top ~7.4 s
export const HEARD_DECEL = 30; // m/s²

/** Carve a seamless loop out of a one-shot recording: copy a region and
 *  crossfade the tail onto the head, so wrapping at loopEnd lands on
 *  blended material instead of a click. */
export function makeSeamlessLoop(
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
