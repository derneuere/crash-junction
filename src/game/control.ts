// Barrel for the player driving model. The implementation lives in ./control/*;
// this file preserves the original public import surface so importers of
// './control' need no change.
export { BOOST_CAP } from './control/constants';
export type { ControlInput } from './control/input';
export { PlayerControl } from './control/playerControl';
