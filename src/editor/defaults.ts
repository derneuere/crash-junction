// Factories + the category table the hierarchy, viewport and toolbar share.
// A category = one LevelDef list the editor can place into; the table keeps
// tree labels, add-factories and accent colors in one place.

import type { LevelDef } from '../game/types';

export function makeBlankLevel(): LevelDef {
  return {
    name: 'NEW JUNCTION',
    mode: { kind: 'crash', medals: { bronze: 80000, silver: 140000, gold: 200000 } },
    player: { variant: 'sedan', color: 0xe8352a, x: 2.3, z: -80, dir: { x: 0, z: 1 }, speed: 0 },
    traffic: [],
    poles: [],
    barrels: [],
    ramps: [],
    buildings: [],
    pickups: [],
    props: [],
  };
}

export interface CategoryDef {
  /** LevelDef list key — also the root path segment. */
  key: 'roads' | 'traffic' | 'poles' | 'barrels' | 'ramps' | 'buildings' | 'pickups' | 'props';
  label: string;
  /** Tree/viewport accent (CSS hex string). */
  accent: string;
  makeEmpty: () => unknown;
}

export const CATEGORIES: CategoryDef[] = [
  {
    key: 'roads', label: 'ROADS', accent: '#c9cfd8',
    makeEmpty: () => ({ x: 0, z: 0, yaw: 0, length: 60, width: 14, dashes: true }),
  },
  {
    key: 'traffic', label: 'TRAFFIC', accent: '#f2b01e',
    makeEmpty: () => ({ variant: 'sedan', color: 0xd8d8d8, x: 0, z: 20, dir: { x: 0, z: -1 }, speed: 8 }),
  },
  {
    key: 'poles', label: 'POLES', accent: '#9aa3ad',
    makeEmpty: () => ({ x: 6, z: 6 }),
  },
  {
    key: 'barrels', label: 'BARRELS', accent: '#e8552a',
    makeEmpty: () => ({ x: 4, z: 4 }),
  },
  {
    key: 'ramps', label: 'RAMPS', accent: '#4ec3e0',
    makeEmpty: () => ({ x: 0, zStart: -15, length: 7, width: 3.4, height: 0.6 }),
  },
  {
    key: 'buildings', label: 'BUILDINGS', accent: '#8a93a8',
    makeEmpty: () => ({ x: 20, z: 20, h: 12, color: 0x5b6470 }),
  },
  {
    key: 'pickups', label: 'MULTIPLIERS', accent: '#ffd24a',
    makeEmpty: () => ({ x: 0, y: 2, z: 0, mult: 2 }),
  },
  {
    key: 'props', label: 'PROPS', accent: '#7fd08a',
    makeEmpty: () => ({
      url: 'builtin:bollard', x: 5, z: -5, yaw: 0, scale: 1,
      collider: { hx: 0.25, hy: 0.5, hz: 0.25 },
    }),
  },
];

export const CATEGORY_BY_KEY: Record<string, CategoryDef> = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, c]),
);
