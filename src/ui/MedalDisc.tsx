import type { Medal } from '../game/events';

/** Tiny metallic medal disc — the at-a-glance "what's left to gold" read
 *  B3 stamps on every event slot. Colors mirror .panel .medal in styles.css;
 *  null/NONE renders the hollow "no record" pip. */
export function MedalDisc({ medal }: { medal: Medal | null | undefined }) {
  const m = medal && medal !== 'NONE' ? medal.toLowerCase() : 'none';
  const title = medal && medal !== 'NONE' ? `${medal} MEDAL` : 'NO MEDAL YET';
  return <span className={`medalDisc ${m}`} title={title} aria-label={title} />;
}
