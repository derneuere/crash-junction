import { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from './game/Game';
import type { EngineFlavor } from './game/audio';
import type { TimeOfDay } from './game/daynight';
import { LEVELS, type LevelId } from './game/levels';
import { PLAYER_CARS, setPlayerCar, type PlayerCarId } from './game/models';
import { GameState } from './game/types';
import { parseReplayFile, type ReplayFile } from './game/replay';
import type { BoostState, CashFloatData, RaceStanding, ReportData, TakedownBanner } from './game/events';
import { Hud, type FlashState } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { Title } from './ui/menu/Title';
import { MainMenu } from './ui/menu/MainMenu';
import { Settings } from './ui/menu/Settings';
import { EventSelect } from './ui/menu/EventSelect';
import { Loading } from './ui/menu/Loading';
import { CarSelect } from './ui/CarSelect';
import {
  readBest, readCar, readMuted, readSel, upgradeBest, writeBest, writeMuted, writeSel, type BestMap,
} from './ui/storage';

/** The front-end state machine. Browsing the menus (TITLE…CARSELECT) is pure,
 *  lightweight React with a themed background — NO game level is mounted. The
 *  heavy Game (which loads the level + streams assets) mounts ONCE on entering
 *  GAMEPLAY (LOADING→INGAME) and unmounts on returning to the menu. That
 *  decoupling is the lag fix: switching events no longer reloads a level. */
type Phase = 'title' | 'main' | 'settings' | 'events' | 'carselect' | 'gameplay';

const isTod = (v: unknown): v is TimeOfDay => v === 'day' || v === 'dusk' || v === 'night';

/** Read the programmatic fast-path params: ?level=&car=&tod=&launch=1 jumps
 *  straight to GAMEPLAY on the chosen level, bypassing the menu/car flow (the
 *  test harnesses use this; ?replay= has its own direct-mount path). */
function readFastPath(): { level: LevelId; car?: PlayerCarId; tod?: TimeOfDay } | null {
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

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const levelRef = useRef<LevelId | null>(null); // level of the mounted Game
  // a replay whose level isn't loaded yet — startReplay() fires once it is
  const pendingReplay = useRef<{ file: ReplayFile; fast: boolean } | null>(null);
  const fast0 = useRef(readFastPath());

  // last selection (event + variant + per-event variant memory) — cj-sel
  const [sel0] = useState(readSel);
  const [levelId, setLevelId] = useState<LevelId>(fast0.current?.level ?? sel0?.level ?? 'junction');
  const [state, setState] = useState(GameState.Idle);
  const [damage, setDamage] = useState(0);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [takedown, setTakedown] = useState<TakedownBanner | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [cash, setCash] = useState<CashFloatData[]>([]);
  const [crashbreaker, setCrashbreaker] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [boost, setBoost] = useState<BoostState>({ fill: 0, segments: 1, maxSegments: 4, burnout: false, chain: 0 });
  const [race, setRace] = useState<RaceStanding | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [cineCam, setCineCam] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [timeOfDay, setTimeOfDayState] = useState<TimeOfDay>(() => {
    const legacy = localStorage.getItem('cj-tod');
    return fast0.current?.tod ?? sel0?.tod ?? (legacy === 'night' || legacy === 'dusk' ? legacy : 'day');
  });
  const todRef = useRef(timeOfDay); // the remount effect reads the live value
  // per-event variant memory: which DAY/NIGHT chip each card reopens with
  const [perEvent, setPerEvent] = useState<Partial<Record<LevelId, TimeOfDay>>>(sel0?.perEvent ?? {});
  const perEventRef = useRef(perEvent); // engine listeners read the live value
  const [best, setBest] = useState<BestMap>(readBest);
  const [carId, setCarId] = useState<PlayerCarId>(fast0.current?.car ?? readCar());
  const [engineSound, setEngineSoundState] = useState<EngineFlavor>(() => {
    const fastCar = fast0.current?.car && PLAYER_CARS.find((c) => c.id === fast0.current!.car);
    if (fastCar) return fastCar.flavor;
    const saved = localStorage.getItem('cj-engine');
    // default = stock (the pre-flavor behavior — switching voices is opt-in)
    return saved === 'v10' || saved === 'v8' ? saved : 'stock';
  });
  const engineRef = useRef(engineSound);
  const [muted, setMutedState] = useState(readMuted);
  const mutedRef = useRef(muted);

  // FLOW: start on TITLE, unless a fast-path/replay deep-link jumps to gameplay
  const [phase, setPhaseState] = useState<Phase>(fast0.current ? 'gameplay' : 'title');
  const phaseRef = useRef(phase);
  const setPhase = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);
  // ready signal for the LOADING screen — flips once the mounted Game's world
  // is up (actors populated + a frame rendered). loadingDone is the LATER edge:
  // the LOADING screen calls it after its minimum beat, which dismisses it.
  const [gameReady, setGameReady] = useState(false);
  const [loadingDone, setLoadingDone] = useState(false);
  // true while the Game should be mounted (gameplay phase, incl. its loading
  // sub-state). The menu phases never mount it — that's the whole lag fix.
  const gameMounted = phase === 'gameplay';

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

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    mutedRef.current = m;
    writeMuted(m); // applied to the Game's audio at mount (toggleMute on a
    // fresh, unmuted Game). Settings is a menu screen — no Game is mounted
    // while it's open — so there's nothing live to flip here.
  }, []);

  /** EVENT SELECT highlight: move the highlighted card / pin a variant. This is
   *  pure selection state now — NO level mounts (the old picker mounted the
   *  attract level here, which is exactly what we removed). */
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
   *  SIM state — the mount effect re-pins it before the Game constructs. */
  const selectCar = useCallback((id: PlayerCarId) => {
    localStorage.setItem('cj-car', id);
    setCarId(id);
    const def = PLAYER_CARS.find((c) => c.id === id);
    if (def) setEngineSound(def.flavor);
  }, [setEngineSound]);

  // persist the selection whenever it settles — cj-sel is what the flow
  // reopens with on the next boot
  useEffect(() => {
    writeSel({ level: levelId, tod: timeOfDay, perEvent });
  }, [levelId, timeOfDay, perEvent]);

  // Backquote toggles the debug overlay (only meaningful in gameplay). The key
  // is NOT in replay.ts KEY_CODES, so the toggle can never pollute a take.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backquote' && !e.repeat) setDebugOpen((v) => !v);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // ---- the heavy Game mount: ONLY while in the gameplay phase ----
  // Keyed on [gameMounted, levelId, carId]: entering gameplay mounts it;
  // leaving unmounts it. A level/car change while mounted (debug hot-switch /
  // replay level swap) remounts, exactly the old take boundary.
  useEffect(() => {
    if (!gameMounted) return;
    setGameReady(false);
    setLoadingDone(false);
    // the player's model template is sim state (it shapes the suspension) —
    // pin it before the Game constructs, never mid-take (models.ts)
    setPlayerCar(carId);
    const game = new Game(containerRef.current!, LEVELS[levelId]);
    // gfx tier removed: the game always boots in CINE (the constructor applies
    // the render path before the first frame; ?verify=1 still forces FAST).
    game.setTimeOfDay(todRef.current);
    game.setEngineFlavor(engineRef.current);
    // apply the SETTINGS mute preference to the fresh (unmuted) Game's audio.
    // Game exposes no public mute setter; reach the audio graph through the
    // same runtime surface the debug overlay + M-key use. Presentation only.
    if (mutedRef.current) {
      (game as unknown as { audio?: { toggleMute(): boolean } }).audio?.toggleMute();
    }
    gameRef.current = game;
    levelRef.current = levelId;
    // a new engine instance always starts idle — resync the HUD
    setState(GameState.Idle);
    stateRef.current = GameState.Idle;
    setDamage(0);
    setFlash(null);
    setTakedown(null);
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
          setTakedown(null);
          setCash([]);
        }
      }),
      game.events.on('damage', setDamage),
      game.events.on('flash', (text) => setFlash((f) => ({ text, key: (f?.key ?? 0) + 1 }))),
      game.events.on('takedown', setTakedown),
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
    // the world is up the moment the constructor returns (actors are built
    // synchronously); flip ready on the next frame so the first render lands
    const readyRaf = requestAnimationFrame(() => setGameReady(true));
    return () => {
      cancelAnimationFrame(readyRaf);
      offs.forEach((off) => off());
      gameRef.current = null;
      levelRef.current = null;
      game.dispose();
    };
  }, [gameMounted, levelId, carId]);

  /** Commit the current event+variant+car → GAMEPLAY (mounts the Game behind
   *  the LOADING screen). The single entry point into gameplay from the menus
   *  and the fast path. */
  const startGameplay = useCallback(() => {
    setReport(null);
    setPhase('gameplay');
  }, [setPhase]);

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

  /** Route a parsed report to the engine, mounting/switching the level first.
   *  Replays bypass the menu flow entirely — they jump straight to gameplay on
   *  the report's level (drag-drop + ?replay= both land here). */
  const loadReplay = useCallback((file: ReplayFile, fast: boolean) => {
    if (!(file.levelId in LEVELS)) {
      alert(`Replay is for unknown level '${file.levelId}' — was it recorded on a newer build?`);
      return;
    }
    const game = gameRef.current;
    if (game && levelRef.current === file.levelId && phaseRef.current === 'gameplay') {
      game.startReplay(file, fast); // level already mounted — start straight away
    } else {
      pendingReplay.current = { file, fast };
      setLevelId(file.levelId as LevelId); // the mount effect starts it
      startGameplay();
    }
  }, [startGameplay]);

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

  // what each card's chip row opens with: remembered variant, else the
  // current lighting; the highlighted card always mirrors the live tod
  const variants = Object.fromEntries(
    (Object.keys(LEVELS) as LevelId[]).map((id) => [
      id,
      id === levelId ? timeOfDay : perEvent[id] ?? timeOfDay,
    ]),
  ) as Record<LevelId, TimeOfDay>;

  // ---- render the active screen ----
  // Menu screens are lightweight React over a themed background (no Game).
  if (phase === 'title') {
    return <Title onStart={() => setPhase('main')} />;
  }
  if (phase === 'main') {
    return (
      <MainMenu
        onPlay={() => setPhase('events')}
        onGarage={() => setPhase('carselect')}
        onSettings={() => setPhase('settings')}
        onControls={() => setPhase('settings')}
      />
    );
  }
  if (phase === 'settings') {
    return (
      <Settings
        timeOfDay={timeOfDay}
        engineSound={engineSound}
        muted={muted}
        onSetTimeOfDay={setTimeOfDay}
        onSetEngineSound={setEngineSound}
        onSetMuted={setMuted}
        onBack={() => setPhase('main')}
      />
    );
  }
  if (phase === 'events') {
    return (
      <EventSelect
        levelId={levelId}
        tod={timeOfDay}
        variants={variants}
        best={best}
        onSelectEvent={selectEvent}
        onConfirm={() => setPhase('carselect')}
        onBack={() => setPhase('main')}
      />
    );
  }
  if (phase === 'carselect') {
    return (
      // garage CarSelect: onSelect IS the SELECT/confirm action; cycling +
      // livery preview are internal to the showroom scene. (Livery colour is
      // chosen in the garage but not yet applied in-game — follow-up.)
      <CarSelect
        cars={PLAYER_CARS}
        initialCarId={carId}
        onSelect={(id) => { selectCar(id); startGameplay(); }}
        onBack={() => setPhase('events')}
      />
    );
  }

  // ---- GAMEPLAY: the Game is mounted; show LOADING until its world is up ----
  const level = LEVELS[levelId];
  return (
    <>
      <div id="game" ref={containerRef} />
      {!loadingDone && (
        <Loading level={levelId} tod={timeOfDay} ready={gameReady} onReady={() => setLoadingDone(true)} />
      )}
      <Hud
        state={state}
        mode={level.mode.kind}
        damage={damage}
        goldTarget={level.mode.kind === 'crash' ? level.mode.medals.gold : 0}
        levelId={levelId}
        multiplier={multiplier}
        boost={boost}
        flash={flash}
        takedown={takedown}
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
        onExit={() => setPhase('main')}
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
