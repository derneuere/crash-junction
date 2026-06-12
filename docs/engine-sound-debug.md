# Engine-sound pipeline debugging

> **2026-06-12, culprit found:** `lockRpm` still sounded weird → the RPM
> sweep was baked into the loop files themselves. The demos accelerate /
> decelerate almost everywhere; the first cut windows rode those sweeps
> (the V8 one sat right on the 25–32s crest of its demo). All loops were
> re-cut from spectrogram-verified flat holds (V8 = the 13–25s maintained
> cruise, V10 = held revs + the settled tail idle). Lesson: a "steady"
> verdict from a drifting-tolerance pitch tracker is not steady — fit a
> line and demand <1%/s, and read the harmonic ladder on a
> `showspectrumpic` render before cutting.

The recorded V10/V8 engines pass through these stages, in order. Each one
can be bypassed at runtime to find which is hurting the sound:

| # | stage                                | bypass switch                  |
| - | ------------------------------------ | ------------------------------ |
| 1 | loop cut + seam crossfade            | `playReference()` (skips all)  |
| 2 | 24 kHz mono downsample               | `engineDebug.hifi = true`      |
| 3 | rpm → pitch sweep (playbackRate)     | `engineDebug.lockRate = true`  |
| 4 | V10 two-layer crossfade              | `engineDebug.soloLayer = 0/1`  |
| 5 | ×2.5 level into the master compressor| `engineDebug.gainScale = 1`    |
| 6 | master DynamicsCompressor (12:1!)    | `engineDebug.bypassCompressor` |

(The loudness normalization (−16 LUFS) is baked into the loop files and not
switchable — judge it by comparing a `lockRate` loop against the reference.)

All switches live on `__game.audio` in the browser console and apply on the
next frame — no reload. `lockRpm`/`lockVol` let you audition while parked at
the idle screen (engine volume is otherwise 0 there).

## Listening recipe

Open the console on the idle screen (after one click, so audio is running):

```js
const a = __game.audio, d = a.engineDebug;

// 0. ground truth — the untouched demo cut, straight to the speakers
a.playReference();        // current flavor ('v10' / 'v8' arg to force one)
a.stopReference();

// 1. the loop itself, native pitch, parked (no sweep, no sim volume)
d.lockVol = 0.12; d.lockRpm = 0.3; d.lockRate = true;
//    → bad here = the cut/seam or the normalization. Compare vs reference.

// 2. pitch-shift damage: re-enable the sweep and walk the band
d.lockRate = false;
d.lockRpm = 0.0;  // then 0.3, 0.7, 1.0 — where does it turn nasty?

// 3. V10 layer blend: listen to each loop alone, then both at full
d.soloLayer = 0;          // idle loop only
d.soloLayer = 1;          // high loop only
d.soloLayer = null; d.noCrossfade = true;   // both, no weighting
d.noCrossfade = false;

// 4. format: 48 kHz stereo loops instead of 24 kHz mono
d.hifi = true;            // ears only — toggle back and forth

// 5/6. dynamics: drop the level into the compressor, then skip it entirely
d.gainScale = 1.0;        // quieter but uncompressed character?
d.bypassCompressor = true;

// reset everything
Object.assign(d, { lockRpm: null, lockVol: null, lockRate: false,
  soloLayer: null, noCrossfade: false, bypassCompressor: false,
  gainScale: 2.5, hifi: false });
```

Then drive a lap with the single most-suspect stage disabled and confirm.

## Prior suspicion ranking

1. **Pitch sweep (3)** — the V8 plays up to 2.1× native, the V10 idle up to
   2.5×; resampled engines turn buzzy fast, and the per-gear rpm saw means
   the pitch is almost never at 1.0.
2. **Master compressor (6)** — browser default is threshold −24 dB, ratio
   12:1; the engine sits above threshold constantly, so it gets ironed
   flat and pumps when crashes land. `gainScale` (5) interacts: more level
   in = more squash.
3. **V10 layer blend (4)** — two different recordings sounding at once
   reads as two engines / chorus, especially mid-band where both carry.
4. **Short loops (1)** — the V10 idle loop is 0.82 s; the source demo only
   holds a steady rev that long. Audible as a 1.2 Hz cyclic drone.
5. **Downsample (2)** — mono kills the stereo width of the original;
   24 kHz shaves the top octave. Subtle but real.
