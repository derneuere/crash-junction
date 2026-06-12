import type { DecalDef, PropDef } from '../../types';
import { COAST, FACT, FLAG, NATURE, PIRATE, PYLON, RACE, decor, type ZoneDressing } from './dressing';

// BEACH — the south-west shore: the Beach Run sweep along the waterline,
// the fisherman's pier, the village snake's hamlet and the motel corner.
// Refshot pose: beach cam(-158,30,-108) look(-235,0,-185).
//
// Zone bounds (composer distribution rule): x <= -78 AND z <= -60 — which
// pulls in the village hamlet buildings and the Beach Run rejoin markers on
// the south straight's west end. This zone owns the WEST/SOUTH-WEST coast
// arc.
//
// Concept identity (docs/concept-art/beach.png): a real shoreline band —
// foreground grass gives way to dune tufts, then a wide dry-sand apron the
// Beach Run dirt ribbon runs THROUGH, then foam and open water; a roadside
// motel with a tall sign and a parking lot works the village-exit corner.
// Burnout's forgiving cut earns a postcard: the pressure-valve shortcut is
// the scenic route.

// Rope-post fencing along the Beach Run path, like the concept's post line:
// chain fence pieces end-to-end along a polyline (every 4th a plank section
// so the run doesn't read as a single extrusion). Visual-only decor — the
// forgiving cut stays unwalled, the posts just SELL the path edge.
const fenceLine = (pts: [number, number][], scale: number): PropDef[] => {
  const out: PropDef[] = [];
  let i = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, z0] = pts[s];
    const [x1, z1] = pts[s + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    // fence_simple spans local x (1 unit, z-offset pivot cz -0.47): aim
    // local +x down the run. decor maps local x to (cos yaw, -sin yaw).
    const yaw = Math.atan2(-uz, ux);
    for (let d = scale / 2; d + scale / 2 <= len; d += scale) {
      const url = `${NATURE}/${i % 4 === 3 ? 'fence_planks' : 'fence_simple'}.glb`;
      out.push(decor(url, x0 + ux * d, z0 + uz * d, yaw, scale, { cz: -0.47 }));
      i++;
    }
  }
  return out;
};

// The motel lot's parking bays: white stripes stepped along the village
// road's bearing (dir (0.316,-0.948) at the motel corner), each stripe's
// length pointing across the lot toward the building.
const BAY_DIR = { x: 0.316, z: -0.948 };
const BAY_YAW = Math.atan2(-BAY_DIR.x, -BAY_DIR.z); // stripe length faces the motel
const parkingBays = (): DecalDef[] => {
  const bays: DecalDef[] = [];
  for (let i = 0; i < 6; i++) {
    bays.push({
      x: -168.5 + BAY_DIR.x * 3.4 * i,
      z: -139 + BAY_DIR.z * 3.4 * i,
      w: 0.35,
      l: 5.5,
      yaw: BAY_YAW,
    });
  }
  return bays;
};

export const beach: ZoneDressing = {
  props: [
    // Beach Run rejoin mouth, so the gap in the south wall reads at speed
    decor(`${RACE}/pylon.glb`, -86, -242, 0, 6, PYLON),
    decor(`${RACE}/flagRed.glb`, -97, -249, 0.5, 5.5, FLAG),

    // --- BEACH RUN + west coast ---
    decor(`${FACT}/warning-traffic.glb`, -260, -104, 0.4, 1.2), // fork-side marker
    decor(`${RACE}/pylon.glb`, -228, -112, 0, 6, PYLON), // in the fork wedge
    // sand mounds pre-date the sand patch — now they read as low dunes on it
    decor(`${PIRATE}/patch-sand-foliage.glb`, -262, -140, 0.6, 2),
    decor(`${PIRATE}/patch-sand.glb`, -240, -190, 2.1, 2),
    decor(`${PIRATE}/patch-sand.glb`, -200, -226, 1.2, 2.2),

    // the concept's palm row marches down the sand side of the ribbon, each
    // with dune-grass tufts at its feet — the grass->tufts->sand transition
    decor(`${PIRATE}/palm-bend.glb`, -258, -150, 1.0, 1.8),
    decor(`${PIRATE}/palm-detailed-bend.glb`, -226, -196, -0.7, 1.8),
    decor(`${NATURE}/tree_palmDetailedTall.glb`, -196, -220, 0.3, 6),
    decor(`${NATURE}/tree_palmTall.glb`, -150, -248, 2.0, 6.5),
    decor(`${NATURE}/tree_palmTall.glb`, -237, -152, 0.8, 6.5),
    decor(`${NATURE}/tree_palmDetailedTall.glb`, -214, -186, 2.4, 6.5),
    decor(`${NATURE}/tree_palmBend.glb`, -187, -211, 1.6, 6),
    decor(`${NATURE}/grass_large.glb`, -239, -154.5, 0.4, 4),
    decor(`${NATURE}/grass_large.glb`, -234.5, -150.5, 1.7, 3.5),
    decor(`${NATURE}/grass_large.glb`, -216, -188.5, 2.9, 4),
    decor(`${NATURE}/grass.glb`, -211.5, -184, 0.9, 4),
    decor(`${NATURE}/grass_large.glb`, -189.5, -213.5, 2.2, 4),
    // tuft line along the dune lip where grass hands over to sand
    decor(`${NATURE}/grass_large.glb`, -228, -138, 0.2, 3.5),
    decor(`${NATURE}/grass.glb`, -208, -168, 1.4, 4),
    decor(`${NATURE}/grass_large.glb`, -186, -196, 2.6, 3.5),
    decor(`${NATURE}/grass.glb`, -168, -222, 0.7, 4),

    // the concept's left cluster: lifeguard watch + green shack right at the
    // waterline — the pirate watchtower reads as the lifeguard post
    decor(`${PIRATE}/tower-watch.glb`, -268, -152, 0.8, 2.5),
    decor(`${COAST}/beach-hut.glb`, -274, -162, 0.9, 4, { cx: 0.3, cz: 0.385 }),
    decor(`${COAST}/beach-shelter.glb`, -206, -190, -0.4, 4),

    // the fisherman's pier off the SW corner: a short boardwalk along the
    // shore, then the jetty TURNS seaward (an L-pier) and steps gently down
    // so the stilts reach the water — the tip lands past the foam line
    decor(`${COAST}/dock-hut.glb`, -266, -116, 0.9, 4),
    decor(`${PIRATE}/structure-platform-dock.glb`, -272, -123, 0.9, 1.8),
    decor(`${PIRATE}/structure-platform-dock.glb`, -277, -129, 0.9, 1.8),
    decor(`${PIRATE}/structure-platform-dock.glb`, -281.4, -128, 0.9, 1.8, { y: -0.35 }),
    decor(`${PIRATE}/structure-platform-dock.glb`, -285.7, -127.1, 0.9, 1.8, { y: -0.75 }),
    decor(`${PIRATE}/structure-platform-dock.glb`, -290, -126.1, 0.9, 1.8, { y: -1.15 }),
    decor(`${PIRATE}/structure-platform-dock.glb`, -294.3, -125.2, 0.9, 1.8, { y: -1.5 }),
    decor(`${PIRATE}/structure-platform-dock-small.glb`, -298.3, -124.4, 0.9, 1.8, { y: -1.8 }),
    // dinghy moored at the pier head, riding the -2.2 sea
    decor(`${PIRATE}/boat-row-small.glb`, -305, -123, 0.6, 1.6, { y: -2.35 }),

    // beached boats stay ON land (inside the outline); floaters drop to the
    // -2.2 sea past the sand's waterline toe
    decor(`${COAST}/rowboat.glb`, -262, -158, 2.4, 0.4),
    decor(`${PIRATE}/boat-row-large.glb`, -256, -196, -0.8, 1.5),
    decor(`${NATURE}/canoe.glb`, -218, -214, 1.9, 3), // the beached dinghy (GDD 5.4)
    decor(`${PIRATE}/boat-row-small.glb`, -232, -242, 0.5, 1.6),
    decor(`${NATURE}/canoe.glb`, -208, -246, 1.0, 3),
    decor(`${PIRATE}/boat-row-large.glb`, -165, -258, 2.2, 1.5),
    decor(`${NATURE}/log_large.glb`, -142, -250, 0.4, 2.5),
    decor(`${COAST}/sail-yacht.glb`, -290, -180, 0.5, 0.25, { y: -2.2 }),
    // channel buoys: the coastal kit's life ring, tinted marker-yellow and
    // floated — improvised, but it reads as harbour furniture at range
    { ...decor(`${COAST}/life-preserver.glb`, -312, -140, 0.3, 0.016, { y: -1.9 }), tint: 0xf2c224 },
    { ...decor(`${COAST}/life-preserver.glb`, -310, -205, 1.1, 0.016, { y: -1.9 }), tint: 0xf2c224 },

    // driftwood scattered down the apron
    decor(`${NATURE}/log_large.glb`, -234, -206, 1.1, 3),
    decor(`${NATURE}/log_large.glb`, -258, -178, 1.3, 2.5),
    decor(`${NATURE}/log.glb`, -180, -228, 2.0, 4),
    decor(`${NATURE}/log.glb`, -222, -236, 0.9, 3.5),
    // tinted the concept's lifeguard red — the canopy reads dark grey otherwise
    { ...decor(`${COAST}/beach-umbrella.glb`, -212, -204, 0, 0.0085, { y: 1.83 }), tint: 0xd84a3a }, // pole extends below origin
    { ...decor(`${COAST}/beach-umbrella.glb`, -247, -168, 0.9, 0.0085, { y: 1.83 }), tint: 0xd84a3a },
    decor(`${PIRATE}/rocks-sand-b.glb`, -276, -74, 1.7, 1.8),
    decor(`${PIRATE}/rocks-sand-c.glb`, -282, -162, 0.2, 1.8),
    // merge-pass seam mask: the coast skirt swaps bank→beach at the
    // (-130,-272) arc seam — sand rocks at the vertex make the grass bank
    // giving way to sand read as shoreline, not a texture seam
    decor(`${PIRATE}/rocks-sand-a.glb`, -130, -269, 1.5, 1.7),
    decor(`${PIRATE}/rocks-sand-b.glb`, -122, -271, 0.2, 1.3),

    // the concept's post line along the ribbon's inland edge — the dune lip
    // fence that frames the forgiving cut without walling it
    ...fenceLine(
      [
        [-226, -133],
        [-196, -174],
        [-168, -218],
        [-148, -227],
      ],
      3.4,
    ),

    // --- the motel corner ---
    // The concept promotes the hamlet plinth by the second village 90° into
    // a proper roadside motel: block faces the road over a concrete lot with
    // bay stripes; still pure decor — it lives behind the race wall, so a
    // car can never legitimately reach it (collider stays 'none').
    // warm cream tint reads beach-town; the glazing is name-skipped by tint
    { ...decor(`${COAST}/motel-block.glb`, -176, -154, 1.25 + Math.PI, 0.045, { cx: 30.4, cz: -0.93, y: 0.18 }), tint: 0xeed8b2 },
    // MOTEL sign at the building's left end like the concept — the racing
    // kit billboard on posts is the closest panel-on-pylon silhouette
    // (panel's plain face points at the camera pose; the ad faces the road)
    decor(`${RACE}/billboard.glb`, -187, -142, 1.25 + Math.PI, 4.5, { cx: 0.09, cz: -0.85 }),
    decor(`${NATURE}/tree_palmDetailedShort.glb`, -190, -166, 0.5, 5),
    decor(`${NATURE}/plant_bush.glb`, -186, -143, 0, 3),
    decor(`${NATURE}/plant_bushSmall.glb`, -182, -139, 1.2, 3),
  ],

  // The village hamlet inside the snake, repainted beach-town pastel — same
  // audited 14x14 plinth rule as the dockyard warehouses (>= 27 m from every
  // centreline). The plinth that used to sit at the motel corner moved east
  // out of the lot's way (still >= 38 m clear of the snake and straight).
  buildings: [
    { x: -100, z: -155, h: 7, color: 0xe8d2b4 }, // village hamlet
    { x: -110, z: -130, h: 6, color: 0xcfe0d8 },
    { x: -104, z: -180, h: 6, color: 0xf0dccb },
  ],

  // Ground reads in the concept's order: foreground drygrass wedge (0.005),
  // then the sand apron (0.006) that the Beach Run ribbon (0.010) crosses,
  // then the coast skirt and foam past the rim. The sand's seaward boundary
  // reuses the coast arc vertices verbatim so patch and skirt meet without
  // a green sliver; the concrete motel lot tucks under the race ribbon edge
  // so no grass peeks between lot and road.
  patches: [
    {
      kind: 'sand',
      poly: [
        // inland dune lip, fork -> rejoin (~8 m inland of the ribbon centre)
        [-245, -90],
        [-228, -130],
        [-215, -150],
        [-195, -182],
        [-179, -204],
        [-161, -228],
        [-130, -237],
        [-100, -237],
        [-95, -247],
        [-112, -261],
        // seaward boundary = the coast arc, SE seam back up to the fork
        [-130, -272],
        [-185, -266],
        [-225, -254],
        [-252, -238],
        [-272, -216],
        [-282, -196],
        [-264, -180],
        [-290, -158],
        [-276, -138],
        [-272, -120],
        [-284, -94],
        [-288, -68],
        [-263, -66],
        [-255, -82],
      ],
    },
    {
      // dune-lip transition band only — the concept keeps the foreground in
      // plain green; drygrass is the strip where lawn dries out into sand
      kind: 'drygrass',
      y: 0.005, // under the sand so the shared boundary can overlap safely
      poly: [
        // seaward edge: the sand's inland boundary pushed ~3 m onto the sand
        [-247, -92],
        [-230, -132],
        [-217, -152],
        [-197, -184],
        [-181, -206],
        [-163, -230],
        [-131, -240],
        [-100, -240],
        // inland edge ~10 m up the lawn
        [-100, -226],
        [-130, -225],
        [-151, -221],
        [-169, -197],
        [-185, -175],
        [-205, -143],
        [-218, -123],
        [-235, -85],
      ],
    },
    {
      // the motel lot, meeting the village road's edge — gravel is the
      // darkest paved tile we have, closest read to the concept's asphalt
      kind: 'gravel',
      poly: [
        [-192, -170],
        [-190, -140],
        [-157, -133],
        [-146, -166],
      ],
    },
  ],

  decals: parkingBays(),

  // West/south-west coast arc, south→north (continues from the shared south
  // arc and hands off to the shared NW connector around the Beach Run
  // fork). All 'beach' — an 18 m sand skirt down to the foam. The pull-in
  // at z -180 keeps the sail-yacht in open water; the nose back out at
  // z -158 keeps the rocks-sand-c cluster on the sand. ROUGH: refine within
  // this arc, but keep the first vertex meeting the shared south arc and
  // the last vertex meeting the shared NW arc.
  coast: [
    { x: -130, z: -272, edge: 'beach' },
    { x: -185, z: -266, edge: 'beach' },
    { x: -225, z: -254, edge: 'beach' },
    { x: -252, z: -238, edge: 'beach' },
    { x: -272, z: -216, edge: 'beach' },
    { x: -282, z: -196, edge: 'beach' },
    { x: -264, z: -180, edge: 'beach' }, // pulled in: the yacht floats off this bight
    { x: -290, z: -158, edge: 'beach' }, // nose out: sand rocks stay ashore
    { x: -276, z: -138, edge: 'beach' },
    { x: -272, z: -120, edge: 'beach' }, // the pier overhangs seaward of here
    { x: -284, z: -94, edge: 'beach' },
    { x: -288, z: -68, edge: 'beach' },
  ],
};
