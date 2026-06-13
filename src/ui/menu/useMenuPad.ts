import { useEffect, useRef } from 'react';

// Lightweight menu-only gamepad polling. The Game's GamepadInput (gamepad.ts)
// is the deterministic in-sim path and only exists while a Game is mounted —
// the menus aren't a Game, so they read the pad directly here. This poller
// produces no sim input and touches no recorder state, so it can't affect
// replay determinism; it just lets Start/A/B/D-pad drive the menu like the
// keyboard does. Active only while a menu screen is mounted (the Game unmounts
// these screens before it runs, so the two pollers never fight over the pad).

/** W3C "standard gamepad" (Xbox 360) button indices we navigate menus with. */
const BTN = {
  A: 0, // confirm / select
  B: 1, // back / cancel
  START: 9, // confirm (PRESS START)
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

const AXIS_X = 0;
const AXIS_Y = 1;
const DEADZONE = 0.5;

export interface MenuPadHandlers {
  onConfirm?: () => void; // A / Start
  onBack?: () => void; // B
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
}

/** Poll the first connected pad on a rAF loop and edge-fire the menu handlers.
 *  Handlers are kept in a ref so the rAF loop never restarts on re-render
 *  (which would drop edge state and double-fire). */
export function useMenuPad(handlers: MenuPadHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let raf = 0;
    const prev: Record<number, boolean> = {};
    let axHeld = { up: false, down: false, left: false, right: false };

    const edge = (pad: Gamepad, idx: number): boolean => {
      const btn = pad.buttons[idx];
      const now = !!btn && (btn.pressed || btn.value >= 0.5);
      const was = prev[idx] ?? false;
      prev[idx] = now;
      return now && !was;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const pads = navigator.getGamepads?.() ?? [];
      const pad = [...pads].find((p) => p && p.connected) as Gamepad | undefined;
      if (!pad) return;
      const h = ref.current;
      if (edge(pad, BTN.A) || edge(pad, BTN.START)) h.onConfirm?.();
      if (edge(pad, BTN.B)) h.onBack?.();

      // D-pad edges
      if (edge(pad, BTN.DPAD_UP)) h.onUp?.();
      if (edge(pad, BTN.DPAD_DOWN)) h.onDown?.();
      if (edge(pad, BTN.DPAD_LEFT)) h.onLeft?.();
      if (edge(pad, BTN.DPAD_RIGHT)) h.onRight?.();

      // stick edges (treat crossing the deadzone as a discrete step)
      const x = pad.axes[AXIS_X] ?? 0;
      const y = pad.axes[AXIS_Y] ?? 0;
      const up = y < -DEADZONE;
      const down = y > DEADZONE;
      const left = x < -DEADZONE;
      const right = x > DEADZONE;
      if (up && !axHeld.up) h.onUp?.();
      if (down && !axHeld.down) h.onDown?.();
      if (left && !axHeld.left) h.onLeft?.();
      if (right && !axHeld.right) h.onRight?.();
      axHeld = { up, down, left, right };
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}
