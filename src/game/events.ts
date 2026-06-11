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

export type CoreEvents = {
  state: GameState;
  flash: string; // 'CRASHTIME' | 'CRASHBREAKER' | 'TAKEDOWN'
  report: ReportData;
  boost: number; // boost meter fraction 0..1
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
