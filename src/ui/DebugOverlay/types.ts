import type { EngineFlavor } from '../../game/audio';
import type { TimeOfDay } from '../../game/daynight';
import type { LevelId } from '../../game/levels';
import type { ReplayFile } from '../../game/replay';
import type { GameState } from '../../game/types';

/** Structural view of window.__game — the dev handle Game.ts publishes. The
 *  fields are TS-private on the class, but this overlay deliberately works
 *  through the same runtime surface the console and tools/refshot.mjs use,
 *  so Game.ts needs no code for it. */
export interface GlassParams {
  tint: number;
  transmission: number;
  roughness: number;
  thickness: number;
  ior: number;
  dispersion: number;
  attenuation: number;
  reflection: number;
  rim: number;
  warp: number;
  frost: number;
}

export interface DebugGame {
  captureReport(note?: string): unknown;
  camera: {
    position: { set(x: number, y: number, z: number): void };
    lookAt(x: number, y: number, z: number): void;
  };
  director: { update?: (...args: never[]) => void };
  audio?: { levels(): number; samplesLoaded(): number };
  simTime?: number;
  levelId?: string;
  setGlassParams?(p: Partial<GlassParams>): GlassParams;
  getGlassParams?(): GlassParams;
  // grass verge field (coast levels only) — cheap cached telemetry, no
  // per-blade work. See grass.ts GrassField.stats().
  grass?: { stats(): { allocated: number; tilesTotal: number; tilesDrawn: number } };
  // live render readout for the corner stats HUD (Game.perfLive()).
  perfLive?(): { fps: number; calls: number; triangles: number };
}

export interface ReplayVerdict {
  ok: boolean;
  aborted: boolean;
  framesPlayed: number;
  framesTotal: number;
  diverged: unknown;
}

export interface DebugOverlayProps {
  open: boolean;
  onClose: () => void;
  state: GameState;
  levelId: LevelId;
  timeOfDay: TimeOfDay;
  engineSound: EngineFlavor;
  onSetTimeOfDay: (t: TimeOfDay) => void;
  onSetEngineSound: (f: EngineFlavor) => void;
  onSelectLevel: (id: LevelId) => void;
  onLoadReplay: (file: ReplayFile, fast: boolean) => void;
}

export interface Telemetry {
  simTime: number;
  rms: number;
  clips: number;
  ai: string;
  replay: string;
  grass: string;
}
