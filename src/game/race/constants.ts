import * as CANNON from 'cannon-es';

export const AI_YAW = 1.35; // rad/s steering authority (a touch under the player's drift)
// ---- force-port: scripted rival steering ----
// AI steer = clamp(-wrapAngle(aim - bodyHeading) * AI_STEER_GAIN, -1, 1). NOT
// divided by steerLock (that double-compensates — the solver already scales
// the wheel angle by the speed-sensitive lock). STARTING value; re-tune in
// preview vs the ~0.2 s emergent yaw build (weaving=too high, wide=too low).
export const AI_STEER_GAIN = 2.2;
export const AI_ACC = 13;
export const AI_BRAKE = 20;
export const RESPAWN_AFTER = 2.5; // s wrecked before the reset pair kicks in
export const RESET_SPEED = 10; // "SLOW" EResetSpeedType
export const SHORTCUT_SLACK = 4; // corridor slack (m) — same half-spacing slack as the main road

// ---- the catch-up band, Burnout 3 style ----
// B3 keeps the pack glued to the player both ways: rivals behind run hot
// (the infamous "AI boost"), rivals ahead breathe out — close enough to
// fight, never gifted the lead. The band is a multiplier on the section
// speed classes, eased over distance so pace never reads as a switch.
export const RUBBER_MAX = 1.32; // flat-out factor when far behind
export const RUBBER_BEHIND_FULL = 110; // m behind the player for the full boost
export const RUBBER_MIN = 0.93; // leaders coast, they don't park
export const RUBBER_AHEAD_FULL = 90; // m ahead where the coast bottoms out
export const AI_TOP = 46; // hard ceiling, catch-up included (player: 39, boost 48)

// ---- aggression ----
// B3 rivals don't just race — they hunt. A rival with a clean shot picks an
// attack run: a SHUNT (ram the bumper, surge through them) when the victim
// sits dead ahead, a SLAM (lean through their door, ideally into a wall)
// when door-to-door. Runs are time-boxed, abort for braking zones and wall
// margins, and respect a cooldown so combat comes in beats, not a grind.
export const DECIDE_EVERY = 0.5; // s between attack decisions
export const ATTACK_AHEAD = 17; // engagement envelope in the rival's frame (m)
export const ATTACK_BEHIND = 6;
export const ATTACK_LAT = 5.5;
export const SHUNT_LAT = 2.0; // inside this beam width the victim is "dead ahead"
export const SHUNT_TIME = 1.7; // s an attack run is pressed before giving up
export const SLAM_TIME = 1.3;
// Burnout-style slam lineup. A committed slam isn't a dive at the door from
// behind — the rival pulls ALONGSIDE the victim on the side it's already on
// (draws even), then once it's beside them (the commit gate) cuts THROUGH
// their line into the door. A +offset aim point off the victim's RIGHT vector
// lines up alongside; a −offset cuts through; the commit gate is an
// along/lateral-separation window.
export const SLAM_ALONGSIDE = 2.0; // m abeam of the victim to draw even before barging
export const SLAM_CUT = 1.4; // m past the victim's centre the cut aims (through the door)
export const SLAM_ALONG_BAND = 3.0; // |alongSep| under this (m): level enough to commit
export const SLAM_BESIDE = 3.2; // |latSep| under this (m): alongside, not still closing in
export const ATTACK_COOLDOWN = 4; // base s between runs, scaled by aggression
export const LANE_RATE = 3.5; // m/s of lateral line adjustment
export const WANDER = 2.2; // m of line wander around the preferred lane

export const PLAYER = -1; // victim index sentinel

export const UP = new CANNON.Vec3(0, 1, 0);
