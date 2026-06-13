import type { Actor } from './types';

// ----------------------------------------------------------------------------
// TAKEDOWN CLASSIFICATION — Burnout 3 style.
//
// When a takedown resolves in Game.onCollide, the core hands us the data the
// sim already computed for THAT contact (the rammer, the victim, the impact
// speed, whether the player was steering their wreck, whether the victim was
// airborne, the signature zone the wreck landed in, the revenge ledger) and we
// derive a TYPE NAME + a POINTS value for the banner. We name the takedown the
// way B3 does — the banner tells you HOW you got them.
//
// DETERMINISM CONTRACT (load-bearing): this module is PURE PRESENTATION. It
// READS sim state and returns a label + a number. It MUST NOT:
//   - write any physics/body/control state,
//   - consume the seeded sim RNG (rng.ts simRand) — no randomness at all here,
//   - feed anything back into the recorded sim inputs.
// The revenge ledger it keeps (TakedownTracker) is derived only from sim reads
// and is never read back by the sim, so it can't move a pin. If a determinism
// pin ever diverges after touching this file, the logic leaked into the sim —
// move it back out here.
//
// B3 research (burnout.fandom.com/wiki/Takedown, /wiki/Aftertouch,
// /wiki/Signature_Takedowns_(Burnout_3), strategywiki B3/Gameplay):
//   - Signature Takedown — slam a rival into a named environmental hazard;
//     flagged by a camera flash and worth MORE than a standard takedown.
//   - Aftertouch Takedown — steer your own wreck into a rival after you crash;
//     refills boost and protects your bonus meter (the showy one).
//   - Vertical Takedown — take a rival down while they're airborne off a ramp
//     (B3 ramps / Revenge races).
//   - Wall Takedown — slam a rival into the wall so they crash (the baseline).
//   - Car / Van / Truck / Bus Takedown — slam a rival into traffic of that
//     class. We fold our traffic into CAR / BUS / TANKER by victim variant.
//   - Revenge Takedown — take down a rival who had previously taken YOU down.
//   - T-bone is a Revenge/Paradise term, but a side-on slam reads great, so we
//     classify a broadside hit as T-BONE and a rear-end as a SHUNT.
// Points below are OUR arcade values (B3 never published a public table); they
// rank the way B3 ranks them: signature & aftertouch are the showpieces.
// ----------------------------------------------------------------------------

export type TakedownKind =
  | 'signature' // victim wrecked inside a named theatre (zone name shown)
  | 'aftertouch' // player steered their own wreck into the victim
  | 'vertical' // victim taken down airborne (off a ramp)
  | 'revenge' // victim had previously taken the player down
  | 'tbone' // broadside slam — abeam of the victim's travel
  | 'shunt' // rear-end / longitudinal slam
  | 'traffic' // junction: shunted a traffic car (named by its class)
  | 'wall'; // the baseline race takedown into the barrier

export interface TakedownInfo {
  kind: TakedownKind;
  /** The banner's big line — e.g. 'CRANE SMASH', 'AFTERTOUCH TAKEDOWN'. */
  label: string;
  /** Points awarded for this takedown (type-specific, see POINTS). */
  points: number;
}

/** Everything the classifier reads — all of it already lives in the sim at the
 *  moment a takedown resolves (Game.onCollide). Pure inputs, no mutation. */
export interface TakedownContext {
  /** The car that delivered the hit (usually the player or a player-chained
   *  rival); may be the wreck itself on an aftertouch. */
  rammer: Actor;
  /** The car that gets wrecked. Null only on degenerate paths (no banner). */
  victim: Actor | null;
  /** Impact speed along the contact normal (m/s) — the sim's own number. */
  impact: number;
  /** True if the player was actively steering their wreck this step
   *  (Game.aftertouchActive) — the aftertouch takedown tell. */
  aftertouch: boolean;
  /** Signature theatre the victim wrecked inside, or null. */
  signatureZone: string | null;
  /** True if the level is the open junction (traffic kills) vs a circuit. */
  junction: boolean;
}

// Base points per type. Tuned so the showpieces pop and the everyday slam
// still feels worth it. These ride the damage-cash multiplier in score.ts.
const POINTS: Record<TakedownKind, number> = {
  signature: 700, // the marquee — a named theatre, B3's camera-flash takedown
  aftertouch: 600, // steering your wreck into them: the flashiest skill move
  vertical: 500, // catching them in the air off a ramp
  revenge: 450, // settling the score with someone who wrecked you
  tbone: 350, // a clean broadside
  traffic: 300, // junction traffic by class
  shunt: 250, // a straight rear-end punt
  wall: 200, // the bread-and-butter wall slam
};

/** Speed bonus: a harder hit pays more, capped so it stays a bonus not a
 *  jackpot. ~25 points per m/s over the takedown floor (4 m/s), max +400. */
function speedBonus(impact: number): number {
  return Math.min(400, Math.max(0, Math.round((impact - 4) * 25)));
}

/** Human-readable victim class for a junction traffic takedown. */
function trafficLabel(victim: Actor): string {
  switch (victim.spec?.variant) {
    case 'bus':
      return 'BUS TAKEDOWN';
    case 'tanker':
      return 'TANKER TAKEDOWN';
    default:
      return 'TRAFFIC TAKEDOWN';
  }
}

/** Is the rammer's line abeam of the victim's travel (a side slam / T-bone) or
 *  behind it (a rear-end shunt)? Same geometry judgeAggressor uses. Read-only:
 *  positions and velocities in, a boolean out. */
function isBroadside(rammer: Actor, victim: Actor): boolean {
  const dx = victim.body.position.x - rammer.body.position.x;
  const dz = victim.body.position.z - rammer.body.position.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d;
  const nz = dz / d;
  // victim travel direction (facing if nearly stopped)
  const vv = victim.body.velocity;
  const vsp = Math.hypot(vv.x, vv.z);
  const vx = vsp > 2 ? vv.x / vsp : (victim.scripted?.dir.x ?? nx);
  const vz = vsp > 2 ? vv.z / vsp : (victim.scripted?.dir.z ?? nz);
  // |alignment| ~1 = rammer is behind/ahead (longitudinal), ~0 = abeam
  const along = Math.abs(nx * vx + nz * vz);
  return along < 0.55;
}

/** Was the victim airborne when the takedown landed — a vertical takedown?
 *  Off the ground (none of its corners touching) AND meaningfully off grade. */
function isAirborne(victim: Actor): boolean {
  const grounded = victim.susp.some((s) => s.grounded);
  if (grounded) return false;
  // some height above the road base (suspension is ~0.8 m ride height); also
  // require a little vertical motion so a wreck resting on its roof off the
  // suspension model doesn't read as "airborne".
  return victim.body.position.y > 1.6 || Math.abs(victim.body.velocity.y) > 2.5;
}

/** Classify a resolved takedown into a B3-style type + banner label + points.
 *  Priority is the B3 reading order: the signature theatre and the aftertouch
 *  skill move trump everything, then vertical air, then the revenge story,
 *  then the geometry of the slam. Falls back to a plain WALL/TRAFFIC takedown.
 */
export function classifyTakedown(ctx: TakedownContext, tracker: TakedownTracker): TakedownInfo {
  const { victim, impact, aftertouch, signatureZone, junction, rammer } = ctx;
  let kind: TakedownKind;
  let label: string;

  if (signatureZone) {
    kind = 'signature';
    label = signatureZone; // the theatre's own name — CRANE SMASH, CLIFF CRASH…
  } else if (aftertouch) {
    kind = 'aftertouch';
    label = 'AFTERTOUCH TAKEDOWN';
  } else if (victim && isAirborne(victim)) {
    kind = 'vertical';
    label = 'VERTICAL TAKEDOWN';
  } else if (victim && tracker.isRevenge(victim)) {
    kind = 'revenge';
    label = 'REVENGE TAKEDOWN';
  } else if (junction && victim) {
    kind = 'traffic';
    label = trafficLabel(victim);
  } else if (victim && isBroadside(rammer, victim)) {
    kind = 'tbone';
    label = 'T-BONE TAKEDOWN';
  } else if (victim) {
    kind = 'shunt';
    label = 'SHUNT TAKEDOWN';
  } else {
    kind = 'wall';
    label = 'TAKEDOWN';
  }

  const points = POINTS[kind] + speedBonus(impact);

  // remember that the player just settled this score, and forget any grudge
  // we held against this victim (it's paid).
  if (victim) tracker.clearGrudge(victim);

  return { kind, label, points };
}

/** The revenge ledger: which rivals have taken the player down and are owed a
 *  Revenge Takedown. PRESENTATION-ONLY state — written from sim reads, never
 *  read back by the sim, so it can't perturb a determinism pin. Reset per take
 *  alongside the rest of the run state. */
export class TakedownTracker {
  private grudges = new Set<number>(); // body ids of rivals who wronged the player

  /** Record that `aggressor` just took the player down — they now owe us. */
  rememberAggressor(aggressor: Actor | null): void {
    if (aggressor && !aggressor.isPlayer) this.grudges.add(aggressor.body.id);
  }

  isRevenge(victim: Actor): boolean {
    return this.grudges.has(victim.body.id);
  }

  clearGrudge(victim: Actor): void {
    this.grudges.delete(victim.body.id);
  }

  reset(): void {
    this.grudges.clear();
  }
}
