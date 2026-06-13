import { useState } from 'react';
import { GameState, type ModeKind } from '../game/types';
import type { TimeOfDay } from '../game/daynight';
import type { BoostState, CashFloatData, RaceStanding, ReportData, TakedownBanner } from '../game/events';
import type { LevelId } from '../game/levels';
import type { PlayerCarId } from '../game/models';
import { BoostBar, CrashbreakerBar, RaceChip, RaceTagline, ScoreChip } from './chips';
import { ControlsPanel } from './ControlsPanel';
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
  boost: BoostState; // segmented boost meter
  flash: FlashState | null;
  takedown: TakedownBanner | null; // classified takedown → B3-style banner
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
  onSelectEvent: (id: LevelId, tod?: TimeOfDay) => void;
  onSelectCar: (id: PlayerCarId) => void;
  onOpenDebug: () => void;
  onCashDone: (id: number) => void;
}

/** HUD shell: the shared chrome (cine bars, flash, hints, cash floats) with
 *  the mode-specific chips composed in. The idle screen is the B3-style
 *  event picker (EventPicker) — the old level-button strip and the global
 *  DAY/NIGHT + engine toggles folded into its cards and footer. */
export function Hud({
  state, mode, damage, goldTarget, levelId,
  multiplier, boost, flash, takedown, report, cash, crashbreaker, race, replaying, cineCam,
  timeOfDay, variants, best, carId, onSelectEvent, onSelectCar, onOpenDebug, onCashDone,
}: HudProps) {
  const cine = state === GameState.Crash || cineCam;
  const inRun = state !== GameState.Idle && state !== GameState.Done;
  const driving = state === GameState.Launch;
  const crashed = state === GameState.Crash || state === GameState.Settle;
  // controls reference is opt-in via the idle "CONTROLS" toggle (was a
  // persistent hint line) — local UI state, no sim coupling
  const [controlsOpen, setControlsOpen] = useState(false);
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

      {replaying && <div className="replay">&#9210; REPLAY &middot; ESC EXITS</div>}

      {flash && (
        <div className="flash" key={flash.key}>
          {flash.text}
        </div>
      )}

      {/* B3-style takedown banner: the TYPE name + the points it paid. Keyed on
          the banner id so each fresh takedown restarts the slam animation
          (stacked takedowns read as a quick punchy replace). Signature and
          aftertouch hits get a hotter treatment via the data-kind attribute. */}
      {takedown && (
        <div className="takedown" data-kind={takedown.kind} key={takedown.key}>
          <div className="td-label">{takedown.label}</div>
          <div className="td-points">+{takedown.points.toLocaleString('en-US')}</div>
        </div>
      )}

      {state === GameState.Idle && (
        <>
          <div className="titleTag">
            <b>CRASH JUNCTION</b>
            <span>react + three.js + cannon-es</span>
          </div>
          <EventPicker
            levelId={levelId}
            tod={timeOfDay}
            variants={variants}
            best={best}
            carId={carId}
            onSelectEvent={onSelectEvent}
            onSelectCar={onSelectCar}
            onOpenDebug={onOpenDebug}
          />
          <button
            className="controlsToggle"
            onClick={(e) => {
              setControlsOpen(true);
              e.currentTarget.blur();
            }}
            title="View keyboard &amp; controller bindings"
          >
            &#9000; CONTROLS
          </button>
        </>
      )}

      {controlsOpen && <ControlsPanel mode={mode} onClose={() => setControlsOpen(false)} />}

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
