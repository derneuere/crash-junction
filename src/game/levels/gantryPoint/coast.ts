import type { CoastDef } from '../../types';
import { beach } from '../gantry/beach';
import { cliff } from '../gantry/cliff';
import { dockyard } from '../gantry/dockyard';
import { harbor } from '../gantry/harbor';
import { shared, sharedNorthwestArc, sharedSouthArc } from '../gantry/shared';
import type { ZoneDressing } from '../gantry/dressing';

// ---------------------------------------------------------------------------
// Zone assembly. Concatenation order is fixed — shared, dockyard, harbor,
// cliff, beach — for BOTH render layering and physics determinism: solid
// props create static cannon bodies in array order, and reshuffling them
// re-deals body ids (replay determinism pins live on the other levels, but
// there is no reason to churn). wallStyles inherit the same order, and the
// engine resolves overlaps last-wins: a zone's local exception beats
// shared's broad range.
// ---------------------------------------------------------------------------

export const ZONES: ZoneDressing[] = [shared, dockyard, harbor, cliff, beach];

// The island outline: ONE closed CCW loop stitched from the per-zone arcs in
// a FIXED order (each arc is open; its last vertex's edge styles the seam
// segment into the next arc, and harbor's last vertex closes back into the
// south arc):
//
//   shared south arc (E→W, bank)
//   → beach west/south-west arc (S→N, beach)
//   → shared NW connector (S→N, bank)
//   → cliff north arc (W→E, cliff)
//   → harbor east arc (N→S, wall/cliff/beach)
//   → close
//
// The outline replaces the auto-sized ground square, so it must enclose
// every road, prop and building — the deliberate exceptions are the four
// vessels (freighter, two fishing boats, the yacht), which float OUTSIDE it
// on the -2.2 sea, and the pier platforms that overhang the beach rim.
export const COAST: CoastDef = {
  seaLevel: -2.2,
  outline: [...sharedSouthArc, ...(beach.coast ?? []), ...sharedNorthwestArc, ...(cliff.coast ?? []), ...(harbor.coast ?? [])],
};
