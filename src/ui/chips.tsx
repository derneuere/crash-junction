import type { BoostState, RaceStanding } from '../game/events';

export const ordinal = (n: number) => `${n}${n === 1 ? 'ST' : n === 2 ? 'ND' : n === 3 ? 'RD' : 'TH'}`;

export const usd = (n: number) => '$' + n.toLocaleString('en-US');

/** Crash/practice top-left chip: the damage cash total and its stakes. */
export function ScoreChip({
  damage,
  multiplier,
  goldTarget,
  practice,
}: {
  damage: number;
  multiplier: number;
  goldTarget: number;
  practice: boolean;
}) {
  return (
    <div className="dmg">
      <div className="lbl">DAMAGE TOTAL</div>
      <div className="val">
        {usd(damage)}
        {multiplier > 1 && <span className="mult">&times;{multiplier}</span>}
      </div>
      {practice ? (
        <div className="target">PRACTICE — NOTHING TO LOSE</div>
      ) : (
        <div className="target">GOLD AT {usd(goldTarget)}</div>
      )}
    </div>
  );
}

/** Race top-left chip: no cash in a race — just the stakes. */
export function RaceTagline() {
  return (
    <div className="dmg">
      <div className="lbl">RACE</div>
      <div className="target">FIRST ACROSS THE LINE WINS</div>
    </div>
  );
}

/** Race standing: position and lap, top right under the title tag. */
export function RaceChip({ standing }: { standing: RaceStanding }) {
  return (
    <div className="raceChip">
      <span className="pos">{ordinal(standing.pos)}</span> / {standing.racers} &middot; LAP {standing.lap}/
      {standing.laps}
    </div>
  );
}

/** Burnout-3 segmented boost meter. The bar is divided into `maxSegments`
 *  cells; `segments` of them are EARNED (lit frame), the rest are empty room
 *  to grow (one more per takedown). The orange fill flows left→right across
 *  the earned cells. At a full bar it tips into a pulsing "Burnout" (the
 *  sustained state), and chained Burnouts read out their count. */
export function BoostBar({ boost }: { boost: BoostState }) {
  const { fill, segments, maxSegments, burnout, chain } = boost;
  // fill is across the whole EARNED bar; the earned region is segments/max of
  // the container, so scale the orange fill into that region
  const earnedFrac = segments / maxSegments;
  const fillPct = Math.min(100, Math.round(fill * earnedFrac * 100));
  const cells = [];
  for (let i = 0; i < maxSegments; i++) {
    cells.push(<div key={i} className={`boostSeg ${i < segments ? 'on' : ''}`} />);
  }
  return (
    <div className={`boost ${burnout ? 'burnout' : ''}`}>
      <div className="boostFill" style={{ width: `${fillPct}%` }} />
      <div className="boostSegs">{cells}</div>
      <div className="boostLbl">
        {burnout ? `BURNOUT${chain > 0 ? ` ×${chain + 1}` : ''}` : `BOOST ${segments}×`}
      </div>
    </div>
  );
}

export function CrashbreakerBar({ charge }: { charge: number }) {
  return (
    <div className={`boost ${charge >= 1 ? 'cbReady' : ''}`}>
      <div className="boostFill cbFill" style={{ width: `${Math.round(charge * 100)}%` }} />
      <div className="boostLbl">{charge >= 1 ? 'PRESS E — CRASHBREAKER' : 'CRASHBREAKER'}</div>
    </div>
  );
}
