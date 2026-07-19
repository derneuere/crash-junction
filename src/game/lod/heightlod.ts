import * as THREE from 'three';

// ============================================================================
// HEIGHT-DRIVEN SCREEN-SPACE LOD (perf-heightlod)
// ============================================================================
//
// Detail is dropped per object based on how tall it LOOKS on screen, not how
// far away it is. Every registered target carries its world-space vertical
// extent; each frame we project that height through the camera:
//
//     pxHeight = worldHeight · k / distance,   k = viewportH / (2·tan(fov/2))
//
// and walk a 3-level ladder on PIXEL thresholds:
//
//     level 0  FULL        — rendered, casts shadows
//     level 1  NO-SHADOW   — rendered, dropped from the sun's shadow depth pass
//     level 2  HIDDEN      — not rendered at all
//
// WHY pixel thresholds and not distance bands: a fixed distance band either
// pops a 12 m crane out while it is still 40 px tall (visible pop) or keeps
// every 0.5 m bollard alive to the far plane (no perf win). Projected height
// gives every object its OWN switch distance proportional to its size — tall
// landmarks hold detail for hundreds of metres, small clutter drops early,
// and every transition happens when the object spans only a few pixels, which
// is what makes the switches invisible.
//
// WHY the ladder is visibility + shadow flips and not decimated geometry:
// docs/research/perf-lod-props-findings.md — this engine is DRAW-CALL bound,
// not triangle bound (the reverted @three.ez geometry-LOD experiment proved
// it). Level 1 removes the object from the shadow depth pass (one whole extra
// scene render); level 2 removes its draw entirely, a saving that MULTIPLIES
// ×6 through the live cube reflection. Both attack draw calls directly.
//
// POP-IN GUARDS:
//   * thresholds are chosen where the object is a few pixels tall — a 6 px
//     sliver vanishing at 250 m reads as nothing, unlike a distance band.
//   * HYSTERESIS on every boundary (hide at HIDE px, re-show at the larger
//     SHOW px) so a camera hovering at a threshold never flickers an object.
//   * FLAT-OBJECT FLOOR: a lying pallet projects almost no vertical extent
//     but plenty of footprint, so the effective size is floored at a fraction
//     of the horizontal diagonal — wide-flat things never wrongly vanish.
//
// DETERMINISM: PURE PRESENTATION. Reads only the render camera; flips only
// `visible` / `castShadow` / BatchedMesh instance visibility on render
// objects. The sim, colliders and replay pins never see any of it.
// ============================================================================

/** Pixel thresholds (CSS px of the viewport height) for the ladder. Each
 *  DOWN transition has a larger UP partner — that gap is the hysteresis band.
 *  Tuning: raise `hide` for more perf (earlier cull, bigger pop risk); raise
 *  `shadowOff` to thin the shadow pass sooner (shadows of far small objects
 *  are sub-pixel in the shadow map anyway, so this one is nearly free). */
export const LOD_PX = {
  /** below this projected height the object is HIDDEN (level 2) */
  hide: 6,
  /** must re-grow past this to become visible again (up-partner of `hide`) */
  show: 7.5,
  /** below this projected height the object stops casting shadows (level 1) */
  shadowOff: 16,
  /** must re-grow past this to cast shadows again (up-partner of `shadowOff`) */
  shadowOn: 19,
};

/** Fraction of the horizontal footprint diagonal that floors the effective
 *  size, so flat-but-wide objects (pallets, slabs) don't project ~0 height
 *  and wrongly vanish. 0.35 keeps a 14 m slab alive past any playable range
 *  while leaving genuinely small clutter (≤1 m every way) free to cull. */
const FOOTPRINT_FRAC = 0.35;

/** 0 = full, 1 = no shadow, 2 = hidden. */
export type LodLevel = 0 | 1 | 2;

interface Entry {
  cx: number;
  cy: number;
  cz: number;
  /** bounding radius of the target (m) — subtracted from the camera distance
   *  so a 40 m tile is judged by its NEAREST content, not its centre. 0 for
   *  single objects. */
  radius: number;
  /** effective world size (m): bbox height floored by the footprint rule */
  size: number;
  level: LodLevel;
  // per-entry switch DISTANCES derived from the pixel thresholds and the
  // current projection constant k — recomputed only when k changes (resize /
  // fov change), so the per-frame work is one distance + comparisons.
  hideD: number;
  showD: number;
  shadowOffD: number;
  shadowOnD: number;
  apply: (level: LodLevel) => void;
}

/** Registry of LOD targets + the per-frame ladder walk. One instance per
 *  Game; propinstancer/environment register targets as they emit meshes. */
export class HeightLOD {
  private entries: Entry[] = [];
  /** projection constant: viewportH / (2·tan(fov/2)). 0 = not yet known. */
  private k = 0;

  /** Register one target. `center`/`radius` bound it in world space, `size`
   *  is its effective world size (see lodMetricsOf), `apply` receives ladder
   *  levels — it is only called on CHANGES, starting from level 0 (the state
   *  every mesh is built in: visible, shadows as authored). */
  register(center: { x: number; y: number; z: number }, radius: number, size: number, apply: (level: LodLevel) => void): void {
    const e: Entry = {
      cx: center.x,
      cy: center.y,
      cz: center.z,
      radius,
      size: Math.max(0.01, size),
      level: 0,
      hideD: Infinity,
      showD: Infinity,
      shadowOffD: Infinity,
      shadowOnD: Infinity,
      apply,
    };
    if (this.k > 0) this.derive(e);
    this.entries.push(e);
  }

  /** pixel threshold px → the camera distance where the target spans it */
  private derive(e: Entry): void {
    const s = e.size * this.k;
    e.hideD = s / LOD_PX.hide;
    e.showD = s / LOD_PX.show;
    e.shadowOffD = s / LOD_PX.shadowOff;
    e.shadowOnD = s / LOD_PX.shadowOn;
  }

  /** Walk the ladder for every target. Call once per frame from the render
   *  side with the live camera + the CSS viewport height. ~1k targets cost a
   *  distance and a few compares each — microseconds. */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    const k = viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5));
    if (!(k > 0)) return;
    if (Math.abs(k - this.k) > this.k * 1e-3) {
      this.k = k;
      for (const e of this.entries) this.derive(e);
    }
    const p = camera.position;
    for (const e of this.entries) {
      const dx = e.cx - p.x;
      const dy = e.cy - p.y;
      const dz = e.cz - p.z;
      const d = Math.max(0.01, Math.sqrt(dx * dx + dy * dy + dz * dz) - e.radius);
      // hysteresis ladder: each state only leaves through its own thresholds,
      // and the up-thresholds sit NEARER than the down-thresholds (larger px),
      // so a camera parked on a boundary can't flicker the target.
      let lvl = e.level;
      if (lvl === 2) {
        if (d < e.showD) lvl = d < e.shadowOnD ? 0 : 1;
      } else if (lvl === 1) {
        if (d > e.hideD) lvl = 2;
        else if (d < e.shadowOnD) lvl = 0;
      } else {
        if (d > e.hideD) lvl = 2;
        else if (d > e.shadowOffD) lvl = 1;
      }
      if (lvl !== e.level) {
        e.level = lvl;
        e.apply(lvl);
      }
    }
  }

  /** live ladder census for the perf HUD / probes */
  stats(): { total: number; noShadow: number; hidden: number } {
    let noShadow = 0;
    let hidden = 0;
    for (const e of this.entries) {
      if (e.level === 1) noShadow++;
      else if (e.level === 2) hidden++;
    }
    return { total: this.entries.length, noShadow, hidden };
  }
}

const _v = new THREE.Vector3();

/** World-space LOD metrics of one placed geometry: the centre of its world
 *  bbox and its EFFECTIVE size — vertical extent floored at FOOTPRINT_FRAC of
 *  the horizontal diagonal (the flat-object guard). The template geometry's
 *  local bbox is computed once and cached by three; only the 8 corners are
 *  transformed per placement. */
export function lodMetricsOf(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): { size: number; cx: number; cy: number; cz: number } {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  if (bb.isEmpty()) return { size: 1, cx: matrix.elements[12], cy: matrix.elements[13], cz: matrix.elements[14] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < 8; i++) {
    _v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(matrix);
    if (_v.x < minX) minX = _v.x;
    if (_v.y < minY) minY = _v.y;
    if (_v.z < minZ) minZ = _v.z;
    if (_v.x > maxX) maxX = _v.x;
    if (_v.y > maxY) maxY = _v.y;
    if (_v.z > maxZ) maxZ = _v.z;
  }
  const size = Math.max(maxY - minY, FOOTPRINT_FRAC * Math.hypot(maxX - minX, maxZ - minZ));
  return { size, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2 };
}
