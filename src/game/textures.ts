import * as THREE from 'three';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Deterministic 0..1 from an index — the same value every reload. The
 *  terrain textures and the coast's cliff jitter use this instead of
 *  Math.random so the fixed-pose screenshot harness (tools/refshot.mjs)
 *  diffs cleanly: a reload must never reshuffle the scenery's noise. */
export function hash01(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Paint cb at every 3x3 wrap offset that touches the tile, so blobs and
 *  streaks crossing a canvas edge re-enter on the far side — RepeatWrapping
 *  otherwise shows a hard seam grid every tile. */
function wrapped(size: number, x: number, y: number, r: number, cb: (x: number, y: number) => void): void {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox;
      const py = y + oy;
      if (px > -r && px < size + r && py > -r && py < size + r) cb(px, py);
    }
  }
}

/** Facade + its matching night mask: the windows that are warm in the
 *  diffuse map are exactly the ones that glow in the emissive map. */
export function makeWindowTextures(): { map: THREE.CanvasTexture; lit: THREE.CanvasTexture } {
  const [c, g] = canvas(128);
  const [cl, gl] = canvas(128);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  gl.fillStyle = '#000000';
  gl.fillRect(0, 0, 128, 128);
  for (let y = 10; y < 128; y += 30)
    for (let x = 10; x < 128; x += 30) {
      const litWindow = Math.random() < 0.25;
      g.fillStyle = litWindow ? 'rgba(255,238,180,0.85)' : 'rgba(30,38,52,0.85)';
      g.fillRect(x, y, 16, 18);
      // night mask: the warm windows blaze, a second tier glows dimly,
      // the rest stay dark — an all-or-nothing mask reads as a black void
      gl.fillStyle = litWindow
        ? Math.random() < 0.7
          ? '#ffd27a'
          : '#ffeebc'
        : Math.random() < 0.4
          ? '#2c3950'
          : '#0a0c10';
      gl.fillRect(x, y, 16, 18);
    }
  const wrap = (cv: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: wrap(c), lit: wrap(cl) };
}

/** Soft radial disk — the sun and moon sprites. */
export function makeGlowTexture(inner: string, mid: string): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, inner);
  gr.addColorStop(0.32, inner);
  gr.addColorStop(0.45, mid);
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeSmokeTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64);
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  gr.addColorStop(0, 'rgba(255,255,255,0.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Soft-core blob with a roughened rim — reads as flame, not bokeh. */
export function makeFireTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  const core = g.createRadialGradient(64, 64, 4, 64, 64, 60);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random();
    const r = 34 + Math.random() * 14;
    const x = 64 + Math.cos(a) * r;
    const y = 64 + Math.sin(a) * r;
    const blob = g.createRadialGradient(x, y, 1, x, y, 14 + Math.random() * 10);
    blob.addColorStop(0, 'rgba(255,255,255,0.55)');
    blob.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = blob;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

export function makeChevronTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.fillStyle = '#2e3138';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#e8b820';
  g.lineWidth = 14;
  for (let y = -32; y < 192; y += 44) {
    g.beginPath();
    g.moveTo(-8, y + 40);
    g.lineTo(64, y);
    g.lineTo(136, y + 40);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

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

export type PatchKind = 'concrete' | 'sand' | 'drygrass' | 'gravel';

/** Tileable ground-patch surfaces (GroundPatchDef). All hash-stable. */
export function makePatchTexture(kind: PatchKind): THREE.CanvasTexture {
  const [c, g] = canvas(256);
  if (kind === 'concrete') {
    // light grey apron: pour seams on a grid, hairline cracks, oil stains
    g.fillStyle = '#b3b5b1';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(120,122,118,0.5)';
    g.lineWidth = 2;
    for (const p of [0, 128]) {
      g.beginPath();
      g.moveTo(p + 0.5, 0);
      g.lineTo(p + 0.5, 256);
      g.moveTo(0, p + 0.5);
      g.lineTo(256, p + 0.5);
      g.stroke();
    }
    for (let i = 0; i < 7; i++) {
      // cracks: short random walks, darker than the seams
      let x = hash01(i * 11 + 200) * 256;
      let y = hash01(i * 11 + 201) * 256;
      g.strokeStyle = 'rgba(96,98,94,0.45)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 5; s++) {
        x += (hash01(i * 11 + 202 + s) - 0.5) * 36;
        y += (hash01(i * 11 + 207 + s) - 0.5) * 36;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const x = hash01(i * 13 + 300) * 256;
      const y = hash01(i * 13 + 301) * 256;
      const r = 12 + hash01(i * 13 + 302) * 22;
      wrapped(256, x, y, r, (px, py) => {
        const gr = g.createRadialGradient(px, py, 1, px, py, r);
        gr.addColorStop(0, 'rgba(42,42,48,0.22)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(px - r, py - r, r * 2, r * 2);
      });
    }
  } else if (kind === 'sand') {
    // warm pale grain — just speckle, sand has no features at this scale
    g.fillStyle = '#dcc69b';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const x = hash01(i * 3 + 400) * 256;
      const y = hash01(i * 3 + 401) * 256;
      g.fillStyle = hash01(i * 3 + 402) < 0.5 ? 'rgba(196,172,128,0.5)' : 'rgba(238,222,182,0.5)';
      g.fillRect(x, y, 1.6, 1.6);
    }
  } else if (kind === 'drygrass') {
    // golden-tan mottle: big soft blotches + a few wispy strokes
    g.fillStyle = '#b59f5c';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 70; i++) {
      const x = hash01(i * 9 + 500) * 256;
      const y = hash01(i * 9 + 501) * 256;
      const r = 8 + hash01(i * 9 + 502) * 24;
      const warm = hash01(i * 9 + 503) < 0.5;
      wrapped(256, x, y, r, (px, py) => {
        const gr = g.createRadialGradient(px, py, 1, px, py, r);
        gr.addColorStop(0, warm ? 'rgba(160,138,70,0.35)' : 'rgba(202,180,110,0.35)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(px - r, py - r, r * 2, r * 2);
      });
    }
    g.strokeStyle = 'rgba(140,118,58,0.4)';
    g.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      const x = hash01(i * 5 + 600) * 256;
      const y = hash01(i * 5 + 601) * 256;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (hash01(i * 5 + 602) - 0.5) * 10, y - 4 - hash01(i * 5 + 603) * 6);
      g.stroke();
    }
  } else {
    // gravel: dense grey speckle in three tones
    g.fillStyle = '#9a9a96';
    g.fillRect(0, 0, 256, 256);
    const tones = ['rgba(122,122,118,0.7)', 'rgba(176,176,170,0.7)', 'rgba(140,140,134,0.7)'];
    for (let i = 0; i < 1200; i++) {
      const x = hash01(i * 3 + 700) * 256;
      const y = hash01(i * 3 + 701) * 256;
      g.fillStyle = tones[Math.floor(hash01(i * 3 + 702) * 3)];
      const s = 1 + hash01(i * 3 + 703) * 2;
      g.fillRect(x, y, s, s);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Chain-link mesh on a transparent ground — the 'fence' wall style cuts it
 *  out with alphaTest. One tile maps to ~1 m of fence. */
export function makeChainLinkTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.clearRect(0, 0, 128, 128);
  g.lineWidth = 2.5;
  for (const [dir, color] of [
    [1, 'rgba(150,158,164,0.95)'],
    [-1, 'rgba(178,186,192,0.95)'],
  ] as const) {
    g.strokeStyle = color;
    for (let k = -5; k <= 9; k++) {
      g.beginPath();
      g.moveTo(k * 32, dir > 0 ? 0 : 128);
      g.lineTo(k * 32 + dir * 128, dir > 0 ? 128 : 0);
      g.stroke();
    }
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
 *  canvas reads in that order. u tiles along the coast. */
export function makeFoamTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128);
  g.clearRect(0, 0, 128, 128);
  const band = g.createLinearGradient(0, 0, 0, 128);
  band.addColorStop(0, 'rgba(240,250,250,0)');
  band.addColorStop(0.3, 'rgba(240,250,250,0.85)');
  band.addColorStop(0.55, 'rgba(240,250,250,0.5)');
  band.addColorStop(1, 'rgba(240,250,250,0)');
  g.fillStyle = band;
  g.fillRect(0, 0, 128, 128);
  // punch holes so the seaward edge breaks up instead of fading evenly
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 46; i++) {
    const x = hash01(i * 3 + 800) * 128;
    const y = 40 + hash01(i * 3 + 801) * 88;
    const r = 3 + hash01(i * 3 + 802) * 9;
    wrapped(128, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, 'rgba(0,0,0,0.9)');
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

export function makeBarrelTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64);
  g.fillStyle = '#c0271c';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e8e2d4';
  g.fillRect(0, 24, 64, 9);
  g.fillStyle = '#8e1812';
  g.fillRect(0, 0, 64, 5);
  g.fillRect(0, 59, 64, 5);
  g.fillStyle = '#1c1c1c';
  g.fillRect(26, 25, 12, 7); // hazard mark on the band
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

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
