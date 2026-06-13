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

/** A classified takedown for the B3-style banner (takedowns.ts). The banner
 *  shows the TYPE name and the POINTS; `kind` lets the HUD style signature /
 *  aftertouch hits differently. Purely presentation — derived from sim state,
 *  never fed back into it. */
export interface TakedownBanner {
  kind: string; // TakedownKind — 'signature' | 'aftertouch' | 'vertical' | …
  label: string; // the big line: 'CRANE SMASH', 'AFTERTOUCH TAKEDOWN', …
  points: number; // type-specific points awarded
  key: number; // monotonic id so the HUD can stack/replace banners
}

export type CoreEvents = {
  state: GameState;
  flash: string; // 'CRASHTIME' | 'CRASHBREAKER' | 'SLAMMED' | …
  takedown: TakedownBanner; // classified takedown → the rich B3-style banner
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
