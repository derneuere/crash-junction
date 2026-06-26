import * as THREE from 'three';
import { glassMat } from './glass';
import { carMats, ENV_INTENSITY, registerPlayerSwappable } from './registry';

/** One shared material for every painted/deformable surface — color comes
 *  from per-vertex attributes so crumple scuffing can darken paint.
 *  Burnout-3 gloss = clearcoat (a white specular layer over the color, so
 *  even dark paint shines; metalness would tint reflections by albedo) +
 *  SMOOTH shading: the baked hulls carry creased-smooth normals, so the
 *  env streaks sweep across curved panels instead of stamping per facet. */
export const hullMat = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  vertexColors: true,
  roughness: 0.32,
  metalness: 0.05,
  clearcoat: 1,
  clearcoatRoughness: 0.07,
});

/** Headlights (and the bus light strip): clearcoated lenses that switch
 *  on at night via the daynight emissive sweep. */
export const headlightMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.1,
  clearcoat: 1,
  clearcoatRoughness: 0.05,
  emissive: 0xffe9bb,
  emissiveIntensity: 0,
});
headlightMat.userData.night = { intensity: 2.6 };

export const taillightMat = new THREE.MeshPhysicalMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.1,
  clearcoat: 1,
  clearcoatRoughness: 0.05,
  emissive: 0xff2014,
  emissiveIntensity: 0,
});
taillightMat.userData.night = { intensity: 1.9 };

/** Bare-chassis metal — interior platform, engine bay, trunk. */
export const metalMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.32,
  metalness: 0.85,
});

/** Cabin fittings — dash, seats, steering wheel. Matte. */
export const cabinMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.85,
  metalness: 0.05,
});

// Seed the shared env registries (registry.ts) with the showroom car set, in
// the canonical material order — glass included so the day/night swap drives it
// too. carEnv hasn't been set yet at module load, so this only records the
// materials + their baseline env intensities, exactly as the old literal init.
carMats.push(hullMat, glassMat, headlightMat, taillightMat, metalMat, cabinMat);
ENV_INTENSITY.set(hullMat, 0.75);
ENV_INTENSITY.set(glassMat, 1.0);
ENV_INTENSITY.set(headlightMat, 0.9);
ENV_INTENSITY.set(taillightMat, 0.9);
ENV_INTENSITY.set(metalMat, 0.8);
ENV_INTENSITY.set(cabinMat, 0.25);

// the live world is dimmer than the showroom's hot strip — run the player
// set a notch hotter than the rivals' tuned values
registerPlayerSwappable(hullMat, 0.9);
registerPlayerSwappable(glassMat, 1.2);
registerPlayerSwappable(headlightMat, 1.1);
registerPlayerSwappable(taillightMat, 1.1);
