import * as THREE from 'three';
import { canvas, hash01, wrapped } from './shared';

/** WET beach sand: the strip the swash has just soaked. Darker, cooler and
 *  much smoother than dry sand (the water fills the grain voids and mirrors
 *  the sky), with the wave's DIRECTIONAL DRAG marks — long low arcs raked
 *  toward the sea — and a scatter of trapped-water glints. Tiles seamlessly
 *  along the coast. Pairs with a low-roughness material so scene.environment
 *  (the PMREM sky) gives the wet sheen; the dark base does the wet read.
 *  Wet-sand authoring per the 80.lv Substance beach study (gradient warped
 *  by Perlin + anisotropic/directional drag noise, lower noise than dry). */
export function makeWetSandTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  // darker, slightly desaturated/cooler base than dry #dcc69b
  g.fillStyle = '#9d8a64';
  g.fillRect(0, 0, 256, 256);
  // broad damp drift — patches where water still pools read even darker
  for (let i = 0; i < 18; i++) {
    const x = hash01(i * 7 + 900) * 256;
    const y = hash01(i * 7 + 901) * 256;
    const r = 30 + hash01(i * 7 + 902) * 64;
    const wetter = hash01(i * 7 + 903) < 0.5;
    wrapped(256, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 2, px, py, r);
      gr.addColorStop(0, wetter ? 'rgba(108,96,70,0.30)' : 'rgba(86,76,56,0.30)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // directional wave-drag arcs: long, shallow, raked the same way (the
  // anisotropic drag the receding swash leaves) — far fewer, longer strokes
  // than dry sand's grain, which is what makes wet sand read as smoother
  g.lineWidth = 1.4;
  for (let i = 0; i < 30; i++) {
    const x = hash01(i * 5 + 940) * 256;
    const y = hash01(i * 5 + 941) * 256;
    const len = 60 + hash01(i * 5 + 942) * 90;
    const bow = 6 + hash01(i * 5 + 943) * 10; // consistent rake direction
    g.strokeStyle = hash01(i * 5 + 944) < 0.5 ? 'rgba(78,68,50,0.34)' : 'rgba(150,134,100,0.26)';
    wrapped(256, x, y, len, (px, py) => {
      g.beginPath();
      g.moveTo(px - len / 2, py);
      g.quadraticCurveTo(px, py + bow, px + len / 2, py);
      g.stroke();
    });
  }
  // light grain (sparse — wet sand has far less visible tooth than dry)
  for (let i = 0; i < 500; i++) {
    const x = hash01(i * 3 + 980) * 256;
    const y = hash01(i * 3 + 981) * 256;
    g.fillStyle = hash01(i * 3 + 982) < 0.5 ? 'rgba(72,62,46,0.4)' : 'rgba(140,124,92,0.3)';
    g.fillRect(x, y, 1.4, 1.4);
  }
  // trapped-water glints: tiny bright specks the sheen catches
  for (let i = 0; i < 22; i++) {
    const x = hash01(i * 11 + 1020) * 256;
    const y = hash01(i * 11 + 1021) * 256;
    g.fillStyle = 'rgba(228,234,232,0.5)';
    g.fillRect(x, y, 1.6, 1.6);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Tileable TANGENT-SPACE NORMAL MAP for dry beach sand. Two perturbations,
 *  both baked into one map so MeshStandardMaterial's normalMap path lights
 *  them through the normal PBR pipeline (no shader rewrite):
 *
 *   • DUNE RIPPLES — low-frequency wind waves. Adapted from Alan Zucconi's
 *     "Journey Sand Shader #6 (Sand Ripples)": Zucconi blends a shallow/steep
 *     ripple normal map by slope; on our near-flat skirt we bake a single
 *     anisotropic ripple band (a summed-sine height field, raked along one
 *     wind axis) straight into the height before differentiating.
 *   • GRAIN — high-frequency per-grain tilt. Adapted from "#3 (Sand Normal)":
 *     Zucconi samples a random unit vector and nlerps the normal toward it;
 *     we fold an equivalent hashed high-freq height jitter into the same field
 *     so the grain tooth catches the directional light.
 *
 *  https://www.alanzucconi.com/2019/10/08/journey-sand-shader-3/
 *  https://www.alanzucconi.com/2019/10/08/journey-sand-shader-6/
 *  Height field H(x,y) is sampled at the 4 neighbours and the normal is the
 *  cross of its tangents (the standard finite-difference normal-from-height),
 *  encoded to RGB. Deterministic via hash01 so the refshot harness diffs. */
export function makeSandNormalTexture(): THREE.CanvasTexture {
  const N = 256;
  const [c, g] = canvas(N);
  // value-noise helper: smooth hashed lattice so the grain isn't pure static
  const vnoise = (x: number, y: number, freq: number, seed: number): number => {
    const fx = x * freq;
    const fy = y * freq;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx); // smoothstep
    const sy = ty * ty * (3 - 2 * ty);
    // wrap the lattice on the tile period (N*freq) so the map tiles seamlessly
    const period = Math.max(1, Math.round(N * freq));
    const h = (ax: number, ay: number) =>
      hash01(((((ax % period) + period) % period) * 73856093) ^ ((((ay % period) + period) % period) * 19349663) + seed);
    const a = h(ix, iy);
    const b = h(ix + 1, iy);
    const cc = h(ix, iy + 1);
    const d = h(ix + 1, iy + 1);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (cc * (1 - sx) + d * sx) * sy;
  };
  // HEIGHT field: anisotropic dune ripples (summed sines raked ~20° off the
  // u axis, the wind direction) + two octaves of grain value-noise. All in
  // tile space [0..1) so it tiles. Amplitudes are gentle — sand, not rock.
  const RIPPLE_DIR_X = Math.cos(0.35);
  const RIPPLE_DIR_Y = Math.sin(0.35);
  const height = (px: number, py: number): number => {
    const x = px / N;
    const y = py / N;
    const along = x * RIPPLE_DIR_X + y * RIPPLE_DIR_Y; // raked coordinate
    // ripples: two close frequencies so crests beat into long dunes, integer
    // cycle counts keep them seamless across the tile
    let h = 0;
    h += Math.sin(along * Math.PI * 2 * 7) * 0.5;
    h += Math.sin(along * Math.PI * 2 * 11 + 1.7) * 0.28;
    // slight cross-ripple wobble so the crests aren't ruler-straight
    h += Math.sin((x * 5 - y * 3) * Math.PI * 2 + 0.6) * 0.12;
    h *= 0.55; // ripple amplitude
    // grain: high-freq tooth, two octaves
    h += (vnoise(px, py, 1 / 6, 0) - 0.5) * 0.9;
    h += (vnoise(px, py, 1 / 2.5, 91) - 0.5) * 0.5;
    return h;
  };
  const img = g.createImageData(N, N);
  const STRENGTH = 2.4; // overall bump strength (xy slope scale)
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      // central differences with wrap → seamless tangent-space normal
      const hl = height((px - 1 + N) % N, py);
      const hr = height((px + 1) % N, py);
      const hd = height(px, (py - 1 + N) % N);
      const hu = height(px, (py + 1) % N);
      let nx = (hl - hr) * STRENGTH;
      let ny = (hd - hu) * STRENGTH;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const i = (py * N + px) * 4;
      img.data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace; // normal data is linear, NOT sRGB
  return t;
}

/** GLITTER microfacet map for the sand sparkle (Alan Zucconi "Journey Sand
 *  Shader #5 — Glitter"). Each texel is a RANDOM UNIT NORMAL packed into RGB
 *  ([-1,1] → [0,1]); the sand shader injection reflects the light off these
 *  micro-mirrors and only the few whose reflection nearly hits the eye glint.
 *  High-frequency + tiled, so at world scale each glint is a single grain.
 *  https://www.alanzucconi.com/2019/10/08/journey-sand-shader-5/
 *  Deterministic (hash01) so the refshot harness diffs cleanly. */
export function makeSandGlitterTexture(): THREE.CanvasTexture {
  const N = 128;
  const [c, g] = canvas(N);
  const img = g.createImageData(N, N);
  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      const i = py * N + px;
      // two hashes → a random direction on the unit sphere, biased to the
      // upper hemisphere (z>0) so most facets face roughly outward like grains
      const u = hash01(i * 2 + 1) * 2 - 1; // azimuth-ish
      const v = hash01(i * 2 + 2); // 0..1
      const phi = u * Math.PI;
      const z = 0.35 + v * 0.65; // upper hemisphere bias
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const nx = Math.cos(phi) * r;
      const ny = Math.sin(phi) * r;
      const o = i * 4;
      img.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
      img.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      img.data[o + 2] = Math.round((z * 0.5 + 0.5) * 255);
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter; // crisp per-grain facets, no smearing
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace; // direction data, linear
  return t;
}
