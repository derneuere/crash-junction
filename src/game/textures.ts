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
    // DRY beach sand. Real dry sand at this scale is grain on grain: a warm
    // pale base, broad tonal drift (the sun bleaches the high ground, damp
    // hollows stay tan), a four-tone speckle for tooth, faint wind-ripple
    // drag marks, and the odd shell/pebble fleck. Built per the Substance
    // beach-sand workflow — "cell noise at different scales with distortion
    // + a high-scale spot texture, slope-blurred" — approximated with
    // layered radial blots + multi-tone fillRect grain (80.lv beach-sand).
    g.fillStyle = '#dcc69b';
    g.fillRect(0, 0, 256, 256);
    // broad tonal drift: big soft warm/cool blots so the apron doesn't read
    // as one flat slab of paint (the cell-noise-at-large-scale layer)
    for (let i = 0; i < 22; i++) {
      const x = hash01(i * 7 + 380) * 256;
      const y = hash01(i * 7 + 381) * 256;
      const r = 26 + hash01(i * 7 + 382) * 60;
      const warm = hash01(i * 7 + 383) < 0.5;
      wrapped(256, x, y, r, (px, py) => {
        const gr = g.createRadialGradient(px, py, 2, px, py, r);
        gr.addColorStop(0, warm ? 'rgba(206,182,134,0.22)' : 'rgba(232,216,176,0.22)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(px - r, py - r, r * 2, r * 2);
      });
    }
    // wind-ripple drag marks: faint near-horizontal arcs, the dry-sand
    // analog of the wet drag noise — gives the flat apron a grain direction
    g.lineWidth = 1;
    for (let i = 0; i < 26; i++) {
      const x = hash01(i * 5 + 420) * 256;
      const y = hash01(i * 5 + 421) * 256;
      const len = 22 + hash01(i * 5 + 422) * 40;
      const tilt = (hash01(i * 5 + 423) - 0.5) * 8;
      g.strokeStyle = hash01(i * 5 + 424) < 0.5 ? 'rgba(198,174,128,0.28)' : 'rgba(236,222,184,0.3)';
      wrapped(256, x, y, len, (px, py) => {
        g.beginPath();
        g.moveTo(px - len / 2, py);
        g.quadraticCurveTo(px, py + tilt, px + len / 2, py);
        g.stroke();
      });
    }
    // four-tone grain for tooth (denser + more tonal range than before)
    const grain = ['rgba(190,164,118,0.5)', 'rgba(238,222,182,0.5)', 'rgba(210,190,144,0.45)', 'rgba(170,146,104,0.4)'];
    for (let i = 0; i < 1500; i++) {
      const x = hash01(i * 3 + 400) * 256;
      const y = hash01(i * 3 + 401) * 256;
      g.fillStyle = grain[Math.floor(hash01(i * 3 + 402) * 4)];
      const s = 1.2 + hash01(i * 3 + 403) * 1.2;
      g.fillRect(x, y, s, s);
    }
    // shell / pebble flecks: a few brighter highlit specks catch the eye and
    // sell the scale — sand is never perfectly uniform
    for (let i = 0; i < 16; i++) {
      const x = hash01(i * 9 + 460) * 256;
      const y = hash01(i * 9 + 461) * 256;
      const s = 1.6 + hash01(i * 9 + 462) * 2.2;
      g.fillStyle = hash01(i * 9 + 463) < 0.6 ? 'rgba(250,244,228,0.7)' : 'rgba(150,128,92,0.55)';
      g.fillRect(x, y, s, s);
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
