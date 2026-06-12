# Kenney Pirate Kit (cherry-picked) — boats, surf rocks, pier for GANTRY POINT

- Source: https://kenney.nl/assets/pirate-kit (direct zip: https://kenney.nl/media/pages/assets/pirate-kit/e6d4bb1525-1771333093/kenney_pirate-kit.zip, v2.1)
- License: CC0 1.0 (see License.txt). No attribution required.
- IMPORTANT: every GLB in this pack references `Textures/colormap.png` by RELATIVE URI.
  Keep the `Textures/` folder next to the GLBs and load them from this directory
  (three.js GLTFLoader resolves the texture relative to the model URL, so this works as-is).
- Unlike the Nature Kit, this kit is authored near metre scale — most models are close to drop-in.
  All models sit flush at y=0.

Sizes are native W x H x D from the GLB accessor bounds; "in-game" is the suggested scaled footprint.

## Boats (beach + shallows; visual only)
| file | native | in-game suggestion |
| --- | --- | --- |
| boat-row-large.glb | 2.75 x 0.85 x 2.85 | x1.5 → ~4 m rowboat (bbox includes shipped oar) |
| boat-row-small.glb | 2.75 x 0.85 x 2.37 | x1.5 → ~3.5 m rowboat |
| ship-wreck.glb | 4.80 x 9.96 x 10.60 | x1.2-1.5 → 13-16 m wrecked hull, mast stub ~12 m; plant it on the surf rocks off Cannery Point |

## Surf rocks / cliff clusters (CLIFF CRASH centerpiece)
`rocks-sand-*` sit in a sand skirt (beach waterline); `rocks-*` are bare (cliff base).
| file | native | in-game suggestion |
| --- | --- | --- |
| rocks-a.glb | 5.11 x 2.90 x 4.39 | x1.5-2.5 → 8-13 m rock cluster |
| rocks-b.glb | 4.44 x 3.65 x 4.70 | x1.5-2.5 → taller cluster |
| rocks-sand-a.glb | 5.11 x 3.21 x 4.39 | x1.5-2 → surf rocks w/ sand base |
| rocks-sand-b.glb | 4.38 x 3.71 x 4.71 | x1.5-2 → surf rocks w/ sand base |
| rocks-sand-c.glb | 3.71 x 2.61 x 3.72 | x1.5-2 → smaller surf rocks |

## Palms (bent variants — different silhouette than the Nature Kit palms)
| file | native | in-game suggestion |
| --- | --- | --- |
| palm-bend.glb | 2.88 x 4.25 x 3.22 | x1.5-2 → 6.5-8.5 m beach palm leaning over the sand |
| palm-detailed-bend.glb | 2.88 x 4.25 x 3.22 | same pose, fuller fronds |

## Beach ground patches
| file | native | in-game suggestion |
| --- | --- | --- |
| patch-sand.glb | 7.74 x 0.25 x 6.04 | x1-2 → 8-15 m sand blob to break up the ground plane at the beach |
| patch-sand-foliage.glb | 7.74 x 0.56 x 6.04 | same with grass tufts baked in |

## Structures
| file | native | in-game suggestion |
| --- | --- | --- |
| tower-watch.glb | 3.05 x 2.79 x 3.05 | x2.5-3 → ~8 m wooden lookout tower (Lookout Ess knoll fallback) |
| structure-platform-dock.glb | 2.50 x 1.31 x 2.51 | x1.5-2 → chainable pier section on stilts |
| structure-platform-dock-small.glb | 1.90 x 1.31 x 2.51 | x1.5-2 → pier end/narrow section |
