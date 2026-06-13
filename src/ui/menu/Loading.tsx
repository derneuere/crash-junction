import { useEffect, useState } from 'react';
import type { TimeOfDay } from '../../game/daynight';
import { LEVEL_LABELS, type LevelId } from '../../game/levels';
import { EVENT_META } from '../eventMeta';

interface LoadingProps {
  level: LevelId;
  tod: TimeOfDay;
  /** True once the Game is mounted and the level's actors/props are up. App
   *  drives this; when it flips, Loading calls onReady after a short minimum
   *  so the screen never just flickers. */
  ready: boolean;
  onReady: () => void;
}

const MIN_MS = 650; // floor so a fast (cached) load still reads as a beat

/** Screen 6 — LOADING. A themed card shown while the heavy Game/level mounts
 *  and the GLB props stream in. It does NOT mount the Game itself — App mounts
 *  the Game underneath (off-screen) and flips `ready` when the world is up;
 *  Loading then fades to gameplay. The chrome bar fills on a timer purely as
 *  feedback (the real gate is `ready`). */
export function Loading({ level, tod, ready, onReady }: LoadingProps) {
  const [shownAt] = useState(() => performance.now());
  const [pct, setPct] = useState(8);

  // cosmetic fill — eases toward 90% while loading, snaps to 100 once ready
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setPct((p) => (ready ? Math.min(100, p + 6) : Math.min(90, p + (90 - p) * 0.04)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  // hand off to gameplay once ready AND the minimum beat has elapsed
  useEffect(() => {
    if (!ready) return;
    const wait = Math.max(0, MIN_MS - (performance.now() - shownAt));
    const id = window.setTimeout(onReady, wait);
    return () => window.clearTimeout(id);
  }, [ready, shownAt, onReady]);

  const meta = EVENT_META[level];

  return (
    <div className="screen loadingScreen">
      <div className="bgSwoosh" aria-hidden />
      <div className="bgGrid" aria-hidden />

      <div className="loadCard">
        <div className="loadKicker">LOADING EVENT</div>
        <div className="loadName">{LEVEL_LABELS[level]}</div>
        <div className="loadTag">{meta.tagline} &middot; {tod.toUpperCase()}</div>
        <div className="loadStakes">{meta.modeLine}</div>

        <div className="loadBar">
          <div className="loadFill" style={{ width: `${pct}%` }} />
        </div>
        <div className="loadPct">{Math.round(pct)}%</div>
      </div>

      <div className="loadHint">DRESSING THE WORLD&hellip;</div>
    </div>
  );
}
