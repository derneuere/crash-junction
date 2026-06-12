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
