// Whether the loading screen (SiteLoader) has finished, so things that should play "when the page opens" wait for the page to be seen.
let done = false;
const listeners = new Set<() => void>();

export const loaderIsDone = () => done;

export function markLoaderDone() {
  if (done) return;
  done = true;
  listeners.forEach((fn) => fn());
  listeners.clear();
}

/** Calls `fn` once the loading screen is gone (at once if it already is). Returns a function that cancels. */
export function whenLoaderDone(fn: () => void): () => void {
  if (done) {
    fn();
    return () => undefined;
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
