import * as THREE from 'three';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
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
