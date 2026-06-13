import { useEffect, useState } from 'react';
import { useStartButton } from './useStartButton';

interface TitleProps {
  /** PRESS START / click / controller-Start advances to the main menu. */
  onStart: () => void;
}

/** Screen 1 — the opening. A brief studio-bumper beat ("a [studio]
 *  production" vibe) fades into the PRESS START title card: the game name in
 *  bold italic chrome over a dark metallic-blue swoosh background. Start /
 *  Space / click / controller-Start all advance.
 *
 *  B3 vibe (not a copy): chrome-on-blue title, an orange-gold underswoosh, a
 *  pulsing PRESS START prompt. No live game level mounts here — this is pure
 *  React, so browsing the menus never reloads a heavy three.js world. */
export function Title({ onStart }: TitleProps) {
  // the bumper plays once, then the title card; clicking through the bumper
  // skips straight to the title (and a second activation starts the game)
  const [phase, setPhase] = useState<'bumper' | 'title'>('bumper');
  useEffect(() => {
    const id = window.setTimeout(() => setPhase('title'), 1600);
    return () => window.clearTimeout(id);
  }, []);

  const advance = () => {
    if (phase === 'bumper') setPhase('title');
    else onStart();
  };

  // Space / Enter / Start (pad) / click — only armed on the title card so the
  // bumper can't be "started" past by a stray keypress
  useStartButton(phase === 'title' ? onStart : () => setPhase('title'));

  return (
    <div className="screen titleScreen" onClick={advance}>
      <div className="bgSwoosh" aria-hidden />
      <div className="bgGrid" aria-hidden />

      {phase === 'bumper' ? (
        <div className="bumper">
          <div className="bumperKi">A JUNCTION WORKS PRODUCTION</div>
        </div>
      ) : (
        <div className="titleCard">
          <div className="gameWordmark">
            <span className="wm1">CRASH</span>
            <span className="wm2">JUNCTION</span>
          </div>
          <div className="gameSub">ARCADE TAKEDOWN RACING</div>
          <div className="pressStart">PRESS START</div>
          <div className="startHint">SPACE / ENTER / &#9655; START / CLICK</div>
        </div>
      )}
    </div>
  );
}
