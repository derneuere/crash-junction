import { useEffect } from 'react';
import type { TimeOfDay } from '../../game/daynight';
import { LEVELS, LEVEL_LABELS, type LevelId } from '../../game/levels';
import type { BestMap } from '../storage';
import { EventCard } from '../EventCard';
import { useMenuPad } from './useMenuPad';

interface EventSelectProps {
  /** Highlighted event (browsing only — NO level loads here). */
  levelId: LevelId;
  /** Variant the highlighted card shows / will launch with. */
  tod: TimeOfDay;
  /** What each card opens with (per-event memory merged in App). */
  variants: Record<LevelId, TimeOfDay>;
  best: BestMap;
  /** Move the highlight to an event, optionally pinning its variant. */
  onSelectEvent: (id: LevelId, tod?: TimeOfDay) => void;
  /** Commit the highlighted event → advance to CAR SELECT. */
  onConfirm: () => void;
  onBack: () => void;
}

const ORDER = Object.keys(LEVELS) as LevelId[];
const TOD_CYCLE: Record<TimeOfDay, TimeOfDay> = { day: 'dusk', dusk: 'night', night: 'day' };

/** Screen 4 — EVENT SELECT (B3 "Crash Nav / select location" vibe). The four
 *  levels are the events; each card shows its stakes (laps/rivals/gold) and a
 *  DAY/DUSK/NIGHT variant choice. Reuses EventCard + eventMeta verbatim, just
 *  hosted in the menu flow instead of over a live level.
 *
 *  CRITICAL: highlighting a card does NOT mount a Game — that's the whole lag
 *  fix. The heavy level only loads after CAR SELECT, behind the LOADING screen.
 *  ←/→ walk the strip, ↑/↓/Tab cycle the highlighted variant, Enter / LAUNCH /
 *  pad-A confirms → CAR SELECT, ESC / B backs out. */
export function EventSelect({
  levelId, tod, variants, best, onSelectEvent, onConfirm, onBack,
}: EventSelectProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        const i = ORDER.indexOf(levelId);
        const next = ORDER[(i + (e.code === 'ArrowRight' ? 1 : ORDER.length - 1)) % ORDER.length];
        onSelectEvent(next);
      } else if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'Tab') {
        e.preventDefault();
        onSelectEvent(levelId, TOD_CYCLE[tod]);
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
        e.preventDefault();
        onConfirm();
      } else if (e.code === 'Escape') {
        onBack();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [levelId, tod, onSelectEvent, onConfirm, onBack]);

  useMenuPad({
    onLeft: () => {
      const i = ORDER.indexOf(levelId);
      onSelectEvent(ORDER[(i + ORDER.length - 1) % ORDER.length]);
    },
    onRight: () => {
      const i = ORDER.indexOf(levelId);
      onSelectEvent(ORDER[(i + 1) % ORDER.length]);
    },
    onUp: () => onSelectEvent(levelId, TOD_CYCLE[tod]),
    onDown: () => onSelectEvent(levelId, TOD_CYCLE[tod]),
    onConfirm,
    onBack,
  });

  return (
    <div className="screen eventScreen">
      <div className="bgSwoosh" aria-hidden />
      <div className="bgGrid" aria-hidden />

      <div className="menuHeader">
        <div className="menuKicker">SELECT EVENT</div>
        <div className="region">CRASH JUNCTION ISLANDS</div>
      </div>

      <div className="cards eventCards">
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
            onLaunch={onConfirm}
          />
        ))}
      </div>

      <div className="menuFoot">
        &#9664;&#9654; SELECT &middot; &#9650;&#9660; VARIANT &middot; ENTER / LAUNCH &rarr; GARAGE
      </div>
      <button className="backBtn" onClick={onBack}>&#9664; BACK</button>
    </div>
  );
}
