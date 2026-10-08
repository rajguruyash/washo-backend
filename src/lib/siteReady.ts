import { useSyncExternalStore } from 'react';

// Whether the opening loading screen has gone. Things that animate "when the page opens" (the price countdown) wait for it, or they would play
// unseen underneath it.
let ready = false;
const listeners = new Set<() => void>();

export function markSiteReady() {
  if (ready) return;
  ready = true;
  listeners.forEach((fn) => fn());
  listeners.clear();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

export const useSiteReady = (): boolean => useSyncExternalStore(subscribe, () => ready, () => true);
