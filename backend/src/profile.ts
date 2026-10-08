import type { PoolClient } from 'pg';
import { Claims, withUser } from './db';
import { HttpError } from './errors';

export type Role = 'customer' | 'worker' | 'admin';

export interface Profile {
  id: string;
  role: Role;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  /** Archived by an admin: the account may not be used (migration 20261004000013). */
  archived: boolean;
}

/**
 * Loads the signed-in person's public.profiles row, mapped from the Supabase Auth user through profiles.auth_user_id.
 * The role is whatever profiles.role says.
 *
 * Reads the row as JSON and picks the columns it needs, so a column that has not been added to this database yet
 * (profiles.email arrives with migration 20261004000003) can never break sign-in. Email falls back to the one on the
 * Supabase Auth token. Returns null when the person has no profile row.
 */
export async function loadProfile(c: PoolClient, claims: Claims): Promise<Profile | null> {
  const { rows } = await c.query<{ p: Record<string, unknown> }>('SELECT to_jsonb(p) AS p FROM public.profiles p WHERE p.auth_user_id = auth.uid() LIMIT 1');
  const p = rows[0]?.p;
  if (!p) return null;
  return {
    id: String(p.id),
    role: p.role as Role,
    full_name: (p.full_name as string | null) ?? null,
    phone: (p.phone as string | null) ?? claims.phone ?? null,
    email: (p.email as string | null) ?? claims.email ?? null,
    archived: Boolean(p.archived_at),
  };
}

/**
 * A customer is set up once we know their name. A mobile number (a specialist rings before every wash) is asked for, and verified, at the
 * moment they pay, not before: someone who signed in with their email can look around freely first. Payments refuse without it (requirePhone).
 */
export const needsProfile = (p: Profile) => p.role === 'customer' && !p.full_name;

// The role and name rarely change. Re-reading them on EVERY request doubled the database round trips, so they are remembered
// briefly. Anything that changes them (profile save, sign-in) calls forgetProfile().
const TTL_MS = 30_000;
const remembered = new Map<string, { at: number; profile: Profile }>();
export const forgetProfile = (sub: string) => void remembered.delete(sub);

/** loadProfile as the user, turning any database failure into an error the person (and the logs) can act on. */
export async function profileFor(claims: Claims, o: { fresh?: boolean } = {}): Promise<Profile> {
  const hit = remembered.get(claims.sub);
  if (!o.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.profile;
  let profile: Profile | null;
  try {
    profile = await withUser(claims, (c) => loadProfile(c, claims));
  } catch (err) {
    console.error('Profile lookup failed for an authenticated user:', (err as Error).message);
    throw new HttpError(503, 'profile_unavailable', 'You are signed in, but we could not load your profile. Please try again in a moment. If it keeps happening, contact WASHO.');
  }
  if (!profile) throw new HttpError(403, 'no_profile', 'Your account is not set up yet. Please contact WASHO.');
  if (profile.archived) {
    remembered.delete(claims.sub);
    throw new HttpError(403, 'account_archived', 'This account has been deactivated. Please contact WASHO.');
  }
  if (remembered.size > 500) remembered.clear();
  remembered.set(claims.sub, { at: Date.now(), profile });
  return profile;
}

/**
 * profileFor, for the moment someone has just proved who they are (a code): a login with no profile (an account made before profiles were created
 * automatically, or one the trigger missed) gets one, instead of being told their account is not set up. Falls back to the original answer if the
 * database cannot repair it (or does not have ensure_my_profile yet).
 */
export async function profileForOrRepair(claims: Claims): Promise<Profile> {
  try {
    return await profileFor(claims, { fresh: true });
  } catch (err) {
    if (!(err instanceof HttpError && err.code === 'no_profile')) throw err;
    try {
      await withUser(claims, (c) => c.query('SELECT public.ensure_my_profile()'));
    } catch (repair) {
      console.warn('Could not create a missing profile on sign-in:', (repair as Error).message);
      throw err;
    }
    forgetProfile(claims.sub);
    return profileFor(claims, { fresh: true });
  }
}
