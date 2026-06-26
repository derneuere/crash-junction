// Barrel for the crash/contact rules. The implementation lives in
// ./collision/*; this file preserves the original public import surface so
// importers of './collision' need no change.
export type { ImpactJudgment, ContactContext, ContactOutcome } from './collision/types';
export { judgePlayerImpact, judgeAggressor, isTboneTakedown } from './collision/judgment';
export { resolveJunctionContact, resolveRaceContact } from './collision/resolve';
export { contactPointOf } from './collision/contactPoint';
