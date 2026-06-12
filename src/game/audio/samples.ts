// Internet-sourced one-shots (public/sounds/, CC0 except the engine-sim
// flavor WAVs — see LICENSES.md there for the provenance of every file).
//
// Clips are analyzed at decode time: leading silence is skipped via a
// per-clip start offset and the peak is measured for a normalization
// gain — so manifest mix levels are absolute, and a quietly-mastered
// source recording can't sink (or a hot one blow out) the mix.

export interface Clip {
  buffer: AudioBuffer;
  offset: number; // first audible sample (s) — playback starts here
  norm: number; // gain that brings the clip's peak to 1.0
}

const MANIFEST = {
  crash_big: ['crash_big_0.mp3', 'crash_big_1.mp3', 'crash_big_2.mp3'],
  crash_med: ['crash_med_0.mp3', 'crash_med_1.mp3', 'crash_med_2.mp3', 'crash_med_3.mp3'],
  hit: ['hit_0.mp3', 'hit_1.mp3', 'hit_2.mp3'],
  clank: ['clank_0.mp3', 'clank_1.mp3', 'clank_2.mp3', 'clank_3.mp3', 'clank_4.mp3'],
  glass: ['glass_0.mp3', 'glass_1.mp3', 'glass_2.mp3'],
  boom: ['boom_0.mp3', 'boom_1.mp3', 'boom_2.mp3'],
  boom_sub: ['explosion_sub.mp3'],
  explosion_big: ['explosion_big.mp3'],
  skid: ['skid_0.mp3', 'skid_1.mp3'],
  horn: ['horn_0.mp3', 'horn_1.mp3'],
  kaching: ['kaching.mp3'],
  whoosh: ['whoosh_0.mp3', 'whoosh_1.mp3'],
  // steady-state loops (synths.ts bakes seamless loop buffers from these):
  // three RPM holds cut from one onboard recording + a rocket-thrust roar
  engine_low: ['engine_low.mp3'],
  engine_mid: ['engine_mid.mp3'],
  engine_high: ['engine_high.mp3'],
  // V10/V8 engine flavors (synths.ts ENGINE_FLAVORS), sampled from
  // AngeTheGreat's engine simulator — see ENGINE_SOURCES.md alongside the
  // files. Deliberately WAV: the seam crossfade is baked in and mp3
  // encoder padding would break gapless decodeAudioData looping.
  engine_v10_low: ['engine_v10_low.wav'],
  engine_v10_high: ['engine_v10_high.wav'],
  engine_v8: ['engine_v8.wav'],
  boost_loop: ['boost_loop.mp3'],
  shift: ['shift_0.mp3', 'shift_1.mp3', 'shift_2.mp3'],
} as const;

export type SampleName = keyof typeof MANIFEST;

const SILENCE = 0.04; // of peak — below this is "leading silence"

function analyze(buffer: AudioBuffer): Clip {
  const d = buffer.getChannelData(0);
  let peak = 1e-4;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
  }
  const floor = peak * SILENCE;
  let start = 0;
  while (start < d.length && Math.abs(d[start]) < floor) start++;
  return { buffer, offset: start / buffer.sampleRate, norm: Math.min(4, 1 / peak) };
}

export class SampleBank {
  private clips = new Map<string, Clip[]>();
  private bytes = new Map<string, Promise<ArrayBuffer | null>>();
  private decoding = false;

  /** Fetch the raw files — needs no AudioContext, so this can run from the
   *  constructor, well before the first user gesture. Best-effort: a 404
   *  or offline dev box just means that clip stays on its synth fallback. */
  prefetch(): void {
    if (this.bytes.size) return;
    for (const files of Object.values(MANIFEST)) {
      for (const f of files) {
        this.bytes.set(
          f,
          fetch(`sounds/${f}`)
            .then((r) => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null),
        );
      }
    }
  }

  /** Decode everything against the (possibly still suspended) context. */
  decode(ctx: AudioContext): void {
    if (this.decoding) return;
    this.decoding = true;
    this.prefetch();
    for (const [name, files] of Object.entries(MANIFEST)) {
      const list: Clip[] = [];
      this.clips.set(name, list);
      files.forEach((f, i) => {
        void this.bytes.get(f)?.then(async (raw) => {
          if (!raw) return;
          try {
            const buffer = await ctx.decodeAudioData(raw.slice(0));
            list[i] = analyze(buffer);
          } catch {
            /* undecodable clip — synth fallback covers it */
          }
        });
      });
    }
  }

  /** Random loaded variant, or null while still loading / failed. */
  pick(name: SampleName): Clip | null {
    const list = this.clips.get(name);
    if (!list?.length) return null;
    const i = Math.floor(Math.random() * list.length);
    // decode order is arbitrary — scan from the rolled index for any hit
    for (let k = 0; k < list.length; k++) {
      const c = list[(i + k) % list.length];
      if (c) return c;
    }
    return null;
  }

  /** How many clips decoded so far (dev/verification aid). */
  loadedCount(): number {
    let n = 0;
    for (const list of this.clips.values()) for (const c of list) if (c) n++;
    return n;
  }
}
