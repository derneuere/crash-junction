import type { GameState } from './types';

// HUD-facing event contracts. The runtime stays a single Emitter<GameEvents>
// (one bridge to React), but the map is split per producer so each subsystem
// can only emit its own events: the core loop CoreEvents, the Scoreboard
// ScoreEvents, the RaceDirector RaceEvents.

export type Medal = 'GOLD' | 'SILVER' | 'BRONZE' | 'NONE';

export interface CrashReport {
  kind: 'crash';
  total: number; // damage cash total
  wrecked: number;
  medal: Medal;
}

export interface RaceReport {
  kind: 'race';
  position: number; // finishing position (1 = win)
  wrecked: number;
  medal: Medal;
}

export type ReportData = CrashReport | RaceReport;

export interface CashFloatData {
  id: number;
  x: number;
  y: number;
  text: string;
}

export interface RaceStanding {
  lap: number;
  laps: number;
  pos: number;
  racers: number;
}

/** Boost meter HUD state. The Burnout-3 bar is SEGMENTED (1x→4x): it earns
 *  segments from takedowns and a sustained "Burnout" at a full bar. `fill` is
 *  the fraction of the WHOLE current bar (all segments) that's loaded. */
export interface BoostState {
  fill: number; // 0..1 across the whole (extended) bar
  segments: number; // current bar length (B3 1x→4x)
  maxSegments: number; // ceiling (4)
  burnout: boolean; // sustained Burnout state active
  chain: number; // Burnouts strung together
}

export type CoreEvents = {
  state: GameState;
  flash: string; // 'CRASHTIME' | 'CRASHBREAKER' | 'TAKEDOWN' | 'NEAR MISS'
  report: ReportData;
  boost: BoostState; // segmented boost meter (see BoostState)
  replay: boolean; // a recorded take is driving the sim (ESC exits)
  cine: boolean; // cinematic beat outside crashtime (takedown cam) — letterbox
};

export type ScoreEvents = {
  damage: number;
  cash: CashFloatData;
  crashbreaker: number; // charge fraction 0..1 (1 = ready to detonate)
  multiplier: number; // current damage-cash multiplier
};

export type RaceEvents = {
  race: RaceStanding;
};

export type GameEvents = CoreEvents & ScoreEvents & RaceEvents;

/** Write-only structural view of the Emitter. Producers declare the events
 *  they own (e.g. EventBus<ScoreEvents>) while the runtime object stays the
 *  one Emitter<GameEvents> — method-syntax bivariance makes it assignable. */
export interface EventBus<E> {
  emit<K extends keyof E>(key: K, value: E[K]): void;
}
