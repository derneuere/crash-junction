import type { ReactElement } from 'react';
import type { EngineFlavor } from '../game/audio';
import type { TimeOfDay } from '../game/daynight';
import type { LevelId } from '../game/levels';
import { PLAYER_CARS, type PlayerCarId } from '../game/models';
import type { BestMap } from '../ui/storage';
import { Title } from '../ui/menu/Title';
import { MainMenu } from '../ui/menu/MainMenu';
import { Settings } from '../ui/menu/Settings';
import { EventSelect } from '../ui/menu/EventSelect';
import { CarSelect } from '../ui/CarSelect';
import type { Phase } from './fastpath';

/** Everything the lightweight menu screens (TITLE…CARSELECT) need. The values
 *  and callbacks all live in App; this module just renders the active screen so
 *  App's component body stays slim. */
export interface MenuScreensProps {
  phase: Phase;
  levelId: LevelId;
  timeOfDay: TimeOfDay;
  engineSound: EngineFlavor;
  muted: boolean;
  variants: Record<LevelId, TimeOfDay>;
  best: BestMap;
  carId: PlayerCarId;
  setPhase: (p: Phase) => void;
  setTimeOfDay: (t: TimeOfDay) => void;
  setEngineSound: (f: EngineFlavor) => void;
  setMuted: (m: boolean) => void;
  selectEvent: (id: LevelId, tod?: TimeOfDay) => void;
  selectCar: (id: PlayerCarId) => void;
  startGameplay: (autoLaunch?: boolean) => void;
}

/** Render the active menu screen, or null when the phase is GAMEPLAY (App then
 *  renders the mounted Game + HUD instead). Menu screens are lightweight React
 *  over a themed background (no Game). */
export function renderMenuScreen(p: MenuScreensProps): ReactElement | null {
  const {
    phase, levelId, timeOfDay, engineSound, muted, variants, best, carId,
    setPhase, setTimeOfDay, setEngineSound, setMuted, selectEvent, selectCar, startGameplay,
  } = p;

  if (phase === 'title') {
    return <Title onStart={() => setPhase('main')} />;
  }
  if (phase === 'main') {
    return (
      <MainMenu
        onPlay={() => setPhase('events')}
        onGarage={() => setPhase('carselect')}
        onEditor={() => setPhase('editor')}
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
        onSelect={(id) => { selectCar(id); startGameplay(true); }}
        onBack={() => setPhase('events')}
      />
    );
  }
  return null;
}
