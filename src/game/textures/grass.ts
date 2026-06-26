import * as THREE from 'three';
import { canvas, hash01, wrapped } from './shared';

// ===========================================================================
// GRASS + GRASS→SAND DUNE-LIP TRANSITION (art-grass-sand pass)
// ---------------------------------------------------------------------------
// The island ground was a flat untextured MeshStandardMaterial (one slab of
// 0x59614f). These two append-only textures give the SW beach grass real
// surface and turn the grass→sand polygon seam into a natural dune lip.
//
// Techniques applied (all hash-stable like the rest of this module so the
// refshot poses diff clean):
//
//  • LAYERED TONAL VARIATION — base green + soft tonal blotches in three
//    families (fresh/lush, drier yellow-green, deep shadow) so the lawn never
//    reads as one flat fill. The "layer color once the base is down" workflow
//    from stylized-grass material breakdowns (Anartbrand, Substance Designer;
//    E. Kelemen, "Simple, Performant stylized grass in UE4").
//    https://anartbrand.com/creating-stylized-grass-in-substance-designer/
//    https://medium.com/@elliekelemen/simple-performant-stylized-grass-in-unreal-engine-4-345a2213576
//  • PATCH / CLUMP STRUCTURE — grass grows in clumps, not an even carpet:
//    big soft Voronoi-ish tonal cells break the field the way procedural
//    grass tools cluster blades (cainrademan/Unity-Grass; Substance Voronoi).
//    https://github.com/cainrademan/Unity-Grass
//  • FIBRE / BLADE STROKES — sparse short directional ticks add a hint of
//    blade texture at grazing angles without a per-blade mesh.
//  • HEIGHT-THRESHOLD BLEND EDGE (the dune lip) — instead of a linear alpha
//    fade (which reads as a ~tens-of-metres green-tinted smear), the
//    grass→sand boundary is a NOISE/HEIGHT field thresholded per-pixel, so
//    grass survives in broken clumps and tongues that finger into the sand —
//    Radiator's "blend transition mask" technique (compare a height/noise
//    value against the fade ramp; keep grass where noise > ramp).
//    https://www.blog.radiator.debacle.us/2013/09/hacking-blend-transition-masks-into.html

/** Value-noise sampled on a small lattice with smootherstep interpolation and
 *  two octaves — a cheap stand-in for Perlin used to drive the grass clumps
 *  and the dune-lip blend edge. Wraps on `period` so a tile stays seamless
 *  under RepeatWrapping. Deterministic (hash01 lattice). */
function valueNoise(x: number, y: number, period: number): number {
  const lat = (ix: number, iy: number): number => hash01(((ix % period) + period) % period * 73.1 + ((iy % period) + period) % period * 19.7 + 4.0);
  const smoother = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  const oct = (fx: number, fy: number): number => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const sx = smoother(fx - x0);
    const sy = smoother(fy - y0);
    const n00 = lat(x0, y0);
    const n10 = lat(x0 + 1, y0);
    const n01 = lat(x0, y0 + 1);
    const n11 = lat(x0 + 1, y0 + 1);
    return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
  };
  // two octaves: broad clumps + a finer break-up
  return oct(x, y) * 0.65 + oct(x * 2, y * 2) * 0.35;
}

/** Rich island grass: a tileable lawn for the GANTRY POINT coastal island.
 *  Replaces the flat 0x59614f fill. World-tiled by environment.ts (the same
 *  (x,−z) raw-shape UV rule the ground patches use), so a tile covers a few
 *  metres and the clumps read as metres of meadow, never as noise. */
export function makeGrassTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, g] = canvas(N);
  // base: a healthy sea-island green, lighter + a touch more saturated than
  // the old 0x59614f flat so the lit lawn reads lush under the Preetham sky
  // rather than murky-dark.
  g.fillStyle = '#69744c';
  g.fillRect(0, 0, N, N);

  // CLUMP LAYER: paint a value-noise field as soft tonal cells — lush green
  // in the highs, a drier khaki-green in the lows — so the lawn grows in
  // broad patches. Lower frequency (5 cells) + a smoother blend than the
  // first pass so it reads as metres-wide clumps, not pixel grain.
  const lush = [0x78, 0x88, 0x52];
  const dry = [0x86, 0x82, 0x55];
  const img = g.getImageData(0, 0, N, N);
  const d = img.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // 5-cell lattice over the tile (period 5 → seamless wrap), big clumps
      const n = valueNoise((x / N) * 5, (y / N) * 5, 5);
      const t = (n - 0.5) * 1.3; // -0.65..0.65
      const i = (y * N + x) * 4;
      if (t > 0) {
        const k = Math.min(1, t) * 0.5;
        d[i] = d[i] + (lush[0] - d[i]) * k;
        d[i + 1] = d[i + 1] + (lush[1] - d[i + 1]) * k;
        d[i + 2] = d[i + 2] + (lush[2] - d[i + 2]) * k;
      } else {
        const k = Math.min(1, -t) * 0.42;
        d[i] = d[i] + (dry[0] - d[i]) * k;
        d[i + 1] = d[i + 1] + (dry[1] - d[i + 1]) * k;
        d[i + 2] = d[i + 2] + (dry[2] - d[i + 2]) * k;
      }
    }
  }
  g.putImageData(img, 0, 0);

  // SHADOW BLOTCHES: a few deep soft pools give the meadow depth between the
  // clumps; a matching set of LIGHT pools catches the sun — paired so the
  // field has highs and lows, not just darkening. Wrapped to stay seamless.
  for (let i = 0; i < 20; i++) {
    const x = hash01(i * 9 + 900) * N;
    const y = hash01(i * 9 + 901) * N;
    const r = 14 + hash01(i * 9 + 902) * 30;
    const light = hash01(i * 9 + 905) < 0.45;
    wrapped(N, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 1, px, py, r);
      gr.addColorStop(0, light ? 'rgba(150,166,96,0.22)' : 'rgba(54,62,38,0.26)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }

  // FIBRE STROKES: sparse short upright ticks in lighter/darker greens — a
  // hint of blade direction that reads at the raking dune-lip camera angle.
  // Kept sparse + thin so they texture the surface without graining it.
  for (let i = 0; i < 150; i++) {
    const x = hash01(i * 3 + 1000) * N;
    const y = hash01(i * 3 + 1001) * N;
    const up = 2 + hash01(i * 3 + 1002) * 4;
    const lean = (hash01(i * 3 + 1003) - 0.5) * 2.2;
    const light = hash01(i * 3 + 1004) < 0.5;
    g.strokeStyle = light ? 'rgba(140,158,90,0.30)' : 'rgba(54,64,38,0.28)';
    g.lineWidth = 1;
    wrapped(N, x, y, up + 2, (px, py) => {
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + lean, py - up);
      g.stroke();
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Dune-lip blend overlay: a TRANSPARENT grass fringe drawn ON TOP of the
 *  sand at the beach boundary so the green island grass appears to thin into
 *  the sand in broken tongues, not stop at a polygon seam. v runs INLAND
 *  (0 = full grass) → SEAWARD (1 = bare sand); flipY off so the canvas reads
 *  in that order. u tiles along the shore.
 *
 *  The edge is a HEIGHT-THRESHOLD blend (Radiator): at each pixel a value-
 *  noise "grass height" is compared to a ramp that rises with v; grass is
 *  kept (opaque) where noise beats the ramp, dropped (clear) where it loses.
 *  Near v=0 the ramp is low so grass wins everywhere; past the mid the ramp
 *  climbs so only the tallest noise clumps survive — grass dissolves into
 *  islands and fingers instead of a flat alpha gradient. */
export function makeDuneBlendTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, g] = canvas(N);
  const img = g.createImageData(N, N);
  const d = img.data;
  // grass colours matching makeGrassTexture's clump families: lush green
  // inland, drying to a khaki-green tip where the fingers reach the sand so
  // the fringe hands off to the tan without a colour pop.
  const lush = [0x6f, 0x80, 0x4c];
  const edge = [0x90, 0x8c, 0x5a];
  for (let y = 0; y < N; y++) {
    const v = y / (N - 1); // 0 inland → 1 seaward
    // ramp: grass kept where noise > ramp. Solid for the inland quarter (so
    // the fringe welds onto the lawn), then climbs past 1 so it dissolves to
    // nothing by the seaward edge — a height-threshold blend, not a flat fade.
    const ramp = v < 0.25 ? -0.05 : Math.pow((v - 0.25) / 0.75, 1.35) * 1.2;
    for (let x = 0; x < N; x++) {
      const u = x / N;
      // anisotropic noise: stretched along v so survivors read as vertical
      // tongues fingering down into the sand, not round blobs. Two scales of
      // u-detail break the finger edges into smaller blades near the tips.
      const n = valueNoise(u * 8, v * 4.5, 8) * 0.7 + valueNoise(u * 17, v * 9, 17) * 0.3;
      const keep = n - ramp; // > 0 → grass survives here
      const i = (y * N + x) * 4;
      if (keep > 0) {
        // soft AA rim on the threshold so tongues aren't jagged
        const a = Math.min(1, keep / 0.1);
        const m = Math.min(1, v * 1.25);
        d[i] = lush[0] + (edge[0] - lush[0]) * m;
        d[i + 1] = lush[1] + (edge[1] - lush[1]) * m;
        d[i + 2] = lush[2] + (edge[2] - lush[2]) * m;
        d[i + 3] = Math.round(a * 255);
      } else {
        d[i + 3] = 0; // bare — the sand patch shows through
      }
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
