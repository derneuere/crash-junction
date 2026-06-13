import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { CoastDef, LevelDef, RaceWaypoint } from './types';
import { GROUP_DECOR, type PhysicsContext } from './physics';
import { buildOpenSections, SHORTCUT_SPACING } from './race';
import {
  hash01,
  makeChainLinkTexture,
  makeChevronTexture,
  makeDuneBlendTexture,
  makeFoamTexture,
  makeGrassTexture,
  makePatchTexture,
  makeQuayTexture,
  makeSandGlitterTexture,
  makeSandNormalTexture,
  makeWetSandTexture,
  makeWindowTextures,
  type PatchKind,
} from './textures';
import type { HeightSampler } from './suspension';
import { buildSea, SEA_MAX_AMPLITUDE, type Sea } from './sea';
import { applyBakedAO } from './ao';

// Z-ORDER CONTRACT for coplanar ground paint (the camera never goes under
// the road, so tiny y offsets beat polygonOffset): grass/island ground 0 →
// ground patches 0.006 (GroundPatchDef default) → shortcut ribbons 0.010 →
// main race ribbon 0.012 → decals 0.014 → centre dashes / stripes 0.015.
// New paint must keep to its slot or the junction overlaps will shimmer.

// ---- the road-base elevation field (elevation.md Phase 1) ----
// Full elevation holds across the corridor plus a shoulder (the walls and
// posts at halfW+1.65 must stand on the plateau, not its slope), then an
// embankment fade back to grade. The doc's bounds: fade ≥ 15 m at ≤ ~25%
// slope — 6 m over 26 m ≈ 23%, gentler than ANY feature skirt today (the
// ramp side-skirt is 220%/m). Every number here is a SIM tunable: the
// sampler feeds physics, so retuning either repeats the determinism bill.
const ROAD_SHOULDER = 3.5; // m past the ribbon edge at full elevation
const EMBANKMENT_FADE = 26; // m from the shoulder back down to grade

/** One straight run of elevated road centreline between two sections. */
interface ElevSeg {
  ax: number;
  az: number;
  ux: number; // unit a→b
  uz: number;
  len: number;
  ay: number; // elevation at the a/b ends
  by: number;
  plateau: number; // halfW + shoulder for this chain
  minX: number; // influence bounds (plateau + fade inflated)
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Vertical height field for the suspension rays, decomposed per the
 *  HeightSampler contract (suspension.ts): a smooth road-grade BASE from
 *  the race section chains, plus launchable FEATURES — ramp wedges and the
 *  0.16 m sidewalk plinths — stacked on top. The chassis box ignores all
 *  of it (GROUP_DECOR filtering) — the springs are the only thing that
 *  touches it, so jumps and kerb hops are pure suspension + ballistics.
 *
 *  Determinism: on a track with no elevation profile the segment list is
 *  EMPTY, base() returns literal 0 and total degenerates to the feature
 *  loops alone — bit-identical to the pre-elevation sampler on every flat
 *  level (the two replay pins prove it). The field history of this engine
 *  is one long fight against edges: the base field adds NO new edges, only
 *  C0-continuous grades with a linear lateral fade. */
export function makeHeightSampler(level: LevelDef): HeightSampler {
  const ramps = level.ramps;
  const slabs = level.buildings;
  const feature = (x: number, z: number): number => {
    let h = 0;
    for (const r of ramps) {
      // lateral skirt: the wedge fades out over a metre past its edge, so
      // clipping a ramp side rides up like a steep kerb instead of the
      // height field teleporting a wheel a metre into the air
      const lat = Math.abs(x - r.x) - r.width / 2;
      if (lat > 1) continue;
      const t = (z - r.zStart) / r.length;
      if (t < 0 || t > 1) continue;
      h = Math.max(h, r.height * t * (lat <= 0 ? 1 : 1 - lat));
    }
    for (const s of slabs) {
      // plinth edge blends over 0.35 m — the springs walk up it smoothly
      const edge = Math.max(Math.abs(x - s.x), Math.abs(z - s.z)) - 7;
      if (edge < 0.35) h = Math.max(h, 0.16 * (edge <= 0 ? 1 : 1 - edge / 0.35));
    }
    return h;
  };

  // collect the elevated centreline segments — section pairs where either
  // end carries height — from the main loop and every shortcut chain
  const segs: ElevSeg[] = [];
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  if (race) {
    const collect = (chain: { x: number; z: number; y: number }[], halfW: number, closed: boolean): void => {
      const plateau = halfW + ROAD_SHOULDER;
      const reach = plateau + EMBANKMENT_FADE;
      const last = closed ? chain.length : chain.length - 1;
      for (let i = 0; i < last; i++) {
        const a = chain[i];
        const b = chain[(i + 1) % chain.length];
        if (a.y <= 0 && b.y <= 0) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        segs.push({
          ax: a.x, az: a.z, ux: dx / len, uz: dz / len, len, ay: a.y, by: b.y, plateau,
          minX: Math.min(a.x, b.x) - reach, maxX: Math.max(a.x, b.x) + reach,
          minZ: Math.min(a.z, b.z) - reach, maxZ: Math.max(a.z, b.z) + reach,
        });
      }
    };
    collect(race.sections, race.width / 2, true);
    for (const sc of race.shortcuts ?? []) {
      collect(buildOpenSections(sc.waypoints, SHORTCUT_SPACING), sc.width / 2, false);
    }
  }

  if (segs.length === 0) {
    // flat level: total IS the feature field, base is the constant 0 —
    // not just equivalent but the same float ops as before the decompose
    return Object.assign((x: number, z: number) => feature(x, z), { base: () => 0, feature });
  }

  let gMinX = Infinity;
  let gMaxX = -Infinity;
  let gMinZ = Infinity;
  let gMaxZ = -Infinity;
  for (const s of segs) {
    gMinX = Math.min(gMinX, s.minX);
    gMaxX = Math.max(gMaxX, s.maxX);
    gMinZ = Math.min(gMinZ, s.minZ);
    gMaxZ = Math.max(gMaxZ, s.maxZ);
  }
  const base = (x: number, z: number): number => {
    if (x < gMinX || x > gMaxX || z < gMinZ || z > gMaxZ) return 0;
    let e = 0;
    for (const s of segs) {
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      // nearest point on the segment; elevation lerps along it. Adjacent
      // segments share endpoints, so the max over segments is continuous
      // along the chain, and the end-clamp rounds the span ends radially.
      const px = x - s.ax;
      const pz = z - s.az;
      let t = px * s.ux + pz * s.uz;
      t = t < 0 ? 0 : t > s.len ? s.len : t;
      const d = Math.hypot(px - s.ux * t, pz - s.uz * t);
      if (d >= s.plateau + EMBANKMENT_FADE) continue;
      const h = s.ay + ((s.by - s.ay) * t) / s.len;
      const c = d <= s.plateau ? h : h * (1 - (d - s.plateau) / EMBANKMENT_FADE);
      if (c > e) e = c;
    }
    return e;
  };
  return Object.assign((x: number, z: number) => base(x, z) + feature(x, z), { base, feature });
}

/** Painted ground rectangles, one InstancedMesh per color. The road dashes
 *  and checkpoint stripes are all the default off-white, so the existing
 *  call sites still cost a single draw; level decals (DecalDef) ride the
 *  same path with their own colors and a lower y slot. Marks on the
 *  elevated north arc carry their own y (road elevation + slot) and a
 *  pitch about their length axis so a dash lies ON the grade instead of
 *  spearing through it — the coplanar z-order contract above only ever
 *  applied to the flat zones, which pass neither field and stay put. */
function addMarkInstances(
  scene: THREE.Scene,
  marks: { x: number; z: number; w: number; l: number; yaw: number; color?: number; y?: number; pitch?: number }[],
  y = 0.015,
): void {
  const groups = new Map<number, typeof marks>();
  for (const mk of marks) {
    const key = mk.color ?? 0xd9dde2;
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(mk);
  }
  const mGeo = new THREE.PlaneGeometry(1, 1);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  for (const [color, mine] of groups) {
    const mMat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
    const inst = new THREE.InstancedMesh(mGeo, mMat, mine.length);
    mine.forEach((mk, i) => {
      e.set(-Math.PI / 2 + (mk.pitch ?? 0), mk.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      s.set(mk.w, mk.l, 1);
      m4.compose(new THREE.Vector3(mk.x, mk.y ?? y, mk.z), q, s);
      inst.setMatrixAt(i, m4);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.receiveShadow = true;
    scene.add(inst);
  }
}

/** Road ribbon for a section chain: a triangle strip between the left and
 *  right edges of every section. Closed chains (the main loop) wrap the
 *  seam; open chains (shortcut branches) just end at their last section.
 *  Each row rides its section's road elevation plus the z-order slot, so
 *  the strip IS the visual of the suspension base field's corridor. */
function addRibbon(
  scene: THREE.Scene,
  secs: { x: number; z: number; y: number; dirX: number; dirZ: number }[],
  width: number,
  y: number,
  color: number,
  closed: boolean,
): void {
  const w2 = width / 2;
  const N = secs.length;
  const rows = closed ? N + 1 : N;
  const pos = new Float32Array(rows * 2 * 3);
  for (let i = 0; i < rows; i++) {
    const s = secs[i % N];
    const o = i * 6;
    pos[o] = s.x - s.dirZ * w2;
    pos[o + 1] = s.y + y;
    pos[o + 2] = s.z + s.dirX * w2;
    pos[o + 3] = s.x + s.dirZ * w2;
    pos[o + 4] = s.y + y;
    pos[o + 5] = s.z - s.dirX * w2;
  }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const ribbon = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.95, side: THREE.DoubleSide }),
  );
  ribbon.receiveShadow = true;
  scene.add(ribbon);
}

/** Horizontal run (m) from the island rim to the waterline, per edge type.
 *  'wall' is a sheer quay face; 'cliff' leans out a touch so the rock reads
 *  as undercut water-worn stone rather than a painted wall. */
const SKIRT_W = { beach: 18, wall: 0, cliff: 1.0, bank: 6 } as const;

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
function makeSandMaterial(scene: THREE.Scene): THREE.MeshStandardMaterial {
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

/** Island silhouette + sea + coastline skirts (LevelDef.coast). ALL VISUAL:
 *  the physics ground stays the flat y=0 plane out to infinity, so a car
 *  carried past the rim hovers over the water until the off-track rescue
 *  collects it — the accepted arcade tradeoff documented on CoastDef.
 *  Returns the animated-sea handle so the frame loop can drive its waves. */
function buildCoast(scene: THREE.Scene, coast: CoastDef): Sea {
  const o = coast.outline;
  const n = o.length;
  const sea = coast.seaLevel;
  const depth = Math.max(0.5, -sea);
  // every skirt overshoots the waterline along its own slope; the opaque
  // sea hides the hem, so type transitions never flash a raw edge
  const BOT = sea - 1.2;
  const botF = (depth + 1.2) / depth;

  // island ground: the outline polygon replaces the auto-sized grass
  // square. Shape space (x, -z) lands back on world (x, z) under the same
  // rotation.x = -PI/2 the plane ground uses.
  // [art-grass-sand] Textured lawn instead of the old flat 0x59614f fill:
  // ShapeGeometry UVs are raw shape coords (= world metres), so the repeat
  // alone world-tiles the grass seamlessly across the whole island — same
  // (x,−z) rule the ground patches use. A faint base tint keeps the lit
  // material grounded under the Preetham sky; the map carries the variation.
  const grassTex = makeGrassTexture();
  grassTex.repeat.setScalar(1 / 7); // ~7 m tile: clumps read as metres of meadow
  const island = new THREE.Mesh(
    new THREE.ShapeGeometry(new THREE.Shape(o.map((p) => new THREE.Vector2(p.x, -p.z)))),
    new THREE.MeshStandardMaterial({ map: grassTex, color: 0xdfe2d2, roughness: 1 }),
  );
  island.rotation.x = -Math.PI / 2;
  island.receiveShadow = true;
  scene.add(island);

  // ── SEA SEAM (art-ocean) ───────────────────────────────────────────────
  // The old static blue-green plane with baked whitecaps lived here. It is
  // now an ANIMATED ocean built in sea.ts: a 12-wave Gerstner body with
  // tanh-softened crests, a 5-layer domain-warped fragment NORMAL perturbation
  // (the dense micro-ripple), Schlick fresnel, PMREM sky reflection from OUR
  // scene.environment, subsurface scatter, triple-lobe sun specular and a
  // multi-layer foam system — still a pure-visual backdrop with no collider.
  // seaLevel is UNCHANGED at -2.2; max wave amplitude at the shoreline is
  // SEA_MAX_AMPLITUDE (~0.29 m), so the foam strip below (riding sea + 0.04)
  // still sits clear of the crests. The returned handle's update() is driven
  // from the render loop (Game.ts), off RENDER time — pin-safe.
  const seaHandle = buildSea(scene, sea);
  // ───────────────────────────────────────────────────────────────────────

  // per-segment outward normals — the shoelace sign makes the offset robust
  // to either winding even though the CoastDef contract says CCW
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = o[i];
    const b = o[(i + 1) % n];
    area2 += a.x * b.z - b.x * a.z;
  }
  const sgn = area2 > 0 ? 1 : -1;
  const segOut: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = o[i];
    const b = o[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    segOut.push({ x: (sgn * (b.z - a.z)) / l, z: (-sgn * (b.x - a.x)) / l });
  }

  // per-vertex mitred outward (capped so hairpins don't explode) and skirt
  // width averaged across the two adjacent segments: where a beach meets a
  // quay the sand pinches out against the concrete instead of tearing a
  // hole in the ring
  const vOut: { x: number; z: number }[] = [];
  const vW: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = segOut[(i - 1 + n) % n];
    const c = segOut[i];
    let mx = p.x + c.x;
    let mz = p.z + c.z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) {
      mx = c.x;
      mz = c.z;
    } else {
      const scale = Math.min(2, 1 / Math.max(0.5, (mx / ml) * c.x + (mz / ml) * c.z));
      mx = (mx / ml) * scale;
      mz = (mz / ml) * scale;
    }
    vOut.push({ x: mx, z: mz });
    vW.push((SKIRT_W[o[(i - 1 + n) % n].edge] + SKIRT_W[o[i].edge]) / 2);
  }

  // group consecutive same-edge segments into runs; starting at a type
  // change keeps a run from straddling the array seam (all one type = a
  // single closed run around the whole island)
  let start = 0;
  for (let i = 1; i < n; i++) {
    if (o[i].edge !== o[0].edge) {
      start = i;
      break;
    }
  }
  const runs: { edge: CoastDef['outline'][number]['edge']; segs: number[] }[] = [];
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const last = runs[runs.length - 1];
    if (last && last.edge === o[i].edge) last.segs.push(i);
    else runs.push({ edge: o[i].edge, segs: [i] });
  }

  // a simple skirt: one quad strip from the rim (y 0, or the vertex's
  // authored rim elevation along an elevated road) down past the
  // waterline. Adjacent runs share their boundary columns bit-for-bit (same
  // mitred outward, same averaged width), so the ring stays watertight.
  const addFlatSkirt = (segs: number[], mat: THREE.Material, tile: number): void => {
    const cols = segs.length + 1; // closed runs just duplicate the seam column
    const pos = new Float32Array(cols * 6);
    const uv = new Float32Array(cols * 4);
    let u = 0;
    for (let c = 0; c < cols; c++) {
      const vi = (segs[0] + c) % n;
      if (c > 0) {
        const pv = (segs[0] + c - 1) % n;
        u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / tile;
      }
      const k = c * 6;
      pos[k] = o[vi].x;
      pos[k + 1] = o[vi].y ?? 0;
      pos[k + 2] = o[vi].z;
      pos[k + 3] = o[vi].x + vOut[vi].x * vW[vi] * botF;
      pos[k + 4] = BOT;
      pos[k + 5] = o[vi].z + vOut[vi].z * vW[vi] * botF;
      uv[c * 4] = u;
      uv[c * 4 + 1] = 0;
      uv[c * 4 + 2] = u;
      uv[c * 4 + 3] = 1;
    }
    const idx: number[] = [];
    for (let c = 0; c < cols - 1; c++) {
      const a = c * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    scene.add(mesh);
  };

  // BEACH skirt (replaces addFlatSkirt for 'beach' runs): the sand slope from
  // the dune rim down past the waterline, but multi-row and shaded as a real
  // shoreline instead of one flat sand sheet. A WET/DRY gradient bakes into
  // the vertex colours — pale dry sand high up darkens through a damp band to
  // the wet, water-soaked sand at the toe (the swash zone) — and a separate
  // low-roughness WET-SAND overlay covers the splash zone so the PMREM sky
  // gives it a sheen the matte dry sand never gets. The wet read is the key
  // shoreline cue: dry → damp → wet → foam → sea, never a hard cut edge.
  //   wet/dry darkening + alpha-blended wet zone: Cyanilux shoreline
  //   breakdown; smoother low-noise wet sand + drag: 80.lv Substance study.
  const ROWS_BEACH = 7;
  const dryHi = new THREE.Color(0xe6d2a8); // sun-bleached dry sand crest
  const dryLo = new THREE.Color(0xcbb488); // dry sand toward the damp line
  const dampC = new THREE.Color(0x9a8763); // the damp transition band
  const wetC = new THREE.Color(0x6f6045); // dark water-soaked sand at the swash
  const addBeachSkirt = (segs: number[], dryMat: THREE.Material): void => {
    // SEAM CONTRACT: the wet/damp bands + sheen are placed in v relative to
    // the CURRENT seaLevel (sea, from CoastDef) and the swash REACH — how far
    // up the slope spent waves still wet the sand. A flat beach's swash runs
    // metres past the still waterline, so the damp band is anchored well
    // ABOVE sea (SWASH_HI), not at a thin wave-amplitude sliver, or it
    // foreshortens to nothing from a low camera. The water sibling owns the
    // real sea surface + wave height; from this worktree we anchor to the
    // current sea. MERGE: if the water agent's wave amplitude differs,
    // retune SWASH_HI / the heights below so the wet sand tracks their crest.
    const SWASH_HI = 1.7; // metres above sea the damp sand reaches (swash run-up)
    const cols = segs.length + 1;
    const pos = new Float32Array(cols * ROWS_BEACH * 3);
    const uv = new Float32Array(cols * ROWS_BEACH * 2);
    const col = new Float32Array(cols * ROWS_BEACH * 3);
    const tmp = new THREE.Color();
    let u = 0;
    for (let c = 0; c < cols; c++) {
      const vi = (segs[0] + c) % n;
      if (c > 0) {
        const pv = (segs[0] + c - 1) % n;
        u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 7;
      }
      const rimY = o[vi].y ?? 0;
      const topX = o[vi].x;
      const topZ = o[vi].z;
      const dx = vOut[vi].x * vW[vi] * botF;
      const dz = vOut[vi].z * vW[vi] * botF;
      // v fraction (0 rim → 1 toe) where the slope crosses a given height
      const fAt = (h: number) => Math.min(1, Math.max(0, (rimY - h) / Math.max(0.01, rimY - BOT)));
      const fDamp = fAt(sea + SWASH_HI); // top of the damp band (swash run-up)
      const fSea = fAt(sea); // the waterline itself
      for (let r = 0; r < ROWS_BEACH; r++) {
        const t = r / (ROWS_BEACH - 1);
        const k = (c * ROWS_BEACH + r) * 3;
        pos[k] = topX + dx * t;
        pos[k + 1] = rimY + (BOT - rimY) * t;
        pos[k + 2] = topZ + dz * t;
        uv[(c * ROWS_BEACH + r) * 2] = u;
        uv[(c * ROWS_BEACH + r) * 2 + 1] = t;
        // colour: dry crest → dry-low → damp at the swash top → dark wet sand
        // toward the waterline → darkest underwater (hidden by the sea plane).
        // The wide damp→wet ramp is what reads as a real shoreline gradient
        // instead of a clean cut at the water's edge.
        if (t < fDamp) tmp.copy(dryHi).lerp(dryLo, t / Math.max(0.001, fDamp));
        else if (t < fSea) tmp.copy(dryLo).lerp(dampC, (t - fDamp) / Math.max(0.001, fSea - fDamp));
        else tmp.copy(dampC).lerp(wetC, Math.min(1, (t - fSea) / 0.18));
        col[k] = tmp.r;
        col[k + 1] = tmp.g;
        col[k + 2] = tmp.b;
      }
    }
    const idx: number[] = [];
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < ROWS_BEACH - 1; r++) {
        const a = c * ROWS_BEACH + r;
        const b = (c + 1) * ROWS_BEACH + r;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // dry skirt carries the sand texture, tinted by the wet/dry vertex
    // gradient (vertexColors multiplies the map) — one matte mesh, the whole
    // slope. The wet sheen rides as a thin overlay below.
    // [art-sand] use the shared Zucconi sand material directly (vertexColors
    // already on) — NOT a clone: the glitter/rim injection stores its compiled
    // shader + sun-pump on this single material instance, and a clone would
    // recompile into a second shader the per-frame uniform pump can't see.
    const mesh = new THREE.Mesh(geo, dryMat);
    mesh.receiveShadow = true;
    // RENDER-TIME glitter pump (determinism-safe — see makeSandMaterial): drive
    // the sun-tied sparkle uniforms from the mesh's own draw callback. Reads
    // performance.now + the live sun, writes only visual uniforms.
    const updateGlitter = (dryMat as THREE.Material).userData.updateGlitter as (() => void) | undefined;
    if (updateGlitter) mesh.onBeforeRender = updateGlitter;
    scene.add(mesh);

    // WET-SAND SHEEN overlay: a thin strip riding the splash zone (the
    // high-water line down to just below the waterline), a hair proud of the
    // dry slope along its surface normal so the two never z-fight. Low
    // roughness + a touch of metalness so scene.environment (the PMREM sky)
    // mirrors across it — that wet glint, brightest at a glancing angle from
    // a low camera, is what separates wet sand from a dark paint stripe. The
    // wet texture's dark base + drag arcs do the rest. Transparent with an
    // alpha that fades the sheen out toward the dry sand so there's no edge.
    // three rows down the splash zone so the sheen ramps in and back out
    // smoothly: transparent at the dry top, peak just above the waterline
    // (the still-glistening wet sand), tapering under the sea.
    const SHEEN_ROWS = 3;
    const sHeights = [sea + 1.5, sea + 0.2, sea - 0.5]; // dry edge → waterline → under
    const sAlphas = [0, 0.85, 0.4]; // fade in, peak at the wet line, fade under
    const sPos = new Float32Array(cols * SHEEN_ROWS * 3);
    const sUv = new Float32Array(cols * SHEEN_ROWS * 2);
    const sAlpha = new Float32Array(cols * SHEEN_ROWS); // per-vertex sheen alpha
    let su = 0;
    for (let c = 0; c < cols; c++) {
      const vi = (segs[0] + c) % n;
      if (c > 0) {
        const pv = (segs[0] + c - 1) % n;
        su += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 6;
      }
      const rimY = o[vi].y ?? 0;
      const dx = vOut[vi].x * vW[vi] * botF;
      const dz = vOut[vi].z * vW[vi] * botF;
      const fAt = (h: number) => Math.min(1, Math.max(0, (rimY - h) / Math.max(0.01, rimY - BOT)));
      const lift = 0.012; // proud of the slope so it wins the depth test
      for (let r = 0; r < SHEEN_ROWS; r++) {
        const t = fAt(sHeights[r]);
        const k = (c * SHEEN_ROWS + r) * 3;
        sPos[k] = o[vi].x + dx * t + vOut[vi].x * lift;
        sPos[k + 1] = rimY + (BOT - rimY) * t + lift;
        sPos[k + 2] = o[vi].z + dz * t + vOut[vi].z * lift;
        sUv[(c * SHEEN_ROWS + r) * 2] = su;
        sUv[(c * SHEEN_ROWS + r) * 2 + 1] = r / (SHEEN_ROWS - 1);
        sAlpha[c * SHEEN_ROWS + r] = sAlphas[r];
      }
    }
    const sIdx: number[] = [];
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < SHEEN_ROWS - 1; r++) {
        const a = c * SHEEN_ROWS + r;
        const b = (c + 1) * SHEEN_ROWS + r;
        sIdx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const sGeo = new THREE.BufferGeometry();
    sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    sGeo.setAttribute('uv', new THREE.BufferAttribute(sUv, 2));
    sGeo.setAttribute('alpha', new THREE.BufferAttribute(sAlpha, 1));
    sGeo.setIndex(sIdx);
    sGeo.computeVertexNormals();
    const sMat = new THREE.MeshStandardMaterial({
      map: makeWetSandTexture(),
      roughness: 0.24, // low → a crisp grazing-angle sky glint = the wet read
      metalness: 0.0, // dielectric: Fresnel rim reflection, no metallic colour cast
      envMapIntensity: 1.3,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    // per-vertex alpha fade (no shader rewrite — just feed gl_FragColor.a the
    // attribute): the sheen dissolves into the dry sand instead of edging it
    sMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'attribute float alpha;\nvarying float vAlpha;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = alpha;');
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'varying float vAlpha;\nvoid main() {')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
    };
    const sMesh = new THREE.Mesh(sGeo, sMat);
    sMesh.renderOrder = 1; // over the dry slope, under the foam
    sMesh.receiveShadow = true;
    scene.add(sMesh);
  };

  // jagged rock face: extra columns every ~7 m and four rows down the face,
  // interior vertices jittered by index-hash (stable across reloads — the
  // refshot poses depend on it). Run-boundary columns and the rim row stay
  // clean so the cliff still butts flush against its neighbours and the
  // island polygon.
  let cliffKey = 0; // deterministic jitter key, advances per column built
  const addCliffSkirt = (segs: number[]): void => {
    const closed = segs.length === n;
    interface Col {
      tx: number;
      tz: number;
      ty: number; // rim elevation (lerped between vertex rim y values)
      bx: number; // bottom offset (added to top), already botF-scaled
      bz: number;
      ox: number; // outward + along directions for jitter
      oz: number;
      ax: number;
      az: number;
      key: number;
      pinned: boolean; // run boundary — no jitter
    }
    const colList: Col[] = [];
    const pushCol = (tx: number, tz: number, ty: number, bx: number, bz: number, i: number, key: number, pinned: boolean) => {
      const l = Math.hypot(bx, bz) || 1;
      colList.push({
        tx,
        tz,
        ty,
        bx,
        bz,
        ox: bx / l,
        oz: bz / l,
        ax: -segOut[i].z,
        az: segOut[i].x,
        key,
        pinned,
      });
    };
    const firstKey = cliffKey;
    let rimMax = 0; // tallest rim in this run — drives the face row count
    for (let s = 0; s < segs.length; s++) {
      const i = segs[s];
      const j = (i + 1) % n;
      rimMax = Math.max(rimMax, o[i].y ?? 0, o[j].y ?? 0);
      const len = Math.hypot(o[j].x - o[i].x, o[j].z - o[i].z);
      const sub = Math.max(1, Math.round(len / 7));
      const bA = { x: vOut[i].x * vW[i] * botF, z: vOut[i].z * vW[i] * botF };
      const bB = { x: vOut[j].x * vW[j] * botF, z: vOut[j].z * vW[j] * botF };
      for (let k = 0; k < sub; k++) {
        const t = k / sub;
        pushCol(
          o[i].x + (o[j].x - o[i].x) * t,
          o[i].z + (o[j].z - o[i].z) * t,
          (o[i].y ?? 0) + ((o[j].y ?? 0) - (o[i].y ?? 0)) * t,
          bA.x + (bB.x - bA.x) * t,
          bA.z + (bB.z - bA.z) * t,
          i,
          cliffKey++,
          !closed && s === 0 && k === 0,
        );
      }
    }
    // terminal column: the run's last vertex — for a closed run it's the
    // seam duplicate and must reuse column 0's jitter key to stay welded
    const tail = segs[segs.length - 1];
    const tv = (tail + 1) % n;
    pushCol(
      o[tv].x,
      o[tv].z,
      o[tv].y ?? 0,
      vOut[tv].x * vW[tv] * botF,
      vOut[tv].z * vW[tv] * botF,
      tail,
      closed ? firstKey : cliffKey++,
      !closed,
    );

    // an elevated rim stretches the face from ~3.4 m to 9+ — two extra
    // jittered rows keep the rock chunky instead of stretched (Phase 0's
    // "taller cliff skirt": more rows where the drama is)
    const ROWS = rimMax > 1.5 ? 6 : 4;
    const cols = colList.length;
    const pos = new Float32Array(cols * ROWS * 3);
    const col = new Float32Array(cols * ROWS * 3);
    const rock0 = new THREE.Color(0x857f72); // weathered grey
    const rock1 = new THREE.Color(0xa08e6f); // tan strata
    const tmp = new THREE.Color();
    for (let c = 0; c < cols; c++) {
      const cc = colList[c];
      for (let r = 0; r < ROWS; r++) {
        const t = r / (ROWS - 1);
        let x = cc.tx + cc.bx * t;
        let y = cc.ty + (BOT - cc.ty) * t;
        let z = cc.tz + cc.bz * t;
        if (!cc.pinned && r > 0 && r < ROWS - 1) {
          // mid rows carry the full jitter; the rim (r 0) stays glued to
          // the island and the bottom row is underwater anyway
          const h = cc.key * 13 + r * 5;
          x += cc.ox * (hash01(h + 1) - 0.5) * 2.8 + cc.ax * (hash01(h + 3) - 0.5) * 1.8;
          z += cc.oz * (hash01(h + 1) - 0.5) * 2.8 + cc.az * (hash01(h + 3) - 0.5) * 1.8;
          y += (hash01(h + 2) - 0.5) * 0.8;
        }
        const v = (c * ROWS + r) * 3;
        pos[v] = x;
        pos[v + 1] = y;
        pos[v + 2] = z;
        const shade = 0.85 + hash01(cc.key * 13 + r * 5 + 4) * 0.3;
        tmp.copy(rock0).lerp(rock1, hash01(cc.key * 13 + r * 5 + 5)).multiplyScalar(shade);
        col[v] = tmp.r;
        col[v + 1] = tmp.g;
        col[v + 2] = tmp.b;
      }
    }
    const idx: number[] = [];
    for (let c = 0; c < cols - 1; c++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const a = c * ROWS + r;
        const b = (c + 1) * ROWS + r;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, side: THREE.DoubleSide }),
    );
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  };

  // skirt materials, built once per coast (a level has one coastline)
  // [art-sand] the dry beach skirt now carries the Alan-Zucconi sand material
  // (normal-mapped grain + dune ripples, sun-tied glitter sparkle, rim) — see
  // makeSandMaterial. Cloned per skirt in addBeachSkirt to add vertexColors.
  const beachMat = makeSandMaterial(scene);
  const quayMat = new THREE.MeshStandardMaterial({ map: makeQuayTexture(), roughness: 0.9, side: THREE.DoubleSide });
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x4f5944, roughness: 1, side: THREE.DoubleSide });
  for (const run of runs) {
    if (run.edge === 'beach') addBeachSkirt(run.segs, beachMat); // wet/dry shaded sand
    else if (run.edge === 'wall') addFlatSkirt(run.segs, quayMat, 6);
    else if (run.edge === 'bank') addFlatSkirt(run.segs, bankMat, 6);
    else addCliffSkirt(run.segs);
  }

  // FOAM: layered shore-line foam riding the waterline toe of every skirt, a
  // hair above the sea so the transparent-vs-opaque planes never z-fight.
  // Two stacked rings sell the wash instead of one static stripe:
  //   • a FIXED leading edge hugging the shore toe (the bright lacy line
  //     where the last sheet of water meets the sand) — never moves much, so
  //     the waterline always reads as a solid contour;
  //   • a wider SWASH ring drifting in and out (the spent wave sliding up the
  //     sand and retreating), built from a second foam-texture variant.
  // Both animate off the RENDER clock (performance.now in onBeforeRender) —
  // NEVER sim time — so the wash breathes without ever touching determinism:
  // onBeforeRender runs only when a frame is drawn, the replay/sim path never
  // invokes it, and it writes only to visual texture/material state.
  //
  // SEAM CONTRACT: the foam sits at sea + a small lift, and the swash slides
  // over a band sized to an ASSUMED wave amplitude (~0.15–0.3 m). The water
  // sibling owns the real sea surface + wave height; from this worktree we
  // can't see their final numbers, so we anchor to the CURRENT seaLevel
  // (sea) + FOAM_AMP. MERGE: align FOAM_AMP / the foam lift to the water
  // agent's actual wave amplitude so the foam tracks the wet crest, not a
  // guessed height. (Contour-foam + scrolling-swash technique: Cyanilux
  // shoreline breakdown, Alisavakis stylized-water foam.)
  // MERGE: align to sea.ts amplitude — the OCEAN sibling now EXPORTS the real
  // peak crest height (SEA_MAX_AMPLITUDE ≈ 0.288 m at seaLevel -2.2 after the
  // art-ocean rewrite), so we read it directly instead of the round-1 0.22
  // guess (or sand's own round-1 0.207); the foam swash throw
  // tracks the actual wave amplitude. yAt() below still clamps the foam y to
  // max(sea, slope) so the band drapes on the wet sand inland and floats on
  // the sea surface seaward, never sinking under the opaque sea plane.
  {
    const FOAM_AMP = SEA_MAX_AMPLITUDE; // real sea-surface wave amplitude (sea.ts)
    // one foam ring: inner/outer are metres of the skirt's outward normal
    // relative to the WATERLINE — the point where the sand slope crosses the
    // sea surface, NOT the skirt toe (the toe is ~18 m out and metres below
    // the sea, so foam pinned there hid under the slope). Anchoring at the
    // crossing puts the foam exactly on the wet sand at the water's edge.
    // `tex` and `speed` drive the animation.
    const makeFoamRing = (inner: number, outer: number, tex: THREE.CanvasTexture, speed: number, baseOpacity: number): void => {
      const cols = n + 1;
      const pos = new Float32Array(cols * 6);
      const uv = new Float32Array(cols * 4);
      let u = 0;
      for (let c = 0; c < cols; c++) {
        const vi = c % n;
        if (c > 0) {
          const pv = (c - 1) % n;
          u += Math.hypot(o[vi].x - o[pv].x, o[vi].z - o[pv].z) / 3;
        }
        // waterline crossing: fraction along rim→toe where the slope hits sea
        const rimY = o[vi].y ?? 0;
        const runW = Math.max(0.01, vW[vi] * botF); // horizontal rim→toe run
        const slope = (rimY - BOT) / runW; // metres of rise per metre seaward-in
        const tSea = Math.min(1, Math.max(0, (rimY - sea) / Math.max(0.01, rimY - BOT)));
        const wlx = o[vi].x + vOut[vi].x * vW[vi] * botF * tSea;
        const wlz = o[vi].z + vOut[vi].z * vW[vi] * botF * tSea;
        // foam rides the WET SAND inland of the waterline (where the slope is
        // above sea, follow the slope so the band drapes on the sand) and the
        // SEA SURFACE seaward of it (clamp to sea so it floats, never sinks
        // under the opaque sea plane). +0.05 keeps it off both to avoid
        // z-fight. inner is inland (negative offset → +height via -off*slope).
        const yAt = (off: number) => Math.max(sea, sea - off * slope) + 0.05;
        const k = c * 6;
        pos[k] = wlx + vOut[vi].x * inner;
        pos[k + 1] = yAt(inner);
        pos[k + 2] = wlz + vOut[vi].z * inner;
        pos[k + 3] = wlx + vOut[vi].x * outer;
        pos[k + 4] = yAt(outer);
        pos[k + 5] = wlz + vOut[vi].z * outer;
        uv[c * 4] = u;
        uv[c * 4 + 1] = 0;
        uv[c * 4 + 2] = u;
        uv[c * 4 + 3] = 1;
      }
      const idx: number[] = [];
      for (let c = 0; c < cols - 1; c++) {
        const a = c * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        opacity: baseOpacity,
        side: THREE.DoubleSide,
      });
      const foam = new THREE.Mesh(geo, mat);
      foam.renderOrder = 2; // after the sea (0/1) and the wet sheen (1)
      // RENDER-TIME animation (determinism-safe — see block header): scroll
      // the foam crests along the shore + a slow seaward drift, and pulse the
      // swash opacity like a wave running up and sliding back. performance.now
      // is the wall clock, independent of the sim/replay dt stream.
      if (speed !== 0) {
        const ampV = FOAM_AMP; // ties the swash throw to the assumed wave amp
        foam.onBeforeRender = () => {
          const tm = performance.now() / 1000;
          tex.offset.x = (tm * 0.03 * speed) % 1; // drift along the coast
          tex.offset.y = -Math.sin(tm * 0.6 * speed) * 0.12 * ampV * 6; // swash in/out
          // breathe the swash brightness so the spent wave fades as it slides
          mat.opacity = baseOpacity * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tm * 0.6 * speed - 0.5)));
        };
      }
      scene.add(foam);
    };
    // leading edge: a fat lacy band straddling the waterline — runs from ~2 m
    // up the wet sand (inner, inland/negative) out ~2 m over the sea (outer),
    // so the bright crest sits ON the water's edge at readable width from a
    // low camera. Bright, barely drifting — the waterline always reads.
    makeFoamRing(-2.2, 2.0, makeFoamTexture(0), 1, 1.0);
    // outer swash: wider still, a second variant, drifting + pulsing seaward —
    // the spent sheet of a broken wave sliding up the sand and retreating
    makeFoamRing(-3.4, 4.2, makeFoamTexture(1), 1.35, 0.78);
  }

  return seaHandle;
}

/** Embankment drape: the VISUAL ground for the road-base elevation field.
 *  Without it an elevated ribbon floats over flat island grass. One quad
 *  strip per side of every elevated chain span, columns at the sampler's
 *  own lateral breakpoints (road edge → shoulder → fade → grade). Every
 *  vertex takes its height, color AND normal from the FIELD ITSELF
 *  (base(x,z) + finite-difference gradient): on the inside of bends
 *  tighter than the fade reach the lateral fans self-intersect, and
 *  field-sampled folds land coincident — same depth, same shading — so
 *  the overlap is invisible where per-fan lerps drew black creases.
 *  Textured with the SAME world-tiled drygrass the gold ground patches
 *  use — same texture, same (x, −z) UV rule, same 8 m tile — so where
 *  the drape surfaces through a flat patch the intersection contour is
 *  pattern-identical and disappears. Columns that would cross the coast
 *  outline are clipped to it, with the clip vertex on the outline's rim
 *  line (the same lerp the skirts use), so the drape hands off to the
 *  raised cliff skirt watertight instead of hovering over the sea.
 *  PURE VISUAL: no bodies, build-time sampler reads only, zero
 *  determinism cost. */
function addEmbankments(
  scene: THREE.Scene,
  chains: { secs: { x: number; z: number; y: number; dirX: number; dirZ: number }[]; halfW: number; closed: boolean }[],
  coast: CoastDef | undefined,
  base: (x: number, z: number) => number,
): void {
  const LIFT = 0.004; // under every paint slot, above the y-0 island sheet
  const o = coast?.outline;
  const inIsland = (x: number, z: number): boolean => {
    if (!o) return true;
    let inside = false;
    for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
      const a = o[i];
      const b = o[j];
      if (a.z > z !== b.z > z && x < a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z)) inside = !inside;
    }
    return inside;
  };
  /** Clip the segment p→q (p inside, q outside) against the outline; returns
   *  the intersection plus the rim elevation lerped along the crossed edge. */
  const clipToRim = (px: number, pz: number, qx: number, qz: number): { x: number; z: number; y: number } => {
    if (o) {
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
        const a = o[j];
        const b = o[i];
        const rx = qx - px;
        const rz = qz - pz;
        const sx = b.x - a.x;
        const sz = b.z - a.z;
        const den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a.x - px) * sz - (a.z - pz) * sx) / den;
        const u = ((a.x - px) * rz - (a.z - pz) * rx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          return { x: px + rx * t, z: pz + rz * t, y: (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * u };
        }
      }
    }
    return { x: qx, z: qz, y: 0 };
  };

  const posArr: number[] = [];
  const uvArr: number[] = [];
  const nrmArr: number[] = [];
  const idx: number[] = [];
  /** Field-derived vertex: position, patch-aligned UV, gradient normal. */
  const pushVertex = (x: number, z: number, y: number): void => {
    posArr.push(x, y + LIFT, z);
    uvArr.push(x, -z); // ShapeGeometry's raw shape coords — repeat does the tiling
    const e = 0.75;
    const nx = (base(x - e, z) - base(x + e, z)) / (2 * e);
    const nz = (base(x, z - e) - base(x, z + e)) / (2 * e);
    const l = Math.hypot(nx, 1, nz);
    nrmArr.push(nx / l, 1 / l, nz / l);
  };
  for (const { secs, halfW, closed } of chains) {
    const N = secs.length;
    // elevated spans, dilated 2 sections so the strip feathers onto grade
    const hot = secs.map((s) => s.y > 0.001);
    const elev = secs.map((_, i) => {
      for (let k = -2; k <= 2; k++) {
        const j = closed ? (i + k + N) % N : i + k;
        if (j >= 0 && j < N && hot[j]) return true;
      }
      return false;
    });
    const runs: number[][] = [];
    let start = 0;
    if (closed) {
      // start at a cold section so no run straddles the array seam
      start = elev.findIndex((e) => !e);
      if (start < 0) start = 0;
    }
    let cur: number[] | null = null;
    for (let k = 0; k < N; k++) {
      const i = closed ? (start + k) % N : k;
      if (elev[i]) {
        if (!cur) runs.push((cur = []));
        cur.push(i);
      } else cur = null;
    }
    // column offsets: the sampler's lateral breakpoints plus midpoints, so
    // the linear fade renders with its own crease lines in the right spots
    const offs = [halfW - 0.5, halfW + ROAD_SHOULDER, 0, 0, 0];
    offs[2] = offs[1] + EMBANKMENT_FADE / 3;
    offs[3] = offs[1] + (2 * EMBANKMENT_FADE) / 3;
    offs[4] = offs[1] + EMBANKMENT_FADE;
    for (const run of runs) {
      for (const side of [1, -1]) {
        const rowBase = posArr.length / 3;
        for (let r = 0; r < run.length; r++) {
          const s = secs[run[r]];
          let clipped: { x: number; z: number; y: number } | null = null;
          for (let j = 0; j < offs.length; j++) {
            let x = s.x - side * s.dirZ * offs[j];
            let z = s.z + side * s.dirX * offs[j];
            if (clipped) {
              x = clipped.x;
              z = clipped.z;
            } else if (j > 0 && !inIsland(x, z)) {
              const px = s.x - side * s.dirZ * offs[j - 1];
              const pz = s.z + side * s.dirX * offs[j - 1];
              clipped = clipToRim(px, pz, x, z);
              x = clipped.x;
              z = clipped.z;
            }
            // clipped vertices take the outline's rim lerp (watertight with
            // the skirt top row); everything else samples the field
            pushVertex(x, z, clipped ? clipped.y : base(x, z));
          }
        }
        const C = offs.length;
        for (let r = 0; r < run.length - 1; r++) {
          for (let j = 0; j < C - 1; j++) {
            const a = rowBase + r * C + j;
            const b = rowBase + (r + 1) * C + j;
            // wind so the up-faces face up regardless of side
            if (side === 1) idx.push(a, b, a + 1, a + 1, b, b + 1);
            else idx.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
      }
    }
  }
  if (!idx.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvArr), 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrmArr), 3));
  geo.setIndex(idx);
  const tex = makePatchTexture('drygrass');
  tex.repeat.setScalar(1 / 8); // the GroundPatchDef drygrass tile (TILE table)
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
  mesh.receiveShadow = true;
  scene.add(mesh);
}

/** [art-grass-sand] Dune-lip transition overlay — the GRASS side of the
 *  grass→sand boundary. Builds a thin alpha-masked grass-tongue strip that
 *  rides just above the sand at the beach, so the island lawn appears to
 *  THIN into the sand in broken fingers instead of stopping at a polygon
 *  seam. Pure visual (no bodies, build-time only, zero determinism cost).
 *
 *  Seam contract: this OWNS the grass side only. The SAND patch is the
 *  sand-water sibling's; we read its (and the dune band's) existing geometry
 *  and align our fringe to it — we never edit the sand material/patch here.
 *  The strip is generated from the beach DUNE BAND (the thin 'drygrass'
 *  patch authored in beach.ts): its loop is split at the two narrow ends
 *  (min/max x) into a SEAWARD polyline and an INLAND polyline; the fringe is
 *  a quad strip between them with v=0 inland (full grass) → v=1 seaward
 *  (bare). makeDuneBlendTexture supplies the height-thresholded grass tongues.
 */
function addDuneFringe(scene: THREE.Scene, level: LevelDef): void {
  // the dune band = the 'drygrass' patch sitting in the SW beach quadrant
  // (the headland drygrass tongues are drygrass too, but they live NE/E and
  // meet gold grass, not sand — scope by the beach zone bounds x<-78,z<-60).
  const band = (level.patches ?? []).find(
    (p) =>
      p.kind === 'drygrass' &&
      p.poly.length >= 6 &&
      p.poly.every(([x, z]) => x <= -78 && z <= -60),
  );
  if (!band) return;
  const poly = band.poly;
  const M = poly.length;
  // split the thin loop into two long edges at its narrow ends (min/max x):
  // walking from the min-x vertex to the max-x vertex one way is one edge,
  // the other way is the other. One edge runs nearer the sea, one inland.
  let iMin = 0;
  let iMax = 0;
  for (let i = 1; i < M; i++) {
    if (poly[i][0] < poly[iMin][0]) iMin = i;
    if (poly[i][0] > poly[iMax][0]) iMax = i;
  }
  const walk = (from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = from; ; i = (i + 1) % M) {
      out.push(poly[i]);
      if (i === to) break;
    }
    return out;
  };
  const edgeA = walk(iMin, iMax);
  const edgeB = walk(iMax, iMin);
  // the inland edge sits at higher (less negative) z on average — the band
  // is authored ~10 m up the lawn on its inland side; the seaward side hugs
  // the sand. Use mean z to label them robustly.
  const meanZ = (e: [number, number][]): number => e.reduce((s, p) => s + p[1], 0) / e.length;
  let inland = meanZ(edgeA) > meanZ(edgeB) ? edgeA : edgeB;
  let seaward = inland === edgeA ? edgeB : edgeA;
  // resample both edges to the SAME column count so the strip pairs cleanly,
  // and orient them to run the same direction (by their first vertex x)
  if (inland[0][0] > inland[inland.length - 1][0]) inland = [...inland].reverse();
  if (seaward[0][0] > seaward[seaward.length - 1][0]) seaward = [...seaward].reverse();
  const COLS = 48;
  const lerpEdge = (e: [number, number][], t: number): [number, number] => {
    const f = t * (e.length - 1);
    const i = Math.min(e.length - 2, Math.floor(f));
    const k = f - i;
    return [e[i][0] + (e[i + 1][0] - e[i][0]) * k, e[i][1] + (e[i + 1][1] - e[i][1]) * k];
  };
  // push the seaward row a few metres FURTHER onto the sand than the band's
  // own seaward edge, so the tongues finger past the existing drygrass→sand
  // line and break that seam too (not just the green→drygrass one)
  const pos: number[] = [];
  const uv: number[] = [];
  let u = 0;
  let prevX = 0;
  let prevZ = 0;
  for (let cIdx = 0; cIdx < COLS; cIdx++) {
    const t = cIdx / (COLS - 1);
    const inP = lerpEdge(inland, t);
    const seP = lerpEdge(seaward, t);
    // extend ~4 m seaward along the inland→seaward direction
    const dx = seP[0] - inP[0];
    const dz = seP[1] - inP[1];
    const dl = Math.hypot(dx, dz) || 1;
    const seX = seP[0] + (dx / dl) * 4;
    const seZ = seP[1] + (dz / dl) * 4;
    if (cIdx > 0) u += Math.hypot(inP[0] - prevX, inP[1] - prevZ) / 9; // tile u every ~9 m
    prevX = inP[0];
    prevZ = inP[1];
    // two rows: inland (v0) then seaward (v1)
    pos.push(inP[0], 0, inP[1], seX, 0, seZ);
    uv.push(u, 0, u, 1);
  }
  const idx: number[] = [];
  for (let cIdx = 0; cIdx < COLS - 1; cIdx++) {
    const a = cIdx * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    map: makeDuneBlendTexture(),
    transparent: true,
    alphaTest: 0.35, // cut the tongues crisply so they take light + shadow
    roughness: 1,
    side: THREE.DoubleSide,
    polygonOffset: true, // float just over the sand patch (0.006) without z-fight
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const fringe = new THREE.Mesh(geo, mat);
  fringe.position.y = 0.0068; // above the sand patch (0.006), below the ribbons (0.010)
  fringe.rotation.x = 0; // positions are already world (x, y, z)
  fringe.receiveShadow = true;
  scene.add(fringe);
}

/** @returns the animated-sea handle (coast levels only), so the frame loop
 *  can drive its render-time waves; null on inland levels with no sea. */
export function buildEnvironment(scene: THREE.Scene, phys: PhysicsContext, level: LevelDef): Sea | null {
  const race = level.mode.kind === 'race' ? level.mode.race : null;
  let sea: Sea | null = null;

  if (level.coast) {
    // an island in the sea: the outline polygon IS the grass, with skirts
    // down to the water — the auto-sized square below would poke through it
    sea = buildCoast(scene, level.coast);
  } else {
    // ground plane sized from level content — the hard-coded 320 cropped any
    // circuit bigger than SILVER LAKE RING; sections, shortcut waypoints,
    // props and buildings all count, plus margin so the rim never shows
    let extent = 0;
    const grow = (x: number, z: number) => {
      extent = Math.max(extent, Math.abs(x), Math.abs(z));
    };
    if (race) {
      for (const s of race.sections) grow(s.x, s.z);
      for (const sc of race.shortcuts ?? []) for (const [wx, wz] of sc.waypoints) grow(wx, wz);
    }
    for (const p of level.props ?? []) grow(p.x, p.z);
    for (const b of level.buildings) grow(b.x, b.z);
    const groundSize = Math.max(320, (extent + 60) * 2);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.MeshStandardMaterial({ color: 0x59614f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }

  // ground patches: textured aprons/sand/dry grass UNDER the paving — see
  // the z-order contract at the top of this file (default y 0.006 keeps
  // them beneath the 0.010/0.012 ribbons). Visual only, no grip change.
  if (level.patches?.length) {
    const patchMats = new Map<PatchKind, THREE.MeshStandardMaterial>();
    const TILE: Record<PatchKind, number> = { concrete: 9, sand: 6, drygrass: 8, gravel: 4 };
    for (const p of level.patches) {
      let mat = patchMats.get(p.kind);
      if (!mat) {
        const tex = makePatchTexture(p.kind);
        // ShapeGeometry UVs are raw shape coords (= world metres), so the
        // repeat alone gives seamless world-space tiling across patches
        tex.repeat.setScalar(1 / TILE[p.kind]);
        mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1 });
        patchMats.set(p.kind, mat);
      }
      const mesh = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(p.poly.map(([x, z]) => new THREE.Vector2(x, -z)))),
        mat,
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = p.y ?? 0.006;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // [art-grass-sand] grass-side dune-lip transition: a grass-tongue fringe
  // over the sand at the beach so the green→tan boundary reads as the lawn
  // thinning into sand, not a polygon seam. Own block; reads patch geometry
  // only, never edits the shared patch loop above.
  addDuneFringe(scene, level);

  const roadMat = new THREE.MeshStandardMaterial({ color: 0x2e3138, roughness: 0.95 });

  if (race) {
    // the circuit ribbon: a triangle strip between the left/right edges of
    // every race section, with centre dashes and a start/finish stripe
    const secs = race.sections;
    const w2 = race.width / 2;
    const N = secs.length;
    addRibbon(scene, secs, race.width, 0.012, 0x2e3138, true);

    // paint pitch on a grade: a flat dash 2.2 m long would bury one end in
    // a 6% climb and float the other — tilt it about its length axis to
    // the local chain grade (the mark's length axis points BACKWARDS along
    // the chain after the YXZ euler, hence the minus). 0 on flat ground.
    const gradeAt = (chain: { x: number; z: number; y: number }[], i: number, closed: boolean): number => {
      const n = chain.length;
      const a = chain[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
      const b = chain[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      const run = Math.hypot(b.x - a.x, b.z - a.z);
      return run > 0 ? (b.y - a.y) / run : 0;
    };
    interface Mark {
      x: number;
      z: number;
      w: number;
      l: number;
      yaw: number;
      color?: number;
      y?: number;
      pitch?: number;
    }
    const marks: Mark[] = [];
    secs.forEach((s, i) => {
      if (i % 2 !== 0) return;
      marks.push({
        x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ),
        y: s.y + 0.015, pitch: -Math.atan(gradeAt(secs, i, true)),
      });
    });
    marks.push({
      x: secs[0].x,
      z: secs[0].z,
      w: race.width - 2,
      l: 1.0,
      yaw: Math.atan2(secs[0].dirX, secs[0].dirZ),
      y: secs[0].y + 0.015,
    });

    // checkpoints: a painted stripe + glowing gate posts every 6th section,
    // so the racing line always has a visible next target. Posts and
    // stripes ride the section's road elevation on the north arc.
    const postGeo = new THREE.CylinderGeometry(0.12, 0.16, 2.6, 8);
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x22262c,
      emissive: 0xffb327,
      emissiveIntensity: 1.4,
    });
    postMat.userData.night = { intensity: 2.4, day: 1.4 };
    for (let i = 6; i < N; i += 6) {
      const s = secs[i];
      marks.push({
        x: s.x, z: s.z, w: race.width - 2, l: 0.7, yaw: Math.atan2(s.dirX, s.dirZ),
        y: s.y + 0.015, pitch: -Math.atan(gradeAt(secs, i, true)),
      });
      for (const side of [1, -1]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(s.x - side * s.dirZ * (w2 + 1.1), s.y + 1.3, s.z + side * s.dirX * (w2 + 1.1));
        post.castShadow = true;
        scene.add(post);
      }
    }
    // shortcut branch ribbons: same strip builder, own narrower chain, a
    // dirt or asphalt tint, and a hair LOWER than the main road (0.010 vs
    // 0.012) so the junction overlaps at the mouths never z-fight. No
    // walls along a branch — running out of road is part of the price.
    const shortcuts = race.shortcuts ?? [];
    for (const sc of shortcuts) {
      const chain = buildOpenSections(sc.waypoints, SHORTCUT_SPACING);
      addRibbon(scene, chain, sc.width, 0.01, sc.surface === 'dirt' ? 0x6b5d40 : 0x2e3138, false);
      // sparse centre dashes — enough to read as road at speed, not enough
      // to dress a branch up as the main line
      for (let i = 2; i < chain.length - 1; i += 4) {
        const s = chain[i];
        marks.push({
          x: s.x, z: s.z, w: 0.22, l: 2.2, yaw: Math.atan2(s.dirX, s.dirZ),
          y: s.y + 0.015, pitch: -Math.atan(gradeAt(chain, i, false)),
        });
      }
    }
    addMarkInstances(scene, marks);

    // shortcut mouths punch gaps in the barrier: skip main-loop wall
    // segments [entry-1, entry+1] and [exit-1, exit+1], on the attachment
    // side ONLY — inferred from the cross product of the section direction
    // with (branch endpoint − section centre), so the far wall still pins
    // rivals through the junction
    const gapped = new Set<string>(); // "side:segIndex"
    for (const sc of shortcuts) {
      const mouths: [number, RaceWaypoint][] = [
        [sc.entry, sc.waypoints[0]],
        [sc.exit, sc.waypoints[sc.waypoints.length - 1]],
      ];
      for (const [secIdx, wp] of mouths) {
        const s = secs[secIdx % N];
        // 2D cross dir × offset: positive = the side the +1 wall runs on
        // (its offset is along the left perpendicular (-dirZ, dirX))
        const cross = s.dirX * (wp[1] - s.z) - s.dirZ * (wp[0] - s.x);
        const side = cross >= 0 ? 1 : -1;
        for (let k = -1; k <= 1; k++) gapped.add(`${side}:${(secIdx + k + N) % N}`);
      }
    }

    // barriers: wall segments chained just outside both edges — hard enough
    // to wreck on head-on, perfect for pinning a rival. Deliberately NOT in
    // noCrashIds: a wall is a wall. The default 'race' chain is today's
    // 1.0 m red/white boxes; RaceDef.wallStyles swaps section ranges for a
    // coastal guardrail (0.75 m), a quay kerb (0.45 m), dockyard chain-link
    // (2.2 m) or 'none' (an open gap). Each style sets the matching physics
    // box height too, so a kerb is hoppable where the fence is a cage.
    const wallT = 0.5;
    const WALL_H = { race: 1.0, guardrail: 0.75, kerb: 0.45, fence: 2.2 } as const;
    type WallKind = keyof typeof WALL_H;
    // 'left'/'right' are relative to race direction: side +1 offsets along
    // the left perpendicular (-dirZ, dirX) — same convention as the
    // shortcut-mouth cross product above. Overlapping ranges: last wins.
    const styleFor = (side: 1 | -1, i: number): WallKind | 'none' => {
      let st: WallKind | 'none' = 'race';
      for (const ws of race.wallStyles ?? []) {
        if (ws.side !== 'both' && (ws.side === 'left' ? 1 : -1) !== side) continue;
        // from > to wraps the lap seam, mirroring how section indices loop
        if (ws.from <= ws.to ? i >= ws.from && i <= ws.to : i >= ws.from || i <= ws.to) st = ws.style;
      }
      return st;
    };
    // Wall segments on a grade sit at their section pair's MEAN elevation —
    // stepped seams, not pitched boxes, per elevation.md's costed tradeoff:
    // at the profile's steepest ~7% a 9.5 m segment steps ~±0.3 m, hidden
    // by the 0.5 m overlap, and the embankment shoulder under the wall is
    // at full road elevation so no gap opens beneath the box. wallDirs
    // judging stays 2D and untouched.
    const wallSegs: { x: number; z: number; y0: number; y1: number; len: number; yaw: number; style: WallKind }[] = [];
    for (const side of [1, -1] as const) {
      for (let i = 0; i < N; i++) {
        if (gapped.has(`${side}:${i}`)) continue; // a shortcut mouth opens here
        const style = styleFor(side, i);
        if (style === 'none') continue; // deliberate gap — no wall, no body
        const a = secs[i];
        const b = secs[(i + 1) % N];
        const off = w2 + wallT / 2 + 0.15;
        const ax = a.x - side * a.dirZ * off;
        const az = a.z + side * a.dirX * off;
        const bx = b.x - side * b.dirZ * off;
        const bz = b.z + side * b.dirX * off;
        const len = Math.hypot(bx - ax, bz - az) + 0.5; // overlap hides the seams
        wallSegs.push({ x: (ax + bx) / 2, z: (az + bz) / 2, y0: a.y, y1: b.y, len, yaw: Math.atan2(bx - ax, bz - az), style });
      }
    }
    const wallGeo = new THREE.BoxGeometry(1, 1, 1);
    const wallColors = [0xd8dde2, 0xc23a2c]; // alternating white/red
    for (const parity of [0, 1]) {
      // parity over the FULL segment array keeps the chain pixel-identical
      // to the pre-wallStyles build when every segment is 'race'
      const mine = wallSegs.filter((sg, i) => sg.style === 'race' && i % 2 === parity);
      const inst = new THREE.InstancedMesh(
        wallGeo,
        new THREE.MeshStandardMaterial({ color: wallColors[parity], roughness: 0.8 }),
        mine.length,
      );
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      mine.forEach((sg, i) => {
        q.setFromAxisAngle(up, sg.yaw);
        sc.set(wallT, WALL_H.race, sg.len);
        m4.compose(new THREE.Vector3(sg.x, (sg.y0 + sg.y1) / 2 + WALL_H.race / 2, sg.z), q, sc);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = inst.receiveShadow = true;
      scene.add(inst);
    }

    // themed wall visuals: everything is batched — boxes by material into
    // InstancedMeshes, the chain-link into one merged cutout mesh
    interface BoxInst {
      x: number;
      y: number;
      z: number;
      sx: number;
      sy: number;
      sz: number;
      yaw: number;
    }
    const addBoxInstances = (color: number, roughness: number, boxes: BoxInst[]): void => {
      if (!boxes.length) return;
      const inst = new THREE.InstancedMesh(
        wallGeo,
        new THREE.MeshStandardMaterial({ color, roughness }),
        boxes.length,
      );
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      boxes.forEach((bx, i) => {
        q.setFromAxisAngle(up, bx.yaw);
        sc.set(bx.sx, bx.sy, bx.sz);
        m4.compose(new THREE.Vector3(bx.x, bx.y, bx.z), q, sc);
        inst.setMatrixAt(i, m4);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = inst.receiveShadow = true;
      scene.add(inst);
    };
    const kerbs: BoxInst[] = [];
    const rails: BoxInst[] = [];
    const woodPosts: BoxInst[] = [];
    const fencePosts: BoxInst[] = [];
    const fPos: number[] = [];
    const fUv: number[] = [];
    const fIdx: number[] = [];
    for (const sg of wallSegs) {
      const dx = Math.sin(sg.yaw);
      const dz = Math.cos(sg.yaw);
      const yMid = (sg.y0 + sg.y1) / 2; // road elevation under the segment
      // per-spot elevation along the segment — posts follow the grade
      // smoothly even though the long boxes step at the seams
      const yAt = (t: number) => sg.y0 + (sg.y1 - sg.y0) * (t + 0.5);
      if (sg.style === 'kerb') {
        // a plain concrete curb — hop it and pay in undercarriage scrape
        kerbs.push({ x: sg.x, y: yMid + WALL_H.kerb / 2, z: sg.z, sx: wallT, sy: WALL_H.kerb, sz: sg.len, yaw: sg.yaw });
      } else if (sg.style === 'guardrail') {
        // coastal highway: weathered wood posts carrying a grey W-rail
        rails.push({ x: sg.x, y: yMid + 0.58, z: sg.z, sx: 0.09, sy: 0.3, sz: sg.len, yaw: sg.yaw });
        const cnt = Math.max(2, Math.round(sg.len / 2.4));
        for (let k = 0; k < cnt; k++) {
          const t = (k + 0.5) / cnt - 0.5; // interior spots only — no seam doubles
          woodPosts.push({
            x: sg.x + dx * sg.len * t,
            y: yAt(t) + 0.36,
            z: sg.z + dz * sg.len * t,
            sx: 0.16,
            sy: 0.72,
            sz: 0.16,
            yaw: sg.yaw,
          });
        }
      } else if (sg.style === 'fence') {
        const cnt = Math.max(1, Math.round(sg.len / 3));
        for (let k = 0; k < cnt; k++) {
          const t = (k + 0.5) / cnt - 0.5;
          fencePosts.push({
            x: sg.x + dx * sg.len * t,
            y: yAt(t) + WALL_H.fence / 2,
            z: sg.z + dz * sg.len * t,
            sx: 0.09,
            sy: WALL_H.fence,
            sz: 0.09,
            yaw: sg.yaw,
          });
        }
        // one vertical quad per segment, u in metres so the mesh tiles;
        // the corners carry their end's road elevation, so the chain-link
        // (unlike the boxes) follows a grade without stepping
        const hx = (dx * sg.len) / 2;
        const hz = (dz * sg.len) / 2;
        const base = fPos.length / 3;
        fPos.push(
          sg.x - hx, sg.y0, sg.z - hz,
          sg.x + hx, sg.y1, sg.z + hz,
          sg.x + hx, sg.y1 + WALL_H.fence, sg.z + hz,
          sg.x - hx, sg.y0 + WALL_H.fence, sg.z - hz,
        );
        fUv.push(0, 0, sg.len, 0, sg.len, WALL_H.fence, 0, WALL_H.fence);
        fIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    addBoxInstances(0xc9cbc7, 0.9, kerbs); // light concrete
    addBoxInstances(0x9aa1a7, 0.55, rails); // galvanized rail
    addBoxInstances(0x77624c, 1.0, woodPosts); // weathered timber
    addBoxInstances(0x474c51, 0.7, fencePosts); // fence steel
    if (fIdx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(fPos), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(fUv), 2));
      geo.setIndex(fIdx);
      geo.computeVertexNormals();
      const fence = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          map: makeChainLinkTexture(),
          alphaTest: 0.45,
          side: THREE.DoubleSide,
          roughness: 0.7,
        }),
      );
      // no castShadow: the cutout has no custom depth material, so the sun
      // would project the plane as a solid slab — a lie worse than no shadow
      fence.receiveShadow = true;
      scene.add(fence);
    }

    // physics: one static box per segment regardless of dressing — only the
    // height varies by style. Same chain, same wallDirs judging as always.
    // On a grade the box rides the segment's mean road elevation (stepped,
    // like the visual): the shoulder under it is at full elevation, so the
    // worst seam mismatch is ~0.3 m of box bottom against solid embankment.
    for (const sg of wallSegs) {
      const h = WALL_H[sg.style];
      const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
      wb.addShape(new CANNON.Box(new CANNON.Vec3(wallT / 2, h / 2, sg.len / 2)));
      wb.position.set(sg.x, (sg.y0 + sg.y1) / 2 + h / 2, sg.z);
      wb.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), sg.yaw);
      phys.world.addBody(wb);
      phys.wallDirs.set(wb.id, { x: Math.sin(sg.yaw), z: Math.cos(sg.yaw) });
    }

    // the visual ground under every elevated span (no-op on flat tracks);
    // a fresh sampler instance keeps this builder self-contained — same
    // plain-number inputs, same field, build-time only
    addEmbankments(
      scene,
      [
        { secs, halfW: w2, closed: true },
        ...shortcuts.map((sc) => ({
          secs: buildOpenSections(sc.waypoints, SHORTCUT_SPACING),
          halfW: sc.width / 2,
          closed: false,
        })),
      ],
      level.coast,
      makeHeightSampler(level).base,
    );
  }

  if (level.ground === 'pad') {
    // open practice asphalt with painted skidpad rings and dash lines
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(170, 170), roadMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.005;
    pad.receiveShadow = true;
    scene.add(pad);
    if (level.padDecals) {
      for (const r of level.padDecals.rings) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(r.r - 0.35, r.r + 0.35, 64),
          new THREE.MeshBasicMaterial({ color: 0xd9dde2, transparent: true, opacity: 0.4, depthWrite: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(r.x, 0.02, r.z);
        scene.add(ring);
      }
      addMarkInstances(
        scene,
        level.padDecals.dashes.map((d) => ({ x: d.x, z: d.z, w: 0.25, l: 2.0, yaw: d.yaw })),
      );
    }
  } else if (level.ground === 'field') {
    // bare grass — the race ribbon above is the only paving
  } else {
    // crossroad: roads run ±140 so looping traffic recycles deep in the fog
    const roadNS = new THREE.Mesh(new THREE.PlaneGeometry(14, 280), roadMat);
    roadNS.rotation.x = -Math.PI / 2;
    roadNS.position.y = 0.005;
    roadNS.receiveShadow = true;
    scene.add(roadNS);
    const roadEW = new THREE.Mesh(new THREE.PlaneGeometry(280, 14), roadMat);
    roadEW.rotation.x = -Math.PI / 2;
    roadEW.position.y = 0.004;
    roadEW.receiveShadow = true;
    scene.add(roadEW);

    const marks: { x: number; z: number; w: number; l: number; yaw: number }[] = [];
    const addMark = (x: number, z: number, w: number, l: number, yaw: number) => marks.push({ x, z, w, l, yaw });
    for (let z = -136; z <= 136; z += 4.4) if (Math.abs(z) > 8.5) addMark(0, z, 0.22, 2.0, 0);
    for (let x = -136; x <= 136; x += 4.4) if (Math.abs(x) > 8.5) addMark(x, 0, 0.22, 2.0, Math.PI / 2);
    addMark(0, 7.7, 9.4, 0.5, 0);
    addMark(0, -7.7, 9.4, 0.5, 0);
    addMark(7.7, 0, 9.4, 0.5, Math.PI / 2);
    addMark(-7.7, 0, 9.4, 0.5, Math.PI / 2);
    for (let i = -3; i <= 3; i++) {
      addMark(i * 1.25, 9.6, 0.55, 2.4, 0);
      addMark(i * 1.25, -9.6, 0.55, 2.4, 0);
      addMark(9.6, i * 1.25, 0.55, 2.4, Math.PI / 2);
      addMark(-9.6, i * 1.25, 0.55, 2.4, Math.PI / 2);
    }
    addMarkInstances(scene, marks);
  }

  // level decals: painted lane markings on the aprons — the road-dash
  // instancer with per-decal colors, at 0.014 so they ride above the
  // ribbons but never fight the 0.015 race dashes (z-order contract)
  if (level.decals?.length) addMarkInstances(scene, level.decals, 0.014);

  // corner blocks: sidewalk slabs + buildings (static colliders → pinball walls)
  const winTex = makeWindowTextures();
  for (const { x: cx, z: cz, h, color } of level.buildings) {
    const walk = new THREE.Mesh(
      new THREE.BoxGeometry(14, 0.16, 14),
      new THREE.MeshStandardMaterial({ color: 0x80868e, roughness: 1 }),
    );
    walk.position.set(cx, 0.08, cz);
    walk.receiveShadow = true;
    scene.add(walk);
    const wb = new CANNON.Body({ mass: 0, material: phys.matGround });
    wb.addShape(new CANNON.Box(new CANNON.Vec3(7, 0.08, 7)));
    wb.position.set(cx, 0.08, cz);
    wb.collisionFilterGroup = GROUP_DECOR; // live chassis drive over via springs
    phys.world.addBody(wb);
    phys.noCrashIds.add(wb.id); // curbs scuff, they don't wreck

    const tex = winTex.map.clone();
    tex.needsUpdate = true;
    tex.repeat.set(3, Math.max(2, Math.round(h / 3)));
    const lit = winTex.lit.clone();
    lit.needsUpdate = true;
    lit.repeat.copy(tex.repeat);
    // at night the warm windows glow (daynight.ts sweeps the intensity)
    const bldMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.9,
      map: tex,
      emissive: 0xffffff,
      emissiveMap: lit,
      emissiveIntensity: 0,
    });
    bldMat.userData.night = { intensity: 2.6 };
    const bld = new THREE.Mesh(new THREE.BoxGeometry(11, h, 11), bldMat);
    bld.position.set(cx, h / 2 + 0.16, cz);
    bld.castShadow = bld.receiveShadow = true;
    // baked AO contact-darkening at the base of the block (ao.ts / the offline
    // bake). A BoxGeometry is always 24 verts in a fixed order, so the bake's
    // 'building' prototype — a unit box sat on its sidewalk — drapes onto any
    // building height: the bottom ring darkens where wall meets ground while
    // the sunlit upper faces keep their key light (ambient-only, see ao.ts).
    applyBakedAO(bld, 'building');
    scene.add(bld);
    const bb = new CANNON.Body({ mass: 0, material: phys.matGround });
    bb.addShape(new CANNON.Box(new CANNON.Vec3(5.5, h / 2, 5.5)));
    bb.position.set(cx, h / 2 + 0.16, cz);
    phys.world.addBody(bb);
  }

  // launch ramps: a rotated slab; the suspension rays read the matching
  // height field, the physics box only matters for landings and wrecks
  const chevron = makeChevronTexture();
  for (const r of level.ramps) {
    const theta = Math.atan2(r.height, r.length);
    const slopeLen = Math.hypot(r.length, r.height);
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.9 });
    const topTex = chevron.clone();
    topTex.needsUpdate = true;
    topTex.repeat.set(1, Math.max(1, Math.round(slopeLen / 3)));
    const topMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.85 });
    const geo = new THREE.BoxGeometry(r.width, 0.3, slopeLen);
    const mesh = new THREE.Mesh(geo, [sideMat, sideMat, topMat, sideMat, sideMat, sideMat]);
    mesh.rotation.x = -theta;
    mesh.position.set(r.x, r.height / 2 - 0.12, r.zStart + r.length / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({ mass: 0, material: phys.matGround });
    body.addShape(new CANNON.Box(new CANNON.Vec3(r.width / 2, 0.15, slopeLen / 2)));
    body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -theta);
    body.position.set(r.x, r.height / 2 - 0.12, r.zStart + r.length / 2);
    body.collisionFilterGroup = GROUP_DECOR; // springs ride it; box is for wrecks
    phys.world.addBody(body);
    phys.noCrashIds.add(body.id);
  }

  return sea;
}
