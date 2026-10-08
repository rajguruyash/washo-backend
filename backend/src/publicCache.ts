/**
 * A few seconds of memory for answers that are the same for every visitor (the rate card, the campaign banner, an anonymous price estimate).
 * Every first look at the site used to wait on the database for them; now only the first visitor in a window does, the others get the same
 * answer at once, and visitors who ask while it is being fetched share that one fetch. Anything that is about a particular signed-in person is
 * never kept here. An admin changing anything (prices, services, campaigns, limits) empties it straight away, as does a claim, so nobody is
 * shown a stale number for longer than it takes the next request to come in.
 */
import { config } from './config';

type Entry = { at: number; value?: unknown; pending?: Promise<unknown> };
const store = new Map<string, Entry>();
// Off while the tests run (they change the database directly and expect to see it at once); one test file turns it on to test the cache itself.
let enabled = config.env !== 'test';
export const setPublicCacheEnabled = (on: boolean) => {
  enabled = on;
  store.clear();
};

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  if (!enabled) return load();
  const hit = store.get(key);
  if (hit) {
    if (hit.pending) return hit.pending as Promise<T>;
    if (Date.now() - hit.at < ttlMs) return hit.value as T;
  }
  const pending = load().then(
    (value) => {
      if (store.get(key)?.pending === pending) store.set(key, { at: Date.now(), value });
      return value;
    },
    (err) => {
      if (store.get(key)?.pending === pending) store.delete(key); // a failure is never remembered
      throw err;
    }
  );
  store.set(key, { at: hit?.at ?? 0, pending });
  return pending;
}

export const forgetPublic = () => void store.clear();
