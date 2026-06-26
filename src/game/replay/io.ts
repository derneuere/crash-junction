import { REPLAY_FORMAT, REPLAY_VERSION, type ReplayFile } from './types';

// ---------- file I/O ----------

export function parseReplayFile(text: string): ReplayFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  const f = raw as ReplayFile;
  if (f?.format !== REPLAY_FORMAT) throw new Error('not a crash-junction replay file');
  if (f.version !== REPLAY_VERSION) throw new Error(`replay version ${f.version}, expected ${REPLAY_VERSION}`);
  if (!Array.isArray(f.dts) || !Array.isArray(f.keyMasks) || f.dts.length !== f.keyMasks.length) {
    throw new Error('frame arrays missing or mismatched');
  }
  if (typeof f.seed !== 'number' || typeof f.levelId !== 'string') throw new Error('seed or levelId missing');
  if (!Array.isArray(f.commands) || !Array.isArray(f.checksums) || !Array.isArray(f.hidden)) {
    throw new Error('command/checksum arrays missing');
  }
  return f;
}

export function downloadReplay(file: ReplayFile): void {
  const stamp = file.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `crash-report-${file.levelId}-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
