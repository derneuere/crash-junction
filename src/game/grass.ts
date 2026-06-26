// ============================================================================
// INSTANCED FLUFFY-GRASS — the GRASS VERGES of the whole island (GANTRY POINT).
// ============================================================================
//
// The textured island-grass ground + the alpha-tongue dune fringe (both in
// environment.ts) stay as the BASE; this module AUGMENTS them with a field of
// real 3D blade-clumps that sit ON the grass and sway in the wind. Clumps are
// placed ONLY where the ground is genuinely grass.
//
// ── WHY THIS WAS REWRITTEN AGAIN (2026-06-13, grass-lush) ────────────────────
//   The previous pass matched the FluffyGrass demo's NUMERIC density (~3 tufts/
//   m²) with a procedurally-built 3-blade cross-tuft, ~0.45–1.0 m tall. From the
//   chase cam (driving height ~2.4 m, looking down the verge at a shallow angle)
//   that still read as a THIN GREEN FUZZ, not the demo's rich grass field — the
//   blades were too short and too thin-silhouetted to fill the frame. The demo
//   gets its lush look from three things our procedural tuft lacked:
//     1. a real fanned blade-CLUMP mesh (grassLODs.glb LOD00, ~6 splayed cards),
//     2. an ALPHA TEXTURE (grass.jpeg) of ~10 wispy blades cut out of each card
//        — so every instance reads as a bushy clump of strands, not a few quads,
//     3. a base→tip COLOUR GRADIENT + perlin-noise height/colour variation.
//   This pass adopts the demo's ACTUAL assets + shader and makes the blades a
//   lot TALLER (the main missing lever for a shallow chase-cam angle).
//
// ── WHAT WE TOOK FROM FluffyGrass (assets + technique) ───────────────────────
//   Assets (public/grass/, MIT — see public/grass/manifest.md):
//     * grassLODs.glb     — Grass.LOD00/01/02 fanned blade-clump meshes
//     * grass-alpha.jpeg  — white-on-black alpha mask of ~10 wispy blades
//     * perlinnoise.webp  — tiling noise: G drives wind, R drives variation
//   Shader (ported from FluffyGrass GrassMaterial.ts):
//     * world-UV + perlin wind sway scaled by (1 - uv.y) (planted base, whippy
//       tip) + a perlin height bump that gives the field its fluffy unevenness,
//     * baseColor → tipColor vertical gradient with a per-clump noise hue mix,
//     * the alpha-mask blade silhouette (step over the mask's red channel).
//   ADAPTATIONS (not a verbatim port):
//     * the demo scatters 8000 clumps over a ~55 m island with MeshSurfaceSampler
//       and a single LOD; we scatter over a 600 m island with a deterministic
//       hash (pin-safe) and a HARD grass-only surface mask, partitioned into
//       per-tile InstancedMeshes with a distance LOD (LOD00 near → LOD02 far)
//       + distance cull so the full demo look stays affordable to draw,
//     * the shader is grafted onto MeshLambert-equivalents via onBeforeCompile of
//       MeshStandardMaterial so the blades pick up THIS engine's PMREM sky env +
//       fog + the time-of-day grade (the demo is a fixed-light Lambert),
//     * blades are scaled TALLER than the demo (~1.4–1.9 m vs the demo's ~0.65 m)
//       so the field reads lush at our shallow chase-cam angle, not just top-down.
//   MIT requires keeping the copyright/attribution — see public/grass/manifest.md
//   (full licence) and this header. FluffyGrass © 2023 Ebenezer (thebenezer):
//   https://github.com/thebenezer/FluffyGrass  •  https://fluffygrass.vercel.app/
//
// ── ASYNC ASSET LOAD, SYNC PLACEMENT (the determinism contract) ──────────────
//   buildGrass() stays SYNCHRONOUS: it does the (deterministic-hash) placement
//   and creates the per-tile InstancedMeshes IMMEDIATELY, with a tiny fallback
//   geometry + the textures un-set. The GLB + the two textures load in the
//   background; when they land we SWAP the real LOD geometry onto every tile
//   mesh and set the texture uniforms. Nothing about the load order touches sim
//   state — placement, matrices and the world hash are all decided synchronously
//   at build time; the async swap only changes what's DRAWN. Pin-safe.
//
// PIN-SAFE / VISUAL ONLY: clumps are placed at BUILD TIME (deterministic hash),
// carry NO collider, and the wind animates off a RENDER-time clock (update(dt)
// only writes a float uniform). Distance culling reads the RENDER-time camera
// position (passed into update) and only flips per-tile mesh visibility / count
// / LOD — it never touches sim state, RNG, or the world hash.
//
// ── GRASS-ONLY PLACEMENT (the hard mask) ─────────────────────────────────────
//   We build a HARD mask from the LEVEL'S OWN surface geometry (read-only) and
//   REJECT every candidate that is not on real grass:
//     * outside the island OUTLINE polygon (inset a touch) -> over sea (reject)
//     * inside any 'sand' / 'gravel' / 'concrete' patch -> not grass (reject)
//     * seaward of the SW 'drygrass' dune lip -> sand (reject)
//     * within (half-width + margin) of the MAIN race ribbon or any SHORTCUT
//       ribbon centreline -> on/near road (reject)
//     * within a building plinth's footprint + margin -> under a building
//   drygrass patches are NOT rejected — they are drying-but-real grass (the
//   golden headland and cliff verges the player drifts along).
//
// ── DISTANCE CULL + LOD (what makes the demo look affordable) ────────────────
//   The island is partitioned into a grid of TILES; each non-empty tile is its
//   own InstancedMesh. update(dt, camPos):
//     * hides a tile whose centre is beyond CULL_RADIUS (far field draws zero);
//     * picks the tile's blade GEOMETRY by distance: LOD00 (full clump) inside
//       LOD0_RADIUS, LOD01 in the mid ring, LOD02 in the far ring — fewer tris
//       per clump as the clump shrinks on screen;
//     * draws FULL allocated density inside FULL_RADIUS (the lush near field);
//     * between FULL_RADIUS and CULL_RADIUS, scales mesh.count down (ease-out to
//       MIN_LOD_FRAC) so the mid/far ring thins HARD. Placement order within a
//       tile is hash-uniform, so drawing the first K instances is an even
//       spatial subsample — no clustering artefact.
//   three's own frustumCulled (left on per tile) drops off-screen tiles too.
//   ONE InstancedMesh per VISIBLE tile = one draw call each.
//
// ── CINE-ONLY ────────────────────────────────────────────────────────────────
//   The game is always-CINE; there is no FAST density tier. setTier() is kept on
//   the interface (Game.ts still calls it) but resolves to the single path.
//
// ── MODULE LAYOUT (this file is a thin barrel) ───────────────────────────────
//   The implementation lives in ./grass/*; this file re-exports the public
//   surface so importers keep using "./grass" unchanged:
//     * ./grass/config.ts      — density + distance-cull/LOD/tiling constants
//     * ./grass/surfaceMask.ts — the HARD grass-only placement mask
//     * ./grass/assets.ts      — async GLB/texture load + fallback geometry
//     * ./grass/material.ts    — the FluffyGrass shader on MeshStandardMaterial
//     * ./grass/types.ts       — GrassField / GrassPalette / GrassTile
//     * ./grass/build.ts       — buildGrass(): placement + per-frame LOD update
// ============================================================================

export { buildGrass } from './grass/build';
export type { GrassField, GrassPalette } from './grass/types';
