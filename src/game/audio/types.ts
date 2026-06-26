// Shared audio types + mix constants. Pulled out of index.ts so the public
// surface (GameAudio + AudioFrameState + EngineFlavor) can re-export them
// unchanged while the implementation lives in sibling modules.

import type { Actor } from '../types';
import type { EngineFlavor } from './synths';

export type { EngineFlavor };

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** Per-frame sim readout — one persistent object, mutated by Game. */
export interface AudioFrameState {
  dt: number;
  timeScale: number;
  cam: { position: XYZ; quaternion: { x: number; y: number; z: number; w: number } };
  driving: boolean; // engine audible: launched, alive, not a wreck
  speed: number;
  throttle: boolean;
  boosting: boolean;
  drifting: boolean;
  slip: number; // 0..1 — how sideways the drift is (drives squeal level)
  grounded: boolean;
  vy: number; // player vertical speed (landing thump strength)
  actors: Actor[] | null; // near-miss scan
  player: Actor | null;
}

export interface PlayOpts {
  gain: number;
  rate?: number;
  pos?: XYZ | null;
  send?: number; // reverb send (fraction of voice gain)
  delay?: number;
  noWarp?: boolean; // UI sounds skip the slow-mo pitch warp
}

export const NEAR_MISS_DIST2 = 4.6 * 4.6;
export const NEAR_MISS_REL = 9; // m/s relative speed to count as a "whoosh"
export const TRACKSIDE_DIST2 = 6 * 6; // m — passing a post/gantry leg this close…
export const TRACKSIDE_SPEED = 30; // …at this speed earns a pass-by whoosh (A5)
