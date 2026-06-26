import * as THREE from 'three';

// A small tileable value-noise normal map → a gentle glassy surface wobble that
// bends the transmission/reflection a touch off-flat, the 3-D analogue of
// LiquidGlass's grain + lens distortion. Built once at module load; driven onto
// the pane as a clearcoatNormalMap (the clear lacquer ripples, the tint stays
// even). Kept low-frequency and low-amplitude so it never reads as dirt.
export function makeGlassWarpMap(): THREE.DataTexture {
  const S = 64;
  const h = new Float32Array(S * S);
  // a couple of octaves of hashed value noise, smoothed
  const hash = (x: number, y: number): number => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      let amp = 1;
      let freq = 1;
      for (let o = 0; o < 3; o++) {
        const fx = (x / S) * freq * 6;
        const fy = (y / S) * freq * 6;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const a = hash(ix, iy);
        const b = hash(ix + 1, iy);
        const c = hash(ix, iy + 1);
        const d = hash(ix + 1, iy + 1);
        v += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
        amp *= 0.5;
        freq *= 2;
      }
      h[y * S + x] = v;
    }
  }
  // height → tangent-space normal via central differences
  const data = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  const strength = 2.0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * S + x) * 4;
      data[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.needsUpdate = true;
  return tex;
}
