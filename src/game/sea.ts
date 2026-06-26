// THE SEA on GANTRY POINT — a single huge animated water plane.
//
// PURE VISUAL, PIN-SAFE. The physics ground is the flat y=0 plane and this
// mesh carries no collider (same contract as the old static sea). The waves
// are driven by a RENDER clock (accumulated elapsed wall time fed from the
// frame loop), NEVER sim time, so the surface animates freely during replay
// without ever entering the world hash. update() only writes float/colour/
// texture uniforms — it touches no sim state.
//
// ───────────────────────────────────────────────────────────────────────────
// ocean shader adapted from jsfiddle gz76849v
//   (https://jsfiddle.net/gz76849v/ — "Ocean Surface Simulation, Gerstner
//   Waves 3D"). It is the standard real-time ocean recipe: a sum of Gerstner
//   (trochoidal) waves with tanh crest-softening; a 5-layer domain-warped
//   simplex-noise NORMAL perturbation in the fragment shader (the dense
//   micro-ripple that kills the "plastic plane" look); Schlick fresnel;
//   cubemap sky reflection; subsurface scattering; triple-lobe sun specular;
//   and a multi-layer anisotropic foam system. Refs in the original:
//     Gerstner/normal-tangent     GPU Gems 1 ch.1; catlikecoding "Waves"
//     simplex noise               Ashima Arts (Stefan Gustavson / Ian McEwan)
//     fresnel                     Schlick 1994
// ───────────────────────────────────────────────────────────────────────────
//
// WHAT WE ADAPTED for crash-junction's pipeline (vs the standalone fiddle):
//   • REFLECTION SOURCE. The fiddle bakes its own CubeCamera off three's Sky
//     and feeds a `samplerCube`. We instead consume OUR world IBL —
//     scene.environment, the PMREM 2D texture skyenv.ts bakes from the
//     Preetham dome (a sibling SKY agent enriches it). PMREM is NOT a cube
//     map; it is sampled with three's own `textureCubeUV` decoder, so we
//     pull that ShaderChunk in and inject the CUBEUV_* / ENVMAP_TYPE_CUBE_UV
//     defines the renderer would normally add for a standard material. When
//     no env is bound yet we fall back to an analytic sky gradient built from
//     the same time-of-day palette, so the water is never black on frame 0.
//   • TIME OF DAY. uSunDirection / uSunColor and the deep / shallow / fog /
//     sky colours all come from Game's per-tod palette (setTimeOfDay), so the
//     sea reads day / dusk / night in lockstep with the dome. An ambient term
//     darkens + desaturates the body toward moonlit blue at night.
//   • AMPLITUDE BUDGET. The fiddle's waves crest several metres and add 2.2 m
//     of height noise — fine for an open-ocean orbit, but our calm waterline
//     is seaLevel −2.2 right next to a beach, and the SAND agent's foam seam
//     needs the shoreline crest sum kept MODEST (see SEA_MAX_AMPLITUDE). So
//     the Gerstner amplitudes and the vertex noise are scaled WAY down; the
//     dense look is carried by the fragment normal-perturbation (which is
//     amplitude-independent) instead of by tall geometry.
//   • PERFORMANCE. The fiddle runs a 4000×4000 plane at 512×512 and ~25
//     fragment noise fetches everywhere. We keep the 4000 m extent but at
//     256×256 (analytic + fragment normals make near detail independent of
//     tessellation), and DISTANCE-GATE the expensive fragment work: the fine
//     capillary normal layers and the foam layers fade out past the near
//     field, so far water pays only for the cheap base. One mesh, one draw
//     call, no extra passes (a planar-mirror reflection over a 4 km plane
//     would re-render the scene every frame and tank the FAST tier).
//   • FOG. Merged with three's own Fog (fog_* chunks) so the far plane
//     dissolves into the same world fog the dome and track use, instead of
//     the fiddle's standalone exp fog.
//
// ── MODULE LAYOUT (this file is a thin barrel) ───────────────────────────────
//   The implementation lives in ./sea/*; this file re-exports the public
//   surface so importers keep using "./sea" unchanged:
//     * ./sea/waves.ts          — Gerstner wave bank + SEA_MAX_AMPLITUDE budget
//     * ./sea/types.ts          — Sea handle + SeaPalette
//     * ./sea/vertexShader.ts   — Gerstner-wave vertex GLSL source
//     * ./sea/fragmentShader.ts — water fragment GLSL source
//     * ./sea/build.ts          — buildSea() + setSeaCamera()

export { SEA_MAX_AMPLITUDE } from './sea/waves';
export type { Sea, SeaPalette } from './sea/types';
export { buildSea, setSeaCamera } from './sea/build';
