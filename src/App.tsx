import { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from './game/Game';
import type { EngineFlavor } from './game/audio';
import type { TimeOfDay } from './game/daynight';
import { LEVELS, type LevelId } from './game/levels';
import { PLAYER_CARS, setPlayerCar, type PlayerCarId } from './game/models';
import { GameState } from './game/types';
import { parseReplayFile, type ReplayFile } from './game/replay';
import type { CashFloatData, RaceStanding, ReportData } from './game/events';
import { Hud, type FlashState } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import {
  readBest, readCar, readSel, upgradeBest, writeBest, writeSel, type BestMap,
} from './ui/storage';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const levelRef = useRef<LevelId | null>(null); // level of the mounted Game
  // a replay whose level isn't loaded yet — startReplay() fires once it is
  const pendingReplay = useRef<{ file: ReplayFile; fast: boolean } | null>(null);
  // last selection (event + variant + per-event variant memory) — cj-sel
  const [sel0] = useState(readSel);
  const [levelId, setLevelId] = useState<LevelId>(sel0?.level ?? 'junction');
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
  const [debugOpen, setDebugOpen] = useState(false);
  const [timeOfDay, setTimeOfDayState] = useState<TimeOfDay>(
    () => sel0?.tod ?? (localStorage.getItem('cj-tod') === 'night' ? 'night' : 'day'),
  );
  const todRef = useRef(timeOfDay); // the remount effect reads the live value
  // per-event variant memory: which DAY/NIGHT chip each card reopens with
  const [perEvent, setPerEvent] = useState<Partial<Record<LevelId, TimeOfDay>>>(sel0?.perEvent ?? {});
  const perEventRef = useRef(perEvent); // engine listeners read the live value
  const [best, setBest] = useState<BestMap>(readBest);
  const [carId, setCarId] = useState<PlayerCarId>(readCar);
  const [engineSound, setEngineSoundState] = useState<EngineFlavor>(() => {
    const saved = localStorage.getItem('cj-engine');
    // default = stock (the pre-flavor behavior — switching voices is opt-in)
    return saved === 'v10' || saved === 'v8' ? saved : 'stock';
  });
  const engineRef = useRef(engineSound);
  const stateRef = useRef(GameState.Idle); // for Idle→Launch edge detection
  const replayingRef = useRef(false); // a tape's report must never write records
  const runTod = useRef(timeOfDay); // the variant the CURRENT take launched with

  const setTimeOfDay = useCallback((t: TimeOfDay) => {
    setTimeOfDayState(t);
    todRef.current = t;
    localStorage.setItem('cj-tod', t); // legacy key — refshot + old links read it
    gameRef.current?.setTimeOfDay(t);
  }, []);

  const setEngineSound = useCallback((f: EngineFlavor) => {
    setEngineSoundState(f);
    engineRef.current = f;
    localStorage.setItem('cj-engine', f);
    gameRef.current?.setEngineFlavor(f);
  }, []);

  /** Picker selection: focusing a card mounts its level (the attract orbit
   *  behind the cards is the event you're browsing); a chip click pins that
   *  event's variant. A bare focus reopens with the event's remembered
   *  variant, falling back to whatever's currently lit. */
  const selectEvent = useCallback((id: LevelId, tod?: TimeOfDay) => {
    const t = tod ?? perEventRef.current[id] ?? todRef.current;
    if (tod) {
      perEventRef.current = { ...perEventRef.current, [id]: tod };
      setPerEvent(perEventRef.current);
    }
    setTimeOfDay(t);
    setLevelId(id);
  }, [setTimeOfDay]);

  /** v1 roster: a car is a body + its engine voice, so picking one writes
   *  both 'cj-car' and (via setEngineSound) 'cj-engine'. The model swap is
   *  SIM state — the remount effect below re-pins it before the new Game. */
  const selectCar = useCallback((id: PlayerCarId) => {
    localStorage.setItem('cj-car', id);
    setCarId(id);
    const def = PLAYER_CARS.find((c) => c.id === id);
    if (def) setEngineSound(def.flavor);
  }, [setEngineSound]);

  // persist the selection whenever it settles — cj-sel is what the picker
  // reopens with on the next boot
  useEffect(() => {
    writeSel({ level: levelId, tod: timeOfDay, perEvent });
  }, [levelId, timeOfDay, perEvent]);

  // Backquote toggles the debug overlay. The key is NOT in replay.ts
  // KEY_CODES, so the toggle can never pollute a recorded take.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && !e.repeat) setDebugOpen((v) => !v);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    // the player's model template is sim state (it shapes the suspension) —
    // pin it before the Game constructs, never mid-take (models.ts)
    setPlayerCar(carId);
    const game = new Game(containerRef.current!, LEVELS[levelId]);
    game.setTimeOfDay(todRef.current);
    game.setEngineFlavor(engineRef.current);
    gameRef.current = game;
    levelRef.current = levelId;
    // a new engine instance always starts idle — resync the HUD
    // (matters when HMR re-runs this effect against kept component state)
    setState(GameState.Idle);
    stateRef.current = GameState.Idle;
    setDamage(0);
    setFlash(null);
    setReport(null);
    setCash([]);
    setCrashbreaker(0);
    setMultiplier(1);
    setRace(null);
    setReplaying(false);
    replayingRef.current = false;
    setCineCam(false);
    const offs = [
      game.events.on('state', (s) => {
        if (s === GameState.Launch && stateRef.current === GameState.Idle) {
          // launch is the moment a variant becomes "last ran": runTod keys
          // the medal write even if the overlay flips lighting mid-take, and
          // the per-event memory is what this card's chip defaults to next
          runTod.current = todRef.current;
          perEventRef.current = { ...perEventRef.current, [levelId]: todRef.current };
          setPerEvent(perEventRef.current);
        }
        stateRef.current = s;
        setState(s);
        if (s === GameState.Idle) {
          setReport(null);
          setFlash(null);
          setCash([]);
        }
      }),
      game.events.on('damage', setDamage),
      game.events.on('flash', (text) => setFlash((f) => ({ text, key: (f?.key ?? 0) + 1 }))),
      game.events.on('report', (r) => {
        setReport(r);
        if (replayingRef.current) return; // a replayed tape sets no records
        setBest((prev) => {
          const next = upgradeBest(prev, levelId, runTod.current, r.medal);
          if (next !== prev) writeBest(next);
          return next;
        });
      }),
      game.events.on('cash', (c) => setCash((list) => [...list.slice(-11), c])),
      game.events.on('crashbreaker', setCrashbreaker),
      game.events.on('multiplier', setMultiplier),
      game.events.on('boost', setBoost),
      game.events.on('race', setRace),
      game.events.on('replay', (v) => {
        replayingRef.current = v;
        setReplaying(v);
      }),
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
  }, [levelId, carId]);

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
  // what each card's chip row opens with: remembered variant, else the
  // current lighting; the focused card always mirrors the live tod
  const variants = Object.fromEntries(
    (Object.keys(LEVELS) as LevelId[]).map((id) => [
      id,
      id === levelId ? timeOfDay : perEvent[id] ?? timeOfDay,
    ]),
  ) as Record<LevelId, TimeOfDay>;

  return (
    <>
      <div id="game" ref={containerRef} />
      <Hud
        state={state}
        mode={level.mode.kind}
        damage={damage}
        goldTarget={level.mode.kind === 'crash' ? level.mode.medals.gold : 0}
        levelId={levelId}
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
        variants={variants}
        best={best}
        carId={carId}
        onSelectEvent={selectEvent}
        onSelectCar={selectCar}
        onOpenDebug={() => setDebugOpen(true)}
        onCashDone={(id) => setCash((list) => list.filter((c) => c.id !== id))}
      />
      <DebugOverlay
        open={debugOpen}
        onClose={() => setDebugOpen(false)}
        state={state}
        levelId={levelId}
        timeOfDay={timeOfDay}
        engineSound={engineSound}
        onSetTimeOfDay={setTimeOfDay}
        onSetEngineSound={setEngineSound}
        onSelectLevel={selectEvent}
        onLoadReplay={loadReplay}
      />
    </>
  );
}
