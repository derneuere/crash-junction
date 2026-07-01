/** Fire a key the Game's own window handler owns (launch, sandbox explosion,
 *  crashbreaker, mute). UI buttons must never call into the engine for these:
 *  the keydown path routes sim-touching actions through the command queue,
 *  where they're RECORDED — so a take with button pokes still replays
 *  bit-for-bit. The paired keyup clears Game.keys in the same task, before
 *  the next frame samples key state, so nothing leaks into the key bitmask. */
export function synthKey(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code }));
}

// ---------------------------------------------------------------------------
// HELD synthetic keys — the touch controls' equivalent of the gamepad's held
// flags. A press-and-hold on-screen button dispatches ONE keydown (the key
// enters Game.keys and rides the per-frame recorded bitmask) and, on release,
// ONE keyup — so a held touch control is byte-for-byte identical to a held
// keyboard key and replays deterministically. Only codes from replay.ts
// KEY_CODES are ever passed here, so the recorded mask is well-defined.
//
// We track what's currently held so a control can't double-fire a keydown and,
// crucially, so we can force-release EVERYTHING when the tab is hidden or loses
// focus (a finger still down when you background the app must not leave a key
// stuck on when you come back).
// ---------------------------------------------------------------------------

const heldTouchKeys = new Set<string>();

/** Push/clear a held key through the same window event path the keyboard uses.
 *  Idempotent per code: a second `down` (or a `up` with nothing held) is a
 *  no-op, so overlapping pointer callbacks can't desync the held set. */
export function setKey(code: string, down: boolean): void {
  if (down) {
    if (heldTouchKeys.has(code)) return;
    heldTouchKeys.add(code);
    window.dispatchEvent(new KeyboardEvent('keydown', { code }));
  } else {
    if (!heldTouchKeys.delete(code)) return;
    window.dispatchEvent(new KeyboardEvent('keyup', { code }));
  }
}

/** Release every held touch key (tab hidden / blur / unmount). */
export function releaseAllTouchKeys(): void {
  for (const code of Array.from(heldTouchKeys)) setKey(code, false);
}
