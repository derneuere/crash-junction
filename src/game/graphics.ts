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
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  clouds: true,
  water: true,
  grass: true,
  ao: true,
  reflections: true,
  shadows: true,
  props: true,
  stats: true,
};
