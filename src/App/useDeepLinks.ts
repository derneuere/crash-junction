import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { TimeOfDay } from '../game/daynight';
import { LEVELS, type LevelId } from '../game/levels';
import { PLAYER_CARS, type PlayerCarId } from '../game/models';
import { parseReplayFile, type ReplayFile } from '../game/replay';
import { isTod } from './fastpath';

/** The callbacks the programmatic + drag-drop + URL replay entry points reach
 *  for. Grouped so the three deep-link effects can live in their own module
 *  while staying a byte-for-byte move of the originals. */
export interface DeepLinkDeps {
  setTimeOfDay: (t: TimeOfDay) => void;
  selectCar: (id: PlayerCarId) => void;
  setLevelId: Dispatch<SetStateAction<LevelId>>;
  startGameplay: (autoLaunch?: boolean) => void;
  loadReplay: (file: ReplayFile, fast: boolean) => void;
}

/** Wire the three menu-bypassing entry points into gameplay:
 *  - window.__startLevel(levelId, carId?, tod?): the programmatic fast path
 *    (harness + console). Jumps straight to gameplay on the chosen level,
 *    bypassing the title/menu/car flow. Mirrors ?level=&car=&tod=&launch=1.
 *  - drag a crash-report JSON anywhere onto the page to replay it.
 *  - ?replay=<url>[&verify=1] — auto-load a report; verify fast-forwards and
 *    writes the verdict to window.__replayResult / document.title. */
export function useDeepLinks(deps: DeepLinkDeps): void {
  const { setTimeOfDay, selectCar, setLevelId, startGameplay, loadReplay } = deps;

  // window.__startLevel(levelId, carId?, tod?): the programmatic fast path
  // (harness + console). Jumps straight to gameplay on the chosen level,
  // bypassing the title/menu/car flow. Mirrors ?level=&car=&tod=&launch=1.
  useEffect(() => {
    const w = window as unknown as { __startLevel?: (l: LevelId, c?: PlayerCarId, t?: TimeOfDay) => void };
    w.__startLevel = (l, c, t) => {
      if (!(l in LEVELS)) return;
      if (t && isTod(t)) setTimeOfDay(t);
      if (c && PLAYER_CARS.some((x) => x.id === c)) selectCar(c);
      setLevelId(l);
      startGameplay();
    };
    return () => { delete w.__startLevel; };
  }, [setTimeOfDay, selectCar, startGameplay]);

  // drag a crash-report JSON anywhere onto the page to replay it
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      f.text().then(
        (text) => {
          try {
            loadReplay(parseReplayFile(text), false);
          } catch (err) {
            alert(`Could not load replay: ${(err as Error).message}`);
          }
        },
        () => alert('Could not read the dropped file'),
      );
    };
    addEventListener('dragover', onDragOver);
    addEventListener('drop', onDrop);
    return () => {
      removeEventListener('dragover', onDragOver);
      removeEventListener('drop', onDrop);
    };
  }, [loadReplay]);

  // ?replay=<url>[&verify=1] — auto-load a report; verify fast-forwards and
  // writes the verdict to window.__replayResult / document.title
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const url = params.get('replay');
    if (!url) return;
    const fast = params.has('verify');
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => loadReplay(parseReplayFile(text), fast))
      .catch((err) => alert(`Could not load replay from ${url}: ${(err as Error).message}`));
  }, [loadReplay]);
}
