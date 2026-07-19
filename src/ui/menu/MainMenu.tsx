import { useEffect, useState } from 'react';
import { useMenuPad } from './useMenuPad';

interface MainMenuProps {
  onPlay: () => void; // → EVENT SELECT
  onGarage: () => void; // → CAR SELECT (browse the roster)
  onEditor: () => void; // → LEVEL EDITOR
  onSettings: () => void;
  onControls: () => void;
}

interface Item {
  key: string;
  label: string;
  sub: string;
  run: (p: MainMenuProps) => void;
}

// B3 "SELECT OPTION" vibe: a vertical chrome menu list, one highlighted row.
const ITEMS: Item[] = [
  { key: 'play', label: 'PLAY', sub: 'CHOOSE AN EVENT AND DRIVE', run: (p) => p.onPlay() },
  { key: 'garage', label: 'GARAGE', sub: 'PICK YOUR CAR', run: (p) => p.onGarage() },
  { key: 'editor', label: 'LEVEL EDITOR', sub: 'BUILD A JUNCTION · SAVE AS JSON', run: (p) => p.onEditor() },
  { key: 'settings', label: 'SETTINGS', sub: 'TIME OF DAY · ENGINE · SOUND', run: (p) => p.onSettings() },
  { key: 'controls', label: 'CONTROLS', sub: 'KEYBOARD & CONTROLLER', run: (p) => p.onControls() },
];

/** Screen 2 — the main menu. Lightweight React only (no game level): the
 *  entry points into the flow. ↑/↓ + Enter, click, or pad to choose. */
export function MainMenu(props: MainMenuProps) {
  const [i, setI] = useState(0);
  const move = (d: number) => setI((v) => (v + d + ITEMS.length) % ITEMS.length);
  const choose = (idx = i) => ITEMS[idx].run(props);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.code === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') { e.preventDefault(); choose(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  useMenuPad({
    onUp: () => move(-1),
    onDown: () => move(1),
    onConfirm: () => choose(),
  });

  return (
    <div className="screen menuScreen">
      <div className="bgSwoosh" aria-hidden />
      <div className="bgGrid" aria-hidden />

      <div className="menuHeader">
        <div className="menuWordmark">CRASH JUNCTION</div>
        <div className="menuKicker">SELECT OPTION</div>
      </div>

      <ul className="menuList">
        {ITEMS.map((it, idx) => (
          <li key={it.key}>
            <button
              className={`menuRow${idx === i ? ' sel' : ''}`}
              onMouseEnter={() => setI(idx)}
              onClick={() => choose(idx)}
            >
              <span className="menuRowLabel">{it.label}</span>
              <span className="menuRowSub">{it.sub}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="menuFoot">&#9650;&#9660; MOVE &middot; ENTER / &#9655; SELECT</div>
    </div>
  );
}
