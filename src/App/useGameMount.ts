import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { Game } from '../game/Game';
import type { EngineFlavor } from '../game/audio';
import type { TimeOfDay } from '../game/daynight';
import { LEVELS, type LevelId } from '../game/levels';
import { setPlayerCar, type PlayerCarId } from '../game/models';
import { GameState, type LevelDef } from '../game/types';
import type { ReplayFile } from '../game/replay';
import type { GraphicsSettings } from '../game/graphics';
import type { BoostState, CashFloatData, RaceStanding, ReportData, TakedownBanner } from '../game/events';
import type { FlashState } from '../ui/Hud';
import { upgradeBest, writeBest, type BestMap } from '../ui/storage';

/** The refs + setters the mount effect reaches into. Grouped so the heavy
 *  effect can live in its own module while staying a byte-for-byte move. */
export interface GameMountDeps {
  gameMounted: boolean;
  levelId: LevelId;
  /** Editor playtest: mount THIS level instead of LEVELS[levelId]. Best-medal
   *  records never write while it's set (a working level isn't an event). */
  customLevel: LevelDef | null;
  carId: PlayerCarId;
  containerRef: RefObject<HTMLDivElement>;
  gameRef: MutableRefObject<Game | null>;
  levelRef: MutableRefObject<LevelId | null>;
  pendingReplay: MutableRefObject<{ file: ReplayFile; fast: boolean } | null>;
  autoLaunchNext: MutableRefObject<boolean>;
  todRef: MutableRefObject<TimeOfDay>;
  engineRef: MutableRefObject<EngineFlavor>;
  mutedRef: MutableRefObject<boolean>;
  gfxRef: MutableRefObject<GraphicsSettings>;
  stateRef: MutableRefObject<GameState>;
  replayingRef: MutableRefObject<boolean>;
  runTod: MutableRefObject<TimeOfDay>;
  perEventRef: MutableRefObject<Partial<Record<LevelId, TimeOfDay>>>;
  setGameReady: Dispatch<SetStateAction<boolean>>;
  setLoadingDone: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<GameState>>;
  setDamage: Dispatch<SetStateAction<number>>;
  setFlash: Dispatch<SetStateAction<FlashState | null>>;
  setTakedown: Dispatch<SetStateAction<TakedownBanner | null>>;
  setReport: Dispatch<SetStateAction<ReportData | null>>;
  setCash: Dispatch<SetStateAction<CashFloatData[]>>;
  setCrashbreaker: Dispatch<SetStateAction<number>>;
  setMultiplier: Dispatch<SetStateAction<number>>;
  setRace: Dispatch<SetStateAction<RaceStanding | null>>;
  setReplaying: Dispatch<SetStateAction<boolean>>;
  setCineCam: Dispatch<SetStateAction<boolean>>;
  setPerEvent: Dispatch<SetStateAction<Partial<Record<LevelId, TimeOfDay>>>>;
  setBoost: Dispatch<SetStateAction<BoostState>>;
  setBest: Dispatch<SetStateAction<BestMap>>;
}

/** The heavy Game mount: ONLY while in the gameplay phase.
 *  Keyed on [gameMounted, levelId, carId]: entering gameplay mounts it;
 *  leaving unmounts it. A level/car change while mounted (debug hot-switch /
 *  replay level swap) remounts, exactly the old take boundary. */
export function useGameMount(deps: GameMountDeps): void {
  const {
    gameMounted, levelId, customLevel, carId,
    containerRef, gameRef, levelRef, pendingReplay, autoLaunchNext,
    todRef, engineRef, mutedRef, gfxRef, stateRef, replayingRef, runTod, perEventRef,
    setGameReady, setLoadingDone, setState, setDamage, setFlash, setTakedown,
    setReport, setCash, setCrashbreaker, setMultiplier, setRace, setReplaying,
    setCineCam, setPerEvent, setBoost, setBest,
  } = deps;

  useEffect(() => {
    if (!gameMounted) return;
    setGameReady(false);
    setLoadingDone(false);
    // the player's model template is sim state (it shapes the suspension) —
    // pin it before the Game constructs, never mid-take (models.ts)
    setPlayerCar(carId);
    const game = new Game(containerRef.current!, customLevel ?? LEVELS[levelId]);
    // gfx tier removed: the game always boots in CINE (the constructor applies
    // the render path before the first frame; ?verify=1 still forces FAST).
    game.setTimeOfDay(todRef.current);
    game.setEngineFlavor(engineRef.current);
    // apply the persisted graphics toggles before the first rendered frame so a
    // disabled layer (clouds/water/grass/ao) never flashes on at mount. Presentation
    // only — runs after setTimeOfDay so the clouds flag wins over the tod's cloud bake.
    game.setGraphics(gfxRef.current);
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
        if (customLevel) return; // an editor playtest sets no records either
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
    const isReplay = !!(pending && pending.file.levelId === levelId);
    if (isReplay) {
      pendingReplay.current = null;
      game.startReplay(pending!.file, pending!.fast);
    }
    // AUTO-LAUNCH: the menu→gameplay player flow drops straight into the running
    // event the moment warmup ends (no idle "READY / LAUNCH" map-preview beat).
    // Replays drive their own launch via the tape, and the fast-path/deep-link
    // (refshot) wants the idle orbit — both leave it OFF. autoLaunchNext is set
    // by the entry point; default false so anything that mounts the Game
    // directly stays in the safe idle state.
    if (autoLaunchNext.current && !isReplay) game.setAutoLaunch(true);
    autoLaunchNext.current = false;
    // Keep the LOADING overlay up until the Game has WARMED its render pipelines
    // (postfx chain + first cube capture) and is about to hand control over —
    // that's what actually hides the first-frame hitch (worst on gantry). Game
    // fires whenReady after its warmup burst; under ?verify=1 it fires
    // immediately (headless, no warmup).
    game.whenReady(() => setGameReady(true));
    return () => {
      offs.forEach((off) => off());
      gameRef.current = null;
      levelRef.current = null;
      game.dispose();
    };
  }, [gameMounted, levelId, customLevel, carId]);
}
