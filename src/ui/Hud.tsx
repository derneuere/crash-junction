import { GameState, type CashFloatData, type ReportData } from '../game/types';
import { LEVEL_LABELS, type LevelId } from '../game/levels';

export interface FlashState {
  text: string;
  key: number;
}

interface HudProps {
  state: GameState;
  damage: number;
  goldTarget: number;
  practice: boolean;
  levelId: LevelId;
  onSelectLevel: (id: LevelId) => void;
  multiplier: number;
  boost: number; // 0..1
  flash: FlashState | null;
  report: ReportData | null;
  cash: CashFloatData[];
  crashbreaker: number; // charge fraction 0..1
  race: { lap: number; laps: number; pos: number; racers: number } | null;
  isRace: boolean;
  onCashDone: (id: number) => void;
}

const ordinal = (n: number) => `${n}${n === 1 ? 'ST' : n === 2 ? 'ND' : n === 3 ? 'RD' : 'TH'}`;

const usd = (n: number) => '$' + n.toLocaleString('en-US');

export function Hud({
  state, damage, goldTarget, practice, levelId, onSelectLevel,
  multiplier, boost, flash, report, cash, crashbreaker, race, isRace, onCashDone,
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

      <div className="dmg">
        <div className="lbl">DAMAGE TOTAL</div>
        <div className="val">
          {usd(damage)}
          {multiplier > 1 && <span className="mult">&times;{multiplier}</span>}
        </div>
        {goldTarget > 0 ? (
          <div className="target">GOLD AT {usd(goldTarget)}</div>
        ) : isRace ? (
          <div className="target">FIRST ACROSS THE LINE WINS</div>
        ) : (
          <div className="target">PRACTICE — NOTHING TO LOSE</div>
        )}
      </div>

      {race && inRun && (
        <div className="raceChip">
          <span className="pos">{ordinal(race.pos)}</span> / {race.racers} &middot; LAP {race.lap}/{race.laps}
        </div>
      )}

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
              {!practice && <> &middot; E — CRASHBREAKER</>} &middot; R — RESTART
            </div>
          </div>
        </>
      )}

      {driving && (
        <div className="boost">
          <div className="boostFill" style={{ width: `${Math.round(boost * 100)}%` }} />
          <div className="boostLbl">BOOST</div>
        </div>
      )}

      {crashed && !practice && (
        <div className={`boost ${crashbreaker >= 1 ? 'cbReady' : ''}`}>
          <div className="boostFill cbFill" style={{ width: `${Math.round(crashbreaker * 100)}%` }} />
          <div className="boostLbl">{crashbreaker >= 1 ? 'PRESS E — CRASHBREAKER' : 'CRASHBREAKER'}</div>
        </div>
      )}

      {inRun && (
        <div className="hint">
          {driving ? (
            <>
              &#8593; ACCELERATE &middot; &#8592;&#8594; STEER &middot; SPACE BOOST &middot; &#8595; TAP TO DRIFT &middot; STEER SETS THE
              ANGLE
            </>
          ) : (
            <>
              &#8592;&#8593;&#8595;&#8594; AFTERTOUCH &middot; WRECK CARS TO CHARGE THE CRASHBREAKER
              {crashbreaker >= 1 && crashed && (
                <span className="cb"> &middot; E — DETONATE</span>
              )}
            </>
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

      {state === GameState.Done && report && (
        <div className="panel">
          <div className="h">{report.position ? 'RACE RESULT' : 'WRECKAGE REPORT'}</div>
          <div className="val">{report.position ? `${ordinal(report.position)} PLACE` : usd(report.total)}</div>
          <div className="sub">
            {report.position
              ? `${usd(report.total)} COLLATERAL · ${report.wrecked} RIVALS WRECKED`
              : `${report.wrecked} ${report.wrecked === 1 ? 'VEHICLE' : 'VEHICLES'} WRECKED`}
          </div>
          <div className={`medal ${report.medal.toLowerCase()}`}>
            {report.medal === 'NONE' ? 'NO MEDAL' : `${report.medal} MEDAL`}
          </div>
          <div className="key">R — RUN IT BACK</div>
        </div>
      )}
    </div>
  );
}
