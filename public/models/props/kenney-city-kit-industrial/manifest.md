# Kenney City Kit (Industrial) (cherry-picked)

- Source: https://kenney.nl/assets/city-kit-industrial (direct zip: https://kenney.nl/media/pages/assets/city-kit-industrial/5fcb837741-1750838303/kenney_city-kit-industrial_1.0.zip)
- License: CC0 1.0 (see License.txt) — no attribution required
- IMPORTANT: these .glb files reference an EXTERNAL texture `Textures/colormap.png`
  (relative URI). Keep the Textures/ subfolder next to the .glb files and load the
  models from this directory so the relative path resolves.

Native scale is Kenney "city tile" units. Buildings are ~0.7-0.9 units tall; for
believable 9-13 m warehouses multiply by ~12-15x. Origins at base (y=0).

| File | Native W x H x D | Description / suggested in-game footprint |
| --- | --- | --- |
| building-h.glb | 1.32 x 0.73 x 1.31 | Warehouse with roller door. Scale ~12x -> 16 x 9 x 16 m. Port-street block. |
| building-i.glb | 1.03 x 0.73 x 1.30 | Small pitched-roof shed with door. Scale ~12x -> 12 x 9 x 16 m. Cannery shed candidate. |
| building-j.glb | 1.03 x 0.86 x 1.30 | Quonset-hut (rounded roof) warehouse — very dockyard. Scale ~12x. |
| building-k.glb | 1.30 x 0.77 x 0.91 | Sawtooth-roof factory. Scale ~12x -> 16 x 9 x 11 m. |
| building-s.glb | 2.12 x 0.84 x 0.92 | Long low warehouse with orange roller doors. Scale ~12x -> 25 m quay shed. The Harbor Run wall piece. |
| chimney-large.glb | 1.00 x 1.70 x 1.00 | Big industrial smokestack. Scale ~12x -> 20 m landmark stack behind the warehouses. |
| detail-tank.glb | 0.85 x 0.42 x 0.52 | Horizontal storage tank with pipe. Scale ~10x -> 8.5 m fuel tank; pair with quaternius-cargo silo.glb. |

Windows are unlit decals baked into the colormap — for "lit windows at night" the
GDD fallback (BuildingDef boxes with emissive windows) is still the way.
