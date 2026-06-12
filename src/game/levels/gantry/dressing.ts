import type {
  BuildingDef,
  CoastDef,
  DecalDef,
  GroundPatchDef,
  PropDef,
  WallStyleDef,
} from '../../types';

// Shared dressing toolkit for the GANTRY POINT zone modules. READ-ONLY for
// zone work: every zone file (dockyard/harbor/cliff/beach/shared) leans on
// these helpers, so a change here ripples across all of them — edit the
// zone files instead, and treat this module as the contract between them.

/** One zone's slice of the island dressing. The composer (gantryPoint.ts)
 *  concatenates the optional arrays across zones — gameplay (waypoints,
 *  shortcuts, signatures, barrels, poles, ramps) stays central in the
 *  composer and is never authored here.
 *
 *  wallStyles: composer concat order is shared → dockyard → harbor → cliff
 *  → beach, and the engine resolves overlaps last-wins — so shared's broad
 *  ranges lose to a zone's local exception, and later zones beat earlier
 *  ones where ranges meet at a boundary.
 *
 *  coast: an OPEN arc of the island outline, in composer stitching order
 *  (see the outline assembly in gantryPoint.ts) — never close it and never
 *  reorder it; each vertex's edge type styles the segment to the NEXT
 *  vertex, and the arc's last vertex styles the seam into the next arc. */
export interface ZoneDressing {
  props: PropDef[];
  patches?: GroundPatchDef[];
  decals?: DecalDef[];
  wallStyles?: WallStyleDef[];
  buildings?: BuildingDef[];
  coast?: CoastVertex[];
}

export type CoastVertex = CoastDef['outline'][number];

// Asset pack roots (manifest.md in each folder carries source + license).
export const RACE = '/models/props/kenney-racing-kit';
export const IND = '/models/props/kenney-city-kit-industrial';
export const FACT = '/models/props/kenney-factory-kit';
export const CARGO = '/models/props/quaternius-cargo';
export const DOCK = '/models/props/polypizza-dockyard-ccby';
export const NATURE = '/models/props/kenney-nature-kit';
export const PIRATE = '/models/props/kenney-pirate-kit';
export const COAST = '/models/props/polypizza-coastal';

/** Pure-decor prop, pivot-compensated: x/z is where the model's bbox CENTRE
 *  should land; cx/cz is the GLB's local pivot→centre offset (measured from
 *  the accessor bounds — zero for the well-behaved kits). rotation.y maps
 *  local (x,z) to world (x·cos+z·sin, −x·sin+z·cos), same as three.js. */
export function decor(
  url: string,
  x: number,
  z: number,
  yaw: number,
  scale: number,
  o: { cx?: number; cz?: number; y?: number } = {},
): PropDef {
  const cx = o.cx ?? 0;
  const cz = o.cz ?? 0;
  const def: PropDef = {
    url,
    x: x - scale * (cx * Math.cos(yaw) + cz * Math.sin(yaw)),
    z: z - scale * (-cx * Math.sin(yaw) + cz * Math.cos(yaw)),
    yaw,
    scale,
    collider: 'none',
  };
  if (o.y !== undefined) def.y = o.y;
  return def;
}

// Racing-kit pivot offsets (local units, pre-scale) — measured per model.
export const GRANDSTAND = { cx: 0.15, cz: -1.15 };
export const FLAG = { cx: -0.25, cz: -0.67 };
export const PYLON = { cx: -0.35, cz: -0.65 };

// Container collider shorthand (Quaternius 20 ft box, 1x = 5.71x2.60x2.56):
// a single, and a double-stack whose ONE box covers both units — the top
// container is a separate y-lifted decor PropDef riding on it. Stacks face
// the corridor END-ON (yaw ~0): wallDirs takes the box local z as the
// along-wall direction, so local z must run with the passing traffic or
// collision.ts reads a parallel scrape as a head-on. Port reality agrees —
// container rows store gable-end to the lane.
export const BOX1 = { hx: 2.9, hy: 1.3, hz: 1.3 };
export const BOX2 = { hx: 2.9, hy: 2.6, hz: 1.3 };
