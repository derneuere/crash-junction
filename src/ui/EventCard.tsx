import type { Medal } from '../game/events';
import type { TimeOfDay } from '../game/daynight';
import type { LevelId } from '../game/levels';
import type { ModeKind } from '../game/types';
import { EVENT_META, Thumb } from './eventMeta';
import { MedalDisc } from './MedalDisc';
import { ModeIcon } from './ModeIcon';

interface EventCardProps {
  id: LevelId;
  label: string;
  mode: ModeKind;
  focused: boolean;
  /** The variant this card opens (and, when focused, launches) with. */
  variant: TimeOfDay;
  /** Best medal per variant — undefined slot = never medaled. */
  best: Partial<Record<TimeOfDay, Medal>> | undefined;
  onFocus: () => void;
  onVariant: (t: TimeOfDay) => void;
  onLaunch: () => void;
}

const MEDAL_RANK: Record<Medal, number> = { NONE: 0, BRONZE: 1, SILVER: 2, GOLD: 3 };

/** One B3 Crash Nav event slot (research doc §3.4): thumbnail, mode icon +
 *  best-medal disc, slanted-caps name, stakes line, DAY/NIGHT variant chips
 *  each wearing its own medal pip, and the LAUNCH row when focused.
 *
 *  CONTRACT (tools/refshot.mjs): the name button's visible text is EXACTLY
 *  the level label (it drives /^GANTRY POINT$/), and the day chip's text
 *  keeps a bare DAY word (it drives /\bDAY\b/). Keep both as real <button>s. */
export function EventCard({
  id, label, mode, focused, variant, best, onFocus, onVariant, onLaunch,
}: EventCardProps) {
  const meta = EVENT_META[id];
  // the slot's headline medal — best across both variants, B3's at-a-glance read
  const bestAny = ([best?.day, best?.night].filter(Boolean) as Medal[])
    .sort((a, b) => MEDAL_RANK[b] - MEDAL_RANK[a])[0] ?? null;
  const chip = (t: TimeOfDay, icon: string, text: string) => (
    <button
      className={`chip${focused && variant === t ? ' active' : ''}`}
      onClick={(e) => {
        e.stopPropagation(); // a chip click IS the selection — no card re-focus
        onVariant(t);
        e.currentTarget.blur(); // keep Space on the game's launch, not the chip
      }}
      title={`${label} · ${text}`}
    >
      {icon} {text} <MedalDisc medal={best?.[t]} />
    </button>
  );
  return (
    <div className={`card${focused ? ' focused' : ''}`} onClick={onFocus}>
      <div className="thumb">
        <Thumb id={id} />
        {/* top-right slot reserved for B3's padlock/NEW — all v1 events open */}
      </div>
      <div className="modeRow">
        <span className="modeKind">
          <ModeIcon kind={mode} /> {mode.toUpperCase()}
        </span>
        <MedalDisc medal={bestAny} />
      </div>
      <button
        className="evName"
        onClick={(e) => {
          e.stopPropagation();
          onFocus();
          e.currentTarget.blur();
        }}
      >
        {label}
      </button>
      <div className="tagline">{meta.tagline}</div>
      <div className="modeLine">{meta.modeLine}</div>
      <div className="variants">
        {chip('day', '☀', 'DAY')}
        {chip('night', '☽', 'NIGHT')}
      </div>
      {/* hidden (not unmounted) when unfocused so cards keep one height */}
      <button
        className="launchRow"
        style={focused ? undefined : { visibility: 'hidden' }}
        onClick={(e) => {
          e.stopPropagation();
          onLaunch();
          e.currentTarget.blur();
        }}
      >
        &#9658; LAUNCH
      </button>
    </div>
  );
}
