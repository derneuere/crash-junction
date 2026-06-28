import { useCallback, useEffect, useRef, useState } from 'react';
import { Game } from './game/Game';
import type { EngineFlavor } from './game/audio';
import type { TimeOfDay } from './game/daynight';
import { LEVELS, type LevelId } from './game/levels';
import { PLAYER_CARS, type PlayerCarId } from './game/models';
import { GameState } from './game/types';
import type { ReplayFile } from './game/replay';
import type { BoostState, CashFloatData, RaceStanding, ReportData, TakedownBanner } from './game/events';
import { Hud, type FlashState } from './ui/Hud';
import { DebugOverlay } from './ui/DebugOverlay';
import { GraphicsOverlay } from './ui/GraphicsOverlay';
import { Loading } from './ui/menu/Loading';
import type { GraphicsSettings } from './game/graphics';
import {
  readBest, readCar, readGraphics, readMuted, readSel, writeGraphics, writeMuted, writeSel, type BestMap,
} from './ui/storage';
import { readFastPath, type Phase } from './App/fastpath';
import { useGameMount } from './App/useGameMount';
import { useDeepLinks } from './App/useDeepLinks';
import { renderMenuScreen } from './App/MenuScreens';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Game | null>(null);
  const levelRef = useRef<LevelId | null>(null); // level of the mounted Game
  // a replay whose level isn't loaded yet — startReplay() fires once it is
  const pendingReplay = useRef<{ file: ReplayFile; fast: boolean } | null>(null);
  const fast0 = useRef(readFastPath());
  // whether the NEXT gameplay mount should auto-launch straight into the event
  // (the menu→gameplay player flow) vs settle in idle (fast-path / replay). The
  // mount effect reads + clears it.
  const autoLaunchNext = useRef(false);

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
  // graphics quality toggles (clouds/water/grass/ao/stats) — presentation-only.
  // The mount applies them to a fresh Game; setGfx pushes live edits too.
  const [gfx, setGfxState] = useState<GraphicsSettings>(readGraphics);
  const gfxRef = useRef(gfx);
  const [gfxOpen, setGfxOpen] = useState(false);

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

  /** Merge a graphics-toggle change, persist it, and push it to the live Game.
   *  Presentation-only — setGraphics rides render-time seams the sim never reads,
   *  so editing mid-run can't perturb a replay or a determinism pin. */
  const setGfx = useCallback((patch: Partial<GraphicsSettings>) => {
    const next = { ...gfxRef.current, ...patch };
    gfxRef.current = next;
    setGfxState(next);
    writeGraphics(next);
    gameRef.current?.setGraphics(next);
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
  useGameMount({
    gameMounted, levelId, carId,
    containerRef, gameRef, levelRef, pendingReplay, autoLaunchNext,
    todRef, engineRef, mutedRef, gfxRef, stateRef, replayingRef, runTod, perEventRef,
    setGameReady, setLoadingDone, setState, setDamage, setFlash, setTakedown,
    setReport, setCash, setCrashbreaker, setMultiplier, setRace, setReplaying,
    setCineCam, setPerEvent, setBoost, setBest,
  });

  /** Commit the current event+variant+car → GAMEPLAY (mounts the Game behind
   *  the LOADING screen). The single entry point into gameplay from the menus
   *  and the fast path. `autoLaunch` (the player flow from CAR SELECT) drops
   *  straight into the running event once warmed; the fast-path/replay callers
   *  leave it off so the game settles in idle. */
  const startGameplay = useCallback((autoLaunch = false) => {
    autoLaunchNext.current = autoLaunch;
    setReport(null);
    setPhase('gameplay');
  }, [setPhase]);

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

  // the programmatic fast path, drag-drop replay, and ?replay= URL entry points
  useDeepLinks({ setTimeOfDay, selectCar, setLevelId, startGameplay, loadReplay });

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
  const menu = renderMenuScreen({
    phase, levelId, timeOfDay, engineSound, muted, variants, best, carId,
    setPhase, setTimeOfDay, setEngineSound, setMuted, selectEvent, selectCar, startGameplay,
  });
  if (menu) return menu;

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
      <GraphicsOverlay
        gfx={gfx}
        open={gfxOpen}
        onOpen={() => setGfxOpen(true)}
        onClose={() => setGfxOpen(false)}
        onChange={setGfx}
      />
    </>
  );
}
