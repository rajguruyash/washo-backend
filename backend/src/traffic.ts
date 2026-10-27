import type { Request } from 'express';
import { Claims, withUser } from './db';

/**
 * Traffic: who signed in, and who is using WASHO right now (migration 50, shown in Admin -> Dashboard and Traffic). The server records two things for a SIGNED-IN person, through their own
 * database session (so a person can only ever record themselves): the moment they sign in, and "seen just now" on their requests. Nothing is recorded about visitors who have not signed in.
 * Recording never slows a request down and never fails one: a database without migration 50 simply records nothing.
 */
export type Source = 'website' | 'app';
export type SignInMethod = 'phone' | 'email' | 'signup' | 'google' | 'admin_email';

/** The phone app talks to the same API as the website; its networking stack gives it away. */
export const sourceOf = (req: Request): Source => (/okhttp|cfnetwork|expo|reactnative|dalvik/i.test(req.get('user-agent') ?? '') ? 'app' : 'website');

const SEEN_EVERY_MS = 60_000; // a person is marked as seen at most once a minute
const lastSeen = new Map<string, number>();
let warned = false;

function missing(err: unknown) {
  // 42883: the function does not exist (migration 50 has not been applied). Say so once, not on every request.
  if ((err as { code?: string }).code === '42883') {
    if (!warned) console.warn('Traffic is not being recorded: apply migration 50 (supabase/apply/apply_50_traffic.sql).');
    warned = true;
    return;
  }
  console.warn('Traffic not recorded:', (err as Error).message);
}

/** "This person was just seen", on any request of a signed-in person. Not waited for. */
export function touchActivity(req: Request, claims: Claims): void {
  // The phone app asks for notifications on its own every quarter of an hour while it is closed: that is the phone, not the person.
  if (req.method === 'GET' && req.originalUrl.startsWith('/api/notifications') && sourceOf(req) === 'app') return;
  const now = Date.now();
  if (now - (lastSeen.get(claims.sub) ?? 0) < SEEN_EVERY_MS) return;
  lastSeen.set(claims.sub, now);
  if (lastSeen.size > 5000) for (const [k, t] of lastSeen) if (now - t > SEEN_EVERY_MS) lastSeen.delete(k);
  void withUser(claims, (c) => c.query('SELECT public.record_activity($1)', [sourceOf(req)])).catch(missing);
}

/** A person has just signed in. Waited for (it is one quick statement) so the sign-in is on record when the page they land on asks, but a failure never blocks the sign-in. */
export async function recordSignIn(req: Request, claims: Claims, method: SignInMethod): Promise<void> {
  lastSeen.set(claims.sub, Date.now()); // signing in is being seen: no second write a moment later
  await withUser(claims, (c) => c.query('SELECT public.record_sign_in($1, $2)', [method, sourceOf(req)])).catch(missing);
}

/** For tests. */
export const forgetTraffic = () => {
  lastSeen.clear();
  warned = false;
};
