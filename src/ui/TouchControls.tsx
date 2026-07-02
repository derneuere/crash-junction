import { useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { GameState, type ModeKind } from '../game/types';
import { setKey, releaseAllTouchKeys, synthKey } from './keys';

/** On-screen thumb controls for phones/tablets. Every button drives the sim
 *  through the EXACT recorded key path the keyboard uses (see keys.ts): a hold
 *  button dispatches keydown/keyup for a replay.ts KEY_CODES key, a tap button
 *  reuses synthKey for the one-shot handlers. So touch input is fully
 *  interchangeable with the keyboard and replay-deterministic — no new sim
 *  channel, no risk to the determinism pins.
 *
 *  Only mounts when the primary pointer is coarse (a finger) or when forced with
 *  ?touch=1 (handy for demoing/QA in a desktop browser). On a mouse machine it
 *  returns null, so desktop is completely untouched. */

/** True on touch devices (or when ?touch=1/0 overrides). Evaluated once. */
function detectTouch(): boolean {
  if (typeof window === 'undefined') return false;
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced != null) return forced !== '0';
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

interface HoldButtonProps {
  /** A replay.ts KEY_CODES value — rides the recorded per-frame key bitmask. */
  code: string;
  className: string;
  label: ReactNode;
  ariaLabel: string;
}

/** Press-and-hold control: keydown on touch-down, keyup on release. Pointer
 *  capture keeps the release reliable even if the thumb slides off the button,
 *  and the unmount cleanup drops a still-held key when the layout swaps (e.g.
 *  you're holding GAS at the instant the car wrecks and the GAS button vanishes)
 *  so no flag can stick. */
function HoldButton({ code, className, label, ariaLabel }: HoldButtonProps) {
  const down = useRef(false);
  const press = (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (!down.current) {
      down.current = true;
      setKey(code, true);
    }
  };
  const release = () => {
    if (down.current) {
      down.current = false;
      setKey(code, false);
    }
  };
  // release if this button unmounts mid-hold (driving↔aftertouch layout swap)
  useEffect(() => release, []);
  return (
    <button
      type="button"
      className={className}
      aria-label={ariaLabel}
      onPointerDown={press}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

interface TouchControlsProps {
  state: GameState;
  mode: ModeKind;
  crashbreaker: number; // 0..1 charge — lights the SMASH button when full
  replaying: boolean; // a tape is driving — hide the controls (input is ignored anyway)
}

export function TouchControls({ state, mode, crashbreaker, replaying }: TouchControlsProps) {
  const [touch] = useState(detectTouch);

  // safety net: drop every held key if the tab is hidden or loses focus, so a
  // finger down when the app is backgrounded can't leave a control stuck on.
  useEffect(() => {
    if (!touch) return;
    const onHide = () => { if (document.hidden) releaseAllTouchKeys(); };
    addEventListener('visibilitychange', onHide);
    addEventListener('blur', releaseAllTouchKeys);
    addEventListener('pagehide', releaseAllTouchKeys);
    return () => {
      removeEventListener('visibilitychange', onHide);
      removeEventListener('blur', releaseAllTouchKeys);
      removeEventListener('pagehide', releaseAllTouchKeys);
      releaseAllTouchKeys();
    };
  }, [touch]);

  if (!touch || replaying) return null;

  const driving = state === GameState.Launch;
  const crashed = state === GameState.Crash || state === GameState.Settle;
  const done = state === GameState.Done;

  return (
    <div className="touch">
      {/* Landscape nudge — the whole thing plays best sideways. CSS-gated to
          portrait (see .rotateHint), so it self-dismisses the moment you turn. */}
      <div className="rotateHint">
        <div className="rotateInner">
          <div className="rotateIcon">⟲</div>
          <div className="rotateMsg">ROTATE YOUR DEVICE</div>
          <div className="rotateSub">CRASH JUNCTION PLAYS BEST IN LANDSCAPE</div>
        </div>
      </div>

      {driving && (
        <>
          <div className="touchSteer">
            <HoldButton code="ArrowLeft" className="tBtn tDir" ariaLabel="Steer left" label="◄" />
            <HoldButton code="ArrowRight" className="tBtn tDir" ariaLabel="Steer right" label="►" />
          </div>
          <div className="touchDrive">
            <HoldButton code="ShiftLeft" className="tBtn tBoost" ariaLabel="Boost" label="BOOST" />
            <HoldButton code="ArrowDown" className="tBtn tBrake" ariaLabel="Brake / drift" label="DRIFT" />
            <HoldButton code="ArrowUp" className="tBtn tGas" ariaLabel="Accelerate" label="GAS" />
          </div>
        </>
      )}

      {crashed && (
        <>
          {/* After a wreck the arrow keys ARE the aftertouch input, so the same
              KEY_CODES drive the flying wreck — no extra wiring. */}
          <div className="touchPad">
            <HoldButton code="ArrowUp" className="tBtn tDir tUp" ariaLabel="Aftertouch up" label="▲" />
            <HoldButton code="ArrowLeft" className="tBtn tDir tLeft" ariaLabel="Aftertouch left" label="◄" />
            <HoldButton code="ArrowRight" className="tBtn tDir tRight" ariaLabel="Aftertouch right" label="►" />
            <HoldButton code="ArrowDown" className="tBtn tDir tDown" ariaLabel="Aftertouch down" label="▼" />
          </div>
          {mode === 'crash' && (
            <div className="touchDrive">
              <button
                type="button"
                className={`tBtn tCb${crashbreaker >= 1 ? ' ready' : ''}`}
                aria-label="Crashbreaker"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  synthKey('KeyE'); // == E; the sim ignores it until charged
                }}
                onContextMenu={(e) => e.preventDefault()}
              >
                SMASH
              </button>
            </div>
          )}
        </>
      )}

      {done && (
        <button
          type="button"
          className="tBtn tRestart"
          aria-label="Restart"
          onClick={(e) => {
            synthKey('Enter'); // == restart
            e.currentTarget.blur();
          }}
        >
          ↻ RETRY
        </button>
      )}
    </div>
  );
}
