// Level file I/O — the replay/io.ts pattern applied to levels: a versioned
// JSON envelope, a validating parser, and a Blob download. Also the
// localStorage draft the editor reopens with.

import type { LevelDef, ModeDef, VehicleSpawn } from '../game/types';
import { makeBlankLevel } from './defaults';

export const LEVEL_FORMAT = 'crash-junction-level';
export const LEVEL_VERSION = 1;

export interface LevelFile {
  format: typeof LEVEL_FORMAT;
  version: number;
  createdAt: string;
  level: LevelDef;
}

export function encodeLevelFile(level: LevelDef): string {
  const file: LevelFile = {
    format: LEVEL_FORMAT,
    version: LEVEL_VERSION,
    createdAt: new Date().toISOString(),
    level,
  };
  return JSON.stringify(file, null, 2);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function checkSpawn(s: unknown, who: string): asserts s is VehicleSpawn {
  const v = s as VehicleSpawn;
  if (!v || typeof v !== 'object') throw new Error(`${who} spawn missing`);
  if (!['sedan', 'bus', 'tanker'].includes(v.variant)) throw new Error(`${who}: unknown variant '${String(v.variant)}'`);
  if (!isNum(v.x) || !isNum(v.z) || !isNum(v.speed)) throw new Error(`${who}: x/z/speed must be numbers`);
  if (!v.dir || !isNum(v.dir.x) || !isNum(v.dir.z)) throw new Error(`${who}: dir must be { x, z }`);
}

function checkMode(m: unknown): asserts m is ModeDef {
  const mode = m as ModeDef;
  if (!mode || typeof mode !== 'object') throw new Error('mode missing');
  if (mode.kind === 'crash') {
    const md = mode.medals;
    if (!md || !isNum(md.bronze) || !isNum(md.silver) || !isNum(md.gold)) {
      throw new Error('crash mode: medals.bronze/silver/gold must be numbers');
    }
  } else if (mode.kind === 'race') {
    if (!mode.race || !Array.isArray(mode.race.sections) || mode.race.sections.length < 3) {
      throw new Error('race mode: race.sections missing (author race loops in code for now)');
    }
    if (!Array.isArray(mode.race.rivals)) throw new Error('race mode: race.rivals missing');
  } else if (mode.kind !== 'practice') {
    throw new Error(`unknown mode kind '${String((mode as { kind?: unknown }).kind)}'`);
  }
}

/** Parse + validate a level file. Throws with a human-readable reason.
 *  Missing optional lists are filled so old/hand-trimmed files open fine. */
export function parseLevelFile(text: string): LevelDef {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const f = raw as LevelFile;
  if (f?.format !== LEVEL_FORMAT) throw new Error('not a crash-junction level file');
  if (f.version !== LEVEL_VERSION) throw new Error(`level version ${f.version}, expected ${LEVEL_VERSION}`);
  const level = f.level;
  if (!level || typeof level !== 'object') throw new Error('level payload missing');
  if (typeof level.name !== 'string' || !level.name.trim()) throw new Error('level.name missing');
  checkMode(level.mode);
  checkSpawn(level.player, 'player');
  const lists = ['traffic', 'poles', 'barrels', 'ramps', 'buildings', 'pickups'] as const;
  const blank = makeBlankLevel();
  for (const key of lists) {
    if (level[key] == null) (level as unknown as Record<string, unknown>)[key] = blank[key];
    else if (!Array.isArray(level[key])) throw new Error(`level.${key} must be a list`);
  }
  level.traffic.forEach((t, i) => checkSpawn(t, `traffic[${i}]`));
  if (level.roads != null && !Array.isArray(level.roads)) throw new Error('level.roads must be a list');
  return level;
}

export function downloadLevel(level: LevelDef): void {
  const slug = level.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'level';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([encodeLevelFile(level)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- localStorage draft ----------

const DRAFT_KEY = 'cj-editor-draft';

export function readDraft(): LevelDef | null {
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    if (!text) return null;
    return parseLevelFile(text);
  } catch {
    return null;
  }
}

export function writeDraft(level: LevelDef): void {
  try {
    localStorage.setItem(DRAFT_KEY, encodeLevelFile(level));
  } catch {
    // storage full/blocked — the draft is a convenience, not a contract
  }
}
