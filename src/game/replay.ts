// Deterministic bug-report capture + replay.
//
// The sim is a fixed-step accumulator fed only by per-frame wall dt, the key
// states sampled at frame start, and the commands fired between frames — so a
// take recorded as (dt, keymask, hidden, commands) per frame, plus the seed of
// the sim RNG stream (rng.ts), replays bit-for-bit on the same JS engine.
// Recording is always on from every take boundary (reset / level load);
// pressing R serializes the take so far into a JSON report. Checksums of the
// full physics state every CHECKSUM_EVERY steps let a replay prove it stayed
// on rails, and the snapshot at report time gives a diagnosis target without
// running anything.
//
// This module is a thin barrel: the implementation lives in ./replay/*.

export {
  REPLAY_FORMAT,
  REPLAY_VERSION,
  CHECKSUM_EVERY,
  KEY_CODES,
} from './replay/types';
export type {
  Command,
  BodySnap,
  Snapshot,
  ReplayFile,
  Divergence,
  ReplayStats,
  ReplayResult,
} from './replay/types';

export { maskFromKeys, keysFromMask } from './replay/keys';

export { worldHash, bodySnap } from './replay/checksum';

export { Recorder } from './replay/recorder';

export { parseReplayFile, downloadReplay } from './replay/io';
