import type { Medal } from '../game/events';
import type { TimeOfDay } from '../game/daynight';
import { LEVELS, type LevelId } from '../game/levels';
import { DEFAULT_CAR, PLAYER_CARS, type PlayerCarId } from '../game/models';
import { DEFAULT_GRAPHICS, IS_MOBILE, type GraphicsSettings } from '../game/graphics';

// localStorage contracts for the event picker (research doc §3.6).
//
//   cj-tod    last launched variant — LEGACY key; tools/refshot.mjs and old
//             links rely on it surviving, so it keeps being written
//   cj-sel    { level, tod, perEvent } — last selection + the per-event
//             variant memory the cards reopen with
//   cj-best   { [levelId]: { day, dusk, night } } — best medal per event
//             variant (pre-dusk saves had two slots; absent keys just read
//             as "never medaled", so no migration step is needed)
//   cj-car    player car id (v1 roster, models.ts)
//   cj-engine engine flavor — owned by App since the flavor feature, unchanged
//
// Everything here is presentation-side persistence: the sim never reads it
// (App applies tod/car/engine at the remount take boundary).

export type BestMap = Partial<Record<LevelId, Partial<Record<TimeOfDay, Medal>>>>;

export interface Selection {
  level: LevelId;
  tod: TimeOfDay;
  perEvent: Partial<Record<LevelId, TimeOfDay>>;
}

/** Upgrade-only ordering: a SILVER run never demotes a GOLD record. */
const MEDAL_RANK: Record<Medal, number> = { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3 };

const isLevel = (v: unknown): v is LevelId => typeof v === 'string' && v in LEVELS;
const isTod = (v: unknown): v is TimeOfDay => v === 'day' || v === 'dusk' || v === 'night';
const isMedal = (v: unknown): v is Medal =>
  v === 'GOLD' || v === 'SILVER' || v === 'BRONZE' || v === 'NONE';

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // a corrupt key behaves like an absent one
  }
}

export function readSel(): Selection | null {
  const raw = readJson('cj-sel');
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isLevel(o.level) || !isTod(o.tod)) return null;
  const perEvent: Partial<Record<LevelId, TimeOfDay>> = {};
  if (typeof o.perEvent === 'object' && o.perEvent !== null) {
    for (const [k, v] of Object.entries(o.perEvent)) {
      if (isLevel(k) && isTod(v)) perEvent[k] = v;
    }
  }
  return { level: o.level, tod: o.tod, perEvent };
}

export function writeSel(sel: Selection): void {
  localStorage.setItem('cj-sel', JSON.stringify(sel));
}

export function readBest(): BestMap {
  const raw = readJson('cj-best');
  if (typeof raw !== 'object' || raw === null) return {};
  const out: BestMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!isLevel(k) || typeof v !== 'object' || v === null) continue;
    const slot: Partial<Record<TimeOfDay, Medal>> = {};
    for (const [tk, tv] of Object.entries(v)) {
      if (isTod(tk) && isMedal(tv) && tv !== 'NONE') slot[tk] = tv;
    }
    if (Object.keys(slot).length) out[k] = slot;
  }
  return out;
}

export function writeBest(map: BestMap): void {
  localStorage.setItem('cj-best', JSON.stringify(map));
}

/** Upgrade-only merge: returns the SAME object when the run didn't beat the
 *  record, so callers can use identity to skip the localStorage write. */
export function upgradeBest(map: BestMap, level: LevelId, tod: TimeOfDay, medal: Medal): BestMap {
  if (medal === 'NONE') return map; // "ran, no medal" displays the same as "never ran"
  const prev = map[level]?.[tod];
  if (prev && MEDAL_RANK[prev] >= MEDAL_RANK[medal]) return map;
  return { ...map, [level]: { ...map[level], [tod]: medal } };
}

export function readCar(): PlayerCarId {
  const raw = localStorage.getItem('cj-car');
  return PLAYER_CARS.some((c) => c.id === raw) ? (raw as PlayerCarId) : DEFAULT_CAR;
}

//   cj-mute  '1' = start muted. The in-game M key still toggles live; this is
//            only the SETTINGS default applied once a Game mounts.
export function readMuted(): boolean {
  return localStorage.getItem('cj-mute') === '1';
}

export function writeMuted(m: boolean): void {
  localStorage.setItem('cj-mute', m ? '1' : '0');
}

//   cj-gfx   graphics toggles { clouds, water, grass, ao, reflections, shadows,
//            props, stats }. All presentation-only; the Game applies the visual
//            ones at mount (and live via setGraphics), `stats` only shows the
//            corner readout. Each key falls back to its default, so a partial/old
//            blob upgrades cleanly with no migration step.
export function readGraphics(): GraphicsSettings {
  const raw = readJson('cj-gfx');
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_GRAPHICS };
  const o = raw as Record<string, unknown>;
  // one-time migration: a blob saved before the quality tiers existed carries
  // ao/reflections=true from the old desktop-only defaults — on a phone that
  // would boot the ×6 cube + composer right back into the framerate hole the
  // tier exists to avoid. Stale schema on mobile ⇒ take the fresh phone
  // defaults wholesale (any toggle the user flips after this is respected,
  // because the re-saved blob then carries the new fields).
  if (IS_MOBILE && typeof o.postfx !== 'boolean') return { ...DEFAULT_GRAPHICS };
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    clouds: bool(o.clouds, DEFAULT_GRAPHICS.clouds),
    water: bool(o.water, DEFAULT_GRAPHICS.water),
    grass: bool(o.grass, DEFAULT_GRAPHICS.grass),
    ao: bool(o.ao, DEFAULT_GRAPHICS.ao),
    reflections: bool(o.reflections, DEFAULT_GRAPHICS.reflections),
    shadows: bool(o.shadows, DEFAULT_GRAPHICS.shadows),
    props: bool(o.props, DEFAULT_GRAPHICS.props),
    stats: bool(o.stats, DEFAULT_GRAPHICS.stats),
    postfx: bool(o.postfx, DEFAULT_GRAPHICS.postfx),
    renderScale: num(o.renderScale, DEFAULT_GRAPHICS.renderScale),
    shadowSize: num(o.shadowSize, DEFAULT_GRAPHICS.shadowSize),
    grassRange: num(o.grassRange, DEFAULT_GRAPHICS.grassRange),
    drawDistance: num(o.drawDistance, DEFAULT_GRAPHICS.drawDistance),
    carBlobShadows: bool(o.carBlobShadows, DEFAULT_GRAPHICS.carBlobShadows),
  };
}

export function writeGraphics(s: GraphicsSettings): void {
  localStorage.setItem('cj-gfx', JSON.stringify(s));
}
