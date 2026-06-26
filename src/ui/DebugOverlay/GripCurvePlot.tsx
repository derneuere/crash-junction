// Optional grip-curve debug readout (Feature C). BP's ONLY caller of the tire
// grip sampler was `GripCurveDebugGraph::PlotCurrentValue` — a debug plotter —
// so mirroring that here lets the rise-then-fall curves be eyeballed and tuned.
// Pure presentation: it samples the deterministic `grip()` function (grip.ts)
// over the static per-variant HANDLING coefficients and draws an inline SVG. It
// reads NOTHING from the live sim, so it can never affect determinism or replay,
// and it is fully self-contained (no new wiring into DebugOverlay required to
// build — mount it where convenient).

import { useState } from 'react';
import { HANDLING } from '../../game/handling';
import type { Variant } from '../../game/types';
import { grip, latGripCurve, driftLatGripCurve, longGripCurve, type GripCurve } from '../../game/grip';

const VARIANTS: Variant[] = ['sedan', 'bus', 'tanker'];
const W = 220;
const H = 120;
const PAD = 18;
const SLIP_MAX = 1.0; // plot |slip| 0..1 (covers rise → peak → fall → plateau)
const SAMPLES = 64;

/** Build an SVG polyline `points` string for one curve over 0..SLIP_MAX. The
 *  y-axis is the coefficient 0..~1.2 (peak can exceed 1 only if a variant tunes
 *  it so; clamp the draw window to 1.2). */
function pathFor(c: GripCurve): string {
  const pts: string[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const slip = (i / SAMPLES) * SLIP_MAX;
    const coeff = Math.abs(grip(slip, c));
    const x = PAD + (slip / SLIP_MAX) * (W - 2 * PAD);
    const y = H - PAD - Math.min(1.2, coeff) / 1.2 * (H - 2 * PAD);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Inline grip-curve plot for one variant: longitudinal, lateral, and the
 *  flatter drift-lateral curve overlaid, so the break-loose shaping is visible.
 *  Drop into the DebugOverlay panel; defaults to the sedan, switchable. */
export function GripCurvePlot({ variant }: { variant?: Variant }) {
  const [sel, setSel] = useState<Variant>(variant ?? 'sedan');
  const h = HANDLING[sel];
  return (
    <div style={{ font: '10px monospace', color: '#cdd', lineHeight: 1.4 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
        <span>GRIP CURVE</span>
        {VARIANTS.map((v) => (
          <button
            key={v}
            onClick={() => setSel(v)}
            style={{
              font: '9px monospace',
              padding: '0 4px',
              background: v === sel ? '#2a5' : '#234',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {v}
          </button>
        ))}
      </div>
      <svg width={W} height={H} style={{ background: '#0a1014', borderRadius: 3 }}>
        {/* peak/floor reference verticals (sedan-style axes) */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#345" strokeWidth={1} />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#345" strokeWidth={1} />
        {/* longitudinal (grey), lateral (cyan), drift-lateral (amber) */}
        <polyline points={pathFor(longGripCurve(h))} fill="none" stroke="#789" strokeWidth={1.2} />
        <polyline points={pathFor(latGripCurve(h))} fill="none" stroke="#4cf" strokeWidth={1.5} />
        <polyline points={pathFor(driftLatGripCurve(h))} fill="none" stroke="#fb4" strokeWidth={1.5} />
      </svg>
      <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
        <span style={{ color: '#789' }}>long</span>
        <span style={{ color: '#4cf' }}>lat</span>
        <span style={{ color: '#fb4' }}>drift-lat</span>
      </div>
      <div style={{ color: '#9ab', marginTop: 2 }}>
        peak {h.grip.latPeakCoeff.toFixed(2)} @ {h.grip.latPeakSlip.toFixed(2)} → floor{' '}
        {h.grip.latFallCoeff.toFixed(2)} (drift {h.grip.driftLatPeakCoeff.toFixed(2)})
      </div>
    </div>
  );
}
