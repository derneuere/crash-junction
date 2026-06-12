// Extend a replay fixture's tail with idle frames (no keys, ~60 fps). A
// recorded tape ends at the R press — when the asserted behavior plays out
// AFTER that moment (a landing, a timed rescue), append input silence so the
// fixture window contains it. Appended frames are real replay input; the
// recorded checksums end where the recording did.
//   node tests/extend-fixture.mjs <in.json> <out.json> <secondsToAppend>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inFile, outFile, secondsArg] = process.argv;
const seconds = Number(secondsArg);
const src = JSON.parse(readFileSync(inFile, 'utf8'));
const DT = 1 / 60;
const n = Math.round(seconds / DT);
const out = {
  ...src,
  note: `${src.note ? src.note + ' — ' : ''}extended ${seconds}s with idle frames`,
  dts: src.dts.concat(Array(n).fill(DT)),
  keyMasks: src.keyMasks.concat(Array(n).fill(0)),
};
writeFileSync(outFile, JSON.stringify(out));
console.log(`${outFile}: ${out.dts.length} frames (+${n} idle)`);
