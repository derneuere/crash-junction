import { useEffect, useRef, useState } from 'react';
import { Game } from './game/Game';
import { LEVELS, type LevelId } from './game/levels';
import { GameState, type CashFloatData, type ReportData } from './game/types';
import { Hud, type FlashState } from './ui/Hud';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [levelId, setLevelId] = useState<LevelId>('junction');
  const [state, setState] = useState(GameState.Idle);
  const [damage, setDamage] = useState(0);
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [report, setReport] = useState<ReportData | null>(null);
  const [cash, setCash] = useState<CashFloatData[]>([]);
  const [crashbreaker, setCrashbreaker] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [boost, setBoost] = useState(1);
  const [race, setRace] = useState<{ lap: number; laps: number; pos: number; racers: number } | null>(null);

  useEffect(() => {
    const game = new Game(containerRef.current!, LEVELS[levelId]);
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
    ];
    return () => {
      offs.forEach((off) => off());
      game.dispose();
    };
  }, [levelId]);

  const level = LEVELS[levelId];

  return (
    <>
      <div id="game" ref={containerRef} />
      <Hud
        state={state}
        damage={damage}
        goldTarget={level.practice ? 0 : level.medals.gold}
        practice={!!level.practice}
        levelId={levelId}
        onSelectLevel={setLevelId}
        multiplier={multiplier}
        boost={boost}
        flash={flash}
        report={report}
        cash={cash}
        crashbreaker={crashbreaker}
        race={level.race ? race : null}
        isRace={!!level.race}
        onCashDone={(id) => setCash((list) => list.filter((c) => c.id !== id))}
      />
    </>
  );
}
