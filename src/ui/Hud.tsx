import { GameState, type ModeKind } from '../game/types';
import type { CashFloatData, RaceStanding, ReportData } from '../game/events';
import { LEVEL_LABELS, type LevelId } from '../game/levels';
import { BoostBar, CrashbreakerBar, RaceChip, RaceTagline, ScoreChip } from './chips';
import { ReportPanel } from './ReportPanel';

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
  onSelectLevel: (id: LevelId) => void;
  multiplier: number;
  boost: number; // 0..1
  flash: FlashState | null;
  report: ReportData | null;
  cash: CashFloatData[];
  crashbreaker: number; // charge fraction 0..1
  race: RaceStanding | null;
  onCashDone: (id: number) => void;
}

/** HUD shell: the shared chrome (cine bars, flash, hints, level select,
 *  cash floats) with the mode-specific chips composed in. */
export function Hud({
  state, mode, damage, goldTarget, levelId, onSelectLevel,
  multiplier, boost, flash, report, cash, crashbreaker, race, onCashDone,
}: HudProps) {
  const cine = state === GameState.Crash;
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

      {flash && (
        <div className="flash" key={flash.key}>
          {flash.text}
        </div>
      )}

      {state === GameState.Idle && (
        <>
          <div className="levels">
            {(Object.keys(LEVEL_LABELS) as LevelId[]).map((id) => (
              <button
                key={id}
                className={id === levelId ? 'active' : undefined}
                onClick={() => onSelectLevel(id)}
              >
                {LEVEL_LABELS[id]}
              </button>
            ))}
          </div>
          <div className="prompt">
            <div className="big">&#9658; CLICK OR PRESS SPACE TO LAUNCH</div>
            <div className="sub">
              &#8593; ACCELERATE &middot; &#8592;&#8594; STEER &middot; SPACE — BOOST &middot; &#8595; TAP TO DRIFT (STEER SETS THE
              ANGLE, STRAIGHTEN TO EXIT)
              {mode === 'crash' && <> &middot; E — CRASHBREAKER</>} &middot; R — RESTART
            </div>
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
          {' '}&middot; R RESTART
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
