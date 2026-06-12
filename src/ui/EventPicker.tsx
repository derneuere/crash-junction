import { useEffect } from 'react';
import type { TimeOfDay } from '../game/daynight';
import { LEVELS, LEVEL_LABELS, type LevelId } from '../game/levels';
import { PLAYER_CARS, type PlayerCarId } from '../game/models';
import type { BestMap } from './storage';
import { EventCard } from './EventCard';
import { synthKey } from './keys';

interface EventPickerProps {
  /** Mounted level == focused card: browsing IS selecting, so the attract
   *  orbit behind the picker always shows the event under the cursor. */
  levelId: LevelId;
  /** Current time-of-day (the focused card's active variant). */
  tod: TimeOfDay;
  /** What each card opens with (per-event memory merged in App). */
  variants: Record<LevelId, TimeOfDay>;
  best: BestMap;
  carId: PlayerCarId;
  onSelectEvent: (id: LevelId, tod?: TimeOfDay) => void;
  onSelectCar: (id: PlayerCarId) => void;
  onOpenDebug: () => void;
}

const ORDER = Object.keys(LEVELS) as LevelId[];

/** The B3 Crash Nav strip (research doc §3): region header, one card per
 *  event with DAY/NIGHT variant chips, the car roster footer. Idle-only —
 *  Hud unmounts it the moment a take starts. */
export function EventPicker({
  levelId, tod, variants, best, carId, onSelectEvent, onSelectCar, onOpenDebug,
}: EventPickerProps) {
  // keyboard browse: ←/→ walk the strip, ↑/↓/Tab flip the focused variant,
  // Space stays the game's own launch key (Game.ts listens on window)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const i = ORDER.indexOf(levelId);
        const next = ORDER[(i + (e.code === 'ArrowRight' ? 1 : ORDER.length - 1)) % ORDER.length];
        onSelectEvent(next);
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'Tab') {
        if (e.code === 'Tab') e.preventDefault(); // variant flip, not focus walk
        onSelectEvent(levelId, tod === 'day' ? 'night' : 'day');
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [levelId, tod, onSelectEvent]);

  return (
    <div className="picker">
      <div className="region">CRASH JUNCTION ISLANDS</div>
      <div className="cards">
        {ORDER.map((id) => (
          <EventCard
            key={id}
            id={id}
            label={LEVEL_LABELS[id]}
            mode={LEVELS[id].mode.kind}
            focused={id === levelId}
            variant={id === levelId ? tod : variants[id]}
            best={best[id]}
            onFocus={() => onSelectEvent(id)}
            onVariant={(t) => onSelectEvent(id, t)}
            onLaunch={() => synthKey('Space')}
          />
        ))}
      </div>
      <div className="carRow">
        <span className="carLbl">CAR</span>
        {PLAYER_CARS.map((c) => (
          <button
            key={c.id}
            className={c.id === carId ? 'active' : undefined}
            title={c.tagline}
            onClick={(e) => {
              onSelectCar(c.id);
              e.currentTarget.blur();
            }}
          >
            {c.label} &middot; {c.flavor.toUpperCase()}
          </button>
        ))}
        <button className="devBtn" title="Debug overlay (` toggles)" onClick={onOpenDebug}>
          DEV
        </button>
      </div>
    </div>
  );
}
