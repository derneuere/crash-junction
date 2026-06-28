import { useEffect, useState } from 'react';
import type { GraphicsSettings } from '../game/graphics';
import { getGame } from './DebugOverlay/constants';

interface GraphicsOverlayProps {
  gfx: GraphicsSettings;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (patch: Partial<GraphicsSettings>) => void;
}

interface Live {
  fps: number;
  calls: number;
  triangles: number;
}

// The dialog rows, grouped. VISUAL QUALITY toggles trade fidelity for GPU fill;
// DRAW CALLS toggles isolate the whole-scene re-renders + the dominant object
// set so you can see what's spending the draw-call budget.
type Toggle = { key: keyof GraphicsSettings; label: string; hint: string };
const GROUPS: { title: string; rows: Toggle[] }[] = [
  {
    title: 'VISUAL QUALITY',
    rows: [
      { key: 'clouds', label: 'CLOUDS', hint: 'Sky-dome cloud layer' },
      { key: 'water', label: 'WATER', hint: 'Animated ocean — coast levels only' },
      { key: 'grass', label: 'GRASS', hint: 'Instanced verge grass — coast levels only' },
      { key: 'ao', label: 'AMBIENT OCCLUSION', hint: 'Screen-space AO (N8AO) — the heaviest post pass' },
    ],
  },
  {
    title: 'DRAW CALLS',
    rows: [
      { key: 'reflections', label: 'REFLECTIONS', hint: 'Player cube reflection — re-renders the whole scene ×6 every other frame' },
      { key: 'shadows', label: 'SHADOWS', hint: 'Sun shadow depth pass — one extra render of every caster' },
      { key: 'props', label: 'PROPS', hint: 'All set-dressing props (~900 objects on gantry) — the dominant draw source' },
    ],
  },
  {
    title: 'HUD',
    rows: [{ key: 'stats', label: 'STATS OVERLAY', hint: 'This FPS / draw-call / triangle readout' }],
  },
];

/** Compact large-number format for the draw/triangle counters. */
function fmt(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/** Top-right graphics cluster: a live FPS / draw-call / triangle readout, a gear
 *  that opens the graphics-settings dialog, and the dialog itself (Clouds /
 *  Water / Grass / Ambient Occlusion / Stats). Every toggle is presentation-only
 *  — the Game applies them through render-time seams and the sim never sees them,
 *  so flipping one mid-run can't perturb a replay or a determinism pin. */
export function GraphicsOverlay({ gfx, open, onOpen, onClose, onChange }: GraphicsOverlayProps) {
  const [live, setLive] = useState<Live | null>(null);

  // poll the live perf readout a few times a second while the stats overlay is
  // shown — cheap (Game.perfLive allocates nothing) and strictly read-only.
  useEffect(() => {
    if (!gfx.stats) {
      setLive(null);
      return;
    }
    const read = () => setLive(getGame()?.perfLive?.() ?? null);
    read();
    const id = window.setInterval(read, 250);
    return () => window.clearInterval(id);
  }, [gfx.stats]);

  return (
    <div className="gfxCorner">
      {gfx.stats && (
        <div className="perfHud" title="Live render stats">
          <div className="perfRow">
            <span>FPS</span>
            <b className={live && live.fps < 50 ? 'lo' : undefined}>{live ? live.fps : '—'}</b>
          </div>
          <div className="perfRow">
            <span>DRAW</span>
            <b>{live ? fmt(live.calls) : '—'}</b>
          </div>
          <div className="perfRow">
            <span>TRIS</span>
            <b>{live ? fmt(live.triangles) : '—'}</b>
          </div>
        </div>
      )}

      <button
        className={`gfxGear${open ? ' active' : ''}`}
        onClick={(e) => {
          if (open) onClose();
          else onOpen();
          e.currentTarget.blur();
        }}
        title="Graphics settings"
      >
        &#9881; GRAPHICS
      </button>

      {open && (
        <div className="gfxPanel">
          <div className="gfxHead">
            <span>GRAPHICS</span>
            <button onClick={onClose} title="Close">
              &times;
            </button>
          </div>
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="gfxGroupLabel">{group.title}</div>
              {group.rows.map((t) => (
                <button
                  key={t.key}
                  className={`gfxToggle${gfx[t.key] ? ' on' : ''}`}
                  onClick={(e) => {
                    onChange({ [t.key]: !gfx[t.key] } as Partial<GraphicsSettings>);
                    e.currentTarget.blur();
                  }}
                  title={t.hint}
                >
                  <span className="gfxToggleLabel">{t.label}</span>
                  <span className="gfxToggleState">{gfx[t.key] ? 'ON' : 'OFF'}</span>
                </button>
              ))}
            </div>
          ))}
          <div className="gfxNote">
            Presentation only &middot; turn layers off to isolate the framerate / draw-call cost. Water &amp; grass affect coast levels.
          </div>
        </div>
      )}
    </div>
  );
}
