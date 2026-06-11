import type * as THREE from 'three';
import type { Actor, GameState, LevelDef, VehicleSpawn } from '../types';
import type { ContactContext, ContactOutcome } from '../collision';
import type { GameEvents, ReportData } from '../events';
import type { Emitter } from '../emitter';
import type { Scoreboard } from '../score';
import type { PlayerControl } from '../control';
import type { HeightSampler } from '../suspension';
import { CrashMode } from './crash';
import { PracticeMode } from './practice';
import { RaceMode } from './race';

/** The narrow surface of Game a mode is allowed to touch. */
export interface ModeHost {
  readonly events: Emitter<GameEvents>;
  readonly actors: readonly Actor[];
  readonly player: Actor;
  readonly control: PlayerControl;
  readonly heightAt: HeightSampler;
  /** World point → HUD pixel coords, or null when behind the camera. */
  project(p: THREE.Vector3): { x: number; y: number } | null;
  /** Spawn an extra vehicle wired into the core collision pipeline —
   *  rivals MUST go through this or they'd be judged as walls. */
  spawnVehicle(spawn: VehicleSpawn): Actor;
  /** Fully repair the player's car (un-crumple, re-hang panels, refit
   *  wheels) — used by race respawns. */
  repairPlayer(): void;
  /** End the run: sets GameState.Done, emits 'state' then 'report'. */
  finish(report: ReportData): void;
}

/** What a level plays like — the strategy the core loop composes. Each mode
 *  owns its own rules and state: CrashMode scores cash against medals,
 *  PracticeMode keeps the player unwreckable, RaceMode runs the rivals. */
export interface GameMode {
  /** Scoring component; null = cash is not a thing in this mode (race). */
  readonly score: Scoreboard | null;
  /** One fixed physics step of mode AI (traffic / rivals). */
  fixedStep(dt: number, state: GameState, simTime: number): void;
  /** false = the player can never be wrecked (practice): crashes scuff and
   *  shed panels but driving continues — no crashtime, no report. */
  playerCanCrash(): boolean;
  /** Judge one hard non-scenery contact; the core applies the outcome
   *  (wrecks, shunt-mode timers, wall glances, takedown presentation). */
  resolveContact(ctx: ContactContext): ContactOutcome;
  /** Where the autopilot should aim while the takedown camera plays —
   *  the middle of the road ahead. null = no autopilot in this mode. */
  autopilotHeading(): number | null;
  /** Metres the player sits beyond the drivable road (0 = on it). Modes
   *  without a road return 0. Feeds replay stats + the cam handback check. */
  playerOffTrackDistance(): number;
  /** The takedown camera beat just ended — the mode may rescue the player
   *  (race: respawn on the track at pre-takedown speed if the beat left
   *  them beached, thrown over the barrier, or ground to a halt). */
  onTakedownCamOver(): void;
  /** false = E does nothing (race, Burnout-style). */
  allowCrashbreaker(): boolean;
  /** Crashtime slow-mo just ramped back to 1× with the player wrecked.
   *  'resume' = the mode already put the player back on track (race
   *  reset-pair) and the core returns to Launch; 'settle' = watch the
   *  wreckage come to rest as usual. */
  onCrashTimeOver(): 'settle' | 'resume';
  /** The wreckage settled (or timed out) — build the report and finish. */
  onSettled(): void;
}

export function createMode(level: LevelDef, host: ModeHost): GameMode {
  switch (level.mode.kind) {
    case 'crash':
      return new CrashMode(level.mode.medals, host);
    case 'practice':
      return new PracticeMode(host);
    case 'race':
      return new RaceMode(level.mode.race, host);
  }
}

/** Shared by the report builders. */
export function countWrecked(actors: readonly Actor[]): number {
  return actors.filter((a) => a.kind === 'vehicle' && !a.isPlayer && a.crashed).length;
}
