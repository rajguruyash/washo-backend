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
  };
}

/** loadProfile as the user, turning any database failure into an error the person (and the logs) can act on. */
export async function profileFor(claims: Claims): Promise<Profile> {
  let profile: Profile | null;
  try {
    profile = await withUser(claims, (c) => loadProfile(c, claims));
  } catch (err) {
    console.error('Profile lookup failed for an authenticated user:', (err as Error).message);
    throw new HttpError(503, 'profile_unavailable', 'You are signed in, but we could not load your profile. Please try again in a moment. If it keeps happening, contact WASHO.');
  }
  if (!profile) throw new HttpError(403, 'no_profile', 'Your account is not set up yet. Please contact WASHO.');
  return profile;
}
