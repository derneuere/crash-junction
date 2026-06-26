// ============================================================================
// GRASS — the FluffyGrass shader grafted onto MeshStandardMaterial.
// ============================================================================
//
// ── WHAT WE TOOK FROM FluffyGrass (shader technique) ─────────────────────────
//   Shader (ported from FluffyGrass GrassMaterial.ts):
//     * world-UV + perlin wind sway scaled by (1 - uv.y) (planted base, whippy
//       tip) + a perlin height bump that gives the field its fluffy unevenness,
//     * baseColor → tipColor vertical gradient with a per-clump noise hue mix,
//     * the alpha-mask blade silhouette (step over the mask's red channel).
//   ADAPTATION: the shader is grafted onto MeshLambert-equivalents via
//   onBeforeCompile of MeshStandardMaterial so the blades pick up THIS engine's
//   PMREM sky env + fog + the time-of-day grade (the demo is a fixed-light
//   Lambert).
//   MIT requires keeping the copyright/attribution — see public/grass/manifest.md
//   (full licence) and grass.ts's header. FluffyGrass © 2023 Ebenezer
//   (thebenezer): https://github.com/thebenezer/FluffyGrass
// ============================================================================

import * as THREE from 'three';

/** Everything buildGrass needs from the grass material: the material itself
 *  plus the live uniform objects (so the async texture swap and the time-of-day
 *  re-tint can write straight into the compiled program) and the palette base
 *  colours the time-of-day re-tint lerps from. */
export interface GrassMaterialHandle {
  mat: THREE.MeshStandardMaterial;
  /** wind clock (seconds) — update() advances this each frame */
  uTime: { value: number };
  /** overall light level on the blades (setTimeOfDay) */
  uAmbient: { value: number };
  uBaseColor: { value: THREE.Color };
  uTip1Color: { value: THREE.Color };
  uTip2Color: { value: THREE.Color };
  /** blade alpha-mask texture; null until the async assets land */
  uAlphaTex: { value: THREE.Texture | null };
  /** perlin noise texture driving wind + colour variation; null until loaded */
  uNoiseTex: { value: THREE.Texture | null };
  /** 0 until the textures land (avoid sampling null) */
  uHasTex: { value: number };
  /** palette anchors the time-of-day re-tint lerps from (un-tinted look) */
  BASE_COL: THREE.Color;
  TIP1_COL: THREE.Color;
  TIP2_COL: THREE.Color;
}

/** Build the grass blade material: a MeshStandard with the FluffyGrass gradient
 *  + alpha-mask + perlin wind spliced in via onBeforeCompile. Returns the live
 *  uniform objects so the caller can drive wind/time-of-day and swap textures
 *  in once the async assets land. */
export function makeGrassMaterial(): GrassMaterialHandle {
  // ── MATERIAL: FluffyGrass shader grafted onto MeshStandard ─────────────────
  // MeshStandard so the blades pick up the PMREM sky env + fog + shadows like
  // the textured ground; the demo's gradient + alpha-mask + wind are spliced in
  // via onBeforeCompile. Colours match the FluffyGrass palette (dark olive base
  // -> bright sage tip, with a darker variation tip mixed by noise).
  // FluffyGrass palette, lifted a touch: our scene has a BLUE hemisphere fill
  // (hemiSky ~#bfd6ff) the demo lacks, so the demo's near-black base (#313f1b)
  // got swamped by sky fill into a cyan cast on sparse/short blades. A brighter,
  // greener base keeps the green dominant everywhere while preserving the demo's
  // dark-base → bright-sage-tip gradient character.
  const BASE_COL = new THREE.Color('#42551f'); // mid olive-green planted base
  const TIP1_COL = new THREE.Color('#acd982'); // bright sage sunlit tip (demo-ish)
  const TIP2_COL = new THREE.Color('#6f9242'); // mid-green variation tip
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.35,
    transparent: false,
    shadowSide: THREE.DoubleSide,
    // The blades are lit by the PMREM sky env (so they sit in the scene), but at
    // full env intensity the BLUE sky IBL washes the green diffuse toward cyan
    // at our grazing chase-cam angle. Damp the env contribution hard so the
    // green base->tip gradient stays the dominant colour (the demo is flat
    // Lambert with no env at all; this keeps a touch of sky fill without the
    // cyan cast).
    envMapIntensity: 0.22,
  });
  // Force three to declare the generic `uv` attribute + `vUv` varying in BOTH
  // shader stages even though we set no map/alphaMap on the material. Without
  // this, USE_UV is undefined and our onBeforeCompile references to `uv.y`
  // (vertex) and `vUv` (the alpha-mask cutout, fragment) are undeclared and the
  // program fails to compile — three then silently falls back to a broken/blank
  // program. USE_UV makes `vUv = uv` available in the fragment (see three's
  // uv_pars_*/uv_vertex chunks), which is exactly the card UV the demo samples
  // its blade-silhouette alpha mask at.
  mat.defines = { ...(mat.defines ?? {}), USE_UV: '' };

  // shared uniforms — one material drives every tile mesh
  const uTime = { value: 0 };
  const uAmbient = { value: 1 };
  const uBaseColor = { value: BASE_COL.clone() };
  const uTip1Color = { value: TIP1_COL.clone() };
  const uTip2Color = { value: TIP2_COL.clone() };
  const uAlphaTex = { value: null as THREE.Texture | null };
  const uNoiseTex = { value: null as THREE.Texture | null };
  const uHasTex = { value: 0 }; // 0 until the textures land (avoid sampling null)

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uAmbient = uAmbient;
    shader.uniforms.uBaseColor = uBaseColor;
    shader.uniforms.uTip1Color = uTip1Color;
    shader.uniforms.uTip2Color = uTip2Color;
    shader.uniforms.uAlphaTex = uAlphaTex;
    shader.uniforms.uNoiseTex = uNoiseTex;
    shader.uniforms.uHasTex = uHasTex;

    // ── VERTEX: world-UV + perlin wind (ported from FluffyGrass) ───────────
    // The clump's world origin comes from the instance matrix translation. The
    // demo's wind is sin(freq · dot(windDir, globalUV) + noise.g · k + t) scaled
    // by (1 - uv.y) so the base stays planted and the tip whips, plus a perlin
    // height bump for the fluffy unevenness. We compute globalUV from the world
    // position so neighbouring clumps share the field-scale wind wave.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform sampler2D uNoiseTex;
         uniform int uHasTex;
         varying float vBladeY;   // 0 base -> 1 tip (uv.y)
         varying vec2 vGlobalUV;  // field-scale UV for the colour-variation noise`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBladeY = uv.y;
         // instance world origin (translation column of the instance matrix)
         vec3 iPos = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
         // field-scale UV: tile the noise every ~64 m of world so the wind wave
         // and colour variation read at clump-to-clump scale, like the demo.
         vGlobalUV = iPos.xz / 64.0;
         float tipFactor = uv.y; // 0 at base, 1 at tip
         if (uHasTex == 1) {
           // wind: a travelling sine across the field, jittered by the noise G
           // channel so it isn't a clean ripple; amplitude grows toward the tip.
           vec4 n = texture2D(uNoiseTex, vGlobalUV * 1.5 + uTime * 0.012);
           float wave = sin(8.0 * (iPos.x * 0.03 + iPos.z * 0.03) + n.g * 6.0 + uTime * 1.4);
           float amp = 0.22 * tipFactor;
           transformed.x += wave * amp;
           transformed.z += wave * amp * 0.7;
           // perlin height bump: makes the field fluffy/uneven (demo trick),
           // strongest at the tip so the base stays planted on the ground.
           float bump = texture2D(uNoiseTex, vGlobalUV * 2.0).r;
           transformed.y += (exp(bump) - 1.0) * 0.12 * tipFactor;
         } else {
           // pre-texture fallback: a cheap planted-base sway so it isn't static
           float wave = sin(uTime * 1.2 + iPos.x * 0.35 + iPos.z * 0.27);
           transformed.x += wave * 0.14 * tipFactor * tipFactor;
           transformed.z += wave * 0.08 * tipFactor * tipFactor;
         }`,
      );

    // ── FRAGMENT: base->tip gradient + noise variation + alpha-mask cutout ──
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uAmbient;
         uniform vec3 uBaseColor;
         uniform vec3 uTip1Color;
         uniform vec3 uTip2Color;
         uniform sampler2D uAlphaTex;
         uniform sampler2D uNoiseTex;
         uniform int uHasTex;
         varying float vBladeY;
         varying vec2 vGlobalUV;`,
      )
      // splice the alpha-mask cutout BEFORE the standard alphatest so a masked
      // texel is discarded (the wispy blade silhouette = the fluffy look). The
      // mask runs across the card's own uv; we read .r and threshold it.
      .replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
         if (uHasTex == 1) {
           float m = texture2D(uAlphaTex, vUv).r;
           if (m < 0.35) discard;
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // base->tip vertical gradient; the tip colour itself varies clump-to-
         // clump via the noise R channel (sage <-> mid-green), so the field
         // isn't one flat green. (FluffyGrass GrassMaterial.ts gradient.)
         vec3 tip = uTip1Color;
         if (uHasTex == 1) {
           float var0 = texture2D(uNoiseTex, vGlobalUV).r;
           tip = mix(uTip1Color, uTip2Color, var0);
         }
         float t = vBladeY * vBladeY; // ease so more of the blade reads tip-lit
         vec3 grass = mix(uBaseColor, tip, t);
         diffuseColor.rgb *= grass * uAmbient;`,
      );
  };
  mat.customProgramCacheKey = () => 'cj-grass-fluffy';

  return {
    mat,
    uTime,
    uAmbient,
    uBaseColor,
    uTip1Color,
    uTip2Color,
    uAlphaTex,
    uNoiseTex,
    uHasTex,
    BASE_COL,
    TIP1_COL,
    TIP2_COL,
  };
}
