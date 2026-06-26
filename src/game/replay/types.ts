import type { GameState } from '../types';

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

export const REPLAY_FORMAT = 'crash-junction-replay';
export const REPLAY_VERSION = 1;
export const CHECKSUM_EVERY = 30; // physics steps (0.25 s at 120 Hz)

/** Every key the sim reads. Order is the bitmask layout — append only. */
export const KEY_CODES = [
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'ShiftLeft', 'ShiftRight',
] as const;

/** Discrete actions that fire between frames. Key *state* is the bitmask;
 *  these are the edge-triggered things keydown/pointerdown handlers do.
 *  The B-key explosion records its resolved position so replay needs no
 *  randomness at the command layer. */
export type Command =
  | { t: 'launch' }
  | { t: 'cb' }
  | { t: 'explode'; x: number; y: number; z: number; power: number };

export interface BodySnap {
  p: number[]; // position
  q: number[]; // quaternion
  v: number[]; // velocity
  w: number[]; // angular velocity
  sleep: number;
}

export interface Snapshot {
  state: GameState;
  simTime: number;
  step: number;
  timeScale: number;
  accumulator: number;
  control: { heading: number; velAngle: number; speed: number; drifting: boolean; boostMeter: number };
  actors: {
    kind: string;
    variant: string | null;
    isPlayer: boolean;
    crashed: boolean;
    destabilized: number;
    damageLvl: number;
    popped: number;
    exploded: boolean;
    fuse: number | null;
    body: BodySnap;
  }[];
  looseParts: BodySnap[];
}

export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: number;
  app: string;
  userAgent: string;
  createdAt: string;
  note: string;
  levelId: string;
  seed: number;
  /** Parallel per-frame arrays. */
  dts: number[];
  keyMasks: number[];
  /** Frame indices where the tab was hidden (changes the step cap). */
  hidden: number[];
  commands: { f: number; c: Command }[];
  /** Aggregate world hash + one hash per body, in registration order. */
  checksums: { s: number; h: number; b: number[] }[];
  snapshot: Snapshot;
}

export interface Divergence {
  step: number;
  expected: number;
  actual: number;
  /** First body whose hash strayed (index into actors+looseParts order). */
  body: { index: number; desc: string; expected: number | null; actual: number | null } | null;
}

/** Physics-sanity envelope of the player across a whole replay — what bug
 *  fixtures assert on (checksums pin a sim version; stats pin behavior). */
export interface ReplayStats {
  /** Highest chassis COM above the local height field (m). */
  maxAltitude: number;
  /** Largest upward velocity (m/s). */
  maxUpwardSpeed: number;
  /** Largest tilt of the chassis from world-up (degrees). */
  maxTiltDeg: number;
  /** TAKEDOWN flashes during the take. */
  takedowns: number;
  /** Shortest gap (s) from a takedown to the player wrecking; 999 = never.
   *  The "crashed into my own takedown" bug shows up as a sub-second value. */
  takedownToPlayerCrashMin: number;
  /** Metres beyond the road edge at the end of the take (race: a stranded
   *  player reads as tens of metres; other modes report 0). */
  finalOffTrack: number;
  /** Times the player got SLAMMED (lost an aggressor judgment). */
  playerSlams: number;
  /** Times the player won one — put a rival into shunt mode. */
  rivalShunts: number;
  /** Times the player wrecked. Fixtures where the player should power
   *  through (e.g. winning a ram) assert 0. */
  playerWrecks: number;
  /** Most wheels the player had popped off while LIVE (wreck-phase pops
   *  don't count — repair zeroes them before the car drives again). A
   *  live car must keep its wheels: losing them without wrecking is an
   *  undriveable hulk with no crash respawn coming. */
  playerPopped: number;
  /** Walls/props met by a LIVE, un-destabilized rival — a car still under
   *  AI steering. Rivals own the racing line: untouched, they never meet a
   *  barrier (the gantry grid once U-turned its front slots into one). */
  rivalWallHits: number;
}

export interface ReplayResult {
  ok: boolean;
  aborted: boolean;
  framesPlayed: number;
  framesTotal: number;
  checksumsChecked: number;
  diverged: Divergence | null;
  stats: ReplayStats;
}
