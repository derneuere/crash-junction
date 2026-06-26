import * as THREE from 'three';
import { canvas } from './shared';

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
