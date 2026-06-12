// Trim a replay fixture's tail. A bug fixture only needs frames up to
// (shortly past) the moment it asserts on — the tail is where a tape drifts
// off the current sim and turns the stats into noise (takedown-cam-throw
// ended with 2 s of desynced recorded steering driving the player off road).
//   node tests/trim-fixture.mjs <in.json> <out.json> <simSeconds>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile, outFile, simSecondsArg] = process.argv;
const simSeconds = Number(simSecondsArg);
const src = JSON.parse(readFileSync(inFile, 'utf8'));

// frames map 1:1 to sim time while timeScale is 1 (no player crash) — find
// the frame where the dt-sum crosses the cut, and keep checksums inside it
let acc = 0;
let frames = src.dts.length;
for (let i = 0; i < src.dts.length; i++) {
  acc += src.dts[i];
  if (acc >= simSeconds) {
    frames = i + 1;
    break;
  }
}
const maxStep = Math.floor((simSeconds - 0.1) * 120);
const out = {
  ...src,
  note: `${src.note ? src.note + ' — ' : ''}tail trimmed to ${simSeconds}s (frame ${frames})`,
  dts: src.dts.slice(0, frames),
  keyMasks: src.keyMasks.slice(0, frames),
  hidden: src.hidden.filter((f) => f < frames),
  commands: src.commands.filter((c) => c.f < frames),
  checksums: src.checksums.filter((c) => c.s <= maxStep),
};
writeFileSync(outFile, JSON.stringify(out));
console.log(`${outFile}: ${out.dts.length} frames, ${out.checksums.length} checksums, ${out.commands.length} commands`);
