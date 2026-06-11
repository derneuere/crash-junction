// Seeded PRNG for everything that feeds back into the simulation.
//
// Replay determinism splits randomness into two worlds: sim-affecting rolls
// (explosion impulses, fuse jitter, wheel pops, panel-detach kicks, barrel
// spawn yaw, damage payouts) draw from this seeded stream, which is re-seeded
// at every take boundary (reset/level load) with a seed the recorder writes
// into the bug report. Purely visual randomness (particles, camera shake,
// crumple jitter) stays on Math.random — it never touches a physics body, so
// it can't desync a replay and doesn't need to share the stream.

let state = 0x9e3779b9;

/** Re-seed the sim stream — every take (reset / level load / replay) starts here. */
export function seedSim(seed: number): void {
  state = seed >>> 0;
}

/** mulberry32 — drop-in for Math.random() at sim-affecting call sites. */
export function simRand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A fresh random seed for a live take. */
export function rollSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
