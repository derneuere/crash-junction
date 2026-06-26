import * as THREE from 'three';
import type { CoastDef } from '../types';
import {
  makePatchTexture,
  makeSandGlitterTexture,
  makeSandNormalTexture,
} from '../textures';

/** Horizontal run (m) from the island rim to the waterline, per edge type.
 *  'wall' is a sheer quay face; 'cliff' leans out a touch so the rock reads
 *  as undercut water-worn stone rather than a painted wall. */
export const SKIRT_W = { beach: 18, wall: 0, cliff: 1.0, bank: 6 } as const;

/** Edge type used to index SKIRT_W (and group coast outline segments). */
export type CoastEdge = CoastDef['outline'][number]['edge'];

/** [art-sand] The ALAN-ZUCCONI SAND MATERIAL for the beach skirt.
 *
 *  Approach: MeshStandardMaterial + onBeforeCompile injection (NOT a bespoke
 *  ShaderMaterial). The scene runs day/dusk/night lighting, PMREM sky IBL,
 *  cast shadows, fog, and a post composer that flips the renderer to
 *  NoToneMapping (the composer owns tonemapping). A raw ShaderMaterial would
 *  have to re-implement every one of those to stay consistent with the grass,
 *  props and sea; onBeforeCompile lets the standard PBR path do all of it and
 *  we only ADD the three sand effects on top of the lit colour:
 *
 *   1. NORMAL-MAPPED DIFFUSE + DUNE RIPPLES — a procedural sand normalMap
 *      (textures.ts makeSandNormalTexture) carries the grain tooth and the
 *      baked wind-ripple dunes; the stock normalMap path lights them, so the
 *      sun rakes across the ripples for free (Zucconi #3 Sand Normal + #6
 *      Sand Ripples, baked into one tangent-space map).
 *   2. GLITTER / SPARKLE (the hallmark, Zucconi #5) — per-grain micro-mirror
 *      specular: sample a random unit normal G from a tiled glitter map,
 *      R = reflect(-L, G), and only facets whose reflection nearly hits the
 *      eye (RdotV within a narrow threshold) emit a bright, tiny glint. Tied
 *      to SUN INTENSITY via uGlitterSun so it reads at day and fades to almost
 *      nothing at dusk/night (no disco). https://www.alanzucconi.com/2019/10/08/journey-sand-shader-5/
 *   3. RIM / FRESNEL (Zucconi #4) — a subtle warm edge term, (1 - N·V)^p,
 *      that picks out the dune contours at grazing angles from the low camera.
 *
 *  uGlitterSun + uTime are updated every RENDER frame in onBeforeRender (the
 *  twinkle phase is performance.now — RENDER time, never sim/replay time — so
 *  determinism is untouched, same contract the foam animation uses). The sun
 *  intensity is read live off the scene's DirectionalLight, so time-of-day
 *  changes drive the sparkle without any extra wiring.
 *  https://www.alanzucconi.com/2019/10/08/journey-sand-shader-1/ (series). */
export function makeSandMaterial(scene: THREE.Scene): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: makePatchTexture('sand'),
    normalMap: makeSandNormalTexture(),
    roughness: 0.92, // dry sand is matte but not 1.0 — leave the spec a sliver
    metalness: 0.0,
    side: THREE.DoubleSide,
    vertexColors: true, // the wet/dry skirt gradient multiplies the sand map
  });
  // gentle bump: enough to catch the rake light, never embossed plastic
  mat.normalScale.set(0.55, 0.55);
  const glitterTex = makeSandGlitterTexture();
  // SUN-INTENSITY reference: full glitter at the day key (2.2), scaling down
  // with the live directional light so dusk/night sand barely twinkles.
  const DAY_SUN = 2.2;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlitterTex = { value: glitterTex };
    shader.uniforms.uGlitterSun = { value: 1 };
    shader.uniforms.uTime = { value: 0 };
    // ---- vertex: pass world position + world normal for view/rim/glitter ----
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vSandWPos;
        varying vec3 vSandWNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 sandWP = modelMatrix * vec4(transformed, 1.0);
        vSandWPos = sandWP.xyz;
        vSandWNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    // ---- fragment: add glitter + rim AFTER the standard lighting ----
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D uGlitterTex;
        uniform float uGlitterSun;
        uniform float uTime;
        varying vec3 vSandWPos;
        varying vec3 vSandWNormal;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          // world-space view + a representative sun/key direction. directionalLights[0]
          // is the scene key; fall back to a fixed up-sun if none is bound.
          vec3 V = normalize(cameraPosition - vSandWPos);
          #if NUM_DIR_LIGHTS > 0
            vec3 L = normalize(directionalLights[0].direction);
            vec3 sunCol = directionalLights[0].color;
          #else
            vec3 L = normalize(vec3(0.45, 0.78, 0.32));
            vec3 sunCol = vec3(1.0);
          #endif

          // ---- GLITTER (Zucconi #5): per-grain micro-mirror specular ----
          // Sample several offset taps so a glint lands per grain, not per
          // texel block. Animate the sample offset on RENDER time for a faint
          // twinkle as "grains" catch the light (determinism-safe).
          vec2 guv = vSandWPos.xz * 1.9; // world-locked grain field
          float glint = 0.0;
          for (int gi = 0; gi < 3; gi++) {
            vec2 off = vec2(float(gi) * 0.37, float(gi) * 0.61)
                     + vec2(sin(uTime + float(gi) * 2.1), cos(uTime * 0.8 + float(gi))) * 0.015;
            vec3 G = normalize(texture2D(uGlitterTex, guv + off).rgb * 2.0 - 1.0);
            // tilt the micro-mirror toward the surface normal so glints sit
            // on the slope, then reflect the incoming light off it
            G = normalize(mix(vSandWNormal, G, 0.7));
            vec3 R = reflect(-L, G);
            float RdotV = max(0.0, dot(R, V));
            // only near-perfect mirror alignment glints: sharp, rare, bright
            glint += pow(RdotV, 220.0);
          }
          // sparkle reads at DAY, fades with the sun toward dusk/night
          vec3 glitterColor = vec3(1.0, 0.97, 0.86) * sunCol;
          gl_FragColor.rgb += glint * 1.4 * uGlitterSun * glitterColor;

          // ---- RIM / FRESNEL (Zucconi #4): grazing-angle dune edge ----
          float rim = 1.0 - max(0.0, dot(normalize(vSandWNormal), V));
          rim = pow(rim, 4.0) * 0.16;
          // rim also leans on the sun so it doesn't glow at night
          gl_FragColor.rgb += rim * (0.4 + 0.6 * uGlitterSun) * vec3(1.0, 0.93, 0.78) * sunCol;
        }`,
      );
    mat.userData.sandShader = shader; // expose for the per-frame uniform update
  };
  // RENDER-TIME uniform pump (determinism-safe — performance.now is the wall
  // clock, this fires from a Mesh.onBeforeRender which only runs when a frame
  // is actually drawn, never on the sim/replay path, and writes only visual
  // uniform state). Reads the live sun intensity so the sparkle tracks the
  // time of day automatically. Materials have no per-frame hook, so the beach
  // meshes call this from THEIR onBeforeRender (see addBeachSkirt).
  let sun: THREE.DirectionalLight | null = null;
  mat.userData.updateGlitter = () => {
    const shader = mat.userData.sandShader as { uniforms: Record<string, { value: number }> } | undefined;
    if (!shader) return;
    if (!sun) sun = scene.getObjectByProperty('isDirectionalLight', true) as THREE.DirectionalLight | null;
    const sunInt = sun ? sun.intensity : DAY_SUN;
    // normalise to the day key and clamp so dusk's brighter low sun (sunInt 3.0
    // is a warm grazing key, not "more sparkle") still calms rather than spikes
    shader.uniforms.uGlitterSun.value = Math.min(1, sunInt / DAY_SUN);
    shader.uniforms.uTime.value = (performance.now() / 1000) % 1000;
  };
  // harmless under the daynight emissive sweep (no emissive tag) — the sparkle
  // is driven by the live sun read above instead.
  return mat;
}
