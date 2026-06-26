import {
  REPLAY_FORMAT,
  REPLAY_VERSION,
  type Command,
  type ReplayFile,
  type Snapshot,
} from './types';

// ---------- recorder ----------

export class Recorder {
  private levelId = '';
  private seed = 0;
  private dts: number[] = [];
  private keyMasks: number[] = [];
  private hidden: number[] = [];
  private commands: { f: number; c: Command }[] = [];
  private checksums: { s: number; h: number; b: number[] }[] = [];
  private armed = false;

  /** New take: wipe the tape and start over. */
  begin(levelId: string, seed: number): void {
    this.levelId = levelId;
    this.seed = seed;
    this.dts = [];
    this.keyMasks = [];
    this.hidden = [];
    this.commands = [];
    this.checksums = [];
    this.armed = true;
  }

  /** Replays must not record themselves. */
  disarm(): void {
    this.armed = false;
  }

  frame(dt: number, mask: number, hidden: boolean, cmds: readonly Command[]): void {
    if (!this.armed) return;
    const f = this.dts.length;
    this.dts.push(dt);
    this.keyMasks.push(mask);
    if (hidden) this.hidden.push(f);
    for (const c of cmds) this.commands.push({ f, c });
  }

  checksum(step: number, hash: number, bodies: number[]): void {
    if (!this.armed) return;
    this.checksums.push({ s: step, h: hash, b: bodies });
  }

  export(note: string, snapshot: Snapshot): ReplayFile {
    return {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      app: `crash-junction ${import.meta.env.MODE}`,
      userAgent: navigator.userAgent,
      createdAt: new Date().toISOString(),
      note,
      levelId: this.levelId,
      seed: this.seed,
      dts: this.dts.slice(), // recording continues after an export
      keyMasks: this.keyMasks.slice(),
      hidden: this.hidden.slice(),
      commands: this.commands.slice(),
      checksums: this.checksums.slice(),
      snapshot,
    };
  }
}
