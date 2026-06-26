import type { Actor } from '../types';

/** What a player impact amounts to, before any consequences are applied. */
export interface ImpactJudgment {
  /** The player wrecks: crash state, crashtime cinematics. */
  playerCrashes: boolean;
  /** Shunt takedown: the victim wrecks, the player powers through. */
  takedown: boolean;
}

// ---------- contact resolution (per game mode) ----------

/** Everything a mode needs to judge one hard, non-scenery contact. */
export interface ContactContext {
  self: Actor;
  other: Actor | null; // null = a wall (static non-scenery body)
  impact: number;
  simTime: number;
  shuntGrace: ReadonlyMap<number, number>; // bodyId → simTime of the shunt
  /** Track barrier only: the along-wall direction. Wall touches are judged
   *  against its side normal — engine contact normals on segment END faces
   *  would read shallow scrapes as head-ons. */
  wallDir: { x: number; z: number } | null;
  /** simTime until which the player's takedown wall-grace runs (see
   *  TAKEDOWN_WALL_GRACE) — walls glance instead of wrecking, debris
   *  doesn't destabilize. */
  playerWallGraceUntil: number;
}

/** What the core should apply for this contact. */
export interface ContactOutcome {
  wreckSelf: boolean;
  wreckOther: boolean;
  /** TAKEDOWN presentation: flash + boost refill (+ cash where scored). */
  takedown: boolean;
  /** Race only: cut to the takedown camera while the autopilot drives. */
  takedownCam: boolean;
  /** Junction shunt: the checked car tumbles clear, can't wreck us for a beat. */
  graceOther: boolean;
  destabilizeSelf: number; // seconds of shunt-mode slide (0 = none)
  destabilizeOther: number;
  /** Extra horizontal shove (m/s) down the rammer's line, on top of the
   *  physics impulse — the Burnout shunt kick. Never vertical. */
  shoveOther: number;
  /** The mirrored kick when SELF is the one slammed — the sideways force
   *  that makes a slam felt without scripting a wreck. */
  shoveSelf: number;
  /** Shallow wall touch: scrub a little speed, reroute along the wall. */
  wallGlance: boolean;
}

export const none = (): ContactOutcome => ({
  wreckSelf: false,
  wreckOther: false,
  takedown: false,
  takedownCam: false,
  graceOther: false,
  destabilizeSelf: 0,
  destabilizeOther: 0,
  shoveOther: 0,
  shoveSelf: 0,
  wallGlance: false,
});
