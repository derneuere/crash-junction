import { KEY_CODES } from './types';

export function maskFromKeys(keys: Record<string, boolean>): number {
  let m = 0;
  for (let i = 0; i < KEY_CODES.length; i++) if (keys[KEY_CODES[i]]) m |= 1 << i;
  return m;
}

export function keysFromMask(mask: number): Record<string, boolean> {
  const keys: Record<string, boolean> = {};
  for (let i = 0; i < KEY_CODES.length; i++) if (mask & (1 << i)) keys[KEY_CODES[i]] = true;
  return keys;
}
