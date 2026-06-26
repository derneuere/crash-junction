import type { Actor } from '../types';
import { SHUNT_WRECK_THRESHOLD, SHUNT_FRAGILE_WALL_RELIEF } from '../constants';
import { type ContactContext, type ContactOutcome, none } from './types';
import { judgePlayerImpact, judgeAggressor, isTboneTakedown, wallApproach } from './judgment';

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
        const playerAggressor = judgeAggressor(self, other) === 'self';
        if (playerAggressor && isTboneTakedown(self, other)) {
          // T-BONE TAKEDOWN — a fast broadside into the rival's flank wrecks
          // them OUTRIGHT, no wall needed (the missing mechanic). Gated on
          // closing speed + impact angle so a catch-up shunt or a door-to-door
          // never trips it; classifyTakedown labels it T-BONE off the same
          // geometry. takedownCam + graceOther mirror the wall-takedown payoff.
          out.wreckOther = true;
          out.takedown = true;
          out.takedownCam = true;
          out.graceOther = true;
        } else if (playerAggressor) {
          if (other.destabilized > 0 && other.howCloseToWrecked >= SHUNT_WRECK_THRESHOLD) {
            // a SECOND hard shunt landing while they're already sliding and
            // loaded up (howCloseToWrecked high) tips them over — no wall
            // needed. Burnout's recoverable out-of-control slide: one shunt and they
            // catch it, shunt them again before they do and they wreck. Pays
            // out as a TAKEDOWN like the wall finish.
            out.wreckOther = true;
            out.takedown = true;
            out.takedownCam = true;
            out.graceOther = true;
          } else {
            out.destabilizeOther = 2.2; // shunt mode — they fight the slide
            // the ram's kick — now the Δv (m/s) the impulse aims to transfer
            // (Game.applyShuntKick scales it by closing-speed gate + mass ratio).
            // No longer saturating at ~impact 12: a 40 m/s boost-ram transfers
            // clearly more than a catch-up tap, the way Burnout's does.
            out.shoveOther = Math.min(28, 4 + impact * 0.8);
          }
        } else {
          // slammed: a sideways kick + a fragile beat — never a scripted
          // wreck on the FIRST slam. But a hard slam landing while we're
          // already sliding and loaded up finishes us — the same recoverable
          // gradient, now against the player (whether it's our takedown to
          // give is up to the rival's credit, judged in Game).
          if (self.destabilized > 0 && self.howCloseToWrecked >= SHUNT_WRECK_THRESHOLD && !graced) {
            out.wreckSelf = true;
          } else {
            out.destabilizeSelf = 1.5;
            out.shoveSelf = Math.min(22, 3 + impact * 0.6);
            // SLAM (Feature F): being slammed loose is the one-shot wallop — a
            // parabolic yaw wobble on top of the sideways shove, distinct from
            // the aggressor's clean SHUNT punt above (which leaves shoveOther
            // but no slam). Scaled by impact so a hard slam wobbles more.
            out.slamSelf = Math.min(1, impact / 12);
          }
        }
      }
    } else if (isWall) {
      const { closing, steep } = wallApproach(self, ctx.wallDir, impact);
      if (self.destabilized > 0) {
        // fragile, not doomed: the old any-angle 3.5 turned every wall kiss
        // during a slide into a wreck + respawn beat. It still takes a
        // reasonably square hit — just much less than a clean one. A slide
        // that's loaded up (howCloseToWrecked) wrecks on a gentler touch —
        // the recoverable gradient smoothly extended onto the barrier.
        const bar = 4.5 - SHUNT_FRAGILE_WALL_RELIEF * self.howCloseToWrecked;
        if (closing > bar && steep > 0.3 && !graced) out.wreckSelf = true;
        else out.wallGlance = true;
      } else if (closing > 7 && steep > 0.45 && !graced) {
        out.wreckSelf = true; // hard and frontal
      } else {
        out.wallGlance = true; // scrape: lose a little speed, carry on
      }
    }
  } else if (!self.isPlayer && self.kind === 'vehicle' && !self.crashed && isWall) {
    // a destabilized rival meeting the barrier — the payoff. A loaded-up
    // slide (howCloseToWrecked) wrecks on a gentler touch, same gradient.
    const bar = 3.5 - SHUNT_FRAGILE_WALL_RELIEF * self.howCloseToWrecked;
    if (self.destabilized > 0 && wallApproach(self, ctx.wallDir, impact).closing > bar) {
      out.wreckSelf = true;
      out.takedown = self.destabilizedByPlayer;
      out.takedownCam = self.destabilizedByPlayer;
    }
  } else if (
    // chain shunt (#1): rival AI is velocity-driven and would soak a sliding
    // car's momentum dead — instead the slide knocks the blocker loose too.
    // Player credit propagates (Game), so a chained wall wreck still pays
    // out as a TAKEDOWN, Burnout style. The destabilizedBy guard keeps the
    // car that WON the contact from being read as a blocker by its own
    // victim's mirrored collide event.
    !self.isPlayer && self.kind === 'vehicle' && !self.crashed && self.destabilized > 0 &&
    other?.kind === 'vehicle' && !other.isPlayer && !other.crashed && other.destabilized <= 0 &&
    other.body.id !== self.destabilizedBy &&
    impact > 3
  ) {
    out.destabilizeOther = 1.4;
    out.shoveOther = Math.min(18, 2 + impact * 0.6);
    // a sliding rival that's loaded up (howCloseToWrecked) and piles into
    // another car wrecks itself too — the recoverable gradient, off the wall:
    // shunted, never caught it, then hit traffic. Player credit still rides
    // destabilizedByPlayer (Game pays the chained wreck out as a TAKEDOWN).
    if (self.howCloseToWrecked >= SHUNT_WRECK_THRESHOLD) {
      out.wreckSelf = true;
      out.takedown = self.destabilizedByPlayer;
      out.takedownCam = self.destabilizedByPlayer;
    }
  } else if (
    // rival-on-rival combat: two clean AI cars trading paint get the same
    // aggressor judgment as the player — the loser picks up shunt mode and
    // the kick. Only the winner's collide event applies it (the judgment is
    // anti-symmetric), so the pair resolves exactly once. No takedown cam,
    // no player credit — just rivals feuding in the mirrors, B3 style.
    !self.isPlayer && self.kind === 'vehicle' && !self.crashed && self.destabilized <= 0 &&
    other?.kind === 'vehicle' && !other.isPlayer && !other.crashed && other.destabilized <= 0 &&
    impact > 4.5
  ) {
    if (judgeAggressor(self, other) === 'self') {
      out.destabilizeOther = 1.5;
      out.shoveOther = Math.min(20, 2.5 + impact * 0.65);
      // SLAM (Feature F): a rival slammed loose in a feud gets the same
      // one-shot yaw wobble the player does when slammed — rivals feel knocked
      // about, not just nudged sideways.
      out.slamOther = Math.min(1, impact / 12);
    }
  }
  return out;
}
