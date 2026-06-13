import { useState } from 'react';
import type { EngineFlavor } from '../../game/audio';
import type { TimeOfDay } from '../../game/daynight';
import { ControlsPanel } from '../ControlsPanel';
import { useMenuPad } from './useMenuPad';

interface SettingsProps {
  timeOfDay: TimeOfDay; // default time-of-day for new events
  engineSound: EngineFlavor;
  muted: boolean;
  onSetTimeOfDay: (t: TimeOfDay) => void;
  onSetEngineSound: (f: EngineFlavor) => void;
  onSetMuted: (m: boolean) => void;
  onBack: () => void;
}

const TODS: { id: TimeOfDay; label: string; icon: string }[] = [
  { id: 'day', label: 'DAY', icon: '☀' },
  { id: 'dusk', label: 'DUSK', icon: '☄' },
  { id: 'night', label: 'NIGHT', icon: '☽' },
];

const ENGINES: { id: EngineFlavor; label: string; sub: string }[] = [
  { id: 'stock', label: 'STOCK', sub: 'ONBOARD RECORDING' },
  { id: 'v10', label: 'V10', sub: 'EXOTIC SCREAM' },
  { id: 'v8', label: 'V8', sub: 'MUSCLE RUMBLE' },
];

/** Screen 3 — settings. Consolidates what used to be scattered across the idle
 *  screen + debug overlay: default time-of-day, engine flavor, sound (mute),
 *  and the CONTROLS reference (reuses ControlsPanel). Lightweight React, no
 *  game level. ESC / B / BACK returns to the main menu. */
export function Settings({
  timeOfDay, engineSound, muted,
  onSetTimeOfDay, onSetEngineSound, onSetMuted, onBack,
}: SettingsProps) {
  const [controlsOpen, setControlsOpen] = useState(false);

  // ESC backs out (but ControlsPanel owns ESC while it's open)
  useMenuPad({ onBack: () => (controlsOpen ? setControlsOpen(false) : onBack()) });

  return (
    <div className="screen settingsScreen">
      <div className="bgSwoosh" aria-hidden />
      <div className="bgGrid" aria-hidden />

      <div className="menuHeader">
        <div className="menuKicker">SETTINGS</div>
        <div className="menuWordmark sm">CRASH JUNCTION</div>
      </div>

      <div className="setBody">
        <div className="setGroup">
          <div className="setLabel">DEFAULT TIME OF DAY</div>
          <div className="setRow">
            {TODS.map((t) => (
              <button
                key={t.id}
                className={`pill${timeOfDay === t.id ? ' active' : ''}`}
                onClick={(e) => { onSetTimeOfDay(t.id); e.currentTarget.blur(); }}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
          <div className="setHint">Per-event variant can still be chosen on the event card.</div>
        </div>

        <div className="setGroup">
          <div className="setLabel">ENGINE FLAVOR</div>
          <div className="setRow">
            {ENGINES.map((f) => (
              <button
                key={f.id}
                className={`pill${engineSound === f.id ? ' active' : ''}`}
                onClick={(e) => { onSetEngineSound(f.id); e.currentTarget.blur(); }}
                title={f.sub}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="setHint">Picking a car in the GARAGE overrides this with the car&rsquo;s voice.</div>
        </div>

        <div className="setGroup">
          <div className="setLabel">SOUND</div>
          <div className="setRow">
            <button
              className={`pill${!muted ? ' active' : ''}`}
              onClick={(e) => { onSetMuted(false); e.currentTarget.blur(); }}
            >
              &#9835; ON
            </button>
            <button
              className={`pill${muted ? ' active' : ''}`}
              onClick={(e) => { onSetMuted(true); e.currentTarget.blur(); }}
            >
              &#128263; MUTE
            </button>
          </div>
          <div className="setHint">M toggles mute in-game too.</div>
        </div>

        <div className="setGroup">
          <div className="setLabel">REFERENCE</div>
          <div className="setRow">
            <button className="pill" onClick={() => setControlsOpen(true)}>
              &#9000; CONTROLS
            </button>
          </div>
          <div className="setHint">Keyboard &amp; Xbox 360 / compatible controller bindings.</div>
        </div>

        <div className="setCredits">
          CRASH JUNCTION &middot; REACT + THREE.JS + CANNON-ES &middot; CC0 VEHICLE MODELS BY QUATERNIUS
        </div>
      </div>

      <button className="backBtn" onClick={onBack}>&#9664; BACK</button>

      {controlsOpen && <ControlsPanel mode="crash" onClose={() => setControlsOpen(false)} />}
    </div>
  );
}
