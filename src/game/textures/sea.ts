import * as THREE from 'three';
import { canvas, hash01, wrapped } from './shared';

/** Open water for the coast's sea plane: deep stylized blue-green with big
 *  soft tonal patches and sparse baked whitecap streaks. Tiles seamlessly;
 *  environment.ts repeats it so one tile covers ~100 m — a streak reads as
 *  a few metres of broken water from the race camera, never as noise. */
export function makeSeaTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(512);
  g.fillStyle = '#15607a';
  g.fillRect(0, 0, 512, 512);
  // large soft swells: alternating lighter/darker blobs keep the expanse
  // from reading as one flat slab of paint
  for (let i = 0; i < 42; i++) {
    const x = hash01(i * 5 + 1) * 512;
    const y = hash01(i * 5 + 2) * 512;
    const r = 50 + hash01(i * 5 + 3) * 100;
    const dark = hash01(i * 5 + 4) < 0.5;
    wrapped(512, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 2, px, py, r);
      gr.addColorStop(0, dark ? 'rgba(10,68,92,0.30)' : 'rgba(46,128,144,0.26)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // sparse whitecaps: short near-horizontal strokes, a touch of curl
  for (let i = 0; i < 30; i++) {
    const x = hash01(i * 7 + 100) * 512;
    const y = hash01(i * 7 + 101) * 512;
    const len = 10 + hash01(i * 7 + 102) * 24;
    const tilt = (hash01(i * 7 + 103) - 0.5) * 0.5;
    wrapped(512, x, y, len, (px, py) => {
      g.strokeStyle = `rgba(232,244,246,${0.18 + hash01(i * 7 + 104) * 0.3})`;
      g.lineWidth = 1.5 + hash01(i * 7 + 105) * 2;
      g.beginPath();
      g.moveTo(px - len / 2, py);
      g.quadraticCurveTo(px, py - len * tilt, px + len / 2, py);
      g.stroke();
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Concrete quay face for the coast's 'wall' edges: light grey with pour
 *  seams and a tide stain darkening toward the waterline. flipY is off so
 *  canvas-bottom = v 1 = the skirt's bottom row — the stain lands at the
 *  water, not the cap. */
export function makeQuayTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.fillStyle = '#b1b5b8';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(92,97,102,0.35)';
  g.lineWidth = 2;
  for (let y = 24; y < 128; y += 34) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(128, y + 0.5);
    g.stroke();
  }
  g.strokeStyle = 'rgba(92,97,102,0.18)';
  for (const x of [40, 96]) {
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, 128);
    g.stroke();
  }
  const tide = g.createLinearGradient(0, 70, 0, 128);
  tide.addColorStop(0, 'rgba(46,72,78,0)');
  tide.addColorStop(1, 'rgba(46,72,78,0.45)');
  g.fillStyle = tide;
  g.fillRect(0, 70, 128, 58);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Waterline foam band: alpha peaks just off the shore toe and dissolves
 *  into lacy holes seaward. v runs inner (0) → outer (1); flipY off so the
 *  canvas reads in that order. u tiles along the coast.
 *
 *  Built as CONTOUR foam (Cyanilux shoreline breakdown / Alisavakis
 *  stylized-water foam): rather than one even band it lays a bright,
 *  near-opaque LEADING EDGE where the swash meets the sand, then two or
 *  three softer foam CONTOUR LINES trailing seaward, each broken into lacy
 *  holes by cell-noise so the edge reads as scalloped sea-foam, not a decal
 *  stripe. The variant arg lets the coast stack two offset copies (a
 *  scrolling outer swash over a fixed leading edge) for the animated wash.
 *  https://www.cyanilux.com/tutorials/shoreline-shader-breakdown/
 *  https://halisavakis.com/my-take-on-shaders-stylized-water-shader/ */
export function makeFoamTexture(variant = 0): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  const seed = variant * 1000;
  g.clearRect(0, 0, 128, 128);
  // a soft base band so there's always SOME foam tint across the strip
  const band = g.createLinearGradient(0, 0, 0, 128);
  band.addColorStop(0, 'rgba(246,253,253,0)');
  band.addColorStop(0.16, 'rgba(246,253,253,0.7)');
  band.addColorStop(0.5, 'rgba(242,251,251,0.4)');
  band.addColorStop(1, 'rgba(242,251,251,0)');
  g.fillStyle = band;
  g.fillRect(0, 0, 128, 128);
  // contour lines: each is a wavy near-horizontal foam crest. The first
  // sits at the shore toe (bright, the swash leading edge), the rest trail
  // seaward and fade — the "distinct wave lines" of the contour technique.
  const lines = [
    { y: 24, h: 19, a: 1.0 }, // leading edge — opaque, the bright waterline crest
    { y: 56, h: 14, a: 0.7 },
    { y: 88, h: 11, a: 0.45 },
  ];
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    g.fillStyle = `rgba(248,253,253,${ln.a})`;
    // draw the crest as a filled wavy ribbon: top edge wobbles in u, bottom
    // edge wobbles out of phase so the band thickens and thins like foam
    g.beginPath();
    for (let x = 0; x <= 128; x += 4) {
      const w = Math.sin((x / 128) * Math.PI * 4 + li * 1.7 + seed) * 3 + Math.sin((x / 128) * Math.PI * 9 + seed) * 1.5;
      g.lineTo(x, ln.y + w - ln.h / 2);
    }
    for (let x = 128; x >= 0; x -= 4) {
      const w = Math.sin((x / 128) * Math.PI * 5 + li * 2.3 + seed) * 3.2;
      g.lineTo(x, ln.y + w + ln.h / 2);
    }
    g.closePath();
    g.fill();
  }
  // punch lacy cell-noise holes so every crest scallops instead of reading
  // as a solid stripe (the "blend in some cell noise" foam step)
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 90; i++) {
    const x = hash01(i * 3 + 800 + seed) * 128;
    const y = 12 + hash01(i * 3 + 801 + seed) * 110;
    const r = 2.5 + hash01(i * 3 + 802 + seed) * 8;
    wrapped(128, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, 'rgba(0,0,0,0.95)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
