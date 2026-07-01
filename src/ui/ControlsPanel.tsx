import { useEffect } from 'react';
import type { ModeKind } from '../game/types';

interface ControlsPanelProps {
  mode: ModeKind;
  onClose: () => void;
}

interface Binding {
  action: string;
  keyboard: string;
  pad: string; // Xbox 360 binding
  crashOnly?: boolean;
}

/** Keyboard + Xbox 360 controller bindings. The pad column tracks the
 *  controller sibling's mapping: Steer = Left stick / D-pad, Accelerate = RT,
 *  Boost = A, Brake/Drift = LT or B, Aftertouch = Left stick, Crashbreaker = X,
 *  Launch/Restart = Start. Keep this list in sync with src/game input. */
const BINDINGS: Binding[] = [
  { action: 'Accelerate', keyboard: '↑ / W', pad: 'RT' },
  { action: 'Steer', keyboard: '← → / A D', pad: 'Left stick / D-pad' },
  { action: 'Boost', keyboard: 'Space', pad: 'A' },
  { action: 'Brake / Drift', keyboard: '↓ / S', pad: 'LT or B' },
  { action: 'Aftertouch (after crash)', keyboard: '← ↑ ↓ →', pad: 'Left stick' },
  { action: 'Crashbreaker', keyboard: 'E', pad: 'X', crashOnly: true },
  { action: 'Launch / Restart', keyboard: 'Enter', pad: 'Start' },
  { action: 'Mute', keyboard: 'M', pad: '—' },
  { action: 'Bug report', keyboard: 'R', pad: '—' },
  { action: 'Debug overlay', keyboard: '`', pad: '—' },
];

/** A tidy controls reference behind a toggle — keeps the long bindings list
 *  off the idle screen until asked for. Centered dark B3-style panel; closes on
 *  Esc, on the backdrop, or via the close button. Purely presentational. */
export function ControlsPanel({ mode, onClose }: ControlsPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = BINDINGS.filter((b) => !b.crashOnly || mode === 'crash');

  return (
    <div className="ctrlBackdrop" onClick={onClose}>
      <div className="ctrlPanel" onClick={(e) => e.stopPropagation()}>
        <div className="ctrlHead">
          <span className="ctrlTitle">CONTROLS</span>
          <button className="ctrlClose" onClick={onClose} title="Close (Esc)">
            &times;
          </button>
        </div>
        <table className="ctrlTable">
          <thead>
            <tr>
              <th>ACTION</th>
              <th>KEYBOARD</th>
              <th>CONTROLLER</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.action}>
                <td className="ctrlAct">{b.action}</td>
                <td className="ctrlKey">{b.keyboard}</td>
                <td className="ctrlPad">{b.pad}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ctrlFoot">
          XBOX 360 &amp; COMPATIBLE PADS &middot; ON-SCREEN CONTROLS ON TOUCH DEVICES &middot; ESC TO CLOSE
        </div>
      </div>
    </div>
  );
}
