import { GameState, type ModeKind } from '../game/types';
import type { TimeOfDay } from '../game/daynight';
import type { GfxMode } from '../game/Game';
import type { CashFloatData, RaceStanding, ReportData } from '../game/events';
import type { LevelId } from '../game/levels';
import type { PlayerCarId } from '../game/models';
import { BoostBar, CrashbreakerBar, RaceChip, RaceTagline, ScoreChip } from './chips';
import { EventPicker } from './EventPicker';
import { ReportPanel } from './ReportPanel';
import type { BestMap } from './storage';

export interface FlashState {
  text: string;
  key: number;
}

interface HudProps {
  state: GameState;
  mode: ModeKind;
  damage: number;
  goldTarget: number;
  levelId: LevelId;
  multiplier: number;
  boost: number; // 0..1
  flash: FlashState | null;
  report: ReportData | null;
  cash: CashFloatData[];
  crashbreaker: number; // charge fraction 0..1
  race: RaceStanding | null;
  replaying: boolean;
  cineCam: boolean; // takedown-cam beat — letterbox outside crashtime
  timeOfDay: TimeOfDay;
  variants: Record<LevelId, TimeOfDay>; // what each event card opens with
  best: BestMap;
  carId: PlayerCarId;
  gfx: GfxMode; // global presentation tier — CINE film look / FAST bare renderer
  onSelectEvent: (id: LevelId, tod?: TimeOfDay) => void;
  onSelectCar: (id: PlayerCarId) => void;
  onSetGfx: (g: GfxMode) => void;
  onOpenDebug: () => void;
  onCashDone: (id: number) => void;
}

/** HUD shell: the shared chrome (cine bars, flash, hints, cash floats) with
 *  the mode-specific chips composed in. The idle screen is the B3-style
 *  event picker (EventPicker) — the old level-button strip and the global
 *  DAY/NIGHT + engine toggles folded into its cards and footer. */
export function Hud({
  state, mode, damage, goldTarget, levelId,
  multiplier, boost, flash, report, cash, crashbreaker, race, replaying, cineCam,
  timeOfDay, variants, best, carId, gfx, onSelectEvent, onSelectCar, onSetGfx, onOpenDebug, onCashDone,
}: HudProps) {
  const cine = state === GameState.Crash || cineCam;
  const inRun = state !== GameState.Idle && state !== GameState.Done;
  const driving = state === GameState.Launch;
  const crashed = state === GameState.Crash || state === GameState.Settle;
  return (
    <div id="hud" className={cine ? 'cine' : undefined}>
      <div className="bar top" />
      <div className="bar bottom" />
      <div className="vig" />

      {mode === 'race' ? (
        <RaceTagline />
      ) : (
        <ScoreChip damage={damage} multiplier={multiplier} goldTarget={goldTarget} practice={mode === 'practice'} />
      )}

      {mode === 'race' && race && inRun && <RaceChip standing={race} />}

      <div className="tag">
        <b>CRASH JUNCTION</b>
        react + three.js + cannon-es
      </div>

      {replaying && <div className="replay">&#9210; REPLAY &middot; ESC EXITS</div>}

      {flash && (
        <div className="flash" key={flash.key}>
          {flash.text}
        </div>
      )}

      {state === GameState.Idle && (
        <>
          <EventPicker
            levelId={levelId}
            tod={timeOfDay}
            variants={variants}
            best={best}
            carId={carId}
            gfx={gfx}
            onSelectEvent={onSelectEvent}
            onSelectCar={onSelectCar}
            onSetGfx={onSetGfx}
            onOpenDebug={onOpenDebug}
          />
          <div className="hint">
            &#8593; ACCELERATE &middot; &#8592;&#8594; STEER &middot; SPACE — BOOST &middot; &#8595; TAP TO DRIFT (STEER SETS THE
            ANGLE, STRAIGHTEN TO EXIT)
            {mode === 'crash' && <> &middot; E — CRASHBREAKER</>} &middot; ENTER — RESTART &middot; R — BUG REPORT
          </div>
        </>
      )}

      {driving && <BoostBar boost={boost} />}

      {crashed && mode === 'crash' && <CrashbreakerBar charge={crashbreaker} />}

      {inRun && (
        <div className="hint">
          {driving ? (
            <>
              &#8593; ACCELERATE &middot; &#8592;&#8594; STEER &middot; SPACE BOOST &middot; &#8595; TAP TO DRIFT &middot; STEER SETS THE
              ANGLE
            </>
          ) : mode === 'crash' ? (
            <>
              &#8592;&#8593;&#8595;&#8594; AFTERTOUCH &middot; WRECK CARS TO CHARGE THE CRASHBREAKER
              {crashbreaker >= 1 && crashed && (
                <span className="cb"> &middot; E — DETONATE</span>
              )}
            </>
          ) : (
            <>&#8592;&#8593;&#8595;&#8594; AFTERTOUCH</>
          )}
          {' '}&middot; ENTER RESTART &middot; R BUG REPORT
        </div>
      )}

      {cash.map((c) => (
        <div
          key={c.id}
          className="cash"
          style={{ left: c.x, top: c.y }}
          onAnimationEnd={() => onCashDone(c.id)}
        >
          {c.text}
        </div>
      ))}

      {state === GameState.Done && report && <ReportPanel report={report} />}
    </div>
  );
}
