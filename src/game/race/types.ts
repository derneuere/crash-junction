import type { Actor } from '../types';
import type { RaceSection } from './sections';
import type { VehicleForceState } from '../control/driving';

/** A shortcut's resampled section chain plus where it hands progress back.
 *  Player-only: rivals NEVER take shortcuts — BP-style, the AI owns the
 *  main racing line; branches are the player's knowledge reward (and risk),
 *  so AI paths and the pack's pace are untouched by them. */
export interface ShortcutChain {
  exit: number; // main-loop section index where the branch rejoins
  halfW: number;
  secs: RaceSection[];
}

export interface RacerState {
  a: Actor;
  heading: number;
  speed: number;
  target: number; // section index we're driving toward
  lap: number;
  respawnT: number;
  skill: number; // corner-speed multiplier <1 — what makes them beatable
  aggression: number; // 0 clean … 1 bully — gates attack rolls and cooldowns
  lane: number; // preferred lateral offset off the section centre (m)
  laneNow: number; // smoothed actual offset — the line they're driving
  phase: number; // per-rival wander phase, fixed at spawn
  attackT: number; // s left pressing the current attack (0 = not attacking)
  attackKind: 'shunt' | 'slam';
  slamCut: boolean; // slam has lined up and is now cutting through (barge speed)
  victim: number; // racers index, or PLAYER, valid while attackT > 0
  cooldown: number; // s until the next attack roll
  decideT: number; // s until the next decision tick (staggered per rival)
  rubber: number; // smoothed catch-up factor — also scales acceleration
  heat: number; // B3 hostility: ≥1, rises when the player roughs this rival up
  offT: number; // s spent beyond the road edge — combat can throw a rival
  //               over the barrier, and there's no driving back in
  progress: number;
  loose: boolean; // was destabilized last step — resync AI on recovery
  /** Per-rival force-solver state (createForceState). The rival feeds the SAME
   *  stepVehicleForces the player uses a scripted ControlInput each frame;
   *  heading/speed are re-seeded from the body at the top of stepRival. */
  fs: VehicleForceState;
}
