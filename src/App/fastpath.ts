import type { TimeOfDay } from '../game/daynight';
import { LEVELS, type LevelId } from '../game/levels';
import { PLAYER_CARS, type PlayerCarId } from '../game/models';

/** The front-end state machine. Browsing the menus (TITLE…CARSELECT) is pure,
 *  lightweight React with a themed background — NO game level is mounted. The
 *  heavy Game (which loads the level + streams assets) mounts ONCE on entering
 *  GAMEPLAY (LOADING→INGAME) and unmounts on returning to the menu. That
 *  decoupling is the lag fix: switching events no longer reloads a level. */
export type Phase = 'title' | 'main' | 'settings' | 'events' | 'carselect' | 'editor' | 'gameplay';

export const isTod = (v: unknown): v is TimeOfDay => v === 'day' || v === 'dusk' || v === 'night';

/** Read the programmatic fast-path params: ?level=&car=&tod=&launch=1 jumps
 *  straight to GAMEPLAY on the chosen level, bypassing the menu/car flow (the
 *  test harnesses use this; ?replay= has its own direct-mount path). */
export function readFastPath(): { level: LevelId; car?: PlayerCarId; tod?: TimeOfDay } | null {
  const p = new URLSearchParams(location.search);
  if (!p.has('launch')) return null;
  const level = p.get('level');
  if (!level || !(level in LEVELS)) return null;
  const car = p.get('car');
  const tod = p.get('tod');
  return {
    level: level as LevelId,
    car: PLAYER_CARS.some((c) => c.id === car) ? (car as PlayerCarId) : undefined,
    tod: isTod(tod) ? tod : undefined,
  };
}
