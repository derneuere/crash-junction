import type * as CANNON from 'cannon-es';
import type { Actor, GameState } from './types';
import type { LoosePart } from './vehicles';

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

export function maskFromKeys(keys: Record<string, boolean>): number {
  let m = 0;
  for (let i = 0; i < KEY_CODES.length; i++) if (keys[KEY_CODES[i]]) m |= 1 << i;
  return m;
}

export function keysFromMask(mask: number): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (let i = 0; i < KEY_CODES.length; i++) if (mask & (1 << i)) keys[KEY_CODES[i]] = true;
  return keys;
}

// ---------- world-state checksum ----------

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);

function hashFloat(h: number, v: number): number {
  _f64[0] = v;
  h = Math.imul(h ^ _u32[0], 16777619);
  h = Math.imul(h ^ _u32[1], 16777619);
  return h >>> 0;
}

function hashBody(h: number, b: CANNON.Body): number {
  h = hashFloat(h, b.position.x);
  h = hashFloat(h, b.position.y);
  h = hashFloat(h, b.position.z);
  h = hashFloat(h, b.quaternion.x);
  h = hashFloat(h, b.quaternion.y);
  h = hashFloat(h, b.quaternion.z);
  h = hashFloat(h, b.quaternion.w);
  h = hashFloat(h, b.velocity.x);
  h = hashFloat(h, b.velocity.y);
  h = hashFloat(h, b.velocity.z);
  h = hashFloat(h, b.angularVelocity.x);
  h = hashFloat(h, b.angularVelocity.y);
  h = hashFloat(h, b.angularVelocity.z);
  return h;
}

/** FNV-style hashes over every dynamic body, in stable registration order:
 *  one aggregate plus one per body, so a divergence names its first body. */
export function worldHash(
  actors: readonly Actor[],
  looseParts: readonly LoosePart[],
): { h: number; bodies: number[] } {
  let h = 2166136261;
  const bodies: number[] = [];
  for (const a of actors) {
    h = hashBody(h, a.body);
    bodies.push(hashBody(2166136261, a.body));
  }
  for (const lp of looseParts) {
    h = hashBody(h, lp.body);
    bodies.push(hashBody(2166136261, lp.body));
  }
  return { h, bodies };
}

export function bodySnap(b: CANNON.Body): BodySnap {
  return {
    p: [b.position.x, b.position.y, b.position.z],
    q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
    v: [b.velocity.x, b.velocity.y, b.velocity.z],
    w: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z],
    sleep: b.sleepState,
  };
}

// ---------- recorder ----------

export class Recorder {
  private levelId = '';
  private seed = 0;
  private dts: number[] = [];
  private keyMasks: number[] = [];
  private hidden: number[] = [];
  private commands: { f: number; c: Command }[] = [];
  private checksums: { s: number; h: number; b: number[] }[] = [];
  private armed = false;

  /** New take: wipe the tape and start over. */
  begin(levelId: string, seed: number): void {
    this.levelId = levelId;
    this.seed = seed;
    this.dts = [];
    this.keyMasks = [];
    this.hidden = [];
    this.commands = [];
    this.checksums = [];
    this.armed = true;
  }

  /** Replays must not record themselves. */
  disarm(): void {
    this.armed = false;
  }

  frame(dt: number, mask: number, hidden: boolean, cmds: readonly Command[]): void {
    if (!this.armed) return;
    const f = this.dts.length;
    this.dts.push(dt);
    this.keyMasks.push(mask);
    if (hidden) this.hidden.push(f);
    for (const c of cmds) this.commands.push({ f, c });
  }

  checksum(step: number, hash: number, bodies: number[]): void {
    if (!this.armed) return;
    this.checksums.push({ s: step, h: hash, b: bodies });
  }

  export(note: string, snapshot: Snapshot): ReplayFile {
    return {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      app: `crash-junction ${import.meta.env.MODE}`,
      userAgent: navigator.userAgent,
      createdAt: new Date().toISOString(),
      note,
      levelId: this.levelId,
      seed: this.seed,
      dts: this.dts.slice(), // recording continues after an export
      keyMasks: this.keyMasks.slice(),
      hidden: this.hidden.slice(),
      commands: this.commands.slice(),
      checksums: this.checksums.slice(),
      snapshot,
    };
  }
}

// ---------- file I/O ----------

export function parseReplayFile(text: string): ReplayFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const f = raw as ReplayFile;
  if (f?.format !== REPLAY_FORMAT) throw new Error('not a crash-junction replay file');
  if (f.version !== REPLAY_VERSION) throw new Error(`replay version ${f.version}, expected ${REPLAY_VERSION}`);
  if (!Array.isArray(f.dts) || !Array.isArray(f.keyMasks) || f.dts.length !== f.keyMasks.length) {
    throw new Error('frame arrays missing or mismatched');
  }
  if (typeof f.seed !== 'number' || typeof f.levelId !== 'string') throw new Error('seed or levelId missing');
  if (!Array.isArray(f.commands) || !Array.isArray(f.checksums) || !Array.isArray(f.hidden)) {
    throw new Error('command/checksum arrays missing');
  }
  return f;
}

export function downloadReplay(file: ReplayFile): void {
  const stamp = file.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `crash-report-${file.levelId}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
