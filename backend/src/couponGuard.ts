import { HttpError } from './errors';

/**
 * Coupon codes are short words people hand to each other, so they can be guessed. A person who types wrong codes too often is asked to wait: 10 codes that could not be
 * used in 15 minutes (counted per signed-in person, on this server). A code that works never counts against anyone, and a wrong one costs nothing but the wait.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
const fails = new Map<string, number[]>();

const recent = (key: string) => {
  const cutoff = Date.now() - WINDOW_MS;
  const list = (fails.get(key) ?? []).filter((t) => t > cutoff);
  if (list.length) fails.set(key, list); else fails.delete(key);
  return list;
};

export const forgetCouponTries = () => fails.clear();

/** A message from the database about a coupon (not valid, expired, used up, already used): the answer to "can I use this code?", not a server fault. */
const isCouponRefusal = (err: unknown) => {
  const e = err as { code?: string; message?: string } | null;
  return e?.code === 'P0001' && /coupon/i.test(e.message ?? '');
};

/** Runs something that applies a coupon for this person; refuses to start when they have been wrong too often, and remembers when they are wrong again. */
export async function withCouponGuard<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (recent(key).length >= MAX_FAILS) throw new HttpError(429, 'too_many_tries', 'Too many coupon codes that did not work. Please wait a few minutes and try again.');
  try {
    return await run();
  } catch (err) {
    if (isCouponRefusal(err)) {
      if (fails.size > 5000) fails.clear();
      fails.set(key, [...recent(key), Date.now()]);
    }
    throw err;
  }
}
