import { CARGO, FACT, FLAG, GRANDSTAND, IND, NATURE, PIRATE, PYLON, RACE, decor, type CoastVertex, type ZoneDressing } from './dressing';

// SHARED — everything between the four named zones: the start straight's
// grandstands and BILLBOARD BLAST, the Flyover Link slip-road dressing on
// the Cannery horseshoe, the NW sweeper pines and the ROADBLOCK barricade
// theatre. No refshot pose owns this file — changes here can show up in
// ANY of the four baselines (the dockyard pose sees the start straight, the
// beach pose sees the roadblock verge), so zone agents leave it alone.

export const shared: ZoneDressing = {
  props: [
    // --- BILLBOARD BLAST + start straight (behind the walls; all decor — the
    // racing-kit pivots make a centred collider impossible, and the straight
    // is walled on both sides so nothing here is reachable anyway) ---
    decor(`${RACE}/billboard.glb`, 45, -252, 0, 9, { cx: 0.09, cz: -0.85 }), // the zone's namesake, towering over the south wall
    decor(`${RACE}/grandStandCovered.glb`, 4, -252, 0, 9, GRANDSTAND),
    decor(`${RACE}/grandStand.glb`, -6, -252, 0, 9, GRANDSTAND),
    decor(`${RACE}/grandStandAwning.glb`, -16, -252, 0, 9, GRANDSTAND),
    // start gantry spanning the road: 1.26 native x19 puts the legs ~0.5 m
    // outside each barrier wall — cars thread it every lap
    decor(`${RACE}/overheadLights.glb`, 2, -228, Math.PI / 2, 19, { cx: 0.15, cz: -0.555 }),
    // flag line tracks the infield wall — the straight itself climbs from
    // z -228 to -212 across its run, so the flags climb with it
    decor(`${RACE}/flagCheckers.glb`, 20, -214, Math.PI, 5.5, FLAG),
    decor(`${RACE}/flagRed.glb`, 60, -210, Math.PI, 5.5, FLAG),
    decor(`${RACE}/flagGreen.glb`, 100, -207, Math.PI, 5.5, FLAG),
    decor(`${RACE}/flagCheckers.glb`, 140, -204, Math.PI, 5.5, FLAG),
    decor(`${RACE}/tent.glb`, 60, -200, Math.PI, 7, GRANDSTAND), // team paddock on the infield
    decor(`${RACE}/tentClosedLong.glb`, 92, -202, 0, 7, { cx: 0.65, cz: -1.15 }),
    decor(`${CARGO}/tires.glb`, 52, -246, 1.1, 1),
    decor(`${CARGO}/wheels-stack.glb`, 40, -245, 0.4, 1.8),
    // Flyover Link mouth marker — a banner tower where the slip road forks
    decor(`${RACE}/bannerTowerRed.glb`, 164, -203, 0, 7, { cx: -0.155, cz: -0.845 }),

    // --- Flyover Link slip-road dressing on the Cannery horseshoe ---
    // (ambiguous case: geographically the cannery's, but it dresses the
    // shared slip road, not the harbor's waterfront — so it lives here)
    decor(`${IND}/building-i.glb`, 184, -168, 0, 12, { cx: -0.435, cz: 0.27 }), // the cannery shed, infield of the link
    decor(`${NATURE}/tree_palmTall.glb`, 216, -190, 0.8, 6.5),
    decor(`${NATURE}/plant_bushLarge.glb`, 210, -186, 1.8, 3.5),
    // concrete barriers lining the OUTSIDE of the slip road (GDD 5.2) — decor:
    // the link is the low-risk cut, an invisible-wall surprise would break that
    decor(`${RACE}/barrierWall.glb`, 214, -176, -0.89, 6, { cx: 0.15, cz: -0.71 }),
    decor(`${RACE}/barrierWall.glb`, 228, -136, -1.373, 6, { cx: 0.15, cz: -0.71 }),

    // --- NW sweepers: sparse — the corner IS the feature ---
    // (kept here, not in cliff, despite z >= 185: they dress the shared NW
    // connector arc, per the composer's distribution note). y: measured
    // seats on the downhill run's embankment (elevation.md — the sweepers
    // now descend 6→0, and this verge carries its fade).
    decor(`${NATURE}/tree_pineTallA_detailed.glb`, -216, 228, 2.4, 7, { y: 1.5 }),
    decor(`${NATURE}/tree_pineTallC_detailed.glb`, -252, 180, 0.9, 7, { y: 0.6 }),
    decor(`${NATURE}/stone_largeC.glb`, -258, 140, 0.3, 3, { y: 0.4 }),
    decor(`${NATURE}/plant_bushDetailed.glb`, -206, 232, 0, 3, { y: 2.1 }),

    // --- ROADBLOCK: barricade clusters on the verge outside the middle
    // flicks (decor: the red/white wall is the wrecking surface; these just
    // make shoving someone wide READ as smashing them through a roadblock).
    // The flow pass moved flick 3's centreline ~11 m west, so its east-side
    // cluster follows the wall — a barricade stranded 16 m out in the grass
    // stops reading as the thing you get smashed through. ---
    decor(`${RACE}/barrierWall.glb`, -258, 46, 2.19, 6, { cx: 0.15, cz: -0.71 }),
    decor(`${RACE}/barrierRed.glb`, -260, 38, 2.4, 6, { cx: -0.225, cz: -0.71 }),
    decor(`${RACE}/barrierWhite.glb`, -256, 28, 2.0, 6, { cx: -0.225, cz: -0.71 }),
    decor(`${FACT}/warning-orange.glb`, -254, 52, 0, 1.2),
    decor(`${RACE}/barrierWall.glb`, -214, 6, 0.97, 6, { cx: 0.15, cz: -0.71 }),
    decor(`${RACE}/barrierRed.glb`, -213, -6, 1.1, 6, { cx: -0.225, cz: -0.71 }),
    decor(`${FACT}/warning-traffic.glb`, -216, 14, 0, 1.2),
    decor(`${RACE}/pylon.glb`, -217, -14, 0, 6, PYLON),
    decor(`${RACE}/pylon.glb`, -252, 60, 0, 6, PYLON),

    // --- merge-pass seam masks: the coast skirt swaps type mid-segment at
    // the zone-arc seams (beach→bank behind the chicane verge, beach→bank
    // again behind the straight's east end). A skirt change in open view
    // reads as a texture bug; a rock cluster at the vertex reads as the
    // REASON the shore changes. All decor — nothing drivable comes near.
    { ...decor(`${NATURE}/stone_largeC.glb`, -288, -39, 1.2, 4), tint: 0xe5ded2 },
    { ...decor(`${NATURE}/stone_largeA.glb`, -285, -46, 2.5, 3), tint: 0xe5ded2 },
    { ...decor(`${PIRATE}/rocks-sand-b.glb`, -291, -34, 0.4, 1.4) },
    { ...decor(`${NATURE}/stone_largeC.glb`, 230, -258, 0.8, 3.5), tint: 0xe5ded2 },
    { ...decor(`${PIRATE}/rocks-sand-a.glb`, 222, -260, 2.1, 1.5) },
    decor(`${NATURE}/plant_bushLarge.glb`, 237, -255, 1.4, 3),

    // the harbor concept's lone grass-infield lamp — the infield is shared
    // turf (x < 246), so the quay zone flagged it for the merge pass; arm
    // east over the kerb like the quay line (local +z → yaw π/2). y: the
    // quay climb's inland embankment runs under it now (measured seat).
    decor('builtin:lamp-post', 230, 146, Math.PI / 2, 1.15, { y: 1.5 }),
  ],

  // Merge-pass blending: the named zones repainted their ground wall-to-wall,
  // which left the shared connective turf ending in ruler-straight kind
  // changes at the zone lines. These tongues let the neighbours bleed a few
  // metres into shared grass — same kind and same default y as the zone
  // patch they touch, so the overlap renders as one seamless union (world-
  // space tiling makes coplanar same-kind overlap pixel-identical).
  patches: [
    // golden headland grass spilling south of the z≈185 cliff line where the
    // quay road climbs toward the rim — also the landmark for the kerb→
    // guardrail handover at section 87: the rail goes wood as the grass
    // goes gold
    {
      kind: 'drygrass',
      poly: [
        [190, 190], [208, 189.5], [226, 189], [246, 189], [248, 180],
        [242, 167], [226, 156], [208, 151], [194, 159], [186, 173],
      ],
    },
    // gold creeping down the Lookout Ess's south slope
    {
      kind: 'drygrass',
      poly: [
        [-40, 192], [-16, 191], [8, 190], [30, 191], [42, 190],
        [30, 171], [8, 162], [-16, 166], [-34, 176],
      ],
    },
    // the NW sweeper's seaward verge dries out toward the headland
    {
      kind: 'drygrass',
      poly: [
        [-247, 200], [-254, 186], [-261, 170], [-265, 152], [-257, 141],
        [-247, 150], [-242, 164], [-240, 178], [-243, 193],
      ],
    },
    // wind-blown sand traces past the Beach Run rejoin onto the start
    // straight's verge — the beach letting go, not a hard seam at x -78
    {
      kind: 'sand',
      poly: [
        [-100, -240], [-80, -238], [-60, -243], [-44, -250],
        [-58, -257], [-82, -252], [-98, -249],
      ],
    },
  ],
};

// The shared zone contributes TWO disjoint coast arcs (the named zones each
// own one), exported separately so the composer can interleave them in
// stitching order: south arc → beach arc → NW connector → cliff arc →
// harbor arc → close.

/** South shore behind the start straight, east→west — a plain grass bank
 *  (the grandstand island ends in turf, not sand). */
export const sharedSouthArc: CoastVertex[] = [
  { x: 228, z: -262, edge: 'bank' },
  { x: 160, z: -268, edge: 'bank' },
  { x: 80, z: -272, edge: 'bank' },
  { x: 10, z: -274, edge: 'bank' },
  { x: -60, z: -272, edge: 'bank' }, // hands off to the beach arc
];

/** West side + NW corner, south→north: the roadblock chicane's seaward
 *  verge and the sweeper headland, all grass bank. The last four vertices
 *  carry rim y (road-base field sampled at the vertex, elevation.md):
 *  the downhill sweepers' embankment reaches the shore here, so the bank
 *  rises toward the cliff-arc seam instead of stepping at it. */
export const sharedNorthwestArc: CoastVertex[] = [
  { x: -292, z: -40, edge: 'bank' },
  { x: -288, z: 2, edge: 'bank' },
  { x: -294, z: 44, edge: 'bank' },
  { x: -286, z: 86, edge: 'bank' },
  { x: -282, z: 122, edge: 'bank' },
  { x: -270, z: 158, edge: 'bank', y: 0.2 },
  { x: -250, z: 196, edge: 'bank', y: 0.5 },
  { x: -226, z: 226, edge: 'bank', y: 0.8 },
  { x: -192, z: 250, edge: 'bank', y: 1.8 }, // hands off to the cliff arc
];
