import type * as THREE from 'three';
import { buildWheelGeometry, type WheelDetail, type WheelStyle } from '../../geometry';

// ────────────────────────────────────────────────────────────────────────────
// Wheel templates for the generated cars — the same contract as the baked
// wheel templates (centred at origin, axle along X, radius exactly the
// spec's wheelRadius, vertex-coloured, display-only/never deformed). The
// geometry itself comes from the shared parametric builder so the generated
// cars and the generic wheel are one design.
// ────────────────────────────────────────────────────────────────────────────

/** Left + right wheel template pair for a style. */
export function buildWheelPair(style: WheelStyle, r: number, detail: WheelDetail = 'full'): { wheelL: THREE.BufferGeometry; wheelR: THREE.BufferGeometry } {
  return { wheelL: buildWheelGeometry(style, r, 'L', detail), wheelR: buildWheelGeometry(style, r, 'R', detail) };
}
