// UNIFIED OFFLINE ASSET / BAKE PIPELINE for Crash Junction.
//
//   fnm exec --using=22 -- node tools/bake-all.mjs [step] [--force] [--list]
//
// Runs the project's OFFLINE asset-generation steps in dependency order. Each
// step turns source assets (FBX packs, level geometry) into the baked artifacts
// the game loads at runtime, so the build itself never bakes anything. The two
// steps today, in order:
//
//   1. models  — FBX → GLB (tools/convert-models.mjs). Converts the Quaternius
//                vehicle/transport FBX packs to the .glb the runtime loads.
//                Produces public/models/{cars,transport}/glb/*.glb.
//   2. ao      — offline ambient-occlusion bake (tools/bake-ao.mjs). Computes
//                per-vertex self+ground AO for the static built environment and
//                writes public/baked-ao.json. Runs AFTER `models` because the
//                bake reads the GLB prototypes (containers, cranes, warehouses).
//
// NOT part of this pipeline (documented for orientation):
//   * The CLOUD bake is a RUNTIME bake — per-time-of-day, in src/game/skyenv.ts
//     — not an offline artifact, so it has no step here.
//   * tools/inspect-models, tools/fluffy-measure, tools/grass-count,
//     tools/refshot, tests/scene-census + the perf probes are DIAGNOSTICS, not
//     asset generators. tests/run-replay-tests.mjs (npm test) + the fixture
//     recorders are the regression/determinism workflow. See the README.
//
// USAGE
//   node tools/bake-all.mjs            run every step in order, skipping any whose
//                                      outputs are already up to date
//   node tools/bake-all.mjs models     run just the `models` step
//   node tools/bake-all.mjs ao --force re-run `ao` even if it looks up to date
//   node tools/bake-all.mjs --force    force every step
//   node tools/bake-all.mjs --list     list the steps and exit
//
// EXTENDING: add one entry to the STEPS array below — { name, script, inputs,
// outputs, desc }. `inputs`/`outputs` drive the up-to-date check (newest input
// mtime vs oldest output mtime); leave `inputs` empty to always run. A future
// grass-asset bake, for example, is a single new STEPS entry slotted in order.

import { spawn } from 'node:child_process';
import { statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

// ---- the ordered pipeline --------------------------------------------------
// Each step: a tool to run, the source paths it reads (inputs) and the
// artifacts it writes (outputs). inputs/outputs are repo-relative directories
// or files; directories are scanned recursively for the freshest/oldest file.
const STEPS = [
  {
    name: 'models',
    script: 'tools/convert-models.mjs',
    desc: 'FBX → GLB vehicle/transport packs (public/models/*/glb/*.glb)',
    inputs: ['public/models/cars/FBX', 'public/models/transport/FBX'],
    outputs: ['public/models/cars/glb', 'public/models/transport/glb'],
  },
  {
    name: 'ao',
    script: 'tools/bake-ao.mjs',
    desc: 'offline per-vertex ambient-occlusion bake (public/baked-ao.json)',
    // Reads the GLB prototypes produced by `models` plus the procedural
    // geometry in builtins/environment, and writes the single JSON artifact.
    inputs: [
      'public/models/props',
      'public/models/cars/glb',
      'public/models/transport/glb',
      'src/game/builtins.ts',
      'tools/bake-ao.mjs',
    ],
    outputs: ['public/baked-ao.json'],
  },
];

// ---- mtime helpers for the up-to-date check --------------------------------
/** Newest mtime under a set of files/dirs (dirs walked recursively). Missing
 *  paths are ignored. Returns -Infinity if nothing exists. */
function newestMtime(paths) {
  let newest = -Infinity;
  const visit = (p) => {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const child of readdirSync(p)) visit(path.join(p, child));
    } else {
      newest = Math.max(newest, st.mtimeMs);
    }
  };
  for (const p of paths) visit(path.join(root, p));
  return newest;
}

/** Oldest mtime across outputs; Infinity if any output is missing (so a missing
 *  artifact always forces the step to run). */
function oldestOutputMtime(paths) {
  let oldest = Infinity;
  for (const p of paths) {
    const abs = path.join(root, p);
    if (!existsSync(abs)) return -Infinity; // missing output → must run
    const st = statSync(abs);
    if (st.isDirectory()) {
      const kids = readdirSync(abs);
      if (kids.length === 0) return -Infinity; // empty output dir → must run
      for (const child of kids) oldest = Math.min(oldest, statSync(path.join(abs, child)).mtimeMs);
    } else {
      oldest = Math.min(oldest, st.mtimeMs);
    }
  }
  return oldest;
}

/** A step is up to date when every output exists and is at least as new as the
 *  newest input. Steps with no inputs always run. */
function isUpToDate(step) {
  if (!step.inputs?.length) return false;
  const out = oldestOutputMtime(step.outputs);
  if (out === -Infinity) return false; // a missing/empty output forces a run
  return out >= newestMtime(step.inputs);
}

function runStep(step) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶ ${step.name}: ${step.desc}`);
    console.log(`  ${process.execPath} ${step.script}`);
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(root, step.script)], {
      cwd: root,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`✓ ${step.name} done in ${secs}s → ${step.outputs.map(rel).join(', ')}`);
        resolve();
      } else {
        reject(new Error(`step "${step.name}" (${step.script}) exited ${code}`));
      }
    });
  });
}

// ---- CLI -------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const list = args.includes('--list');
  const positional = args.filter((a) => !a.startsWith('--'));

  if (list) {
    console.log('Offline bake pipeline steps (run in this order):');
    for (const s of STEPS) console.log(`  ${s.name.padEnd(8)} ${s.desc}`);
    return;
  }

  let toRun = STEPS;
  if (positional.length) {
    const wanted = new Set(positional);
    const unknown = positional.filter((n) => !STEPS.some((s) => s.name === n));
    if (unknown.length) {
      console.error(`unknown step(s): ${unknown.join(', ')}`);
      console.error(`known steps: ${STEPS.map((s) => s.name).join(', ')}`);
      process.exit(2);
    }
    toRun = STEPS.filter((s) => wanted.has(s.name));
  }

  console.log(`Crash Junction bake pipeline — ${toRun.length} step(s)${force ? ' (forced)' : ''}`);
  let ran = 0;
  let skipped = 0;
  const t0 = Date.now();
  for (const step of toRun) {
    if (!force && isUpToDate(step)) {
      console.log(`\n• ${step.name}: up to date (outputs newer than inputs) — skipping. Use --force to rebake.`);
      skipped++;
      continue;
    }
    await runStep(step);
    ran++;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nbake pipeline complete: ${ran} ran, ${skipped} skipped, ${secs}s total.`);
}

main().catch((e) => {
  console.error(`\nbake pipeline FAILED: ${e.message}`);
  process.exit(1);
});
