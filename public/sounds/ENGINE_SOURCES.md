# Engine loop sources

`engine_v10_low.wav`, `engine_v10_high.wav`, `engine_v8.wav`

Sampled from AngeTheGreat — "Improving My Engine Sound Simulator With Real
Data" (https://www.youtube.com/watch?v=sUdnJTC2w9I), the "Tube Junctions
(V10 and V8 samples)" chapter (~24:03–25:34). The audio is output of his
open-source engine simulator (https://github.com/ange-yaghi/engine-sim).
Personal prototype use only.

| file                | content          | source cut (video time) | loop f0 |
| ------------------- | ---------------- | ----------------------- | ------- |
| engine_v10_low.wav  | V10 lumpy idle   | 1481.4s – 1482.6s       | ~47 Hz  |
| engine_v10_high.wav | V10 steady revs  | 1468.5s – 1471.3s       | ~90 Hz  |
| engine_v8.wav       | V8 rumble        | 1525.6s – 1528.8s       | ~46 Hz  |

Each loop is made seamless by crossfading its tail into its head (qsin,
0.35–0.6s), loudness-normalized to −16 LUFS, and stored as 24 kHz mono WAV —
mp3 encoder padding would break gapless looping in decodeAudioData.
