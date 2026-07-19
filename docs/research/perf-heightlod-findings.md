# Height-driven screen-space LOD (perf-heightlod)

**Status: SHIPPED** (branch `feat/height-lod`). Successor to the reverted
geometry-LOD experiment (`perf-lod-props-findings.md`), built on its core
lesson: this engine is **draw-call bound, not triangle bound**, so the LOD
ladder flips *draws* (visibility, shadow-caster status), not vertex counts.

## The idea

Every prop tile / batched-tail instance / building registers with the world
**height** of its contents (floored by a fraction of its footprint so flat-wide
objects don't wrongly vanish). Per frame its projected on-screen height is

    pxHeight = worldHeight · k / distance,   k = viewportH / (2·tan(fov/2))

and a 3-level ladder walks on **pixel** thresholds (`lod/heightlod.ts`,
`LOD_PX`):

| level | state | trigger (default) |
|---|---|---|
| 0 | full render + shadows | — |
| 1 | stops casting shadows | < 16 px (re-arm > 19 px) |
| 2 | hidden | < 6 px (re-show > 7.5 px) |

Pixel thresholds give every object its own switch distance **proportional to
its size** — a 12 m crane holds detail ~10× farther than a 1.2 m bollard —
which is both the perf win (small clutter culls early) and the no-pop-in
guarantee (everything switches while a few px tall). Hysteresis bands stop
boundary flicker. Granularity: per-tile for InstancedMesh runs (judged by the
TALLEST member and nearest-edge distance), per-INSTANCE `setVisibleAt` for the
BatchedMesh singleton tail (no shadow rung — castShadow is per-batch), per-mesh
for plains and buildings.

## Measured (gantry day cine, 800 targets, tests/heightlod-probe.mjs)

| pose | main calls | cube(6f) calls | ladder |
|---|---|---|---|
| dockyard | 325→289 (−11%) | 1900→1762 | 240 no-shadow / 333 hidden |
| harbor | 234→215 (−8%) | 2007→1858 | 256 / 256 |
| straight | 749→675 (−10%) | 1932→1732 | 188 / 489 |
| ontrack | 276→253 (−8%) | 1956→1842 | 257 / 247 |

Visual A/B (tests/heightlod-pixdiff.mjs, full-vs-ladder at 1280×720): worst
pose changes **0.19%** of pixels, chase-height on-track pose **0.02%** — and
that is the *sum* of every demoted object at once, so any single transition is
far below perception.

## Gotchas / notes

* The replay suite is UNAFFECTED (identical pass/fail set with and without the
  ladder — the 3 current failures are pre-existing on `feat/procedural-cars`,
  physics pins broken by the in-progress car rework).
* The ladder runs off the MAIN camera only; the cube-reflection pass inherits
  its state (fine — the probe numbers above include it).
* `lod.update(cam, 1e9)` is the probe trick to force everything back to
  level 0 (huge viewport ⇒ every projected height enormous) for A/B baselines.
* Tuning lives in one place (`LOD_PX`); raise `hide` for more cull at more pop
  risk, `shadowOff` is nearly free (a <16 px object's shadow is sub-texel in
  the 1536² map).
* `window.__game.lodStats()` = live ladder census.
