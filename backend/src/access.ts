import type { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { Claims, withUser } from './db';
import { HttpError } from './errors';
import { asyncHandler, requireRole, requireSession } from './middleware/http';

/**
 * Who may do what in the admin console. The roles and what each may view or manage are DATA in the database (admin_access, admin_role_areas, migration 27);
 * this file asks the database who the caller is, and turns every /api/admin request into "which area, view or manage" so ONE gate covers every route, including
 * ones added later. An area the table below does not know is refused to everyone but the super admin, so a forgotten route is closed, not open.
 */
export type Level = 'view' | 'manage';
export interface AdminAccess {
  access: 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support';
  areas: Record<string, Level>;
}

// The same list the migration seeds for the super admin. Only used to describe the owner's reach when the owner is recognised by their email
// (so a mistake in the roles table can never lock them out).
export const ALL_AREAS = [
  'overview', 'requests', 'bookings', 'memberships', 'people', 'services', 'campaigns', 'capacity', 'payments', 'history', 'support', 'activity', 'settings', 'team',
  'export_customers', 'export_washes', 'export_memberships', 'export_payments', 'export_refunds', 'export_support', 'export_activity',
] as const;

const TTL_MS = 30_000;
const remembered = new Map<string, { at: number; value: AdminAccess | null }>();
export const forgetAccess = () => remembered.clear();

/** The signed-in admin's role and reach, from the database (remembered for half a minute). The owner's email is always the super admin. */
export async function adminAccessFor(claims: Claims): Promise<AdminAccess | null> {
  const hit = remembered.get(claims.sub);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: AdminAccess | null = null;
  try {
    value = await withUser(claims, async (c) => (await c.query('SELECT public.my_admin_access() AS a')).rows[0].a as AdminAccess | null);
  } catch (err) {
    console.error('Could not read the admin role:', (err as Error).message);
  }
  if (claims.email && claims.email.toLowerCase() === config.admin.superEmail) {
    value = { access: 'super_admin', areas: Object.fromEntries(ALL_AREAS.map((a) => [a, 'manage' as Level])) };
  }
  if (remembered.size > 200) remembered.clear();
  remembered.set(claims.sub, { at: Date.now(), value });
  return value;
}

// The first part of an /api/admin/... path -> the area it belongs to.
const AREA_OF: Record<string, string> = {
  overview: 'overview', dashboard: 'overview',
  'membership-requests': 'requests',
  bookings: 'bookings', reviews: 'bookings',
  memberships: 'memberships', reminders: 'memberships', renewals: 'memberships',
  attention: 'payments', payments: 'payments', refunds: 'payments',
  workers: 'people', customers: 'people', vehicles: 'people', addresses: 'people',
  history: 'history',
  services: 'services', pricing: 'services', discounts: 'services', 'pricing-settings': 'services',
  campaigns: 'campaigns', coupons: 'campaigns',
  capacity: 'capacity',
  support: 'support',
  activity: 'activity',
  settings: 'settings',
  team: 'team',
};

/** `path` is relative to /api/admin, e.g. "/bookings/123/assign". Reading is 'view'; anything that changes something is 'manage'. */
export function areaFor(path: string, method: string): { area: string; level: Level } {
  const [first = '', second = ''] = path.split('/').filter(Boolean);
  const level: Level = method === 'GET' || method === 'HEAD' ? 'view' : 'manage';
  if (first === 'export') return { area: `export_${second}`, level: 'manage' };
  return { area: AREA_OF[first] ?? 'team', level };
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminAccess;
  }
}

export const can = (a: AdminAccess | undefined, area: string, level: Level = 'view') => {
  const have = a?.areas[area];
  return have === 'manage' || (have === 'view' && level === 'view');
};

/** Mounted once on /api/admin: a signed-in admin (second step done), with a role, whose role may do THIS. */
export const adminGate = [
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    const access = await adminAccessFor(req.session!.claims);
    if (!access) throw new HttpError(403, 'no_admin_role', 'Your admin account has no role yet. Ask the super admin to give you one.');
    const { area, level } = areaFor(req.path, req.method);
    if (!can(access, area, level)) throw new HttpError(403, 'forbidden', 'Your admin role cannot do that.');
    req.admin = access;
    next();
  }),
];
