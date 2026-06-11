import type * as THREE from 'three';
import type { Actor, CollideEvent } from './types';

/** What a player impact amounts to, before any consequences are applied. */
export interface ImpactJudgment {
  /** The player wrecks: crash state, crashtime cinematics. */
  playerCrashes: boolean;
  /** Shunt takedown: the victim wrecks, the player powers through. */
  takedown: boolean;
}

/** The Burnout crash rules (burnout wiki: Takedown / Traffic Check / Wreck):
 *  ramming a same-direction lighter vehicle is a SHUNT — they wreck, you
 *  power through and the boost bar refills. Walls, oncoming traffic and
 *  heavies wreck YOU. Pure judgment: reads bodies and the shunt-grace map,
 *  mutates nothing — the caller applies the consequences. */
export function judgePlayerImpact(
  self: Actor,
  other: Actor | undefined,
  isWall: boolean,
  impact: number,
  simTime: number,
  shuntGrace: ReadonlyMap<number, number>, // bodyId → simTime of the shunt
): ImpactJudgment {
  let crashes = isWall && impact > 5;
  let takedown = false;
  if (other?.kind === 'vehicle') {
    const v = self.body.velocity;
    const sp = Math.hypot(v.x, v.z);
    const ov = other.body.velocity;
    const osp = Math.hypot(ov.x, ov.z);
    // their direction of travel — facing, if they're sitting still
    const odx = osp > 3 ? ov.x / osp : (other.scripted?.dir.x ?? 0);
    const odz = osp > 3 ? ov.z / osp : (other.scripted?.dir.z ?? 0);
    const align = sp > 2 ? ((v.x / sp) * odx + (v.z / sp) * odz) : 1;
    const heavy = (other.spec?.mass ?? 0) > (self.spec?.mass ?? 1) * 1.6;
    // a car we just shunted is still tumbling clear — Revenge launches the
    // checked car harmlessly, so it can't wreck us for a beat
    const graced = simTime - (shuntGrace.get(other.body.id) ?? -9) < 1.2;
    if ((align > 0.35 && !heavy) || graced) {
      takedown = impact > 4 && !other.crashed; // shunt: no crash for the player
    } else if (align < -0.35 && osp > 3) {
      crashes = impact > 5; // head-on with oncoming
    } else if (heavy) {
      crashes = impact > 5; // the bus always wins
    } else {
      crashes = impact > 6.5; // T-boned by crossing traffic
    }
  }
  return { playerCrashes: crashes, takedown };
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
  /** Shallow wall touch: scrub a little speed, reroute along the wall. */
  wallGlance: boolean;
}

const none = (): ContactOutcome => ({
  wreckSelf: false,
  wreckOther: false,
  takedown: false,
  takedownCam: false,
  graceOther: false,
  destabilizeSelf: 0,
  destabilizeOther: 0,
  shoveOther: 0,
  wallGlance: false,
});

/** The junction (and practice) rules — frontal traffic, heavies and walls
 *  wreck you outright; same-direction lighter cars get shunt-checked. This
 *  is the original deadly Burnout crossing behavior. */
export function resolveJunctionContact(ctx: ContactContext, playerCanCrash: boolean): ContactOutcome {
  const { self, other, impact, simTime, shuntGrace } = ctx;
  const isWall = other === null;
  const out = none();

  if (self.isPlayer && !self.crashed && playerCanCrash && (other?.kind === 'vehicle' || isWall)) {
    const v = judgePlayerImpact(self, other ?? undefined, isWall, impact, simTime, shuntGrace);
    out.takedown = v.takedown;
    out.graceOther = v.takedown;
    out.wreckSelf = v.playerCrashes;
  }
  // traffic only wrecks from player-made chaos: the player itself, an
  // existing wreck, or a prop sent flying by a blast — never from its own
  // driving
  const speed = self.body.velocity.length();
  const selfDangerous = self.isPlayer || self.crashed || (self.kind !== 'vehicle' && speed > 5);
  if (selfDangerous && other && other.kind === 'vehicle' && !other.isPlayer && impact > 4) out.wreckOther = true;
  if (!self.isPlayer && self.kind === 'vehicle' && other && (other.isPlayer || other.crashed) && impact > 4) {
    out.wreckSelf = true;
  }
  return out;
}

/** Who is driving into whom. Longitudinal hits (rear-ends): the harder
 *  pusher along the line between the cars wins — that's the shunt. But for
 *  DOOR-TO-DOOR contact (the line between the cars sits mostly abeam of the
 *  pair's travel) the push comparison judges by whose racing line happened
 *  to converge harder — which hands the AI a SLAMMED against a faster
 *  player it merely drifted into. Burnout resolves side contests by
 *  authority: the faster car wins. */
export function judgeAggressor(self: Actor, other: Actor): 'self' | 'other' {
  const dx = other.body.position.x - self.body.position.x;
  const dz = other.body.position.z - self.body.position.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d;
  const nz = dz / d;
  const sv = self.body.velocity;
  const ov = other.body.velocity;
  const selfPush = sv.x * nx + sv.z * nz; // how hard self drives into other
  const otherPush = -(ov.x * nx + ov.z * nz); // and vice versa
  const sSpeed = Math.hypot(sv.x, sv.z);
  const oSpeed = Math.hypot(ov.x, ov.z);
  // |n · combined travel direction|: ~1 = one car behind the other, ~0 = abeam
  const tx = sv.x + ov.x;
  const tz = sv.z + ov.z;
  const tl = Math.hypot(tx, tz) || 1;
  const alongTravel = Math.abs(nx * (tx / tl) + nz * (tz / tl));
  if (alongTravel < 0.55 && Math.abs(sSpeed - oSpeed) > 2) {
    return sSpeed > oSpeed ? 'self' : 'other';
  }
  return selfPush >= otherPush ? 'self' : 'other';
}

/** The racing rules — car contact never wrecks anyone outright. Winning a
 *  ram puts the LOSER into shunt mode (a couple of seconds with no
 *  steering); a wall touch while destabilized is the wreck — and the
 *  TAKEDOWN, if the player caused the slide. Clean wall contact only
 *  wrecks when it's hard and frontal; shallow touches glance off. */
export function resolveRaceContact(ctx: ContactContext): ContactOutcome {
  const { self, other, impact } = ctx;
  const isWall = other === null;
  const out = none();

  if (self.isPlayer && !self.crashed) {
    // a fresh takedown buys the player out of wrecking at the takedown site
    const graced = ctx.simTime < ctx.playerWallGraceUntil;
    if (other?.kind === 'vehicle') {
      // judged once, from the player's side of the pair
      if (other.crashed) {
        if (impact > 5.5 && !graced) out.destabilizeSelf = 1.2; // clipping a wreck unsettles you
      } else if (impact > 4) {
        if (judgeAggressor(self, other) === 'self') {
          out.destabilizeOther = 2.2; // shunt mode — they fight the slide
          out.shoveOther = Math.min(12, 5 + impact * 0.6); // the ram's kick (#1: stronger)
        } else {
          out.destabilizeSelf = 1.5; // slammed — hang on (steering degraded, not dead)
        }
      }
    } else if (isWall) {
      const { closing, steep } = wallApproach(self, ctx.wallDir, impact);
      if (self.destabilized > 0) {
        if (closing > 3.5 && !graced) out.wreckSelf = true; // no hands on the wheel — that's a crash
      } else if (closing > 7 && steep > 0.45 && !graced) {
        out.wreckSelf = true; // hard and frontal
      } else {
        out.wallGlance = true; // scrape: lose a little speed, carry on
      }
    }
  } else if (!self.isPlayer && self.kind === 'vehicle' && !self.crashed && isWall) {
    // a destabilized rival meeting the barrier — the payoff
    if (self.destabilized > 0 && wallApproach(self, ctx.wallDir, impact).closing > 3.5) {
      out.wreckSelf = true;
      out.takedown = self.destabilizedByPlayer;
      out.takedownCam = self.destabilizedByPlayer;
    }
  } else if (
    // chain shunt (#1): rival AI is velocity-driven and would soak a sliding
    // car's momentum dead — instead the slide knocks the blocker loose too.
    // Player credit propagates (Game), so a chained wall wreck still pays
    // out as a TAKEDOWN, Burnout style.
    !self.isPlayer && self.kind === 'vehicle' && !self.crashed && self.destabilized > 0 &&
    other?.kind === 'vehicle' && !other.isPlayer && !other.crashed && other.destabilized <= 0 &&
    impact > 3
  ) {
    out.destabilizeOther = 1.4;
    out.shoveOther = Math.min(8, 3 + impact * 0.4);
  }
  return out;
}

/** How hard and how square a vehicle is closing on a wall. Uses the wall's
 *  own side normal when known; falls back to the engine impact otherwise. */
function wallApproach(
  self: Actor,
  wallDir: { x: number; z: number } | null,
  impact: number,
): { closing: number; steep: number } {
  const v = self.body.velocity;
  const sp = Math.hypot(v.x, v.z);
  let closing = impact;
  if (wallDir) closing = Math.abs(v.x * -wallDir.z + v.z * wallDir.x);
  return { closing, steep: sp > 0.5 ? closing / sp : 1 };
}

/** World contact point of a collision, written into `out`. */
export function contactPointOf(self: Actor, e: CollideEvent, out: THREE.Vector3): THREE.Vector3 {
  const c = e.contact;
  if (c.bi === self.body) {
    out.set(c.bi.position.x + c.ri.x, c.bi.position.y + c.ri.y, c.bi.position.z + c.ri.z);
  } else {
    out.set(c.bj.position.x + c.rj.x, c.bj.position.y + c.rj.y, c.bj.position.z + c.rj.z);
  }
  return out;
}
