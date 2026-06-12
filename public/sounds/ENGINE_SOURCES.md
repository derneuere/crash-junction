# Engine loop sources

`engine_v10_low.wav`, `engine_v10_high.wav`, `engine_v8.wav`

Sampled from AngeTheGreat — "Improving My Engine Sound Simulator With Real
Data" (https://www.youtube.com/watch?v=sUdnJTC2w9I), the "Tube Junctions
(V10 and V8 samples)" chapter (~24:03–25:34). The audio is output of his
open-source engine simulator (https://github.com/ange-yaghi/engine-sim).
Personal prototype use only.

| file                | content           | source cut (video time) | loop f0 |
| ------------------- | ----------------- | ----------------------- | ------- |
| engine_v10_low.wav  | V10 settled idle  | 1489.0s – 1492.3s       | ~30 Hz  |
| engine_v10_high.wav | V10 held revs     | 1467.4s – 1470.8s       | ~90 Hz  |
| engine_v8.wav       | V8 cruise hold    | 1514.8s – 1520.3s       | ~48 Hz  |

(Re-cut 2026-06-12: the first windows had RPM sweeps baked in — flagged by
ear, confirmed on spectrograms. These cuts come from holds verified flat by
linear-fit pitch tracking, <1%/s drift.)

Each loop is made seamless by crossfading its tail into its head (qsin,
0.35–0.6s), loudness-normalized to −16 LUFS, and stored as 24 kHz mono WAV —
mp3 encoder padding would break gapless looping in decodeAudioData. The
loops feed the swept-flavor model in src/game/audio/synths.ts
(ENGINE_FLAVORS), selectable from the HUD next to the DAY/NIGHT toggle.
