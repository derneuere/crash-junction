import * as THREE from 'three';

// Day/night is mostly an emissive story: at night the streetlights,
// checkpoint posts, building windows and car head/taillights come on.
// Materials opt in via mat.userData.night = { intensity, day? } — the
// emissiveIntensity to use at night (and by day; default 0). Applying is
// a scene sweep instead of a registry, so level rebuilds, per-building
// material clones and shared car materials all need no bookkeeping.

export type TimeOfDay = 'day' | 'night';

interface NightTag {
  intensity: number;
  day?: number;
}

export function applyTimeOfDay(scene: THREE.Scene, t: TimeOfDay): void {
  const seen = new Set<THREE.Material>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as unknown as THREE.Sprite).isSprite) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      const tag = m.userData.night as NightTag | undefined;
      if (!tag) continue;
      (m as THREE.MeshStandardMaterial).emissiveIntensity = t === 'night' ? tag.intensity : (tag.day ?? 0);
    }
  });
}
