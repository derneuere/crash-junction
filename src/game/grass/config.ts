// ============================================================================
// GRASS — placement density + distance-cull/LOD/tiling constants.
// ============================================================================
// Tunables shared by the placement pass (build.ts) and the per-frame LOD update.
// Split out of grass.ts as a cohesive constant block; values are unchanged.

/** Per-area clump density (blade-clumps per m² of accepted grass).
 *
 *  The FluffyGrass demo scatters 8000 clumps over its ~2546 m² terrain →
 *  ~3.14 clumps/m². Each demo clump is a fanned ~6-card cluster textured with a
 *  ~10-blade alpha mask, so the ground reads as a continuous lush mat. We match
 *  that near-field density. Because each clump now renders as a FULL bushy
 *  cluster (alpha-mask silhouette, not a couple of strips) we can hold the lush
 *  read at this density without the old "solid green wall" failure. */
export const DENSITY = 3.1;

/** Hard ceiling on allocated clumps across the whole island. Render-time LOD
 *  makes only a fraction DRAW at once, so this bounds the one-time build cost
 *  (placement + instance buffers) not the per-frame draw. */
export const MAX_BLADES = 600000;

/** Distance-cull radius (m): a tile whose centre is farther than this from the
 *  live camera draws nothing. Sized to read out toward the scene fog (gantry
 *  fog is 90..340 m linear). Between FULL_RADIUS and here the per-tile LOD
 *  thins the draw and shrinks the geometry, so the far edge stays cheap. */
export const CULL_RADIUS = 210;

/** Inside this radius (m) a tile draws its FULL allocated density — the demo's
 *  ~3.1 clumps/m². This is the lush near field the chase cam sees in detail;
 *  it must read exactly as full as the demo. Beyond it the per-tile count LOD
 *  ramps the drawn fraction down to MIN_LOD_FRAC at CULL_RADIUS. */
export const FULL_RADIUS = 64;

/** Floor on the per-tile drawn fraction at the cull edge. A distant-but-visible
 *  tile draws this fraction of its clumps (uniformly thinned). */
export const MIN_LOD_FRAC = 0.05;

/** Geometry-LOD ring radii (m). A tile inside LOD0_RADIUS draws the full LOD00
 *  clump; between LOD0 and LOD1 it draws LOD01; beyond LOD1 (out to CULL_RADIUS)
 *  it draws LOD02. Sized so the swap happens where the clump is already small on
 *  screen, so the tri-count drop is invisible. */
export const LOD0_RADIUS = 80;
export const LOD1_RADIUS = 145;

/** Spatial tile size (m) for the culling + LOD grid. A 22 m tile over the
 *  ~600 m island gives a fine grid for smooth distance LOD + tight frustum. */
export const TILE_SIZE = 22;

// ── BLADE SIZING (the chase-cam lushness lever) ─────────────────────────────
//   The demo scales its LOD00 clump x5 → ~0.65 m tall / ~1.6 m wide. From a
//   near-top-down orbit that reads full; from our shallow chase-cam angle
//   (~2.4 m eye, grazing the verge) short blades collapse to a thin fuzz. So we
//   scale the clump TALLER. Per-instance jitter keeps the field from reading as
//   one flat surface. Heights are in metres of the final clump.
export const HEIGHT_MIN = 1.35; // m — shortest clump
export const HEIGHT_MAX = 1.95; // m — tallest clump
export const WIDTH_MIN = 1.0; // m — narrowest clump footprint
export const WIDTH_MAX = 1.7; // m — widest clump footprint
