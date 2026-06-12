import { CARGO, COAST, DOCK, PIRATE, decor, type ZoneDressing } from './dressing';
import type { DecalDef, PropDef } from '../../types';

// HARBOR — the waterfront: the quay-north run rethemed as a working concrete
// quay (docs/concept-art/harbor.png) — apron between road and water, painted
// red/white edge stripe, cast-iron bollards and quay lamps down the lip, the
// freighter moored against the wall face with the safety-orange luffing
// crane over it — plus the Cannery point (lighthouse, surf rocks, shipwreck)
// at the island's south-east tip. Refshot pose: harbor cam(205,32,95)
// look(290,0,150).
//
// Zone bounds (composer distribution rule): (x >= 246 AND z >= 80) OR
// (x >= 252 AND z <= -110). This zone owns the EAST coast arc — the whole
// seaboard from the cliff headland down past Crane Alley's quay face and
// around the Cannery point to the south shore.

// The quay lip, south→north: the SAME rim line the coast arc below builds
// its 'wall' skirt from. The painted edge stripe, the bollard line and the
// apron patch boundary are all generated/authored against it so the quay
// furniture stays in lockstep with the face if the rim ever moves.
const LIP: [number, number][] = [
  [278, 68],
  [280, 100],
  [288, 124],
  [290, 148],
  [286, 176],
];

/** Points every `step` m along the lip, pushed `inset` m inland (the walk
 *  heads north, so inland is the left normal). Plain numbers at module
 *  load — deterministic by construction, per the physics contract, even
 *  though everything built from it is pure decor. */
function alongLip(step: number, inset: number, phase: number): { x: number; z: number; yaw: number }[] {
  const out: { x: number; z: number; yaw: number }[] = [];
  let next = phase;
  for (let i = 0; i < LIP.length - 1; i++) {
    const [ax, az] = LIP[i];
    const [bx, bz] = LIP[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    while (next < len) {
      out.push({ x: ax + dx * next - dz * inset, z: az + dz * next + dx * inset, yaw: Math.atan2(dx, dz) });
      next += step;
    }
    next -= len;
  }
  return out;
}

/** The road-base elevation along the LIP LINE (elevation.md: the quay-north
 *  climb's seaward embankment toe reaches the rim from z ≈ 128 north).
 *  Piecewise-linear through field samples measured at the stripe inset
 *  (2026-06-12); everything generated along the lip seats on it so the
 *  paint and bollards ride the embankment instead of vanishing under it.
 *  Re-measure if the profile in gantryPoint.ts is retuned. */
const QUAY_LIFT: [number, number][] = [
  [128, 0.05], [137, 0.19], [148, 0.47], [156, 0.92], [164, 1.58], [172, 2.51], [176, 2.74],
];
function quayLift(z: number): number {
  if (z <= QUAY_LIFT[0][0]) return 0;
  for (let i = 1; i < QUAY_LIFT.length; i++) {
    if (z <= QUAY_LIFT[i][0]) {
      const [z0, y0] = QUAY_LIFT[i - 1];
      const [z1, y1] = QUAY_LIFT[i];
      return y0 + ((y1 - y0) * (z - z0)) / (z1 - z0);
    }
  }
  return QUAY_LIFT[QUAY_LIFT.length - 1][1];
}

// Painted quay-edge stripe: contiguous 4 m red/white blocks riding the lip —
// the harbor's hazard paint, the warning the race kerb only implies. Paint
// only (decal slot 0.014, plus the embankment lift north of z 128); the
// actual barrier is the kerb wall style below.
const QUAY_STRIPE: DecalDef[] = alongLip(4, 0.75, 2).map((p, i) => ({
  x: p.x,
  z: p.z,
  w: 0.9,
  l: 4.05,
  yaw: p.yaw,
  y: quayLift(p.z) + 0.014,
  ...(i % 2 === 0 ? { color: 0xc23b2e } : {}),
}));

// Cast-iron mooring bollards down the lip, skipping the span where the
// harbor crane's portal base owns the rim (z ~131..149). Decor only — the
// quay is hoppable now, but a 0.8 m iron stub is not a wall a car should
// silently slam (collider policy: when in doubt, none).
const BOLLARDS: PropDef[] = alongLip(13, 1.05, 6)
  .filter((p) => p.z < 131 || p.z > 149)
  .map((p) => decor('builtin:bollard', p.x, p.z, 0, 1.5, { y: quayLift(p.z) }));

export const harbor: ZoneDressing = {
  props: [
    // --- Cannery point ---
    // the lighthouse on the point: solid — it's the one landmark a Flyover
    // overshoot could conceivably reach (mesh sits 1.79 below its origin)
    { url: `${COAST}/lighthouse.glb`, x: 280, z: -158, yaw: 0, scale: 1.2, y: 2.15, collider: { hx: 4, hy: 10, hz: 4 } },
    decor(`${PIRATE}/rocks-sand-a.glb`, 296, -190, 0.7, 2), // surf rocks off the point
    decor(`${PIRATE}/rocks-b.glb`, 302, -140, 2.3, 2.2),
    decor(`${PIRATE}/ship-wreck.glb`, 300, -168, 2.0, 1.3), // wrecked hull ON the rocks
    // merge-pass seam masks: the coast skirt swaps wall→cliff at (296,-124)
    // and cliff→beach at the (270,-232) cove — rocks at each vertex give the
    // shore a reason to change instead of a bare texture seam
    decor(`${PIRATE}/rocks-b.glb`, 293, -121, 1.1, 1.6),
    decor(`${PIRATE}/rocks-sand-a.glb`, 290, -113, 2.6, 1.3),
    decor(`${PIRATE}/rocks-sand-a.glb`, 266, -227, 0.9, 1.7),
    decor(`${PIRATE}/rocks-sand-b.glb`, 258, -235, 2.2, 1.3),

    // --- quay north waterfront ---
    // The level-luffing crane goes safety orange (multiply tint — its cab
    // glass is spared by the engine's glass guard; the tint stays heavily
    // saturated because multiply can only darken the greyish base) and
    // swings its boom out over the moored freighter, the concept's
    // working-harbor money shot. The boom runs along LOCAL -Z like the
    // builtin gantry crane, so yaw -0.9 points it ESE over the ship's deck.
    // Solid: its portal base sits on the apron a hopped kerb can reach.
    // y: the authored -1.0 mesh sink plus the climb embankment's 0.8 toe
    // at this spot (elevation.md seating pass) — the 0..11 collider span
    // still covers everything reachable.
    { url: `${DOCK}/crane-harbor-hancock.glb`, x: 282, z: 140, yaw: -0.9, scale: 0.3, y: -0.2, tint: 0xff7014, collider: { hx: 7, hy: 5.5, hz: 7 } },
    // The freighter moors AGAINST the quay face now (concept: hull on the
    // fender line, no open water gap) — still OUTSIDE the coast outline,
    // lowered to ride the -2.2 sea (origin mid-hull: y puts the waterline
    // at sea level). Both trawlers idle in open water off the lip.
    decor(`${DOCK}/container-ship-safayan.glb`, 302, 122, 0.08, 95, { y: 12.8 }),
    decor(`${COAST}/fishing-boat-white.glb`, 285, 84, 0.15, 0.013, { y: -1.84 }),
    decor(`${COAST}/fishing-boat-green.glb`, 296, 180, -2.0, 0.013, { y: -1.84 }),

    // Quay lamps replace the race flags and the warning beacon — heads
    // cantilevered seaward over the working edge, night-emissive for free.
    // y: measured climb-embankment seats (elevation.md) — these stand
    // between the rising road and the lip, where the bank runs 0.3→4.9.
    decor('builtin:lamp-post', 259, 97, Math.PI / 2, 1.15, { y: 0.3 }),
    decor('builtin:lamp-post', 266, 128, Math.PI / 2, 1.15, { y: 1.3 }),
    decor('builtin:lamp-post', 271, 152, Math.PI / 2, 1.15, { y: 2.5 }),
    decor('builtin:lamp-post', 276, 180, Math.PI / 2, 1.15, { y: 4.9 }),

    // the bollard line down the painted lip
    ...BOLLARDS,

    // Dock clutter, concept bottom-left: crate-and-coil cluster mid-apron.
    // The tinted crate stands in for the concept's teal cargo box; the tire
    // pile reads as coiled mooring rope at quay distance. Seated on the
    // embankment toe (0.2-0.5 here).
    decor(`${CARGO}/crate.glb`, 262, 103, 0.4, 1.15, { y: 0.4 }),
    decor(`${CARGO}/crate.glb`, 263.8, 105.6, -0.2, 0.95, { y: 0.4 }),
    decor(`${CARGO}/tires.glb`, 260, 106, 1.1, 1.15, { y: 0.5 }),
    decor(`${CARGO}/pallet.glb`, 265, 101.5, 0.9, 1, { y: 0.3 }),
    // the life ring rides a low crate by the lip (props only yaw, so the
    // ring lies flat like deck stowage rather than hanging on a stand) —
    // oversized a touch so the orange reads from the race camera
    decor(`${CARGO}/crate.glb`, 272, 106, 0.7, 0.7, { y: 0.2 }),
    decor(`${COAST}/life-preserver.glb`, 272, 106, 0.3, 0.0042, { y: 1.15 }),
    // second cluster up the quay, by the crane's working radius — well up
    // the climb embankment by now (~3.2-3.5 of bank under it)
    decor(`${CARGO}/crate.glb`, 269, 157, -0.5, 1.25, { y: 3.2 }),
    decor(`${CARGO}/wheels-stack.glb`, 271.2, 159.5, 0.8, 1.9, { y: 3.1 }),
    decor(`${CARGO}/pallet.glb`, 267, 159.8, 0.2, 1, { y: 3.5 }),
  ],

  // The concrete apron: road ribbon to quay lip, one poly. The west bound
  // tracks the main loop's seaward edge 3 m UNDER the ribbon (patch slot
  // 0.006 < ribbon 0.012, so the overlap hides and no grass sliver can
  // show); points sampled from the resampler at centre + 8 m along the
  // quay run (sections 76..90). The flow pass nudged this stretch ≤ 2 m
  // seaward, which only tucks the sampled edge DEEPER under the ribbon —
  // overlap grows, no sliver can open — so the poly stands as sampled.
  // The east bound IS the lip, so the apron meets the wall skirt
  // edge-to-edge. The grass infield inside the road curve stays untouched
  // grass, exactly like the concept.
  patches: [
    {
      kind: 'concrete',
      // 0.0065, not the 0.006 default: the dockyard pours its own concrete
      // apron up to x 272 / z 132, and this poly's west edge dips into that
      // box to meet the ribbon — two coplanar patches would depth-fight, so
      // the quay apron rides half a millimetre above its dockyard neighbour
      // (still well under the 0.010 shortcut-ribbon slot)
      y: 0.0065,
      poly: [
        [214, 80],
        [223, 86],
        [231, 92],
        [238, 100],
        [243, 108],
        [248, 116],
        [251, 124],
        [255, 132],
        [258, 141],
        [260, 149],
        [262, 157],
        [264, 166],
        [266, 174],
        [269.5, 184],
        // north cap toward the headland seam (island edge ~x 291.5 here)
        [289, 184],
        // the quay lip, north→south (the coast arc's rim coordinates)
        [286, 176],
        [290, 148],
        [288, 124],
        [280, 100],
        [278, 68],
        // run the rim a little south past the pose's bottom-left corner so
        // the concrete→grass cut lands out of frame (rim is ~x 277.7 here)
        [277.5, 56],
      ],
    },
  ],

  decals: QUAY_STRIPE,

  // The quay run sheds the red/white race wall for a low concrete kerb on
  // BOTH sides — seaward the apron takes over (hop it and the rim, and the
  // off-track rescue fishes you out), inland the kerb rings the grass
  // infield like the concept. Sections 76..90: quay rejoin to the z=185
  // cliff handoff, indices from the race.ts resampler math (the audit
  // script's catmull/resample replica — N=215 after the flow pass; the
  // eased headland spike crosses z=185 one section later, so the kerb's
  // top end moved 89 → 90 while the quay rejoin anchor at 76 held still).
  // The second entry wins over the first (last-wins within the array): the
  // port's chain-link keeps the INLAND side through 82, because the
  // dockyard's port-exit container row runs right behind that wall up to
  // the box at (222,124) ≈ section 82 — the fence ends at the last
  // container, and only then does the kerb ring the open grass infield.
  // The seaward side goes kerb at 76 with the apron+stripe, so each style
  // change lands on a readable landmark.
  wallStyles: [
    { from: 76, to: 90, side: 'both', style: 'kerb' },
    { from: 76, to: 82, side: 'left', style: 'fence' },
  ],

  // East coast arc, north→south (continues from the cliff zone's arc and
  // closes into the shared south arc). Mostly a sheer 'wall' quay face —
  // the crane and lamps stand right at the rim, the boats float off it —
  // then 'cliff' around the rocky Cannery point (the bulge keeps the surf
  // rocks + shipwreck ON land) and a sandy 'beach' segue into the south
  // shore. The first five vertices are the LIP table above — keep them in
  // sync. Keep the first vertex meeting the cliff arc and the last vertex
  // meeting the shared south arc.
  coast: [
    // y on the two north vertices: the climb's embankment reaches the rim
    // at this end of the arc — rim height = the road-base field sampled at
    // the vertex (same rule as the cliff arc), so the quay face grows
    // taller as the road climbs away from it and the engine's drape lands
    // on the rim line exactly.
    { x: 286, z: 176, edge: 'wall', y: 2.7 }, // fishing-boat-green floats just east of here
    { x: 290, z: 148, edge: 'wall', y: 0.4 },
    { x: 288, z: 124, edge: 'wall' }, // the freighter moors against this face
    { x: 280, z: 100, edge: 'wall' },
    { x: 278, z: 68, edge: 'wall' }, // fishing-boat-white off the quay face
    { x: 277, z: 16, edge: 'wall' },
    { x: 280, z: -42, edge: 'wall' }, // Crane Alley's working quay
    { x: 284, z: -76, edge: 'wall' },
    { x: 288, z: -106, edge: 'wall' },
    { x: 296, z: -124, edge: 'cliff' }, // quay gives way to the rocky point
    { x: 312, z: -148, edge: 'cliff' },
    { x: 310, z: -178, edge: 'cliff' },
    { x: 296, z: -204, edge: 'cliff' },
    { x: 270, z: -232, edge: 'beach' }, // sandy cove rounding into the south arc
  ],
};
