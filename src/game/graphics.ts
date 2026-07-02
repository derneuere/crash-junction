// ============================================================================
// GRAPHICS SETTINGS — the player-facing quality + draw-call diagnostic toggles.
// ============================================================================
// Every visual toggle is PRESENTATION-ONLY: the sim never reads them, so
// flipping any mid-take can't move a replay checksum or a determinism pin.
// Game.ts applies them through render-time seams (sky dome uniforms, mesh
// visibility, the cine composer's N8AO pass, the cube-reflection gate, the
// shadow-map enable, the props group's visibility); `stats` is pure UI — it
// only shows/hides the corner FPS readout.
//
// TWO FLAVORS of toggle:
//   - VISUAL QUALITY (clouds/water/grass/ao): trade fidelity for GPU fill.
//   - DRAW-CALL DIAGNOSTICS (reflections/shadows/props): the per-frame
//     whole-scene re-renders + the dominant object set. These exist to ISOLATE
//     where the draw-call budget goes — on gantry the props alone are ~900
//     objects and the cube reflection re-renders the whole scene 6×, so the
//     two together account for the bulk of the count.
//
// `ao` is the SCREEN-SPACE ambient occlusion (the N8AO pass in the cine
// composer, postfx.ts). The cheap baked vertex AO (ao.ts) rides the materials
// and stays.

/** Coarse phone/tablet detection for the default quality tier. Touch alone is
 *  not enough (Windows touch laptops); require a mobile UA — plus the iPadOS
 *  "Macintosh" masquerade (Mac UA with real touch points). Never read by the
 *  sim; it only seeds DEFAULT_GRAPHICS, and every field stays user-overridable
 *  in the graphics overlay. */
export const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)));

export interface GraphicsSettings {
  /** the drifting cloud layer in the sky dome (skyenv) */
  clouds: boolean;
  /** the animated ocean on coast levels (no-op where a level has no sea) */
  water: boolean;
  /** the instanced blade grass on coast levels (no-op where there's none) */
  grass: boolean;
  /** screen-space ambient occlusion — the N8AO pass in the cine composer */
  ao: boolean;
  // --- draw-call diagnostics: the big per-frame whole-scene re-renders ---
  /** the live player cube reflection — re-renders the WHOLE scene into 6 faces
   *  (every other frame); the single biggest draw-call MULTIPLIER */
  reflections: boolean;
  /** the sun's shadow depth pass — one extra render of every shadow caster */
  shadows: boolean;
  /** all level set-dressing props (containers, cranes, trees, …) — on gantry
   *  this is ~900 separate objects, the dominant draw-call SOURCE */
  props: boolean;
  /** the top-right FPS / draw-call / triangle readout (UI-only) */
  stats: boolean;
  // --- quality tier knobs (numbers, seeded by IS_MOBILE, overlay-adjustable) ---
  /** the film-look composer (postfx.ts: MSAA HDR buffer, N8AO, speed blur,
   *  bloom, vignette/grain). Off = bare renderer.render with renderer-level
   *  ACES — the single biggest GPU-fill/bandwidth cut on phones. */
  postfx: boolean;
  /** multiplier on the device pixel ratio (after the 1.75 cap): 1 = native,
   *  0.75 ≈ 44% fewer pixels shaded. Fill is the phone's scarcest resource. */
  renderScale: number;
  /** sun shadow-map resolution in cine play (the depth pass raster + the
   *  per-fragment sample cost scale with it). 3072 desktop / 1536 phones. */
  shadowSize: number;
  /** multiplier on the grass LOD ring radii (FULL/LOD/CULL): 1 = the tuned
   *  desktop rings, 0.6 pulls the lush band + cull-off much closer. */
  grassRange: number;
  /** multiplier on the level's authored fog band; props fully past the fog
   *  horizon are distance-culled (invisible anyway), so this is the phone's
   *  vertex/raster budget knob — 0.6 halves the dockyard's drawn dressing. */
  drawDistance: number;
}

/** The two quality tiers as settings patches (the overlay's preset buttons
 *  apply one wholesale; DEFAULT_GRAPHICS seeds from the detected device).
 *  PHONE drops the three whole-scene multipliers a mobile GPU can't afford:
 *  the ×6 cube capture (paint falls back to the static showroom PMREM), the
 *  film-look composer (N8AO/MSAA HDR/bloom), and native-DPR fill — plus a
 *  half-res shadow map and closer grass rings. */
export const TIER_PRESETS = {
  desktop: { ao: true, reflections: true, postfx: true, renderScale: 1, shadowSize: 3072, grassRange: 1, drawDistance: 1 },
  phone: { ao: false, reflections: false, postfx: false, renderScale: 0.75, shadowSize: 1536, grassRange: 0.6, drawDistance: 0.6 },
} as const;

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  clouds: true,
  water: true,
  grass: true,
  shadows: true,
  props: true,
  stats: true,
  ...TIER_PRESETS[IS_MOBILE ? 'phone' : 'desktop'],
};
