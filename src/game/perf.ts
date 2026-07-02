import * as THREE from 'three';

// Lag-spike tracker: a per-frame ring buffer of frame timings + renderer
// counters, with automatic spike capture. Presentation-only — it reads
// clocks and renderer.info, never sim state, so replay determinism can't
// see it. Game.frame() drives beginFrame/endFrame and writes the section
// timings; notable presentation events (explosion spawn, vehicle-light
// flip, panel detach, tod/gfx change, …) land in the current frame's tag
// list via tag().
//
// Spike rule: wall dt or measured in-frame work above
// max(50 ms, 3× rolling median wall dt) captures a structured report —
// the ring window around the spike plus counter deltas across it — onto
// window.__lagSpikes (capped) and console.warn's a one-liner. Full readout:
// window.__game.perfReport().
//
// Overhead discipline: ring slots and their tag arrays are preallocated and
// reused; the visible-light count needs a scene traversal, so it's sampled
// every LIGHT_SAMPLE_EVERY frames — but always on tagged frames, on the
// spike frame itself and on the frame after, so spike deltas are real.

const RING = 180;
const WINDOW_BEFORE = 30;
const WINDOW_AFTER = 10;
const SPIKE_FLOOR_MS = 50;
const SPIKE_MEDIAN_RATIO = 3;
const WARMUP_FRAMES = 30; // no spike verdicts until the median means something
const LIGHT_SAMPLE_EVERY = 15;
const MEDIAN_EVERY = 30;
const MAX_SPIKES = 24;

interface PerfFrame {
  id: number;
  wall: number; // rAF-to-rAF dt, ms (carries the PREVIOUS callback's cost)
  sim: number; // recorder/sim advance, ms
  cube: number; // cine cube-map capture, ms
  post: number; // composer render (cine) / renderer.render (fast), ms
  programs: number; // renderer.info.programs.length
  maxProgramId: number; // high-water program id — every shader compile bumps it
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  lights: number; // visible lights; -1 on frames where sampling was skipped
  tags: string[];
}

/** Game state attached to a spike report — strings/numbers only (JSON-able). */
export interface PerfGameState {
  tod: string;
  gfx: string;
  cine: boolean;
  level: string;
  state: string;
  actors: number;
  replaying: boolean;
}

export interface SpikeReport {
  frameId: number;
  wallMs: number;
  workMs: number; // sim + cube + post of the spike frame
  medianMs: number;
  ratio: number; // max(wall, work) / median
  simMs: number;
  cubeMs: number;
  postMs: number;
  /** shader compiles across the spike frame (maxProgramId delta) */
  compiles: number;
  programs: { before: number; after: number };
  geometries: { before: number; after: number };
  textures: { before: number; after: number };
  lights: { before: number; after: number };
  tags: string[];
  /** spike frames that landed inside this report's after-window */
  followOnFrames: number;
  state: PerfGameState;
  window: PerfFrame[];
}

export interface PerfReport {
  medianWallMs: number;
  frameId: number;
  spikes: SpikeReport[];
  frames: PerfFrame[]; // the ring, oldest → newest
}

export class Perf {
  // section timings — Game.frame() writes these between begin and end
  simMs = 0;
  cubeMs = 0;
  postMs = 0;

  private frames: PerfFrame[] = [];
  private head = 0; // slot being filled this frame
  private count = 0;
  private frameId = 0;
  private cur: PerfFrame;
  private median = 16.7;
  // exponential moving averages for the live corner readout — a steady FPS /
  // draw-call / triangle display that tracks changes within a few frames
  // without the per-frame jitter the raw values show (the throttled player cube
  // re-renders the whole scene every other frame, so raw calls/triangles swing
  // hard between cube and non-cube frames). Fed in endFrame; read by live().
  private smoothWall = 16.7;
  private smoothCalls = 0;
  private smoothTris = 0;
  private smoothSim = 0;
  private smoothPost = 0;
  private scratch: number[] = [];
  private lastLights = -1;
  private forceLightSample = false;
  private spikes: SpikeReport[] = [];
  private pending: { report: SpikeReport; left: number }[] = [];
  private lightCount = 0;
  private countLight = (o: THREE.Object3D): void => {
    if ((o as THREE.Light).isLight) this.lightCount++;
  };

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private getState: () => PerfGameState,
  ) {
    // info accumulates across every render of the frame (cube faces, postfx
    // passes); beginFrame() resets it instead
    renderer.info.autoReset = false;
    for (let i = 0; i < RING; i++) {
      this.frames.push({
        id: -1, wall: 0, sim: 0, cube: 0, post: 0, programs: 0, maxProgramId: 0,
        calls: 0, triangles: 0, geometries: 0, textures: 0, lights: -1, tags: [],
      });
    }
    this.cur = this.frames[0]; // tags pushed before the first beginFrame land here
    (window as unknown as { __lagSpikes: SpikeReport[] }).__lagSpikes = this.spikes;
  }

  beginFrame(): void {
    this.renderer.info.reset();
    this.cur = this.frames[this.head];
    this.cur.id = this.frameId;
    this.cur.tags.length = 0;
    this.simMs = 0;
    this.cubeMs = 0;
    this.postMs = 0;
  }

  /** Presentation-event seam: lands in the current frame's tag list. */
  tag(t: string): void {
    this.cur.tags.push(t);
  }

  endFrame(wallMs: number): void {
    const f = this.cur;
    f.wall = wallMs;
    // smooth the wall dt for the live FPS readout (responsive, low jitter)
    this.smoothWall += (wallMs - this.smoothWall) * 0.1;
    f.sim = this.simMs;
    f.cube = this.cubeMs;
    f.post = this.postMs;
    const info = this.renderer.info;
    const programs = info.programs ?? [];
    f.programs = programs.length;
    let maxId = 0;
    for (const p of programs) if (p.id > maxId) maxId = p.id;
    f.maxProgramId = maxId;
    f.calls = info.render.calls;
    f.triangles = info.render.triangles;
    f.geometries = info.memory.geometries;
    f.textures = info.memory.textures;
    // smooth the draw-call / triangle counts for the live readout (raw values
    // alternate between cube and non-cube frames — see the field comment)
    this.smoothCalls += (f.calls - this.smoothCalls) * 0.1;
    this.smoothTris += (f.triangles - this.smoothTris) * 0.1;
    // CPU-side split for the on-device HUD: sim (fixed steps + game logic) vs
    // draw submission (cube + composer/renderer). On a phone this is the fact
    // that settles "GPU-bound or physics-bound" without a cabled profiler.
    this.smoothSim += (f.sim - this.smoothSim) * 0.1;
    this.smoothPost += (f.cube + f.post - this.smoothPost) * 0.1;

    const work = f.sim + f.cube + f.post;
    const threshold = Math.max(SPIKE_FLOOR_MS, SPIKE_MEDIAN_RATIO * this.median);
    const spiking = this.count >= WARMUP_FRAMES && (f.wall > threshold || work > threshold);

    const lightsBefore = this.lastLights;
    if (spiking || this.forceLightSample || f.tags.length > 0 || this.frameId % LIGHT_SAMPLE_EVERY === 0) {
      this.lightCount = 0;
      this.scene.traverseVisible(this.countLight);
      this.lastLights = this.lightCount;
      f.lights = this.lightCount;
      this.forceLightSample = false;
    } else {
      f.lights = -1;
    }

    if (spiking) {
      this.forceLightSample = true; // the after-frame's count must be real too
      const open = this.pending[this.pending.length - 1];
      if (open && f.id - open.report.frameId <= WINDOW_AFTER) {
        open.report.followOnFrames++; // a storm reads as one report, counted
      } else {
        const prev = this.frames[(this.head + RING - 1) % RING];
        const report: SpikeReport = {
          frameId: f.id,
          wallMs: Math.round(f.wall * 10) / 10,
          workMs: Math.round(work * 10) / 10,
          medianMs: Math.round(this.median * 10) / 10,
          ratio: Math.round((Math.max(f.wall, work) / this.median) * 10) / 10,
          simMs: Math.round(f.sim * 10) / 10,
          cubeMs: Math.round(f.cube * 10) / 10,
          postMs: Math.round(f.post * 10) / 10,
          compiles: f.maxProgramId - prev.maxProgramId,
          programs: { before: prev.programs, after: f.programs },
          geometries: { before: prev.geometries, after: f.geometries },
          textures: { before: prev.textures, after: f.textures },
          lights: { before: lightsBefore, after: f.lights },
          tags: f.tags.slice(),
          followOnFrames: 0,
          state: this.getState(),
          window: [],
        };
        console.warn(
          `[perf] lag spike: wall ${report.wallMs}ms work ${report.workMs}ms (median ${report.medianMs}ms, ${report.ratio}x)` +
            ` compiles +${report.compiles} programs ${report.programs.before}->${report.programs.after}` +
            ` lights ${report.lights.before}->${report.lights.after} tags [${report.tags.join(', ')}]`,
        );
        this.pending.push({ report, left: WINDOW_AFTER });
      }
    }

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (--p.left > 0) continue;
      p.report.window = this.windowAround(p.report.frameId);
      this.spikes.push(p.report);
      if (this.spikes.length > MAX_SPIKES) this.spikes.shift();
      this.pending.splice(i, 1);
    }

    this.head = (this.head + 1) % RING;
    if (this.count < RING) this.count++;
    this.frameId++;
    if (this.frameId % MEDIAN_EVERY === 0) this.updateMedian();
  }

  /** Cheap live readout for the corner HUD: smoothed FPS plus the most recent
   *  completed frame's draw-call and triangle counts. No allocation — safe to
   *  poll a few times a second. (this.cur still points at the frame just ended
   *  until the next beginFrame.) */
  live(): { fps: number; calls: number; triangles: number; simMs: number; drawMs: number } {
    return {
      fps: this.smoothWall > 0 ? Math.round(1000 / this.smoothWall) : 0,
      calls: Math.round(this.smoothCalls),
      triangles: Math.round(this.smoothTris),
      simMs: Math.round(this.smoothSim * 10) / 10,
      drawMs: Math.round(this.smoothPost * 10) / 10,
    };
  }

  report(): PerfReport {
    return {
      medianWallMs: Math.round(this.median * 10) / 10,
      frameId: this.frameId,
      spikes: this.spikes.slice(),
      frames: this.ringInOrder().map((f) => this.snapshot(f)),
    };
  }

  private updateMedian(): void {
    const s = this.scratch;
    s.length = 0;
    const n = Math.min(this.count, RING);
    for (let i = 0; i < n; i++) s.push(this.frames[(this.head + RING - 1 - i) % RING].wall);
    if (!s.length) return;
    s.sort((a, b) => a - b);
    this.median = s[s.length >> 1];
  }

  private ringInOrder(): PerfFrame[] {
    const out: PerfFrame[] = [];
    const n = Math.min(this.count, RING);
    for (let i = n; i >= 1; i--) {
      const f = this.frames[(this.head + RING - i) % RING];
      if (f.id >= 0) out.push(f);
    }
    return out;
  }

  private windowAround(frameId: number): PerfFrame[] {
    const out: PerfFrame[] = [];
    for (const f of this.ringInOrder()) {
      if (f.id >= frameId - WINDOW_BEFORE && f.id <= frameId + WINDOW_AFTER) out.push(this.snapshot(f));
    }
    return out;
  }

  private snapshot(f: PerfFrame): PerfFrame {
    return { ...f, tags: f.tags.slice() };
  }
}
