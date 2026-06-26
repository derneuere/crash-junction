// Barrel for the race director. The implementation lives in ./race/* — this
// re-exports the original public surface so importers of './race' are
// unchanged. Split purely to keep every module under the line budget; no
// behaviour, constant, or order-of-operations was touched.
export type { RaceSection } from './race/sections';
export { buildLoopSections, buildOpenSections, SHORTCUT_SPACING } from './race/sections';
export { RaceDirector } from './race/director';
