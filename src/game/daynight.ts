import * as THREE from 'three';

// Day/night is mostly an emissive story: at night the streetlights,
// checkpoint posts, building windows and car head/taillights come on.
// Materials opt in via mat.userData.night = { intensity, day? } — the
// emissiveIntensity to use at night (and by day; default 0). Applying is
// a scene sweep instead of a registry, so level rebuilds, per-building
// material clones and shared car materials all need no bookkeeping.

export type TimeOfDay = 'day' | 'dusk' | 'night';

interface NightTag {
  intensity: number;
  day?: number;
}

/** How much of the night emissive level each time of day runs: windows and
 *  lenses come on at dusk, but the low sun still outshines them. */
const NIGHT_EMISSIVE_FACTOR: Record<TimeOfDay, number> = { day: 0, dusk: 0.55, night: 1 };

/** The emissive level the sweep gives a tagged material at `t` — for
 *  per-frame drivers (the player's brake lights) that layer on top of the
 *  time-of-day baseline instead of replacing it. */
export function nightEmissive(m: THREE.Material, t: TimeOfDay): number {
  const tag = m.userData.night as NightTag | undefined;
  if (!tag) return 0;
  const day = tag.day ?? 0;
  return day + (tag.intensity - day) * NIGHT_EMISSIVE_FACTOR[t];
}

export function applyTimeOfDay(scene: THREE.Scene, t: TimeOfDay): void {
  const f = NIGHT_EMISSIVE_FACTOR[t];
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
      const day = tag.day ?? 0;
      (m as THREE.MeshStandardMaterial).emissiveIntensity = day + (tag.intensity - day) * f;
    }
  });
}
