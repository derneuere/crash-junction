import { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from './game/Game';
import type { EngineFlavor } from './game/audio';
import type { TimeOfDay } from './game/daynight';
import { LEVELS, type LevelId } from './game/levels';
import { GameState } from './game/types';
import { parseReplayFile, type ReplayFile } from './game/replay';
import type { CashFloatData, RaceStanding, ReportData } from './game/events';
import { Hud, type FlashState } from './ui/Hud';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const levelRef = useRef<LevelId | null>(null); // level of the mounted Game
  // a replay whose level isn't loaded yet — startReplay() fires once it is
  const pendingReplay = useRef<{ file: ReplayFile; fast: boolean } | null>(null);
  const [levelId, setLevelId] = useState<LevelId>('junction');
  const [state, setState] = useState(GameState.Idle);
  const [damage, setDamage] = useState(0);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [cash, setCash] = useState<CashFloatData[]>([]);
  const [crashbreaker, setCrashbreaker] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [boost, setBoost] = useState(1);
  const [race, setRace] = useState<RaceStanding | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [cineCam, setCineCam] = useState(false);
  const [timeOfDay, setTimeOfDayState] = useState<TimeOfDay>(() =>
    localStorage.getItem('cj-tod') === 'night' ? 'night' : 'day',
  );
  const todRef = useRef(timeOfDay); // the remount effect reads the live value
  const [engineSound, setEngineSoundState] = useState<EngineFlavor>(() => {
    const saved = localStorage.getItem('cj-engine');
    // default = stock (the pre-flavor behavior — switching voices is opt-in)
    return saved === 'v10' || saved === 'v8' ? saved : 'stock';
  });
  const engineRef = useRef(engineSound);

  const setTimeOfDay = useCallback((t: TimeOfDay) => {
    setTimeOfDayState(t);
    todRef.current = t;
    localStorage.setItem('cj-tod', t);
    gameRef.current?.setTimeOfDay(t);
  }, []);

  const setEngineSound = useCallback((f: EngineFlavor) => {
    setEngineSoundState(f);
    engineRef.current = f;
    localStorage.setItem('cj-engine', f);
    gameRef.current?.setEngineFlavor(f);
  }, []);

  useEffect(() => {
    const game = new Game(containerRef.current!, LEVELS[levelId]);
    game.setTimeOfDay(todRef.current);
    game.setEngineFlavor(engineRef.current);
    gameRef.current = game;
    levelRef.current = levelId;
    // a new engine instance always starts idle — resync the HUD
    // (matters when HMR re-runs this effect against kept component state)
    setState(GameState.Idle);
    setDamage(0);
    setFlash(null);
    setReport(null);
    setCash([]);
    setCrashbreaker(0);
    setMultiplier(1);
    setRace(null);
    setReplaying(false);
    setCineCam(false);
    const offs = [
      game.events.on('state', (s) => {
        setState(s);
        if (s === GameState.Idle) {
          setReport(null);
          setFlash(null);
          setCash([]);
        }
      }),
      game.events.on('damage', setDamage),
      game.events.on('flash', (text) => setFlash((f) => ({ text, key: (f?.key ?? 0) + 1 }))),
      game.events.on('report', setReport),
      game.events.on('cash', (c) => setCash((list) => [...list.slice(-11), c])),
      game.events.on('crashbreaker', setCrashbreaker),
      game.events.on('multiplier', setMultiplier),
      game.events.on('boost', setBoost),
      game.events.on('race', setRace),
      game.events.on('replay', setReplaying),
      game.events.on('cine', setCineCam),
    ];
    const pending = pendingReplay.current;
    if (pending && pending.file.levelId === levelId) {
      pendingReplay.current = null;
      game.startReplay(pending.file, pending.fast);
    }
    return () => {
      offs.forEach((off) => off());
      gameRef.current = null;
      game.dispose();
    };
  }, [levelId]);

  /** Route a parsed report to the engine, switching levels first if needed. */
  const loadReplay = useCallback((file: ReplayFile, fast: boolean) => {
    if (!(file.levelId in LEVELS)) {
      alert(`Replay is for unknown level '${file.levelId}' — was it recorded on a newer build?`);
      return;
    }
    const game = gameRef.current;
    if (game && levelRef.current === file.levelId) {
      game.startReplay(file, fast); // level already mounted — start straight away
    } else {
      pendingReplay.current = { file, fast };
      setLevelId(file.levelId as LevelId); // the remount effect starts it
    }
  }, []);

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

  const level = LEVELS[levelId];

  return (
    <>
      <div id="game" ref={containerRef} />
      <Hud
        state={state}
        mode={level.mode.kind}
        damage={damage}
        goldTarget={level.mode.kind === 'crash' ? level.mode.medals.gold : 0}
        levelId={levelId}
        onSelectLevel={setLevelId}
        multiplier={multiplier}
        boost={boost}
        flash={flash}
        report={report}
        cash={cash}
        crashbreaker={crashbreaker}
        race={level.mode.kind === 'race' ? race : null}
        replaying={replaying}
        cineCam={cineCam}
        timeOfDay={timeOfDay}
        onSetTimeOfDay={setTimeOfDay}
        engineSound={engineSound}
        onSetEngineSound={setEngineSound}
        onCashDone={(id) => setCash((list) => list.filter((c) => c.id !== id))}
      />
    </>
  );
}
