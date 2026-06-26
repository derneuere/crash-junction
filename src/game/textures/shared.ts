export function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Deterministic 0..1 from an index — the same value every reload. The
 *  terrain textures and the coast's cliff jitter use this instead of
 *  Math.random so the fixed-pose screenshot harness (tools/refshot.mjs)
 *  diffs cleanly: a reload must never reshuffle the scenery's noise. */
export function hash01(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Paint cb at every 3x3 wrap offset that touches the tile, so blobs and
 *  streaks crossing a canvas edge re-enter on the far side — RepeatWrapping
 *  otherwise shows a hard seam grid every tile. */
export function wrapped(size: number, x: number, y: number, r: number, cb: (x: number, y: number) => void): void {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox;
      const py = y + oy;
      if (px > -r && px < size + r && py > -r && py < size + r) cb(px, py);
    }
  }
}
