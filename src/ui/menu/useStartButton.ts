import { useEffect } from 'react';
import { useMenuPad } from './useMenuPad';

/** "PRESS START" handling for the title card: Space / Enter / controller-Start
 *  / controller-A all fire `onStart`. (The click is wired on the screen div
 *  itself.) Kept tiny and self-contained so the Title screen stays declarative. */
export function useStartButton(onStart: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        onStart();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onStart]);

  useMenuPad({ onConfirm: onStart });
}
