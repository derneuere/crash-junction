// Volumetric raymarched cloud layer for the atmospheric sky dome (GLSL chunk).
//
// TECHNIQUE + ATTRIBUTION
// -----------------------
// A faithful technique port of Sebastian Lague's "Clouds" project
// (MIT, Copyright (c) 2019 Sebastian Lague — https://github.com/SebLague/Clouds,
// the companion repo to his "Coding Adventure: Clouds" video):
//   Assets/Scripts/Clouds/Shaders/Clouds.shader
//   Assets/Scripts/Clouds/Shaders/CloudSky.shader
//   Assets/Scripts/Clouds/Noise/Compute/NoiseGenCompute.compute (the Worley field)
// which itself credits Andrew Schneider / Guerrilla's "Nubis" Horizon-Zero-Dawn
// cloud talk (GPU Pro 7 / SIGGRAPH 2015) for the Perlin–Worley density + the
// powder/Beer lighting model.
//
// NOTE ON THE TASK REFERENCE: the prompt named SebLague/Geographical-Adventures,
// but that project ships only the atmospheric-scattering model (already ported in
// skyscatter.glsl.ts) — it has NO volumetric cloud raymarcher. The canonical
// volumetric-cloud technique (3D Worley/Perlin density, sun light-march,
// Beer–Lambert, dual-lobe Henyey–Greenstein, powder/silver-lining) lives in
// SebLague/Clouds, also MIT / Sebastian Lague, and is the source ported here.
//
// PORTED + ADAPTED (HLSL → GLSL):
// Lague's shader is a screen-space post pass that raymarches a finite world-space
// box of cloud and, at every density sample, runs a SECOND short march toward the
// sun (lightmarch) for self-shadowing, compositing col = bg·T + lightEnergy·sunCol.
// We keep that whole structure but adapt it to a background SKY DOME:
//
//   * Container : instead of a finite box at the camera, the clouds live in an
//                 infinite horizontal SLAB between two altitudes (cloudBottom..
//                 cloudTop). The view ray (from a virtual eye just under the slab)
//                 is intersected with the two horizontal planes → entry/exit dist.
//                 Flat-earth slab, so clouds naturally bunch toward the horizon
//                 and open up overhead like real cumulus. Direct port of the
//                 rayBoxDst → entry/exit + while(dst<limit) march, minus depth.
//   * Density   : sampleDensity() ported verbatim in spirit — a base SHAPE fbm
//                 (an inverted-Worley/Perlin-Worley analog, since we have no
//                 precomputed 3D NoiseTex), gated by Lague's height gradient
//                 (gMin/gMax remaps → flat-bottomed, rounded-top cumulus) and
//                 eroded at the edges by a DETAIL Worley fbm weighted by
//                 (1-shape)^3 (his detailErodeWeight → cauliflower billows).
//   * Lighting  : lightmarch() ported — numStepsLight samples toward the sun,
//                 accumulate density, Beer's law exp(-d·lightAbsorptionTowardSun),
//                 floored at darknessThreshold so shadowed cloud never goes black.
//   * Phase     : phase() ported verbatim — dual-lobe HG (forward lobe = the
//                 silver lining toward the sun, back lobe = soft fill) with
//                 Lague's phaseParams bias+scale.
//   * Powder    : Schneider's powder term (1 - exp(-2·density)) multiplies the
//                 in-scatter so the cloud's lit edges get the dark-rim "powder"
//                 sugar look — the cue that sells fluffy cumulus.
//   * Drift     : Lague scrolls the noise sample positions by _Time. Because we
//                 BAKE the field once per tod (see PERFORMANCE below), the bake
//                 itself is static; the sense of motion is instead a slow scroll
//                 of the dome's equirect LOOKUP (uCloudDrift, RENDER clock) —
//                 cheaper than re-marching and still never touches sim state.
//
// COLOUR / TIME-OF-DAY: clouds are lit by the SAME uSunTint·uSunIntensity the
// dome's sun disc uses (warm gold at dusk, zero at night) and filled by an
// ambient sky tint (uCloudTint) toward the zenith, so they inherit the per-tod
// palette for free: bright-white sunlit tops by day, warm rims at dusk, dark
// blue-grey moonlit silhouettes at night. No new palette contract.
//
// BLOOM SAFETY: the composer's bloom trues HDR hotspots near luminance 1.4
// (postfx.ts). lightEnergy·sunCol is capped (CLOUD_LIGHT_MAX) so a sunlit cloud
// reads bright but never blooms into a white blob; only the thin sun-struck
// silver lining is allowed to approach the cap.
//
// PERFORMANCE — PRERENDERED CLOUD BAKE (this is the win):
// The raymarch is HEAVY by nature (view march × per-step sun light-march ×
// procedural 3D noise) AND the clouds are distant sky-dome geometry that barely
// changes frame-to-frame. So instead of marching every frame, we BAKE the whole
// cloud layer ONCE per time-of-day into a high-res EQUIRECTANGULAR texture
// (skyenv.ts cloudBake()): the march runs over a 2048×1024 lat/long panorama,
// many steps, NO jitter → a clean, full-res, correctly-lit cloud field. The live
// sky dome then just SAMPLES that texture by view direction (dirToEquirectUv +
// one texture2D) and composites premultiplied-over — a texture fetch, not a
// raymarch. The bake is camera-independent (clouds are at infinity), so the same
// panorama serves every frame and every camera angle; it is re-baked only when
// the time of day changes (3 states), exactly where skyRig already re-bakes the
// PMREM env. Result: full-res quality (no half-res shimmer, no jitter grain) at
// near-zero per-frame cost.
//
// DRIFT: a static bake would freeze the clouds, so the dome scrolls the equirect
// lookup by a slow azimuth offset (uCloudDrift, RENDER-clock driven) — a free
// sense of motion without re-marching or re-baking. Subtle, like distant cumulus.
//
// The bake march (cloudMarchRGBA) takes its step count as a uniform (uViewSteps/
// uLightSteps) so the same code serves a HIGH-quality bake and any cheap inline
// fallback; the bake path sets uCloudBake=1 to drop the dither jitter entirely.
//
// DETERMINISM: visual-only. uCloudDrift is driven off RENDER time (Game's af.dt),
// never sim time — same pin-safe contract as the sea/grass animation. The bake
// runs on tod change (also render-time), never inside the sim/replay loop.

// This file is a thin barrel. The volumetric-cloud GLSL was split into cohesive
// sub-chunks under ./skyclouds.glsl/ to keep every module small; the public
// surface (SKY_CLOUDS, CLOUD_BAKE_VERT, CLOUD_BAKE_FRAG) is unchanged and still
// imported from this same path. SKY_CLOUDS is recomposed byte-identically in
// ./skyclouds.glsl/sky-clouds.ts (see that file for the concatenation proof).
export { SKY_CLOUDS } from './skyclouds.glsl/sky-clouds';
export { CLOUD_BAKE_VERT, CLOUD_BAKE_FRAG } from './skyclouds.glsl/bake.glsl';
