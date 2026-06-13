// ---------------------------------------------------------------------------
// CONTROLLER SUPPORT (Xbox 360 / W3C "standard gamepad")
//
// The whole game is driveable with a pad. The hard constraint is DETERMINISM:
// the deterministic replay records a digital KEY BITMASK each frame (see
// replay.ts KEY_CODES), and the two determinism pins are KEYBOARD fixtures
// that must stay byte-exact. So the pad NEVER invents its own analog channel
// into the sim — it produces exactly the same digital key codes the keyboard
// produces (stick past a deadzone -> a steer key; trigger past a threshold ->
// the accelerate/boost key). Game.ts ORs these synthetic key flags into the
// live keyboard map at the SAME point it samples the recorder bitmask, so pad
// input flows through the existing recorded key path and is replay-deterministic
// and fully interchangeable with the keyboard.
//
// When no pad is connected, poll() writes nothing and returns no intents, so
// the keyboard path (and the two pins) is bit-for-bit untouched.
//
// Held actions ride the bitmask (heldKeys); discrete one-shot actions
// (launch/restart/crashbreaker/sandbox-explode/mute) are EDGE-detected and
// returned as intents so Game.ts can route them through the same command queue
// / handlers the keyboard's keydown uses — once per press, never spammed.
// ---------------------------------------------------------------------------

/** Standard-mapping button indices (W3C "standard gamepad" == Xbox 360). */
const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6, // analog trigger exposed as a button in the standard mapping
  RT: 7,
  BACK: 8, // "View" / Back / Select
  START: 9, // "Menu" / Start
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

/** Standard-mapping axis indices. */
const AXIS = {
  LEFT_X: 0,
  LEFT_Y: 1,
} as const;

// Tuning. Deadzone keeps a resting stick from steering; the trigger threshold
// is where RT/LT "press". A button is considered pressed at >= BTN_PRESSED to
// match how analog triggers report fractional .value while held.
const STICK_DEADZONE = 0.35;
const TRIGGER_THRESHOLD = 0.3;
const BTN_PRESSED = 0.5;

/** One-shot actions the pad can request; Game.ts maps these onto the same
 *  handlers the keyboard's keydown drives, so they record identically. */
export type GamepadIntent = 'launch' | 'restart' | 'crashbreaker' | 'explode' | 'mute';

/** Minimal context the edge logic needs to disambiguate Start (launch vs
 *  restart) — the same idle/done split the keyboard+pointer handlers use. */
export interface PadContext {
  /** true while GameState.Idle — Start should LAUNCH. */
  idle: boolean;
}

function pressed(btn: GamepadButton | undefined): boolean {
  if (!btn) return false;
  return btn.pressed || btn.value >= BTN_PRESSED;
}

export class GamepadInput {
  /** Whether a pad is currently connected and being read. */
  private connected = false;
  /** The index of the pad we're driving (first connected). */
  private index = -1;
  /** Per-button "was down last poll" state for edge detection. */
  private prev: Record<number, boolean> = {};
  /** Synthetic held key codes for THIS poll (rebuilt every poll, so a released
   *  control clears next frame). Only ever contains codes from replay.ts
   *  KEY_CODES, so the OR into the recorder bitmask is well-defined. */
  readonly heldKeys: Record<string, boolean> = {};

  /** Wire up connect/disconnect. Returns a disposer that removes the listeners. */
  attach(): () => void {
    const onConnect = (e: GamepadEvent): void => {
      // adopt the first pad we see; if one is already driving, keep it
      if (this.index < 0) this.index = e.gamepad.index;
      this.connected = true;
    };
    const onDisconnect = (e: GamepadEvent): void => {
      if (e.gamepad.index === this.index) {
        this.index = -1;
        this.connected = false;
        this.reset();
      }
    };
    addEventListener('gamepadconnected', onConnect);
    addEventListener('gamepaddisconnected', onDisconnect);
    return () => {
      removeEventListener('gamepadconnected', onConnect);
      removeEventListener('gamepaddisconnected', onDisconnect);
    };
  }

  /** Drop all held + edge state (on disconnect or replay start) so no stale
   *  flag leaks into the recorded bitmask. */
  reset(): void {
    for (const k of Object.keys(this.heldKeys)) this.heldKeys[k] = false;
    this.prev = {};
  }

  /** True iff a pad is connected. When false, poll() is a guaranteed no-op,
   *  which is what keeps the no-pad keyboard path (and both pins) byte-exact. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Locate the live pad object. The Gamepad API hands back a fresh snapshot
   *  array each call; entries can be null (the slot a pad disconnected from). */
  private current(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.index >= 0) {
      const p = pads[this.index];
      if (p && p.connected) return p;
    }
    // index unset/stale (e.g. page loaded with a pad already plugged, no
    // connect event yet) — adopt the first connected pad we find
    for (const p of pads) {
      if (p && p.connected) {
        this.index = p.index;
        this.connected = true;
        return p;
      }
    }
    return null;
  }

  /** Edge: true only on the poll where btn transitions up->down. */
  private edge(pad: Gamepad, idx: number): boolean {
    const now = pressed(pad.buttons[idx]);
    const was = this.prev[idx] ?? false;
    this.prev[idx] = now;
    return now && !was;
  }

  /**
   * Read the pad once. Rebuilds heldKeys (the digital steer/accel/boost/brake
   * flags Game.ts ORs into the keyboard bitmask) and returns the one-shot
   * intents fired THIS poll. Safe to call every frame; a no-op with no pad.
   *
   * NB: this only sets digital flags — there is NO analog steering path into
   * the sim, by design (see file header). Analog steering is a deferred
   * follow-up precisely because it would add a channel the recorder can't
   * capture, breaking the keyboard pins' byte-exactness.
   */
  poll(ctx: PadContext): GamepadIntent[] {
    // clear last poll's synthetic held flags up front so a released control
    // (stick back to center, trigger let go) drops its key this frame
    for (const k of Object.keys(this.heldKeys)) this.heldKeys[k] = false;

    const pad = this.current();
    if (!pad) {
      this.connected = false;
      return [];
    }
    this.connected = true;

    // ---- HELD (continuous) -> digital key codes the recorder already maps ----
    const lx = pad.axes[AXIS.LEFT_X] ?? 0;
    const steerLeft = lx < -STICK_DEADZONE || pressed(pad.buttons[BTN.DPAD_LEFT]);
    const steerRight = lx > STICK_DEADZONE || pressed(pad.buttons[BTN.DPAD_RIGHT]);
    // both at once (impossible from a stick, possible if D-pad + stick fight) ->
    // cancel, matching how opposing arrow keys net to zero in stepControls()
    if (steerLeft && !steerRight) this.heldKeys['ArrowLeft'] = true;
    if (steerRight && !steerLeft) this.heldKeys['ArrowRight'] = true;

    // RT = accelerate (Burnout-standard). Trigger exposes .value in [0,1].
    if ((pad.buttons[BTN.RT]?.value ?? 0) >= TRIGGER_THRESHOLD) this.heldKeys['ArrowUp'] = true;

    // A = boost (held). Maps to ShiftLeft, which control.ts treats as boost
    // identically to Space — and unlike Space, ShiftLeft's keydown queues no
    // launch command, so holding boost can't re-fire launch.
    if (pressed(pad.buttons[BTN.A])) this.heldKeys['ShiftLeft'] = true;

    // LT or B = brake / tap-to-drift.
    if ((pad.buttons[BTN.LT]?.value ?? 0) >= TRIGGER_THRESHOLD || pressed(pad.buttons[BTN.B])) {
      this.heldKeys['ArrowDown'] = true;
    }

    // NOTE: after a crash, the steer flags above ARE the aftertouch input —
    // Game.stepControls() routes ArrowLeft/Right to aftertouch while wrecked
    // exactly as for the keyboard, so the left stick steers the flying wreck
    // for free, no extra wiring.

    // ---- DISCRETE (one-shot) -> intents routed to the keydown handlers ------
    const intents: GamepadIntent[] = [];
    // Start: launch when idle, restart otherwise — the idle/done split the
    // keyboard (Space launch / Enter restart) and pointer handler use.
    if (this.edge(pad, BTN.START)) intents.push(ctx.idle ? 'launch' : 'restart');
    if (this.edge(pad, BTN.X)) intents.push('crashbreaker');
    if (this.edge(pad, BTN.Y)) intents.push('explode'); // sandbox test blast (keyboard B)
    if (this.edge(pad, BTN.BACK)) intents.push('mute');
    // keep prev[] current for buttons used as HELD too (A/B/triggers/dpad), so
    // they never spuriously edge-fire if later remapped to a one-shot
    pressed(pad.buttons[BTN.A]);

    return intents;
  }
}
