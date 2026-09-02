import * as THREE from 'three';
import type { PanelMetrics } from './metrics-types';

export interface ModelConfig {
  url: string;
  /** Yaw applied first so the nose faces -z (game forward). */
  rotY: number;
  /** Material names to tint with the spawn color; '*biggest*' = the
   *  primitive with the most vertices (the paint body, in the cars pack). */
  paint: string[];
  /** Material name → color override (the transport pack ships grey). */
  palette?: Record<string, number>;
}

export interface VehicleModel {
  /** Normalized to the spec's dims, centered, vertex-colored. */
  body: THREE.BufferGeometry;
  paintRanges: [number, number][]; // vertex ranges painted in spawn color
  glassRanges: [number, number][];
  headRanges: [number, number][]; // headlight lenses (bus: its light strip)
  tailRanges: [number, number][];
  /** Reverse-lamp lenses — a white emissive role lit only while reversing. */
  reverseRanges: [number, number][];
  /** Lamp dressing (bezels, bowls, lens plates): display-only geometry
   *  that never joins a panel cut and never measures a panel landmark, so
   *  the panel boxes — sim state — are exactly the undressed body's. */
  dressRanges: [number, number][];
  wheelL: THREE.BufferGeometry; // centered, radius = spec.wheelRadius
  wheelR: THREE.BufferGeometry;
  /** The same wheels at the builder's coarse density — swapped onto
   *  non-player cars past the near ring by carlod.ts (presentation only). */
  wheelCoarseL: THREE.BufferGeometry;
  wheelCoarseR: THREE.BufferGeometry;
  /** True when wheelL/R are showroom-quality (procgen builds parametric
   *  wheels). The garage substitutes its generic wheel otherwise — the baked
   *  GLB wheels are near-flat discs that read broken at showroom distance. */
  showroomWheels?: boolean;
  arch: { x: number; zFront: number; zRear: number }; // wheel centers, group space
  wheelY: number; // rest height of wheel centers, group space
  panelMetrics: PanelMetrics;
  /** Real bodywork cut from the hull, aligned with panelDefs(spec, model).
   *  null slots cut to slivers and keep the colored-box fallback. */
  panelCuts: (PanelCut | null)[];
  /** Dark blocker masses inside the body (engine bay / cabin / trunk) —
   *  wounds reveal these instead of daylight through the one-sided shell. */
  interior: THREE.BufferGeometry | null;
}

/** A panel's actual bodywork, carved out of the baked hull at bake time.
 *  Geometry is panel-local (origin at the def's box center, so the hinge
 *  pivot and detach physics work exactly as for the boxes). */
export interface PanelCut {
  geo: THREE.BufferGeometry;
  paint: Uint8Array; // per-vertex: repaint in the spawn color
  size: { x: number; y: number; z: number }; // cutout bounds → physics box
}
