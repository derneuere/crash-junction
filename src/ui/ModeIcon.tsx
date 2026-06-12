import type { ModeKind } from '../game/types';

// B3's Crash Nav event-type icon language (research doc §1.3), as inline SVG
// so the cards ship with zero image assets: crash = starburst, race =
// checkered flag, practice = traffic cone. All fill currentColor — the mode
// row's CSS color is the icon's color.

const COMMON = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'currentColor',
  'aria-hidden': true as const,
};

export function ModeIcon({ kind }: { kind: ModeKind }) {
  switch (kind) {
    case 'crash':
      // eight-point starburst — the pileup
      return (
        <svg {...COMMON}>
          <polygon points="8,0 9.8,5 14.5,2.5 11,6.8 16,8 11,9.2 14.5,13.5 9.8,11 8,16 6.2,11 1.5,13.5 5,9.2 0,8 5,6.8 1.5,2.5 6.2,5" />
        </svg>
      );
    case 'race':
      // checkered flag on a pole
      return (
        <svg {...COMMON}>
          <rect x="1.5" y="0" width="1.6" height="16" />
          <path d="M4 1h10v8H4z" fillOpacity="0.25" />
          <path d="M4 1h2.5v2H4zM9 1h2.5v2H9zM6.5 3H9v2H6.5zM11.5 3H14v2h-2.5zM4 5h2.5v2H4zM9 5h2.5v2H9zM6.5 7H9v2H6.5zM11.5 7H14v2h-2.5z" />
        </svg>
      );
    case 'practice':
      // traffic cone with its reflective band
      return (
        <svg {...COMMON}>
          <path d="M8 1 L11.6 13 H4.4 Z" />
          <path d="M6.1 7.4 h3.8 l0.7 2.4 h-5.2 z" fill="#0c0e12" />
          <rect x="2.5" y="13" width="11" height="1.8" />
        </svg>
      );
  }
}
