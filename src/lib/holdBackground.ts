import { useSyncExternalStore } from 'react';

/**
 * The animated background (the wall of slats and the drifting glows) redraws all the time, and on a phone that competes with anything that opens over the page: the Woshi chat froze for several
 * seconds while it did. A screen that opens over the page holds the background still for as long as it is open; the background carries on once the last holder lets go.
 */
let holders = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Holds the background still; call the function it returns to let go. */
export function holdBackground(): () => void {
  holders += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    emit();
  };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export const useBackgroundHeld = () => useSyncExternalStore(subscribe, () => holders > 0, () => false);
