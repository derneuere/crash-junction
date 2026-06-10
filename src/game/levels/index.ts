import { level1 } from './level1';
import { driftTrack } from './driftTrack';
import { raceway } from './raceway';

export const LEVELS = {
  junction: level1,
  track: driftTrack,
  race: raceway,
} as const;

export type LevelId = keyof typeof LEVELS;

export const LEVEL_LABELS: Record<LevelId, string> = {
  junction: 'CRASH JUNCTION',
  track: 'PROVING GROUND',
  race: 'SILVER LAKE RING',
};
