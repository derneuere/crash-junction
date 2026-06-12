import { BOX1, BOX2, CARGO, DOCK, FACT, IND, PYLON, RACE, decor, type ZoneDressing } from './dressing';

// DOCKYARD — the working port at the island's heart: Crane Alley (CRANE
// SMASH), the Harbor Run container canyon, the Port Detour warehouse rows
// and the skyline that towers over all of it. Refshot pose: dockyard
// cam(110,38,-35) look(190,0,35).
//
// Zone bounds (composer distribution rule): x in [60, 270] AND z in
// [-105, 135]. Landlocked — the quay faces east and north belong to the
// HARBOR zone's coast arc, so this zone authors no coast.
//
// Concept target (docs/concept-art/dockyard.png): the port floor is one
// cracked-concrete apron with yellow working-lane paint, the race wall runs
// chain-link instead of red/white inside the gates, the sheds go corrugated
// teal/rust, and two ship-to-shore gantries own the skyline with the moored
// freighter framed between them — the namesake of GANTRY POINT, finally on
// the horizon.

// Concept palette. Tints MULTIPLY the kit colormaps, so every swatch is
// picked a touch lighter than the painted look it should land on.
const TEAL = 0x63a89c; // corrugated teal — the port authority's house color
const RUST = 0xc4654a; // rust-red shed walls
const RUSTY = 0xb98a5e; // rust-streak weathering for container paint
const BLEACH = 0xd9c9a8; // sun-bleached container weathering
const PAINT = 0xc9a227; // worked-over yellow lane paint, halfway to ochre

export const dockyard: ZoneDressing = {
  props: [
    // --- CRANE SMASH: Crane Alley, the island's namesake theatre ---
    // two lattice tower cranes straddle the quay, jibs (local -z) crossed
    // OVER the road; only the mast is solid. wallDir lands across the alley,
    // which is the truth for a mast: there is no shallow angle into one.
    { url: `${DOCK}/crane-tower-jtoastie.glb`, x: 210, z: -88, yaw: -Math.PI / 2, scale: 1.8, collider: { hx: 1.5, hy: 13, hz: 1.5 } },
    { url: `${DOCK}/crane-tower-jtoastie.glb`, x: 247, z: -70, yaw: Math.PI / 2, scale: 1.8, collider: { hx: 1.5, hy: 13, hz: 1.5 } },
    // the level-luffing harbor crane on the quay apron (legs splay to ~±7 m
    // at x0.3; the mesh floats 3.28 native above its origin, hence y -1.0).
    // Safety orange like its twin on the north quay (harbor.ts) — one port
    // authority, one paint locker; the tint stays saturated because multiply
    // can only darken the grey-blue base.
    { url: `${DOCK}/crane-harbor-hancock.glb`, x: 262, z: -96, yaw: 0, scale: 0.3, y: -1.0, tint: 0xff7014, collider: { hx: 7, hy: 5.5, hz: 7 } },
    { url: `${CARGO}/container-red.glb`, x: 250, z: -104, yaw: 0.15, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 250, -104, 0.12, 1, { y: 2.6 }), // 2nd of the stack
    decor(`${CARGO}/container-shipping.glb`, 250, -104, 0.14, 1, { y: 5.2 }), // 3rd — the alley skyline
    { url: `${CARGO}/container-green.glb`, x: 251, z: -96, yaw: -0.1, scale: 1, tint: RUSTY, collider: BOX1 },
    { url: `${CARGO}/container-train-cargo.glb`, x: 253, z: -52, yaw: 0.2, scale: 1, collider: { hx: 4.7, hy: 1.3, hz: 1.05 } },
    decor(`${DOCK}/forklift-kolosstudios.glb`, 252, -88, Math.PI, 1, { cx: 54.25, cz: 3.03 }), // mesh authored 54 units off-origin
    decor(`${CARGO}/tires.glb`, 214, -76, 2.1, 1),
    // mooring bollards on the quay lip — pure scale cues; nothing drivable
    // gets within 20 m of the rim, so cast iron stays decor
    decor('builtin:bollard', 270, -44, 0, 1.2),
    decor('builtin:bollard', 270, -58, 0, 1.2),
    decor('builtin:bollard', 270, -72, 0, 1.2),
    // port gate furniture at the Harbor Run fork — the cut must read at 38 m/s
    decor(`${RACE}/fenceStraight.glb`, 214, -38, -1.8, 6, { cx: 0.15, cz: -0.665 }),
    decor(`${RACE}/fenceStraight.glb`, 242, -49, -1.75, 6, { cx: 0.15, cz: -0.665 }),
    decor(`${FACT}/warning-traffic.glb`, 214, -33, 0.3, 1.2),
    decor(`${FACT}/warning-orange.glb`, 239, -45, 0, 1.2),
    decor(`${RACE}/pylon.glb`, 217, -40, 0, 6, PYLON),
    decor(`${RACE}/pylon.glb`, 236, -42, 0.7, 6, PYLON),

    // --- the GANTRY POINT skyline: two ship-to-shore gantries on the berth ---
    // yaw -π/2 swings each boom (local -z) east over the quay face, the way
    // a working berth lines its cranes up over the ship — from the dockyard
    // pose the moored freighter rides exactly between the two portals. The
    // collider is the whole portal: cars can't thread 28 m of crane legs at
    // 38 m/s, and the berth apron is 40 m off any drivable line anyway.
    { url: 'builtin:gantry-crane', x: 266, z: 46, yaw: -Math.PI / 2, scale: 1, collider: { hx: 9.5, hy: 13, hz: 5.6 } },
    { url: 'builtin:gantry-crane', x: 268, z: 79, yaw: -Math.PI / 2, scale: 1, collider: { hx: 9.5, hy: 13, hz: 5.6 } },
    // boxes staged on the berth apron under the booms — a working berth is
    // never bare concrete between crane legs
    { url: `${CARGO}/container-red.glb`, x: 258, z: 12, yaw: 0.04, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 258, 12, 0.06, 1, { y: 2.6 }),
    { url: `${CARGO}/container-shipping.glb`, x: 260, z: -4, yaw: 0.02, scale: 1.3, collider: { hx: 2.9, hy: 1.4, hz: 1.4 } },

    // --- highmast floodlights — the concept's light poles over the aprons ---
    // slim solid masts (a 16 m steel pole is a wall, not a kerb), each
    // audited ≥ 17 m off every centreline
    { url: 'builtin:floodlight-mast', x: 150, z: -58, yaw: 0.3, scale: 1, collider: { hx: 0.4, hy: 8, hz: 0.4 } },
    { url: 'builtin:floodlight-mast', x: 132, z: 28, yaw: -0.6, scale: 1, collider: { hx: 0.4, hy: 8, hz: 0.4 } },
    { url: 'builtin:floodlight-mast', x: 204, z: 108, yaw: 0.86, scale: 1, collider: { hx: 0.4, hy: 8, hz: 0.4 } },
    { url: 'builtin:floodlight-mast', x: 246, z: -16, yaw: -1.2, scale: 1, collider: { hx: 0.4, hy: 8, hz: 0.4 } },

    // --- HARBOR RUN: the container canyon (GDD 5.1 "between stack walls of
    // containers — solid props just outside the ribbon"). West row first.
    // The z 45..62 landing corridor keeps an extra 4 m of lateral clearance.
    // Concept pass: stacks go three-high (third unit is decor at y 5.2 —
    // colliders stay BOX2, nothing drivable ever gets up there) and the
    // paint weathers via tint so no two boxes read factory-fresh.
    { url: `${CARGO}/container-red.glb`, x: 211, z: -30, yaw: 0.06, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 211, -30, 0.1, 1, { y: 2.6 }),
    decor(`${CARGO}/container-shipping.glb`, 211, -30, 0.08, 1, { y: 5.2 }),
    // second rank west of the lane: from the dockyard pose this is the
    // concept's left-of-frame container wall, stacked behind the front row
    { url: `${CARGO}/container-green.glb`, x: 200, z: -28, yaw: 0.1, scale: 1, tint: 0x6f8fc9, collider: BOX2 }, // navy
    decor(`${CARGO}/container-red.glb`, 200, -28, 0.12, 1, { y: 2.6 }),
    decor(`${CARGO}/container-shipping.glb`, 200, -28, 0.11, 1, { y: 5.2 }),
    { url: `${CARGO}/container-green.glb`, x: 198, z: -12, yaw: 0.08, scale: 1, tint: RUSTY, collider: BOX2 },
    decor(`${CARGO}/container-red.glb`, 198, -12, 0.1, 1, { y: 2.6 }),
    { url: `${CARGO}/container-red.glb`, x: 197, z: 4, yaw: 0.06, scale: 1, collider: BOX2 },
    { ...decor(`${CARGO}/container-green.glb`, 197, 4, 0.08, 1, { y: 2.6 }), tint: BLEACH },
    decor(`${CARGO}/container-small.glb`, 197, 4, 0.07, 1.3, { y: 5.2 }),
    { url: `${CARGO}/container-green.glb`, x: 212, z: -6, yaw: -0.08, scale: 1, tint: BLEACH, collider: BOX2 },
    { ...decor(`${CARGO}/container-red.glb`, 212, -6, -0.05, 1, { y: 2.6 }), tint: RUSTY },
    decor(`${CARGO}/container-small.glb`, 212, -6, -0.06, 1.3, { y: 5.2 }), // blue 10-footer crowns the stack
    { url: `${CARGO}/container-shipping.glb`, x: 210, z: 20, yaw: 0.1, scale: 1.3, collider: { hx: 2.9, hy: 1.4, hz: 1.4 } },
    { url: `${CARGO}/container-red.glb`, x: 208, z: 48, yaw: 0.05, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-shipping.glb`, 208, 48, 0.05, 1.3, { y: 2.6 }),
    // a long unit can't fit the z~72 sliver: the main port exit and the lane
    // converge to ~28 m there, so the row tapers to a half-length box instead
    { url: `${CARGO}/container-small.glb`, x: 213, z: 68, yaw: 0.04, scale: 1.3, collider: { hx: 1.45, hy: 1.4, hz: 1.4 } },
    // east row
    { url: `${CARGO}/container-green.glb`, x: 242, z: -32, yaw: 0.1, scale: 1, tint: RUSTY, collider: BOX2 },
    decor(`${CARGO}/container-red.glb`, 242, -32, 0.14, 1, { y: 2.6 }),
    { ...decor(`${CARGO}/container-green.glb`, 242, -32, 0.12, 1, { y: 5.2 }), tint: BLEACH },
    { url: `${CARGO}/container-structure.glb`, x: 243, z: -8, yaw: 0.1, scale: 1, collider: { hx: 4, hy: 2.3, hz: 2.3 } }, // the dock-office conversion
    { url: `${CARGO}/container-red.glb`, x: 241, z: 30, yaw: -0.12, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 241, 30, -0.1, 1, { y: 2.6 }),
    decor(`${CARGO}/container-red.glb`, 241, 30, -0.11, 1, { y: 5.2 }),
    { url: `${CARGO}/container-shipping.glb`, x: 243, z: 58, yaw: 0.08, scale: 1.3, collider: { hx: 2.9, hy: 1.4, hz: 1.4 } },
    { url: `${CARGO}/container-train-cargo.glb`, x: 241, z: 78, yaw: -0.04, scale: 1, collider: { hx: 4.7, hy: 1.3, hz: 1.05 } },
    // the long quay shed walls the lane's west flank, gable-end to the lane
    // (same end-on rule as the stacks, for the same wallDirs reason) — now
    // in rust-red corrugation per the concept
    { url: `${IND}/building-s.glb`, x: 204, z: 32, yaw: 0, scale: 12, tint: RUST, collider: { hx: 12.7, hy: 5.1, hz: 5.5 } },
    { url: `${CARGO}/silo.glb`, x: 196, z: 52, yaw: 0, scale: 1, collider: { hx: 1.85, hy: 4.5, hz: 1.8 } }, // the fuel silo
    decor(`${IND}/detail-tank.glb`, 192, 42, 0.3, 10),
    decor(`${CARGO}/crate.glb`, 208, 44, 0.7, 1.5),
    decor(`${CARGO}/pallet.glb`, 205, 40, 1.2, 1),

    // --- the west stack yard: the concept's left-of-frame container block ---
    // two tidy rows on the apron south of the Port Detour, gable-end to the
    // working lane like the canyon (the wallDirs rule again), mixed heights
    // and weathered paint so the block reads stockpile, not showroom. All
    // bottoms solid (cars CAN roam this apron via the gate gaps); audited
    // ≥ 20 m off the detour centreline.
    // near corner of the block, right against the detour's south fence —
    // these two are what makes the yard read as a WALL from the apron
    { url: `${CARGO}/container-green.glb`, x: 142, z: -50, yaw: 0.22, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-shipping.glb`, 142, -50, 0.24, 1, { y: 2.6 }),
    { url: `${CARGO}/container-red.glb`, x: 150, z: -52, yaw: 0.22, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 150, -52, 0.2, 1, { y: 2.6 }),
    // front row, z ~-60 (the camera-side block; chain stays ≥ 17 m away)
    { url: `${CARGO}/container-green.glb`, x: 180, z: -59, yaw: 0.25, scale: 1, tint: 0x6f8fc9, collider: BOX2 }, // navy — green colormap × blue tint
    decor(`${CARGO}/container-red.glb`, 180, -59, 0.27, 1, { y: 2.6 }),
    decor(`${CARGO}/container-shipping.glb`, 180, -59, 0.25, 1, { y: 5.2 }),
    { url: `${CARGO}/container-red.glb`, x: 188, z: -61, yaw: 0.22, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 188, -61, 0.24, 1, { y: 2.6 }),
    { url: `${CARGO}/container-shipping.glb`, x: 196, z: -63, yaw: 0.27, scale: 1.3, collider: { hx: 2.9, hy: 1.4, hz: 1.4 } },
    decor(`${CARGO}/container-small.glb`, 196, -63, 0.26, 1.3, { y: 2.8 }),
    // back row, z ~-72
    { url: `${CARGO}/container-green.glb`, x: 164, z: -72, yaw: 0.24, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-red.glb`, 164, -72, 0.22, 1, { y: 2.6 }),
    { ...decor(`${CARGO}/container-green.glb`, 164, -72, 0.25, 1, { y: 5.2 }), tint: RUSTY },
    { url: `${CARGO}/container-red.glb`, x: 172, z: -74, yaw: 0.26, scale: 1, tint: BLEACH, collider: BOX2 },
    decor(`${CARGO}/container-shipping.glb`, 172, -74, 0.25, 1, { y: 2.6 }),
    { url: `${CARGO}/container-green.glb`, x: 184, z: -71, yaw: 0.23, scale: 1, collider: BOX2 },
    { ...decor(`${CARGO}/container-red.glb`, 184, -71, 0.25, 1, { y: 2.6 }), tint: RUSTY },
    { ...decor(`${CARGO}/container-green.glb`, 184, -71, 0.24, 1, { y: 5.2 }), tint: BLEACH },
    { url: `${CARGO}/container-red.glb`, x: 192, z: -73, yaw: 0.26, scale: 1, tint: RUSTY, collider: BOX2 },
    decor(`${CARGO}/container-shipping.glb`, 192, -73, 0.25, 1, { y: 2.6 }),
    { url: `${CARGO}/container-green.glb`, x: 200, z: -75, yaw: 0.23, scale: 1, tint: BLEACH, collider: BOX1 },
    decor(`${CARGO}/pallet.glb`, 176, -55, 0.5, 1),
    decor(`${CARGO}/crate.glb`, 179, -54, 0.9, 1.6),

    // --- container row along the port exit's north flank (concept right
    // edge: boxes behind the chain-link as the road sweeps to the quay) ---
    // yaw 0.86 keeps each box gable-end to the road (local z ∥ traffic)
    { url: `${CARGO}/container-red.glb`, x: 158, z: 80, yaw: 0.86, scale: 1, collider: BOX2 },
    decor(`${CARGO}/container-green.glb`, 158, 80, 0.88, 1, { y: 2.6 }),
    { url: `${CARGO}/container-green.glb`, x: 165, z: 86, yaw: 0.86, scale: 1, collider: BOX1 },
    { url: `${CARGO}/container-green.glb`, x: 172, z: 92, yaw: 0.86, scale: 1, tint: BLEACH, collider: BOX1 },
    { url: `${CARGO}/container-red.glb`, x: 180, z: 98, yaw: 0.86, scale: 1, collider: BOX2 },
    { ...decor(`${CARGO}/container-green.glb`, 180, 98, 0.87, 1, { y: 2.6 }), tint: BLEACH },
    { url: `${CARGO}/container-red.glb`, x: 190, z: 104, yaw: 0.86, scale: 1, tint: RUSTY, collider: BOX2 },
    decor(`${CARGO}/container-small.glb`, 190, 104, 0.86, 1.3, { y: 2.6 }),
    { url: `${CARGO}/container-green.glb`, x: 206, z: 116, yaw: 0.86, scale: 1, collider: BOX1 },
    { url: `${CARGO}/container-shipping.glb`, x: 222, z: 124, yaw: 0.86, scale: 1.3, collider: { hx: 2.9, hy: 1.4, hz: 1.4 } },

    // --- dockyard skyline (Port Detour interior) ---
    { url: `${DOCK}/crane-tower-jtoastie.glb`, x: 180, z: -4, yaw: 2.62, scale: 1.8, collider: { hx: 1.5, hy: 13, hz: 1.5 } }, // third crane: jib swung NW over the sheds
    // 20 m smokestack landmark — banded per the concept: a slimmer red-tinted
    // crown chimney rides inside the grey stack and pokes 2.5 m of straight
    // cylinder out the top (the model is straight above 65% height, so the
    // nested copy stays hidden until the rim). Collider unchanged.
    { url: `${IND}/chimney-large.glb`, x: 150, z: 120, yaw: 0, scale: 12, collider: { hx: 3, hy: 10.2, hz: 3 } },
    { ...decor(`${IND}/chimney-large.glb`, 150, 120, 0, 9, { y: 7.6 }), tint: 0xd24539 },
    { ...decor(`${IND}/building-j.glb`, 138, 104, 0, 11, { cx: -0.435, cz: 0.274 }), tint: TEAL }, // quonset hut under the stack

    // --- the warehouse quarter: corrugated teal/rust sheds replace the old
    // window-cube office blocks. building-s and building-k pivot dead centre,
    // so prop origin == mesh centre == collider centre and the boxes are
    // honest; the corner-pivot kit sheds stay decor-only elsewhere. Spots
    // audited ≥ 23.6 m off every main/branch centreline (collider half-
    // diagonal + ribbon half + 1.5 all clear).
    { url: `${IND}/building-s.glb`, x: 146, z: 14, yaw: 0.25, scale: 13, tint: TEAL, collider: { hx: 13.8, hy: 5.5, hz: 6.0 } },
    { url: `${IND}/building-k.glb`, x: 178, z: 22, yaw: -0.15, scale: 13, tint: RUST, collider: { hx: 8.5, hy: 5.0, hz: 5.95 } },
    { url: `${IND}/building-s.glb`, x: 118, z: 70, yaw: -0.5, scale: 11, tint: TEAL, collider: { hx: 11.7, hy: 4.6, hz: 5.1 } }, // long axis along the port-exit road
    { url: `${IND}/building-k.glb`, x: 150, z: -10, yaw: 0.2, scale: 12.5, tint: TEAL, collider: { hx: 8.2, hy: 4.85, hz: 5.7 } }, // the foreground shed in the concept

    // working clutter with intent: a second forklift mid-shift between the
    // sheds, pallets and crates staged where the lane paint says they belong
    decor(`${DOCK}/forklift-kolosstudios.glb`, 158, 4, -1.4, 1, { cx: 54.25, cz: 3.03 }),
    decor(`${CARGO}/pallet.glb`, 162, 0, 0.4, 1),
    decor(`${CARGO}/crate.glb`, 165, 2, 1.0, 1.4),
    decor(`${CARGO}/tires.glb`, 130, 10, 0.8, 1),
    decor(`${CARGO}/wheels-stack.glb`, 133, 6, 1.9, 1.6),
    // stray pallet pair on the open apron — the camera-side foreground needs
    // one piece of mess or the concrete reads as untouched paint
    decor(`${CARGO}/pallet.glb`, 146, -16, 0.7, 1),
    decor(`${CARGO}/tires.glb`, 152, -13, 1.9, 1),
  ],

  // The port floor: one cracked-concrete apron wall-to-wall inside the
  // gates — the concept kills every blade of grass between the fences. The
  // polygon hugs the zone bounds, tucks inside the harbor zone's quay-face
  // coast (x ≤ 272 < the 277 rim) and stops shy of the z 135 seam; the
  // ribbons render above it per the z-order contract.
  patches: [
    {
      kind: 'concrete',
      poly: [
        [68, -22], [86, -58], [128, -70], [165, -88], [205, -104], [252, -104],
        [272, -94], [272, 124], [252, 132], [214, 124], [150, 130], [128, 108],
        [116, 80], [104, 62], [96, 44], [70, 28],
      ],
    },
  ],

  // Yellow working-lane paint on the apron — the concept's signature ground
  // detail. One color = one InstancedMesh.
  decals: [
    // twin guide lines running the foreground apron toward the port gate
    { x: 154, z: -24, w: 0.5, l: 56, yaw: 2.0, color: PAINT },
    { x: 158, z: -17, w: 0.5, l: 56, yaw: 2.0, color: PAINT },
    // stack-yard bay frontage lines
    { x: 174, z: -58, w: 0.45, l: 34, yaw: 1.32, color: PAINT },
    { x: 178, z: -70, w: 0.45, l: 34, yaw: 1.32, color: PAINT },
    // hatched no-parking wedge off the teal warehouse's roller door
    { x: 133, z: 0, w: 0.5, l: 5, yaw: 2.4, color: PAINT },
    { x: 137, z: 3, w: 0.5, l: 5, yaw: 2.4, color: PAINT },
    { x: 141, z: 6, w: 0.5, l: 5, yaw: 2.4, color: PAINT },
    { x: 145, z: 9, w: 0.5, l: 5, yaw: 2.4, color: PAINT },
    // gate lane-in line where Harbor Run dives between the stacks
    { x: 224, z: -40, w: 0.4, l: 16, yaw: 0.08, color: PAINT },
    // quay-edge safety line along the harbor crane's apron
    { x: 258, z: -72, w: 0.5, l: 36, yaw: 0.15, color: PAINT },
    // berth apron line under the STS gantries
    { x: 252, z: 30, w: 0.5, l: 56, yaw: 0.0, color: PAINT },
    // bay line behind the port-exit container row
    { x: 165, z: 87, w: 0.45, l: 30, yaw: 0.86, color: PAINT },
  ],

  // Chain-link instead of red/white for the whole stretch inside the port
  // gates: sections 36..83 cover Crane Alley, the Port Detour and the quay
  // rejoin (the race re-enters open coast past the z 135 seam). The fence
  // is 2.2 m of steel mesh — same wall physics, dockyard look; the Harbor
  // Run mouth gaps still punch through it.
  wallStyles: [{ from: 36, to: 83, side: 'both', style: 'fence' }],
};
