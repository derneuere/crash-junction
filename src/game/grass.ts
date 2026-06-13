import * as THREE from 'three';
import { hash01 } from './textures';

// ============================================================================
// INSTANCED 3D-BLADE GRASS — the beach-approach dune lip (GANTRY POINT).
// ============================================================================
//
// Round-2 upgrade of the round-1 grass: the textured island-grass ground +
// the alpha-tongue dune fringe (both in environment.ts) stay as the BASE; this
// module AUGMENTS them with a field of real 3D blades that sit ON the grass and
// sway in the wind, then THIN into the sand at the dune lip so the lawn looks
// like it dissolves into the beach in blades, not at a polygon seam.
//
// TECHNIQUE — adapted from FluffyGrass by Ebenezer (MIT):
//   https://github.com/thebenezer/FluffyGrass
//   The blade approach, the vertex-shader wind sway (a noise-perturbed sine
//   that scales by (1 - uv.y) so the base stays planted while the tip whips),
//   and the base->tip colour gradient are adapted from that project's
//   GrassMaterial.ts. We do NOT port its code verbatim: the blade geometry is
//   built procedurally here (FluffyGrass loads a GLB LOD), placement is a
//   bounded deterministic-hash scatter (FluffyGrass uses MeshSurfaceSampler),
//   and the material is grafted onto MeshStandardMaterial (FluffyGrass uses
//   Lambert) so the blades catch this engine's PMREM sky env + fog + shadows.
//   MIT requires keeping the copyright/attribution — see this comment + the
//   art-grass report. License text: _ref/FluffyGrass/LICENSE (not committed).
//
// PIN-SAFE / VISUAL ONLY: blades are placed at BUILD TIME (deterministic hash),
// carry NO collider, and the wind animates off a RENDER-time clock (the same
// pin-safe pattern as sea.ts — update(dt) only writes a float uniform, never
// reads sim state). Nothing here enters the world hash.
//
// ── PERF STRATEGY (critical — a 500 m island of blades is ruinous) ──────────
//   * BOUNDED BAND: blades only cover the SW beach-approach grass band that the
//     locked `grass-sand` refshot pose actually frames (BAND below), NOT the
//     whole island. Everything outside the band keeps the textured ground.
//   * ONE InstancedMesh = ONE draw call. Wind is entirely in the vertex shader
//     (zero CPU per blade per frame); placement is build-time only.
//   * DENSITY FALLOFF + cull: instances are rejected (scaled to zero, parked
//     far below ground) outside the band and past the dune lip, and biased
//     DENSER toward the camera; blades shrink + drop out approaching the sand.
//   * TIER GATE: CINE gets the full blade budget; FAST gets a sparse subset
//     (BUDGET.fast) so the cheap tier leans on the textured-ground fallback.
//     setTier() just flips InstancedMesh.count — no re-alloc, no re-place.
//   * frustumCulled stays on: when the band is off-camera the whole mesh is
//     skipped by three's frustum test.
// ============================================================================

/** Bounded grass band on the SW dune approach (world metres). Sized to the
 *  locked grass-sand pose: foreground green lawn on the LEFT thinning through
 *  the drygrass dune band into the dry-sand apron. We only scatter blades that
 *  land in this rectangle AND on the inland (grass) side of the dune lip. */
const BAND = { minX: -262, maxX: -150, minZ: -240, maxZ: -86 } as const;

/** The dune lip runs roughly NW->SE across the band — the same polyline the
 *  beach.ts tufts/sand patch track. We thin blades toward (and a little past)
 *  it. A point's "seaward distance" is measured along the band's seaward
 *  normal from this line; positive = toward the sand. */
const LIP = [
  [-245, -90],
  [-228, -130],
  [-209, -150],
  [-190, -182],
  [-174, -204],
  [-156, -228],
  [-128, -234],
] as const;

/** Per-tier instance budgets. CINE is the cinematic look; FAST stays sparse so
 *  the textured ground carries the cheap tier. Total allocated = cine. */
const BUDGET = { cine: 24000, fast: 5000 } as const;

/** Camera anchor of the locked grass-sand pose — placement biases density
 *  toward here so the foreground (what the shot frames) is lush and the far
 *  reaches of the band stay sparse. Visual bias only, not the real camera. */
const POV = new THREE.Vector3(-198, 8, -120);

/** Signed seaward distance (m) of (x,z) from the dune lip polyline. Negative =
 *  inland on the grass; positive = out onto the sand. Used to keep blades on
 *  the grass and thin them across the lip. */
function seawardDist(x: number, z: number): number {
  // nearest segment of the lip, then signed perpendicular distance using the
  // band's seaward normal (the lip trends NW->SE; sand is to the SW/down-z).
  let best = Infinity;
  let bestSigned = 0;
  for (let i = 0; i < LIP.length - 1; i++) {
    const ax = LIP[i][0];
    const az = LIP[i][1];
    const bx = LIP[i + 1][0];
    const bz = LIP[i + 1][1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      // seaward normal of this segment: rotate the along-lip dir so it points
      // toward the sand (down-left in world == more negative x & z). The lip
      // is authored W->E along the array, so (dz,-dx) points seaward here.
      const nlen = Math.hypot(dz, dx) || 1;
      const nx = dz / nlen;
      const nz = -dx / nlen;
      bestSigned = (x - px) * nx + (z - pz) * nz;
    }
  }
  return bestSigned;
}

/** Build ONE tapered grass blade as a thin vertical strip. uv.y runs 0 at the
 *  base (planted) -> 1 at the tip (where the wind sway is full and the colour
 *  is lightest). A handful of height segments keeps the wind bend smooth. The
 *  blade narrows to a point so the silhouette reads as grass, not a quad. */
function makeBladeGeometry(): THREE.BufferGeometry {
  const SEGMENTS = 4;
  const HEIGHT = 1; // unit blade; per-instance scale sizes it in metres
  const HALF_W = 0.07; // base half-width (m at unit scale) — fuller silhouette
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s <= SEGMENTS; s++) {
    const v = s / SEGMENTS;
    const y = v * HEIGHT;
    // taper to a point; a gentle curve keeps a little width up high so mid
    // blade isn't a needle, then pinches at the very tip
    const w = HALF_W * (1 - v) * (1 - v * 0.25);
    // left, right
    pos.push(-w, y, 0, w, y, 0);
    uv.push(0, v, 1, v);
    // face the +z hemisphere; the wind/lighting shader will treat both sides
    nrm.push(0, 0, 1, 0, 0, 1);
  }
  for (let s = 0; s < SEGMENTS; s++) {
    const a = s * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  geo.setIndex(idx);
  return geo;
}

/** Handle returned by buildGrass: the instanced mesh (already added) plus the
 *  render-loop hooks. update(dt) advances the wind clock; setTier() flips the
 *  CINE/FAST blade count; setTimeOfDay() tunes the lit base colour. */
export interface GrassField {
  mesh: THREE.InstancedMesh;
  /** @param dtSeconds elapsed RENDER time since last frame (seconds) */
  update(dtSeconds: number): void;
  /** CINE = full budget, FAST = sparse subset. Visual only. */
  setTier(gfx: 'cine' | 'fast'): void;
  /** Re-tint the blades' lit response to match the time-of-day sky. */
  setTimeOfDay(p: GrassPalette): void;
}

/** Per-time-of-day look fed from Game (mirrors the Sea palette pattern). */
export interface GrassPalette {
  /** overall light level on the blades: ~1 day, ~0.85 dusk, ~0.4 night */
  ambient: number;
  /** warm/cool ground tint pushed into the base colour (sun/sky colour) */
  tint: number;
}

/**
 * Build the instanced blade field for the SW dune approach and add it to
 * `scene`. The caller only invokes this on coast levels (the band is
 * GANTRY-specific); inland levels get no grass field.
 *
 * @param scene the world scene (its PMREM environment lights the blades)
 */
export function buildGrass(scene: THREE.Scene): GrassField {
  const geo = makeBladeGeometry();

  // Base material: MeshStandard so the blades pick up the PMREM sky env +
  // scene fog + shadows the same way the textured ground does — that's what
  // makes them sit in the lighting across day/dusk/night instead of glowing.
  // Colours match makeGrassTexture's palette so blades and ground agree.
  const BASE_COL = new THREE.Color(0x5e6d3e); // shaded planted base (matches lawn)
  const TIP_COL = new THREE.Color(0xa9bd78); // light sunlit tip
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
    transparent: false,
    shadowSide: THREE.DoubleSide,
  });

  // wind clock + per-tod tint, shared into the patched shader
  const uTime = { value: 0 };
  const uAmbient = { value: 1 };
  const uBaseColor = { value: BASE_COL.clone() };
  const uTipColor = { value: TIP_COL.clone() };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.uniforms.uAmbient = uAmbient;
    shader.uniforms.uBaseColor = uBaseColor;
    shader.uniforms.uTipColor = uTipColor;

    // ── VERTEX: wind sway (adapted from FluffyGrass GrassMaterial.ts) ──────
    // A noise-free, cheap two-frequency sine of world position + time, scaled
    // by (1 - uv.y)^? so the base is planted and the tip whips. The per-blade
    // phase comes from the instance's world x+z (decoded from instanceMatrix),
    // so neighbours sway out of step and the field shimmers like a breeze.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         varying float vHeight;
         varying float vPhase;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vHeight = uv.y;
         // instance world origin from the instance matrix translation column
         vec3 iPos = vec3(instanceMatrix[3].x, instanceMatrix[3].y, instanceMatrix[3].z);
         float phase = iPos.x * 0.35 + iPos.z * 0.27;
         vPhase = phase;
         // two crossing breezes + a faster flutter; bend scales with height so
         // the planted base stays put. (1.-uv.y) inverted -> tip moves most.
         float sway =
             sin(uTime * 1.1 + phase) * 0.85
           + sin(uTime * 2.3 + phase * 1.7) * 0.35
           + sin(uTime * 5.0 + iPos.x * 0.9) * 0.12;
         float bend = uv.y * uv.y; // 0 at base -> 1 at tip
         transformed.x += sway * 0.13 * bend;
         transformed.z += sway * 0.08 * bend;
         // a touch of vertical droop as the blade leans, so tall blades don't
         // stretch unnaturally when they whip
         transformed.y -= abs(sway) * 0.03 * bend;`,
      );

    // ── FRAGMENT: base->tip colour gradient + tod tint ────────────────────
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uAmbient;
         uniform vec3 uBaseColor;
         uniform vec3 uTipColor;
         varying float vHeight;
         varying float vPhase;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // dark planted base -> light sunlit tip, with a per-blade hue jitter
         // (from the instance phase) so the field isn't one flat green
         float jitter = sin(vPhase * 3.7) * 0.5 + 0.5;
         vec3 tip = mix(uTipColor, uTipColor * 0.78, jitter);
         vec3 grass = mix(uBaseColor, tip, vHeight * vHeight);
         diffuseColor.rgb *= grass * uAmbient;`,
      );
  };
  // a stable cache key so three doesn't think every blade mesh is a new program
  mat.customProgramCacheKey = () => 'cj-grass-blade';

  const mesh = new THREE.InstancedMesh(geo, mat, BUDGET.cine);
  mesh.castShadow = false; // self-shadowing thousands of blades is a perf trap
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  mesh.name = 'cj-grass-blades';

  // ── PLACEMENT (build-time, deterministic hash) ─────────────────────────
  // Walk the bounded band, scatter candidate blades, keep the ones that land
  // on the grass side of the dune lip. Density falls off with seaward distance
  // (thinning into the sand) and with distance from the POV (foreground lush,
  // background sparse). Rejected slots are parked far below ground at zero
  // scale so they never draw.
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const pos = new THREE.Vector3();
  let placed = 0;
  // oversample the band, accept by probability — gives organic clumping
  for (let i = 0; placed < BUDGET.cine && i < BUDGET.cine * 4; i++) {
    const rx = hash01(i * 2.0 + 11.3);
    const rz = hash01(i * 2.0 + 91.7);
    const x = BAND.minX + rx * (BAND.maxX - BAND.minX);
    const z = BAND.minZ + rz * (BAND.maxZ - BAND.minZ);

    // dune-lip gate: keep blades inland (sd < 0) and let a few finger a metre
    // or two onto the sand (sd up to ~+2) where they thin to nothing.
    const sd = seawardDist(x, z);
    // probability 1 well inland, ramping to 0 a couple metres onto the sand
    const lipKeep = sd < -4 ? 1 : sd > 2 ? 0 : (2 - sd) / 6;

    // POV falloff: lush within ~60 m of the framed foreground, sparse past
    // ~130 m, so the band's far end barely seeds blades.
    const dPov = Math.hypot(x - POV.x, z - POV.z);
    const povKeep = dPov < 60 ? 1 : dPov > 130 ? 0.12 : 1 - ((dPov - 60) / 70) * 0.88;

    const keep = lipKeep * povKeep;
    if (hash01(i * 2.0 + 333.1) > keep) continue;

    // size: taller/lusher inland, shrinking as it nears the sand so the
    // transition reads as the lawn thinning out, not a hard edge
    const thin = Math.max(0, Math.min(1, (sd + 4) / 6)); // 0 inland -> 1 at lip
    const baseH = 0.55 + hash01(i * 3.0 + 7.1) * 0.7; // 0.55..1.25 m tall
    const h = baseH * (1 - thin * 0.55);
    const w = 0.8 + hash01(i * 3.0 + 51.9) * 0.6; // width jitter
    s.set(w, h, 1);

    pos.set(x, 0, z);
    const yaw = hash01(i * 3.0 + 13.7) * Math.PI * 2;
    q.setFromAxisAngle(yAxis, yaw);
    m.compose(pos, q, s);
    mesh.setMatrixAt(placed, m);
    placed++;
  }
  // any unfilled tail (shouldn't happen, but be safe) -> zero-scale, buried
  m.compose(new THREE.Vector3(0, -1000, 0), q, new THREE.Vector3(0, 0, 0));
  for (let i = placed; i < BUDGET.cine; i++) mesh.setMatrixAt(i, m);
  mesh.instanceMatrix.needsUpdate = true;

  // FAST budget is a sparse contiguous prefix of the same buffer; because
  // placement is interleaved hash (not sorted), the prefix is itself a
  // well-spread subset — no separate placement pass needed.
  const cineCount = placed;
  const fastCount = Math.min(placed, BUDGET.fast);
  mesh.count = cineCount;

  scene.add(mesh);

  return {
    mesh,
    update(dt) {
      uTime.value += dt;
    },
    setTier(gfx) {
      mesh.count = gfx === 'fast' ? fastCount : cineCount;
    },
    setTimeOfDay(p) {
      uAmbient.value = p.ambient;
      // nudge the base toward the sky/sun tint so dusk warms and night cools
      const t = new THREE.Color(p.tint);
      uBaseColor.value.copy(BASE_COL).lerp(t, 0.12);
      uTipColor.value.copy(TIP_COL).lerp(t, 0.08);
    },
  };
}
