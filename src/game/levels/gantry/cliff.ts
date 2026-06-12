import { COAST, NATURE, PIRATE, RACE, decor, type ZoneDressing } from './dressing';

// CLIFF — the north rim: the CLIFF CRASH headland spike, the clifftop
// straight's windswept pines and the Lookout knoll with its ledge shortcut.
// Refshot pose: cliff cam(212,26,150) look(275,2,212).
//
// Concept retheme (docs/concept-art/cliff.png): the whole headland goes dry
// golden grass, the race barrier becomes a wood-post guardrail both sides,
// and the rim piles up GREY ROCK.
//
// ELEVATION (docs/research/elevation.md, this zone's visual half): the
// north-arc road now genuinely climbs to +6 (profile in gantryPoint.ts),
// the engine drapes a gold-to-green embankment under it, and the coast
// arc below carries per-vertex rim heights matched to the road-base field
// — so the cliff face finally drops rim→sea for real (up to ~8 m of rock
// at the cove) instead of faking everything above grade. Every prop here
// carries a measured y seat (the road-base field sampled at its (x,z),
// tools run 2026-06-12) because prop visuals still spawn at grade 0; the
// values go stale if the PROFILE is retuned — re-run the field sampler
// over this list when that happens. Colliders stay ground-planted boxes
// (props.ts), so the SOLID rocks' hy values are sized to reach from the
// flat physics plane up past their visual tops — the buried lower half is
// inside the embankment and unreachable.
//
// Zone bounds (composer distribution rule): z >= 185 — EXCEPT the NW
// sweeper pines (x <= -198), which the distribution note assigns to the
// shared zone even though they clear the z line: they dress the shared NW
// connector arc, not the clifftop.

// Self-made yellow/black chevron board (cliff-roadside/manifest.md): board
// faces local -Z, arrows sweep local -X, so yaw = atan2(dirX, dirZ) of the
// approaching traffic squares it to the driver with the arrows pointing
// into the left-hander — Burnout's "lift here or swim" furniture.
const CHEVRON = '/models/props/cliff-roadside/chevron-sign.glb';

// The Kenney stone material is a pale glacier blue and the pirate-kit rock
// colormap reads blue-grey under the day light; multiplied toward warm tan
// both land on the concept's sun-bleached granite. The brown/green rock_*
// variants get a lighter grey wash so the families sit together, and the
// headland pines get a deep green knock-down toward the concept's
// near-black windswept stands.
const GRANITE = 0xd9b98a;
const GREYWASH = 0xe5ded2;
const PINE = 0x77a05e;
// the pirate rock colormap reads dark blue-slate under the day light and a
// near-white tint is a no-op (multiply can only darken) — no tint pulls it
// to sunlit granite, so the merge pass keeps pirate rocks ONLY down at the
// waterline, where dark-wet rock under the foam ring is the truthful read
const SURF = 0xb8b4ac;

export const cliff: ZoneDressing = {
  props: [
    // --- CLIFF CRASH: the headland spike ---
    // two big rock towers beyond the outer wall are solid — the GDD's
    // "rim rocks": getting slammed THROUGH the guardrail into them is the
    // fantasy. Merge pass swapped the pirate rocks-a/b for nature-kit
    // monoliths here: the pirate colormap's rock region is dark slate and
    // multiply-tint can only darken, so at the fixed poses the crag read as
    // a charcoal city skyline, not sunlit granite — the Kenney stone
    // material is pale glacier blue, which GRANITE-tints into the concept's
    // warm grey. Same audited positions; colliders shrunk to the new
    // visuals (smaller half-extents = more clearance margin).
    // Visual y = measured field seat 3.9/3.8; the colliders' 0..13 / 0..11.6
    // spans still cover the +6 road band (cars top out ~+9 here), so the
    // audited hx/hz clearances stand untouched.
    { url: `${NATURE}/stone_tallA.glb`, x: 287, z: 207, yaw: -0.62, scale: 13, y: 3.9, tint: GRANITE, collider: { hx: 6.4, hy: 6.5, hz: 4.5 } },
    { url: `${NATURE}/stone_tallA.glb`, x: 277, z: 230, yaw: 2.35, scale: 11.5, y: 3.8, tint: GREYWASH, collider: { hx: 5.7, hy: 5.8, hz: 4.0 } },
    // plateau filler — decor granite packed around and BETWEEN the two
    // solids (the old hand-raised saddle piece now seats at field+1.5) so
    // the point reads as one rising rock mass, not two boxes on a lawn;
    // visuals deliberately interpenetrate, that's how the kits build crags
    { ...decor(`${NATURE}/stone_tallE.glb`, 290, 214, 1.8, 10, { y: 4.2 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_tallA.glb`, 270, 246, 2.6, 7, { y: 2.4 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_tallA.glb`, 296, 196, 0.9, 9, { y: 1.8 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_tallA.glb`, 283, 213, 3.9, 8, { y: 4.4 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_largeC.glb`, 288, 228, 1.3, 8, { y: 1.9 }), tint: GRANITE },
    { ...decor(`${NATURE}/rock_tallB.glb`, 291, 221, 2.1, 9, { y: 2.0 }), tint: GREYWASH },
    { ...decor(`${NATURE}/stone_tallE.glb`, 281, 241, 1.0, 8, { y: 1.5 }), tint: GRANITE },
    { ...decor(`${NATURE}/rock_largeD.glb`, 272, 238, 1.4, 6, { y: 3.5 }), tint: GREYWASH },
    { ...decor(`${NATURE}/stone_largeC.glb`, 294, 187, 2.2, 7, { y: 2.1 }), tint: GRANITE },
    // wide low plinth slabs welding the tower bases into one silhouette —
    // without them the crag reads as separate towers with sky in the gaps
    { ...decor(`${NATURE}/stone_largeA.glb`, 288, 202, 0.5, 11, { y: 3.8 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_largeC.glb`, 283, 222, 2.8, 11, { y: 3.6 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_largeA.glb`, 276, 237, 1.7, 10, { y: 3.0 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_largeC.glb`, 293, 213, 4.0, 9, { y: 2.1 }), tint: GREYWASH },
    // boulders strewn across the band between the guardrail and the crag —
    // the concept crowds rock right up to the road shoulder (all decor,
    // 14-18 m off the centreline, outside the wall at 11; these four ride
    // the +6 shoulder plateau itself)
    { ...decor(`${NATURE}/stone_largeC.glb`, 272, 204, 1.9, 4, { y: 6.2 }), tint: GRANITE },
    { ...decor(`${NATURE}/rock_smallH.glb`, 266, 222, 0.4, 4, { y: 6.2 }), tint: GREYWASH },
    { ...decor(`${NATURE}/stone_largeA.glb`, 262, 230, 2.4, 5, { y: 6.1 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_largeC.glb`, 227, 239, 3.1, 4, { y: 6.0 }), tint: GRANITE },
    // rim boulders trailing west along the north edge — the plateau's mass
    // tapering off, one cluster per ~15 m so the rim never reads bare
    // (merge pass: nature stone for the same slate-vs-granite reason)
    { ...decor(`${NATURE}/stone_tallE.glb`, 252, 252, 1.1, 8, { y: 3.5 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_tallA.glb`, 236, 253, 2.6, 6, { y: 4.6 }), tint: GRANITE },
    { ...decor(`${NATURE}/rock_largeA.glb`, 220, 262, 0.7, 5, { y: 3.5 }), tint: GREYWASH },
    { ...decor(`${NATURE}/stone_largeA.glb`, 204, 261, 1.9, 5, { y: 4.7 }), tint: GRANITE },
    // merge-pass seam masks: the coast skirt swaps type at both ends of the
    // cliff arc — bank→cliff at (-160,272) off the NW connector, cliff→quay
    // wall at the (286,176) headland corner. A stone cluster at each vertex
    // turns the skirt change into "the rock starts here"
    { ...decor(`${NATURE}/stone_largeA.glb`, -162, 268, 1.4, 5, { y: 1.2 }), tint: GRANITE },
    { ...decor(`${NATURE}/rock_largeA.glb`, -152, 270, 0.3, 4, { y: 1.2 }), tint: GREYWASH },
    { ...decor(`${NATURE}/stone_largeC.glb`, 292, 186, 2.4, 5, { y: 2.5 }), tint: GRANITE },
    // surf rocks DOWN at the waterline off the point and the cove — y dips
    // below grade so they ride the -2.2 sea (visual only, like the boats)
    { ...decor(`${PIRATE}/rocks-b.glb`, 315, 196, 0.4, 1.8, { y: -2.8 }), tint: SURF },
    { ...decor(`${PIRATE}/rocks-a.glb`, 321, 212, 1.7, 1.4, { y: -2.6 }), tint: SURF },
    { ...decor(`${PIRATE}/rocks-a.glb`, 309, 228, -0.9, 1.0, { y: -2.7 }), tint: SURF },
    { ...decor(`${PIRATE}/rocks-a.glb`, 243, 286, 0.8, 1.3, { y: -2.7 }), tint: SURF },
    { ...decor(`${PIRATE}/rocks-b.glb`, 256, 278, 2.0, 1.0, { y: -2.8 }), tint: SURF },
    // the concept's lone trawler working the swell off the cove — white
    // hull tinted mustard, floated at the fleet's standard -1.84 draught
    { ...decor(`${COAST}/fishing-boat-white.glb`, 234, 290, 2.4, 0.013, { y: -1.84 }), tint: 0xddaa33 },
    // chevron boards on the outside of the spike, one per ~2 sections,
    // yawed square to the approach (atan2 of each section's portal dir);
    // road furniture, so they ride the road's own +6 shoulder
    decor(CHEVRON, 275.6, 197.0, -0.28, 1.9, { y: 6.0 }),
    decor(CHEVRON, 266.5, 217.7, -0.67, 1.9, { y: 6.2 }),
    decor(CHEVRON, 251.2, 234.1, -0.97, 1.9, { y: 6.0 }),
    decor(CHEVRON, 232.0, 245.2, -1.22, 1.9, { y: 6.0 }),
    // windswept pines — clustered tight with varied yaw/scale so the
    // canopies merge and the stand reads wind-bent even on straight trunks
    { ...decor(`${NATURE}/tree_pineTallC_detailed.glb`, 224, 196, 0.4, 7, { y: 0.8 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallA_detailed.glb`, 233, 189, 2.4, 5.5, { y: 2.1 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallC_detailed.glb`, 216, 205, 4.0, 8.5, { y: 2.1 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallA_detailed.glb`, 272, 222, 1.2, 7, { y: 5.8 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallC_detailed.glb`, 265, 233, 5.3, 6, { y: 5.4 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallA_detailed.glb`, 288, 236, 0.5, 6.5, { y: 0.9 }), tint: PINE }, // right on the rim
    { ...decor(`${NATURE}/tree_pineTallC_detailed.glb`, 250, 247, 1.9, 6.5, { y: 4.8 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallA_detailed.glb`, 262, 243, 4.4, 7.5, { y: 4.1 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallC_detailed.glb`, 196, 258, 2.9, 7, { y: 5.9 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallA_detailed.glb`, 184, 251, 0.9, 5, { y: 6.4 }), tint: PINE },
    { ...decor(`${NATURE}/tree_pineTallC_detailed.glb`, 172, 266, 1.5, 6, { y: 5.5 }), tint: PINE },
    // dry scrub + small stones scattered through the gold — the headland's
    // grass should look grazed-out, not mown
    decor(`${NATURE}/plant_bushLarge.glb`, 231, 210, 0.3, 4, { y: 4.3 }),
    decor(`${NATURE}/plant_bushDetailed.glb`, 222, 219, 1.8, 3.5, { y: 5.6 }),
    decor(`${NATURE}/plant_bushLarge.glb`, 212, 191, 4.1, 4), // off the embankment — grade 0
    decor(`${NATURE}/plant_bushDetailed.glb`, 244, 240, 2.6, 4, { y: 6.0 }),
    decor(`${NATURE}/plant_bushLarge.glb`, 286, 191, 1.2, 3.5, { y: 3.9 }),
    { ...decor(`${NATURE}/stone_largeA.glb`, 208, 214, 1.1, 4, { y: 3.7 }), tint: GRANITE },
    decor(`${NATURE}/rock_smallH.glb`, 228, 202, 2.7, 3.5, { y: 2.4 }),
    { ...decor(`${NATURE}/stone_largeC.glb`, 196, 233, 0.6, 3.5, { y: 6.1 }), tint: GRANITE },

    // --- clifftop straight + the Lookout ---
    decor(`${NATURE}/tree_pineTallA_detailed.glb`, 150, 266, 0.7, 7, { y: 6.1 }),
    decor(`${NATURE}/tree_pineRoundB.glb`, 108, 264, 1.9, 6, { y: 6.0 }),
    decor(`${NATURE}/tree_pineTallC_detailed.glb`, 66, 262, 2.8, 7, { y: 5.1 }),
    decor(`${NATURE}/tree_pineSmallA.glb`, 100, 228, 1.5, 5, { y: 5.2 }),
    decor(`${NATURE}/tree_pineRoundB.glb`, 64, 229, 0.2, 6, { y: 6.1 }),
    decor(`${NATURE}/tree_pineTallC_detailed.glb`, 130, 272, 3.8, 6, { y: 4.5 }),
    decor(`${NATURE}/tree_pineTallA_detailed.glb`, 84, 268, 1.7, 7.5, { y: 4.3 }),
    { ...decor(`${NATURE}/stone_largeA.glb`, 170, 262, 0.8, 4, { y: 6.4 }), tint: GRANITE },
    { ...decor(`${NATURE}/stone_tallE.glb`, 44, 260, 1.5, 5, { y: 4.3 }), tint: GRANITE },
    // the lookout knoll between the ess and the ledge: tower + radar trailer.
    // Decor by necessity — the 28 m neck can't fit the clearance a solid
    // 8 m tower would need from BOTH ribbons. The knoll saddle sits ~+5.4
    // where the dipping ess and the +6 ledge fields cross.
    decor(`${PIRATE}/tower-watch.glb`, -6, 235, 0.35, 2.7, { y: 5.4 }),
    decor(`${RACE}/radarEquipment.glb`, -14, 235, 0.5, 6, { cx: 0.105, cz: -1.065, y: 5.4 }),
    // ledge marker in the fork wedge — moved with the flow-pass ess fork
    // (x~48): measured 1.4 m off the main edge / 1.7 m off the ledge edge in
    // the reopened wedge, yawed to read from the eastbound approach
    decor(`${NATURE}/sign.glb`, 22, 238, 1.3, 3.5, { y: 6.1 }),
    // LOOKOUT LEDGE seaward lip: the GDD's rock outcrops, and they are SOLID —
    // the ledge's risk-per-metre is the point. yaw aims each box's local z
    // down the ledge so a glancing kiss judges shallow, a wide line wrecks.
    // Retheme touched the LOOK only; the flow pass then bowed the ledge
    // ribbon ~2 m seaward mid-run, so rock_tallA steps 1.5 m toward the rim
    // to keep its audited clearance (9.4 vs the 8.6 the solid needs) —
    // still on the lip, still the thing a wide line wrecks on.
    // ELEVATION: visuals seat on the rim field (5.3 / 6.0); the colliders
    // are ground-planted (props.ts), so hy grows until the box TOP clears
    // the visual top (≈8.4 / ≈9.4) — the old 0..3.1 / 0..3.5 boxes would
    // have sat entirely INSIDE the embankment under the +6 ledge, turning
    // the lip rocks into scenery. hx/hz (the audited clearances) untouched.
    { url: `${NATURE}/rock_tallB.glb`, x: 12, z: 258, yaw: -1.42, scale: 3.5, y: 5.3, tint: GREYWASH, collider: { hx: 1.35, hy: 4.2, hz: 1.35 } },
    { url: `${NATURE}/rock_tallA.glb`, x: -29, z: 254.5, yaw: -1.85, scale: 3.5, y: 6.0, tint: GREYWASH, collider: { hx: 1.7, hy: 4.7, hz: 1.2 } },
    { ...decor(`${NATURE}/stone_tallE.glb`, -12, 259, 1.0, 3, { y: 5.3 }), tint: GRANITE },
  ],

  // The whole headland turns dry golden grass — one organic polygon hugging
  // the coast ~3 m inside the rim (a patch past the rim would paint over
  // open water at y 0.006) and waving along the z≈185-191 zone line on the
  // inland side. Roads and the ledge ribbon draw above it (z-order
  // contract), so it runs under everything.
  patches: [
    {
      kind: 'drygrass',
      poly: [
        // south (inland) edge, west→east — wavy, never below the z 185 line
        [-240, 193], [-216, 186], [-190, 191], [-162, 186], [-134, 190],
        [-106, 185], [-78, 189], [-52, 186], [-24, 190], [4, 186],
        [32, 190], [60, 186], [88, 190], [116, 186], [144, 190],
        [170, 186], [196, 190], [220, 186], [244, 189], [266, 186], [288, 188],
        // east edge up to the headland point (inside the harbor seam)
        [296, 195], [300, 203],
        // north rim, east→west, ~3 m inside the coast arc
        [297, 216], [290, 229], [278, 243], [256, 254], [235, 256],
        [217, 268], [172, 280], [112, 276], [42, 268], [-28, 264],
        [-98, 268], [-158, 268],
        // west closure along the shared NW connector's inland side
        [-188, 246], [-221, 222], [-245, 194],
      ],
    },
  ],

  // Wood-post guardrail BOTH sides through the whole north rim (sections
  // 90-148 sit at z >= 185 on the flow-pass loop — the eased spike crosses
  // the line a section later and the deepened Lookout Ess holds the rim
  // road longer; segment 87 still starts the swap early, at the SAME
  // physical spot as before the pass (the gold-grass climb at (256,168)),
  // so the style is already settled where the refshot frame bottom catches
  // the road — cliff outranks harbor in the composer's last-wins order, so
  // this small overlap is deliberate and noted for the merge audit).
  wallStyles: [{ from: 87, to: 148, side: 'both', style: 'guardrail' }],

  // North coast arc, west→east (continues from the shared NW connector and
  // hands off to the harbor arc at the headland). All 'cliff': the Lookout
  // Ledge runs the rim, and the CLIFF CRASH fantasy wants rock under the
  // guardrail. The arc itself got a cove notch (234,259) and a jagged
  // double-vertex point so the skirt's column jitter has corners to bite
  // on. First and last vertices are the FIXED seams with the shared NW and
  // harbor arcs.
  //
  // ELEVATION: each vertex's y is the road-base field SAMPLED AT THAT
  // VERTEX (measured 2026-06-12) — the engine's embankment drape clips its
  // columns to this rim line at exactly these lerped heights, so the gold
  // top meets the rock face watertight, and the cliff face below finally
  // spans rim→sea (≈ y + 2.2 m of rock at the waterline: the cove notch
  // shows ~5.6 m, the ledge rim ~5 m — cliff.png's drop, modest but real).
  // Re-sample if the PROFILE in gantryPoint.ts is ever retuned.
  coast: [
    { x: -160, z: 272, edge: 'cliff', y: 0.7 },
    { x: -100, z: 272, edge: 'cliff', y: 1.5 },
    { x: -30, z: 268, edge: 'cliff', y: 2.8 }, // behind the Lookout Ledge lip rocks
    { x: 40, z: 272, edge: 'cliff', y: 1.5 },
    { x: 110, z: 280, edge: 'cliff', y: 2.2 },
    { x: 170, z: 284, edge: 'cliff', y: 1.2 },
    { x: 216, z: 272, edge: 'cliff', y: 1.5 },
    { x: 234, z: 259, edge: 'cliff', y: 3.4 }, // cove notch — the trawler works the swell off here
    { x: 258, z: 258, edge: 'cliff', y: 1.7 },
    { x: 281, z: 247, edge: 'cliff', y: 0.5 },
    { x: 294, z: 232, edge: 'cliff', y: 0.2 }, // the headland spike's rim rocks stay inland
    { x: 300, z: 218, edge: 'cliff', y: 0.2 },
    { x: 304, z: 202, edge: 'cliff' },
  ],
};
