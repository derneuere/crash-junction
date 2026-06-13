import { useEffect, useState } from 'react';
import type { TimeOfDay } from '../game/daynight';
import type { LevelId } from '../game/levels';
import { LEVEL_LABELS } from '../game/levels';
import { PLAYER_CARS, type PlayerCarId } from '../game/models';

// ---------------------------------------------------------------------------
// PLACEHOLDER CarSelect — the real one ships from the GARAGE sibling agent
// (CarSelect.tsx + a 3D garage scene). This minimal list keeps the `frontend`
// branch building and walkable on its own; the merge swaps in the garage
// sibling's component, which MUST keep this prop contract:
//
//   interface CarSelectProps {
//     event:    LevelId;            // the committed event (for the header)
//     tod:      TimeOfDay;          // the committed variant (garage lighting)
//     cars:     readonly PlayerCarDef[];  // the roster (models.PLAYER_CARS)
//     carId:    PlayerCarId;        // current selection (highlight + default)
//     onSelect: (id: PlayerCarId) => void;  // pick a car (writes cj-car/-engine)
//     onConfirm:(id: PlayerCarId) => void;  // commit → LOADING → INGAME
//     onBack:   () => void;         // → EVENT SELECT
//   }
//
// App owns the flow: onSelect just updates the live selection (so the garage
// can preview the engine voice / body); onConfirm is what advances to LOADING
// and mounts the heavy Game. The garage may treat select+confirm as one click.
// ---------------------------------------------------------------------------

export interface CarSelectProps {
  /** The committed event — header context (the garage may show its skyline). */
  event: LevelId;
  /** The committed time-of-day — drives the garage lighting. */
  tod: TimeOfDay;
  /** The player-car roster (models.PLAYER_CARS). */
  cars: readonly { id: PlayerCarId; label: string; flavor: string; tagline: string }[];
  /** Current selection — highlight + the default confirm target. */
  carId: PlayerCarId;
  /** Pick a car (App writes cj-car + the car's engine voice). */
  onSelect: (id: PlayerCarId) => void;
  /** Commit a car → LOADING → INGAME (mounts the heavy Game). */
  onConfirm: (id: PlayerCarId) => void;
  /** Back to EVENT SELECT. */
  onBack: () => void;
}

/** Screen 5 — CAR SELECT (placeholder). A plain roster list; clicking a row
 *  selects it, DRIVE (or a second click) confirms → LOADING. The garage
 *  sibling replaces this with the 3D showroom; the prop contract above is the
 *  seam. Lightweight React, no game level — the Game mounts only after this. */
export default function CarSelect({
  event, tod, cars, carId, onSelect, onConfirm, onBack,
}: CarSelectProps) {
  const [sel, setSel] = useState<PlayerCarId>(carId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const i = cars.findIndex((c) => c.id === sel);
      if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') {
        const id = cars[(i + cars.length - 1) % cars.length].id;
        setSel(id);
        onSelect(id);
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowDown') {
        const id = cars[(i + 1) % cars.length].id;
        setSel(id);
        onSelect(id);
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
        e.preventDefault();
        onConfirm(sel);
      } else if (e.code === 'Escape') {
        onBack();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [cars, sel, onSelect, onConfirm, onBack]);

  const pick = (id: PlayerCarId) => {
    setSel(id);
    onSelect(id);
  };

  return (
    <div className="screen carScreen">
      <div className="bgSwoosh" aria-hidden />
      <div className="bgGrid" aria-hidden />

      <div className="menuHeader">
        <div className="menuKicker">SELECT CAR</div>
        <div className="region">
          {LEVEL_LABELS[event]} &middot; {tod.toUpperCase()}
        </div>
      </div>

      <ul className="carList">
        {cars.map((c) => (
          <li key={c.id}>
            <button
              className={`carCard${c.id === sel ? ' sel' : ''}`}
              onMouseEnter={() => pick(c.id)}
              onClick={() => (c.id === sel ? onConfirm(c.id) : pick(c.id))}
            >
              <span className="carName">{c.label}</span>
              <span className="carFlavor">{c.flavor.toUpperCase()} ENGINE</span>
              <span className="carTag">{c.tagline}</span>
            </button>
          </li>
        ))}
      </ul>

      <button className="driveBtn" onClick={() => onConfirm(sel)}>
        &#9658; DRIVE
      </button>

      <div className="menuFoot">SELECT A CAR &middot; ENTER / DRIVE &rarr; LOADING</div>
      <button className="backBtn" onClick={onBack}>&#9664; BACK</button>
    </div>
  );
}

/** Re-export the roster type so callers (App) and the garage sibling agree. */
export { PLAYER_CARS };
