# Grass assets — ported from FluffyGrass

These assets are the grass blade-clump geometry, alpha mask, and wind noise used
by `src/game/grass.ts` to render the island's instanced grass verges. They are
taken verbatim from the **FluffyGrass** demo so our grass matches that demo's
lush look from the chase camera.

## Source

- Project: **FluffyGrass** by Ebenezer (`thebenezer`)
- Repo: https://github.com/thebenezer/FluffyGrass
- Live demo: https://fluffygrass.vercel.app/
- License: **MIT** — Copyright (c) 2023 Ebenezer

The MIT license permits use, copy, and modification provided the copyright
notice is retained. The attribution is reproduced here and in the header comment
of `src/game/grass.ts`. Full license text below.

## Files

| file                | source (FluffyGrass `public/`) | what it is |
|---------------------|-------------------------------|------------|
| `grassLODs.glb`     | `grassLODs.glb` (unchanged)   | 3 LOD blade-clump meshes: `Grass.LOD00` (66 tris), `Grass.LOD01` (32 tris), `Grass.LOD02` (16 tris). Each is a small fanned card-cluster, ~0.33 m wide × ~0.13 m tall native; UVs run base→tip (v 0..1). |
| `grass-alpha.jpeg`  | `grass.jpeg` (renamed)        | white-on-black alpha mask of ~10 splayed grass blades. Cuts the wispy blade silhouette out of each LOD card — this is the "fluffy" lever. Sampled `.r`, `step(0.1, ...)` as alpha. |
| `perlinnoise.webp`  | `perlinnoise.webp` (unchanged)| tiling Perlin noise. Green channel drives the wind sine phase; red channel drives per-clump height/colour variation. RepeatWrapping. |

`grass1.jpeg`, `island.glb`, `fluffy_grass_text.glb`, and the `social*.webp`
previews from the demo are NOT used here (we scatter over our own level, not the
demo island).

## How they're used

`src/game/grass.ts` loads `grassLODs.glb` and the two textures asynchronously,
then drives an `InstancedMesh` per spatial tile scattered over the island's grass
verges (hard surface mask: grass only, off sand/road/buildings). The vertex
shader applies the demo's world-UV + perlin wind sway; the fragment shader
applies the demo's `baseColor → tipColor` vertical gradient and the alpha-mask
silhouette. See that file's header for the full attribution and the adaptations
(per-tile distance LOD/cull for our 600 m island, MeshStandard lighting so the
blades sit in our PMREM sky env across day/dusk/night).

---

## MIT License (FluffyGrass)

```
MIT License

Copyright (c) 2023 Ebenezer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
