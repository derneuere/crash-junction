import * as THREE from 'three';
import { canvas, hash01, wrapped } from './shared';

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
