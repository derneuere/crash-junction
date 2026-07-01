import { useState } from 'react';
import { GameState, type ModeKind } from '../game/types';
import type { TimeOfDay } from '../game/daynight';
import { LEVEL_LABELS, type LevelId } from '../game/levels';
import type { BoostState, CashFloatData, RaceStanding, ReportData, TakedownBanner } from '../game/events';
import type { PlayerCarId } from '../game/models';
import { synthKey } from './keys';
import { BoostBar, CrashbreakerBar, RaceChip, RaceTagline, ScoreChip } from './chips';
import { ControlsPanel } from './ControlsPanel';
import { ReportPanel } from './ReportPanel';
import { TouchControls } from './TouchControls';
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
  variants: Record<LevelId, TimeOfDay>; // kept for the merge (debug/menu reuse)
  best: BestMap;
  carId: PlayerCarId;
  onSelectEvent: (id: LevelId, tod?: TimeOfDay) => void;
  onSelectCar: (id: PlayerCarId) => void;
  onExit: () => void; // leave gameplay → back to the menu flow
  onOpenDebug: () => void;
  onCashDone: (id: number) => void;
}

/** HUD shell: the shared chrome (cine bars, flash, hints, cash floats) with
 *  the mode-specific chips composed in. The IN-GAME idle state is now just a
 *  launch prompt + a MENU exit — event/car/settings selection moved OUT to the
 *  menu flow (src/ui/menu/*), which the App mounts BEFORE any Game, so browsing
 *  no longer reloads a level. */
export function Hud({
  state, mode, damage, goldTarget, levelId,
  multiplier, boost, flash, takedown, report, cash, crashbreaker, race, replaying, cineCam,
  onExit, onCashDone,
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

      {/* In-game pre-launch overlay (the level is loaded; events are chosen in
          the menu now, so this is a launch prompt, not a picker). The Game
          listens on window for Space → LAUNCH synthesizes it. */}
      {state === GameState.Idle && (
        <>
          <div className="titleTag">
            <b>{LEVEL_LABELS[levelId]}</b>
            <span>READY</span>
          </div>
          <div className="launchPrompt">
            <button
              className="launchRow"
              onClick={(e) => {
                synthKey('Space');
                e.currentTarget.blur();
              }}
            >
              &#9658; LAUNCH
            </button>
            <div className="launchSub">SPACE / &#9655; START</div>
          </div>
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
          <button
            className="exitBtn"
            onClick={(e) => {
              onExit();
              e.currentTarget.blur();
            }}
            title="Back to the menu"
          >
            &#9664; MENU
          </button>
        </>
      )}

      {controlsOpen && <ControlsPanel mode={mode} onClose={() => setControlsOpen(false)} />}

      {/* on-screen thumb controls (phones/tablets only — null on desktop) */}
      <TouchControls state={state} mode={mode} crashbreaker={crashbreaker} replaying={replaying} />

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

      {state === GameState.Done && report && (
        <>
          <ReportPanel report={report} />
          <button
            className="exitBtn results"
            onClick={(e) => {
              onExit();
              e.currentTarget.blur();
            }}
            title="Back to the menu (switch events with no reload)"
          >
            &#9664; MENU
          </button>
        </>
      )}
    </div>
  );
}
