# Kenney Nature Kit (cherry-picked) — coastal/nature scatter for GANTRY POINT

- Source: https://kenney.nl/assets/nature-kit (direct zip: https://kenney.nl/media/pages/assets/nature-kit/37ac38a37b-1677698939/kenney_nature-kit.zip, v2.1)
- License: CC0 1.0 (see License.txt). No attribution required.
- All GLBs are self-contained (vertex colors / embedded data, no external textures).
- NATIVE SCALE WARNING: this kit is authored at *tile scale* — a "tall palm" is ~1.4 units high.
  Everything below needs roughly 3x-7x uniform scale to read as metres next to a 4.5 m car.
  All models sit on the origin with a tiny -0.05 lip below y=0 (drop them flush on the ribbon at y~0).

Sizes are native W x H x D from the GLB accessor bounds; "in-game" is the suggested scaled footprint.

## Palms (beach + start straight)
| file | native | in-game suggestion |
| --- | --- | --- |
| tree_palm.glb | 0.94 x 1.51 x 1.01 | x5.5 → ~8 m palm |
| tree_palmBend.glb | 0.94 x 1.38 x 1.01 | x5.5 → ~7.5 m leaning palm |
| tree_palmTall.glb | 1.03 x 1.36 x 1.03 | x6.5 → ~9 m slim palm |
| tree_palmDetailedShort.glb | 1.46 x 1.12 x 1.46 | x5 → ~5.5 m bushy palm, wide 7 m crown |
| tree_palmDetailedTall.glb | 1.46 x 1.42 x 1.46 | x6 → ~8.5 m bushy palm |

## Windswept pines (Lookout Ess knoll, cliff tops)
| file | native | in-game suggestion |
| --- | --- | --- |
| tree_pineTallA_detailed.glb | 0.39 x 1.53 x 0.39 | x7 → ~11 m pine |
| tree_pineTallC_detailed.glb | 0.48 x 1.67 x 0.55 | x7 → ~12 m pine |
| tree_pineRoundB.glb | 0.53 x 1.20 x 0.61 | x6 → ~7 m round pine |
| tree_pineSmallA.glb | 0.50 x 0.97 x 0.50 | x5 → ~5 m sapling filler |

## Rocks and boulders (cliff stretch, CLIFF CRASH zone)
`rock_*` are brown/earthy, `stone_*` are grey — mix for variety.
| file | native | in-game suggestion |
| --- | --- | --- |
| rock_largeA.glb | 0.78 x 0.26 x 1.02 | x3 → flat 3 m slab |
| rock_largeB.glb | 0.77 x 0.43 x 1.02 | x3 → 3 m boulder |
| rock_largeD.glb | 1.07 x 0.57 x 1.03 | x3 → 3 m rounded boulder |
| rock_tallA.glb | 0.98 x 1.00 x 0.68 | x3-4 → 3-4 m upright outcrop |
| rock_tallB.glb | 0.76 x 0.88 x 0.77 | x3-4 → upright outcrop |
| rock_tallH.glb | 0.57 x 0.71 x 0.66 | x3 → 2 m spike |
| rock_smallE.glb | 0.36 x 0.26 x 0.31 | x2-3 → verge scatter |
| rock_smallH.glb | 0.46 x 0.41 x 0.46 | x2-3 → verge scatter |
| stone_largeA.glb | 0.78 x 0.26 x 1.02 | grey twin of rock_largeA |
| stone_largeC.glb | 1.06 x 0.32 x 1.02 | grey flat slab |
| stone_tallA.glb | 0.98 x 1.00 x 0.68 | grey twin of rock_tallA |
| stone_tallE.glb | 0.46 x 0.44 x 0.53 | grey small upright |

## Bushes + grass (cheap scatter)
| file | native | in-game suggestion |
| --- | --- | --- |
| plant_bush.glb | 0.40 x 0.24 x 0.40 | x3 → 1.2 m bush |
| plant_bushDetailed.glb | 0.60 x 0.36 x 0.60 | x3 → 1.8 m bush |
| plant_bushLarge.glb | 0.37 x 0.24 x 0.34 | x3-4 → hedge filler |
| plant_bushSmall.glb | 0.38 x 0.21 x 0.34 | x2 → low shrub |
| grass.glb | 0.38 x 0.25 x 0.39 | x2-3 → 1 m grass tuft |
| grass_large.glb | 0.41 x 0.25 x 0.41 | x2-3 → 1 m grass clump |
| grass_leafs.glb | 0.23 x 0.14 x 0.26 | x2 → small tuft |

## Wooden fences (village edges, knoll)
1-unit-long chainable segments; scale ~x2.5 and place end-to-end (2.5 m per segment).
| file | native | in-game suggestion |
| --- | --- | --- |
| fence_simple.glb | 1.00 x 0.35 x 0.07 | post-and-rail |
| fence_simpleHigh.glb | 1.04 x 0.35 x 0.11 | taller variant |
| fence_planks.glb | 1.00 x 0.35 x 0.10 | plank fence |
| fence_gate.glb | 1.00 x 0.35 x 0.07 | gate segment |

## Beach odds and ends
| file | native | in-game suggestion |
| --- | --- | --- |
| canoe.glb | 0.30 x 0.18 x 1.15 | x3 → 3.5 m beached canoe/dinghy |
| log.glb | 0.23 x 0.17 x 0.71 | x3 → 2 m driftwood |
| log_large.glb | 1.00 x 0.42 x 0.55 | x3 → 3 m driftwood with stump |
| sign.glb | 0.30 x 0.41 x 0.07 | x3.5 → 1.4 m wooden sign (cliff-warning fallback) |
