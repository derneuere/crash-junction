import { LEVELS, type LevelId } from '../game/levels';
import { usd } from './chips';

// Per-event card copy + thumbnail art (research doc §3.4).
//
// NOTE for the merge pass: the doc places EVENT_META beside LEVEL_LABELS in
// src/game/levels/index.ts; that file is owned by the level agents in this
// workflow, so the meta lives UI-side for now. The stakes lines are DERIVED
// from the live LevelDefs (laps, rivals, gold target) so they can never
// drift from the sim's numbers, whoever moves this later.

export interface EventMeta {
  /** Location flavor under the icon row — B3's one-line location read. */
  tagline: string;
  /** The stakes: crash = gold target, race = laps/rivals, practice = none. */
  modeLine: string;
}

function stakes(id: LevelId): string {
  const mode = LEVELS[id].mode;
  switch (mode.kind) {
    case 'crash':
      return `4-WAY · GOLD ${usd(mode.medals.gold)}`;
    case 'practice':
      return 'FREE PRACTICE · NO STAKES';
    case 'race':
      return `${mode.race.laps} LAPS · ${mode.race.rivals.length} RIVALS`;
  }
}

export const EVENT_META: Record<LevelId, EventMeta> = {
  junction: { tagline: 'CROSSTOWN INTERCHANGE', modeLine: stakes('junction') },
  track: { tagline: 'OPEN ASPHALT', modeLine: stakes('track') },
  race: { tagline: 'LAKESIDE CIRCUIT', modeLine: stakes('race') },
  gantry: { tagline: 'HARBOR ISLAND', modeLine: stakes('gantry') },
};

// ---------- thumbnails ----------
// Stylized location plates, inline SVG (no image assets): the junction's
// crossroad, the proving ground's skidpad, SILVER LAKE's ring, and GANTRY
// POINT drawn as its island map art (GDD §3) — the map itch without a map
// screen. Decorative only.

const ROAD = '#2a2e36';
const DASH = 'rgba(255,255,255,0.5)';
const GRASS = '#23341f';
const SEA = '#16222e';
const SAND = '#6e5d3a';
const GOLD = 'rgba(255,211,77,0.9)';

const PLATE = {
  viewBox: '0 0 120 56',
  preserveAspectRatio: 'xMidYMid slice' as const,
  'aria-hidden': true as const,
};

export function Thumb({ id }: { id: LevelId }) {
  switch (id) {
    case 'junction':
      // the four-way: two crossing roads, a starburst where they meet
      return (
        <svg {...PLATE}>
          <rect width="120" height="56" fill={GRASS} />
          <rect x="0" y="20" width="120" height="16" fill={ROAD} />
          <rect x="52" y="0" width="16" height="56" fill={ROAD} />
          <rect x="6" y="27.4" width="10" height="1.4" fill={DASH} />
          <rect x="24" y="27.4" width="10" height="1.4" fill={DASH} />
          <rect x="86" y="27.4" width="10" height="1.4" fill={DASH} />
          <rect x="104" y="27.4" width="10" height="1.4" fill={DASH} />
          <polygon
            points="60,18 63,25 70,22 65,28 72,30 65,31.5 69,38 62.5,33.5 60,41 57.5,33.5 51,38 55,31.5 48,30 55,28 50,22 57,25"
            fill="#ff7a18"
          />
        </svg>
      );
    case 'track':
      // the proving ground: a skidpad ring and a drift line of dashes
      return (
        <svg {...PLATE}>
          <rect width="120" height="56" fill="#33363d" />
          <circle cx="44" cy="28" r="16" fill="none" stroke={DASH} strokeWidth="1.6" />
          <circle cx="44" cy="28" r="2" fill={DASH} />
          <rect x="72" y="14" width="9" height="1.4" fill={DASH} transform="rotate(18 76 14)" />
          <rect x="84" y="22" width="9" height="1.4" fill={DASH} transform="rotate(18 88 22)" />
          <rect x="96" y="30" width="9" height="1.4" fill={DASH} transform="rotate(18 100 30)" />
        </svg>
      );
    case 'race':
      // SILVER LAKE RING: the lakeside loop, water in the infield
      return (
        <svg {...PLATE}>
          <rect width="120" height="56" fill={GRASS} />
          <ellipse cx="60" cy="28" rx="46" ry="19" fill="none" stroke={ROAD} strokeWidth="9" />
          <ellipse cx="60" cy="28" rx="24" ry="8" fill={SEA} />
          <rect x="56" y="42.5" width="8" height="9" fill={DASH} opacity="0.8" />
        </svg>
      );
    case 'gantry':
      // GANTRY POINT island plate: coastline, circuit loop, dockside cranes
      return (
        <svg {...PLATE}>
          <rect width="120" height="56" fill={SEA} />
          <polygon
            points="14,34 22,16 38,8 66,5 92,10 110,22 112,38 98,50 70,53 40,52 20,46"
            fill={GRASS}
            stroke={SAND}
            strokeWidth="2.5"
          />
          <path
            d="M30 38 Q26 24 42 16 Q60 9 84 14 Q102 19 100 32 Q97 44 72 46 Q44 48 30 38 Z"
            fill="none"
            stroke={ROAD}
            strokeWidth="5"
          />
          <rect x="78" y="12" width="2" height="10" fill={GOLD} />
          <rect x="74" y="12" width="12" height="2" fill={GOLD} />
          <rect x="92" y="18" width="2" height="9" fill={GOLD} />
          <rect x="88" y="18" width="11" height="2" fill={GOLD} />
        </svg>
      );
  }
}
