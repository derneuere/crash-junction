# Gantry shadow draw-call plan — same-looking shadows for fewer casters

> Planning document. No code in this slice. Presentation-only / pin-safe throughout
> (the shadow map never enters the sim/replay hash; see "Pin-safety" at the end).

## Problem (measured numbers, honest priority)

Frame-exact draw-call averages at the frozen gantry "dockyard" pose:

| Config | Draw calls | FPS |
| --- | --- | --- |
| Baseline (all on) | **1441** | 31 |
| **Shadows OFF** | **1304** | 42 |

So the sun's shadow depth pass costs **≈ 137 draw calls** — one extra render of every shadow caster currently in the ±32 m follow-rig frustum.

**Be honest about priority.** This is the **smallest of the three big levers** the perf HUD exposes:

- Cube reflection ≈ **810** draws (sibling "reflections" plan — `docs/research/perf-reflections-plan.md`)
- Props ≈ **870** draws
- **Shadows ≈ 137** draws ← this plan

The shadow pass is worth a **cheap, low-risk win** but it is NOT where the framerate is won. The reflection and prop levers are ~6× bigger. The right framing for this slice: *recover a meaningful fraction of the 137 with a static, determinism-safe, zero-per-frame-cost change — and stop there.* Do not over-engineer a 137-draw problem.

### Why the shadow pass costs 137 draws (what it actually renders)

`src/game/Game/core.ts` constructor sets up a single `THREE.DirectionalLight` sun with `castShadow = true`, `PCFSoftShadowMap`, `bias -0.0008`, `shadow.camera.far 180`, and a follow-rig orthographic frustum tightened to **±32 m around the player** (`shadow.camera.{left,right,top,bottom} = ∓32`). `updateShadowRig()` re-aims it (texel-snapped) every frame. The cine map is **3072²** (`applyRenderPath`), fast/headless **2048²**.

On a shadow render, three draws **every caster whose bounds intersect that ±32 m box**, once. At the dockyard pose the casters in range are:

- **Props** — `src/game/props.ts` ~line 124 sets `m.castShadow = m.receiveShadow = true` on **every** sub-mesh of **every** prop, batched into per-tile `InstancedMesh`es + singletons by `propinstancer.ts` (which copies `castShadow` through, lines 148/162/234/243). Gantry dresses ~300 hand-placed props; an in-frustum subset of their instanced tiles + singletons casts.
- **Buildings + ramps** — `src/game/environment/build.ts`: each tower/shed block (`bld.castShadow = true`, ~line 235) and each launch ramp (`mesh.castShadow = true`, ~line 267) casts. Sidewalk walks are `receiveShadow` only (correctly — a flat slab casts nothing).
- **Cars** — player + nearby rivals/traffic.
- **Ground / road / patches** — `receiveShadow` only, never cast (good).

The shadow map is rendered **once per frame** for the main view, then the cube reflection **reuses it** (`reflections.ts` sets `renderer.shadowMap.autoUpdate = false` for the 6-face capture). So the 137 draws are paid **once**, NOT ×6 — cutting a caster saves exactly one shadow draw per frame (it does, however, also save shadow-map **texels**, which helps fill on every cube face that samples the map). This is the structural reason the shadow lever is small: unlike props/reflection it does not multiply through the cube.

### What fraction of the 137 is decor

Reading `dockyard.ts` / `harbor.ts` and the `dressing.ts` `decor()` helper, gantry props split cleanly into two authored classes:

- **Structural / large** (carry an explicit `collider`, or are visually tall): lattice tower cranes (~13 m), STS gantry cranes, the level-luffing harbor cranes, the BOX2 container stacks, warehouse sheds (`building-s/-k`), the 20 m chimney + silo, the lighthouse, the moored freighter/container-ship. These have genuine tall silhouettes whose shadows **read on the ground** and must keep casting.
- **Pure decor** (`decor(...)`, `collider: 'none'`, small/flat): bollards, lamp-posts, pallets, crates, tire/wheel stacks, pylons, warning signs, forklifts, surf rocks — **plus every y-lifted upper container** in a stack (the 2nd/3rd boxes at `y: 2.6 / 5.2` are authored as `decor` riding on a BOX1/BOX2 collider). By count, decor is the **majority of placed props**.

The decor pieces are short and ground-hugging: a 0.8 m bollard, a flat pallet, a tire pile, a lamp base — their cast shadows are either tiny, self-occluded into the contact AO already baked by `ao.ts`, or fall under a neighbouring container. They contribute draw calls (and shadow-map texels) for shadows a player cannot distinguish from the receiver's baked ambient darkening.

**Honest estimate:** props are the bulk of the 137 (buildings ≈ 4–8 blocks + 2–4 ramps + cars ≈ 6–10 are a small slice). Of the prop share, decor is the majority of *placements* but tends to instance into **few tiles** (many short props share one geometry → one `InstancedMesh` per tile), so the *draw-call* payoff is smaller than the placement count suggests. Realistic recoverable range from pruning decor casters: **~40–80 of the 137** (roughly **3–5 fps** of the 11-fps shadows-off swing). Treat the upper end as optimistic; measure at the pose.

---

## Options (with tradeoffs)

### Option A — Static caster pruning by prop class — **recommended core**

Stop decor props from casting; keep the player, cars, and large structures casting. The decision is **static per prop** (made at build time from `PropDef`), never per frame.

**Why static, not radius-per-frame.** A tempting alternative is "disable `castShadow` on props beyond R metres of the player each frame." Avoid it:
- Toggling `castShadow` on a mesh **dirties the shadow map** — three must re-render it — and worse, flipping it as props cross the radius makes shadows **pop in/out** at the boundary as the player drives. Visible, and churny.
- The follow-rig frustum **already** culls everything beyond ±32 m from the depth pass for free (three's own shadow-camera frustum test). A per-frame radius is redundant with the frustum cull for the far props and harmful for the near ones.

So the lever is **which props are allowed to cast at all**, decided once:

1. Add an opt-out to the prop authoring path. Cleanest is a `castShadow?: boolean` field on `PropDef` (`src/game/types/level.ts`), defaulting to "cast". The `decor()` helper in `src/game/levels/gantry/dressing.ts` sets `castShadow: false` by default (every `decor()` prop is, by definition, the non-collider set-dressing class), while explicit collider props (cranes, sheds, stacks, freighter) keep casting. This makes the structural-vs-decor split — already encoded by `collider` presence — drive the shadow split with **near-zero edit surface** (one helper change covers all decor; a handful of large `decor()` exceptions like the upper stacked containers / cranes-authored-as-decor can opt back in with `castShadow: true`).
2. `src/game/props.ts` (~line 124): instead of unconditionally `m.castShadow = true`, set `m.castShadow = def.castShadow ?? (def.collider !== 'none' && def.collider !== undefined)` (or read the explicit field). `receiveShadow` stays `true` for everyone — decor should still *receive* the cranes' shadows, only stop *casting*.
3. `propinstancer.ts` already copies each source mesh's `castShadow` into the emitted `InstancedMesh`/plain mesh (lines 148/162/234/243), so a per-tile batch whose members are all non-casting decor emits a non-casting batch automatically — it simply drops out of the depth pass. **No instancer change needed.**

Expected savings: removes the decor share of the prop casters — **~40–80 draws** at the dockyard pose, plus the shadow-map texels those casters consumed (a small fill win that helps every cube face too). Frame average 1441 → **~1361–1401**; toward the 1304 shadows-OFF floor but never reaching it (we keep structural casters, by design). FPS gain ~**2–4** on top of whatever the reflection/prop levers deliver.

Fidelity risk: **low**, and tunable. The risk is a large-ish decor piece (a tall floodlight mast authored as a collider — already kept; a big rock; a forklift) losing a shadow you'd notice. Mitigation: the per-prop `castShadow: true` opt-in lets any decor piece that visibly needs a shadow keep it. Walk the dockyard/harbor pose once and re-admit anything that reads.

### Option B — Lower shadow-map resolution / fewer PCFSoft taps

`3072²` cine map, `PCFSoftShadowMap`. Dropping to **2048²**, or `PCFShadowMap` (fewer taps), would cut shadow **fill / bandwidth**.

- **This is the FILL half, NOT draw calls.** Resolution and filter taps change how many texels the depth pass rasterises and how many samples the receiver does — they do **nothing** for the 137-draw count that gates the 31 fps. The draw-call bottleneck is unmoved.
- The cine map was *deliberately* sized: the constructor comment documents that `3072² / ±32 m` ≈ 20.8 mm texel pitch matches the old `4096² / ±38 m` rig and "PCFSoft blurs the ~2 mm difference away." Dropping to 2048² (≈ 31 mm pitch) **would** start to soften/crawl edges on the long crane shadows — a visible regression, against the "keep shadows looking the same" constraint.
- `PCFSoft → PCF` is a subtle edge-hardening; low risk but, again, zero draw-call payoff.

**Verdict: defer.** Resolution is a fill lever for GPUs that are fill-bound, not the draw-call problem here, and the current pitch is tuned to look identical. Mentioned for completeness; not part of the recommended change. (If a future low-end tier is fill-bound, 2048² is the knob — but only there.)

### Option C — Static-vs-dynamic shadow split (render world casters once, re-render only cars)

The world is static; only cars move. In principle the static casters' shadow contribution could be baked **once** and only the dynamic casters (cars) re-rendered each frame — collapsing the per-frame shadow pass to a handful of car draws.

**Assess three.js feasibility: not worth it for 137 draws.**
- three's built-in shadow map has no static/dynamic partition. `shadowMap.autoUpdate = false` + manual `needsUpdate` freezes the **whole** map — it cannot freeze the static casters while re-rendering only cars into the same map.
- A real split needs a **custom two-map scheme**: a static shadow map rendered once (or on big camera moves, since the follow-rig frustum slides with the player → the "static" world's projection changes every frame the player moves, so it is **not** actually static in light space) + a dynamic map for cars, sampled and `min()`-combined in a patched shadow shader. That is a large, fragile custom subsystem.
- The follow-rig kills the premise: because the shadow frustum tracks the player, the static world's shadow texels move every frame, so "render static once" would require re-projecting or a world-anchored (non-following) static map — re-introducing the wide-frustum cost the follow-rig exists to avoid.
- Payoff ceiling is 137 draws total, of which the static share is maybe ~120. Spending a custom dual-map shadow pipeline (with its own bugs and a determinism-review surface) to chase ~120 draws — when the reflection lever alone is 810 — is a clear **no**.

**Verdict: explicitly not recommended.** Documented so it is not revisited.

### Interaction with the cube reflection (and the sibling "reflections" agent)

Two facts about how this composes:

1. **The cube reuses the shadow map, it does not re-render it.** `reflections.ts` sets `renderer.shadowMap.autoUpdate = false` around the 6-face capture, so the shadow depth pass runs **once per frame** (main view) and all six cube faces sample that one map. Therefore caster pruning saves **one** shadow draw per frame per pruned caster (not ×6) — but the **texel** savings (a tighter, less-cluttered shadow map) benefit the main view *and* every cube face that samples it. This is exactly why the shadow lever is small in draws but still a clean win.
2. **Caster pruning and the reflection agent's prop-layer exclusion are orthogonal and compose cleanly.** The reflections plan (`perf-reflections-plan.md`, Option A) excludes props from the **cube** via `THREE.Layers` — it changes what the **cube camera** renders, on the **colour** pass. Caster pruning changes what the **shadow camera** renders, on the **depth** pass. They touch different cameras and different passes; neither depends on the other. A decor prop can be simultaneously: layer-0-only (invisible in the cube) **and** `castShadow = false` (absent from the depth pass) — both true, no conflict. If the reflection agent excludes the whole `cj-props` group from the cube, the props still cast on the **main-view** shadow map (which is what we're pruning here), so this plan stays relevant regardless of what they ship. No coordination needed beyond not both editing the same line in `props.ts` simultaneously.

---

## Recommended approach

**Adopt Option A (static caster pruning by prop class). Defer B (fill lever, no draw payoff, current pitch is tuned). Reject C (custom dual-map not worth 137 draws). Keep shadows ON.**

Concrete touch points:

1. **`src/game/types/level.ts`** — add `castShadow?: boolean;` to `PropDef` (presentation-only field; the collider/physics fields are untouched, so determinism is structurally unaffected).
2. **`src/game/levels/gantry/dressing.ts`** — in `decor()`, default `castShadow: false` (the decor class is set-dressing by definition). Add `castShadow: true` to the few large `decor()` exceptions that read as silhouettes — notably the **upper stacked containers** (the `y: 2.6 / 5.2` boxes that crown the BOX2 stacks: their bottom box casts, but the stack's full height should read, so opt the top boxes back in) and any large `decor()` rock/structure. Collider props are unaffected (they keep casting).
3. **`src/game/props.ts`** (~line 124) — replace the unconditional `m.castShadow = m.receiveShadow = true` with `m.receiveShadow = true; m.castShadow = def.castShadow ?? (def.collider != null && def.collider !== 'none');`. Keep `receiveShadow` for everyone (decor still catches the cranes' shadows).
4. **`propinstancer.ts`** — **no change**; it already propagates `castShadow` per source mesh into the batched/singleton meshes, so non-casting decor tiles drop out of the depth pass automatically.

Expected savings (dockyard pose): **~40–80 fewer draws** (frame average 1441 → ~1361–1401), **~2–4 fps**, plus a tighter shadow map (small fill win on the main view and every cube face). Honest scope: a fraction of the 137-draw shadows-OFF payoff, taken without losing any shadow a player would notice.

Fidelity risk: **low**. The only visible-change risk is a decor piece whose shadow you'd miss; the per-prop `castShadow: true` opt-in is the escape hatch. Structural shadows (cranes, sheds, stacks, freighter, cars, player) are byte-identical to today.

---

## Incremental rollout

1. **Slice 1 — `PropDef.castShadow` plumbing + `props.ts` gate + `decor()` default-off.** This is the whole win. Measure the dockyard pose against the table above (expect average ~1361–1401, shadows still visually intact). Walk the pose; note any decor shadow that's missed.
2. **Slice 2 — Re-admit the silhouettes.** Add `castShadow: true` to the upper stacked containers and any large `decor()` piece flagged in Slice 1's walkthrough. Re-measure; confirm no visible regression vs baseline screenshots.
3. **Slice 3 (defer / low-tier only) — Resolution fallback.** ONLY if a future low-end GPU target is fill-bound: drop the cine shadow map to 2048² behind a graphics tier. Not the draw-call lever; off the default path. Documented in Option B.

Each slice is independently shippable and measurable at the frozen pose. Slices 1–2 are the deliverable; Slice 3 is a contingency.

## Pin-safety note

All of the above is **presentation-only and pin-safe**:

- **`castShadow` / `receiveShadow` / `shadowMap` are render-time flags.** three reads them only inside the shadow/render walk. They do not touch cannon bodies, RNG, recorded keys, `worldHash`, or the camera transform (the camera transform **is** sim state and is **not** changed here — this plan only changes which meshes the *shadow* camera draws, never the main `this.camera` pose, never the follow-rig frustum's effect on the sim, which is none).
- The new `PropDef.castShadow` field is consumed **only** in the visual branch of `props.ts` (the same `.then()` that clones the GLB and batches it). The **collider** branch above it — the synchronous cannon body built from `def.collider` — is untouched, so the physics world is byte-identical. The determinism contract in `props.ts` ("Physics never sees the mesh") is preserved by construction.
- Headless verify (`?verify=1` / `forceFast`) renders pixels nobody hashes; shadow casters affect only the depth pass, never the sim step, so the replay suite is untouched by construction. The 3 pre-existing replay-fixture failures on origin/main are unrelated.

The replay suite must stay green; nothing in this plan writes sim state, so it will.
