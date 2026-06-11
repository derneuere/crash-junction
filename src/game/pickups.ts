import * as THREE from 'three';
import type { PickupDef } from './types';

// Score-multiplier pickups, Burnout 2 crash-mode style: golden rings
// floating over ramps and the junction. Fly the player (or the wreck —
// aftertouch skill shots count) through one to collect.

function makeLabelTexture(mult: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.font = 'bold 72px Impact, "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 10;
  g.strokeStyle = 'rgba(40,20,0,0.9)';
  g.strokeText(`x${mult}`, 64, 66);
  const grad = g.createLinearGradient(0, 28, 0, 100);
  grad.addColorStop(0, '#ffe79a');
  grad.addColorStop(0.55, '#ffb327');
  grad.addColorStop(1, '#ff7a18');
  g.fillStyle = grad;
  g.fillText(`x${mult}`, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Pickup {
  def: PickupDef;
  group: THREE.Group;
  taken: boolean;
  phase: number;
}

export class Pickups {
  private list: Pickup[] = [];

  constructor(scene: THREE.Scene, defs: PickupDef[]) {
    const ringGeo = new THREE.TorusGeometry(1.0, 0.07, 10, 36);
    for (const def of defs) {
      const group = new THREE.Group();
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffc23d, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      group.add(ring);
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(1.5, 1.5),
        new THREE.MeshBasicMaterial({
          map: makeLabelTexture(def.mult), transparent: true,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      group.add(label);
      group.position.set(def.x, def.y, def.z);
      scene.add(group);
      // deterministic phase: collection tests against the bobbing height, so
      // a replayed take must see the rings at the exact same y
      this.list.push({ def, group, taken: false, phase: this.list.length * 2.39996 });
    }
  }

  /** `t` is SIM time, not wall time — the bob height gates collection. */
  update(
    dt: number,
    t: number,
    playerPos: THREE.Vector3 | null,
    onCollect: (mult: number, p: THREE.Vector3) => void,
  ): void {
    for (const p of this.list) {
      if (p.taken) continue;
      p.group.rotation.y += dt * 2.2;
      p.group.position.y = p.def.y + Math.sin(t * 2 + p.phase) * 0.18;
      if (playerPos) {
        const dx = playerPos.x - p.def.x;
        const dy = playerPos.y - p.group.position.y;
        const dz = playerPos.z - p.def.z;
        if (dx * dx + dy * dy + dz * dz < 2.4 * 2.4) {
          p.taken = true;
          p.group.visible = false;
          onCollect(p.def.mult, p.group.position);
        }
      }
    }
  }

  reset(): void {
    for (const p of this.list) {
      p.taken = false;
      p.group.visible = true;
    }
  }
}
