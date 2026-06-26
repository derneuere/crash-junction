import type { LevelDef } from '../../types';
import { SECTIONS, START } from './waypoints';
import { SHORTCUTS, SIGNATURES } from './shortcuts';
import { COAST, ZONES } from './coast';

export const gantryPoint: LevelDef = {
  name: 'GANTRY POINT',
  ground: 'field', // grass island — the race ribbon is the only paving
  coast: COAST,
  mode: {
    kind: 'race',
    race: {
      laps: 2, // ~2.5 min race; shortcut knowledge pays twice
      width: 22, // four Burnout lanes, same as SILVER LAKE RING — room for combat
      sections: SECTIONS,
      // the GDD's full five-car grid (§2): a deeper pack than SILVER LAKE so
      // the slow pockets concertina — "takedowns everywhere" needs targets.
      // Personalities mirror SILVER LAKE's spread (pacesetter / headhunter /
      // cruiser / bully) plus a mid-temper scrapper: the quickest car races
      // mostly clean at the sharp end while the hunters live in the pack,
      // where the dock pockets concertina the field into reach.
      rivals: [
        { color: 0x2266dd, skill: 0.97, aggression: 0.5 }, // the pacesetter — wins on pace, scraps only when crowded
        { color: 0xeeaa22, skill: 0.94, aggression: 0.85 }, // the headhunter — hunts the player through the pockets
        { color: 0x22bb55, skill: 0.92, aggression: 0.3 }, // the cruiser — minds its racing line
        { color: 0x8844cc, skill: 0.9, aggression: 0.95 }, // the bully — lives for the slam
        { color: 0xd4408a, skill: 0.87, aggression: 0.6 }, // the scrapper — slow, but trades paint to hold the spot
      ],
      shortcuts: SHORTCUTS,
      signatures: SIGNATURES,
      wallStyles: ZONES.flatMap((z) => z.wallStyles ?? []),
    },
  },
  player: {
    variant: 'sedan',
    color: 0xc41e16,
    x: START.x - START.dirZ * 2.6, // grid slot right of the line
    z: START.z + START.dirX * 2.6,
    dir: { x: START.dirX, z: START.dirZ },
    speed: 0,
  },
  traffic: [],
  // Knockable furniture (dynamic actors — never ON a ribbon's driving line).
  // Every spot was audited against the fine-sampled spline chains of the
  // flow-pass geometry (same band math as tools/audit-gantry-dressing.mjs):
  // mouth barrels stand 1–3 m outside their branch ribbon's edge in the
  // fork wedges and flanks, ≥ 12 m off the main centreline — most inside
  // the wall-gap spans, so a wide line clips them from either road. The
  // ROADBLOCK cluster is the exception by necessity: the chicane is walled
  // on both sides, so its run-off is the outer band of the corridor itself;
  // everything there sits ~8.3–9.5 m off the centreline (≥ 1.5 m inside the
  // wall), ground the slalom line never uses.
  poles: [
    // ROADBLOCK run-off lamps (GDD §6): planted where each middle flick's
    // overshoot ray crosses the outer band, in front of the barricade decor
    // behind the wall — blow the flick and you fell a streetlight before
    // you meet the barrier. Both inside the signature circle. Re-seated for
    // the flow pass: flick 3's centreline moved ~11 m west, flick 2's verge
    // tightened ~1 m.
    { x: -248, z: 23.5 },
    { x: -220, z: 5 },
  ],
  barrels: [
    // Shortcut-mouth markers (GDD §7: 2–4 barrels at each entry so the cuts
    // read at speed; §5.1 prices Harbor's mouth in barrels). Explosive red —
    // clipping one on the way into a cut is the advertised risk.
    // HARBOR RUN: flanking the gravel lane through the port-gate furniture
    { x: 216, z: -34 },
    { x: 216.5, z: -37 },
    { x: 234, z: -44 },
    { x: 236, z: -48 },
    // FLYOVER LINK: one under the banner tower, a pair in the slip-road
    // crotch where the link peels off the straight
    { x: 169, z: -204 },
    { x: 192, z: -202 },
    { x: 196, z: -197 },
    // LOOKOUT LEDGE: on the seaward lip at the mouth, short of the solid
    // rim rocks — the narrowest cut announces itself loudest (moved with
    // the ess fork ~18 m east).
    // Elevation: this pair seats at +6 m — Game.ts passes the sampler's
    // base() into createBarrel (elevation.md Phase 1 furniture-y item),
    // so they stand ON the embankment instead of buried inside it.
    { x: 39, z: 249 },
    { x: 33, z: 251 },
    // BEACH RUN: fork-wedge pair by the pylon, seaward pair by the pier —
    // the eased fork pulled the ribbon's first reach ~6 m east, so all
    // four re-seated back to the 1–3 m band off the new edge
    { x: -231, z: -116 },
    { x: -229, z: -125 },
    { x: -246, z: -116 },
    { x: -247, z: -107.5 },
    // ROADBLOCK run-off (GDD §6 "2–3 knockable barrels in the run-off"):
    // bunched on the overshoot rays of the two middle flicks, all inside
    // the signature circle — shoving someone wide here reads as smashing
    // them through the roadblock. The flick-2 trio stays (the eased line
    // drifted them < 1.5 m, still in band); the flick-3 pair follows its
    // centreline ~9 m west.
    { x: -252, z: 32 },
    { x: -250, z: 29 },
    { x: -249, z: 26 },
    { x: -220, z: 11 },
    { x: -219.5, z: 7.5 },
  ],
  // Both ramps live on branch corridors (no walls there), ascend toward +z
  // per the RampDef constraint, and sit dead on their chain centrelines
  // (lateral offset audited at 0.3 m / 1.0 m). The main loop never comes
  // within 16 m of either wedge, so the global height sampler can't bump a
  // car running the ordinary racing line.
  ramps: [
    // Harbor Run container ramp — the compulsory jump mid-lane; the landing
    // corridor (z 45–62 at x 226) stays prop-free by GDD decree
    { x: 226, zStart: 14, length: 9, width: 7, height: 2.2 },
    // Flyover Link ramp — the "highway link" fantasy on a flat world
    { x: 220, zStart: -142, length: 10, width: 8, height: 2.0 },
  ],
  buildings: ZONES.flatMap((z) => z.buildings ?? []),
  pickups: [],
  props: ZONES.flatMap((z) => z.props),
  patches: ZONES.flatMap((z) => z.patches ?? []),
  decals: ZONES.flatMap((z) => z.decals ?? []),
};
