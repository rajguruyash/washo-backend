import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { PoolClient } from 'pg';
import { config } from '../config';
import { Claims, withUser } from '../db';
import { HttpError, fromPg } from '../errors';
import { verifyAccessToken } from '../jwt';
import { AuthSession, gotrue } from '../supabase';

export type Role = 'customer' | 'worker' | 'admin';

export interface Profile {
  id: string;
  role: Role;
  full_name: string | null;
  phone: string | null;
  email: string | null;
}

export interface SessionInfo {
  accessToken: string;
  claims: Claims;
  profile: Profile;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: SessionInfo;
    /** Runs `fn` as the signed-in person. */
    db<T>(fn: (c: PoolClient) => Promise<T>): Promise<T>;
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export const ACCESS_COOKIE = 'washo_at';
export const REFRESH_COOKIE = 'washo_rt';
const REFRESH_DAYS = 30;

const cookieBase = { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/api' } as const;

export function setSessionCookies(res: Response, s: AuthSession) {
  res.cookie(ACCESS_COOKIE, s.access_token, { ...cookieBase, maxAge: Math.max(60, s.expires_in) * 1000 });
  res.cookie(REFRESH_COOKIE, s.refresh_token, { ...cookieBase, maxAge: REFRESH_DAYS * 86_400_000 });
}

export function clearSessionCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { path: '/api' });
}

// One refresh per refresh-token at a time (several page requests can hit an expired access token together).
const inflight = new Map<string, Promise<AuthSession | null>>();
function refreshOnce(rt: string): Promise<AuthSession | null> {
  let p = inflight.get(rt);
  if (!p) {
    p = gotrue.refresh(rt).finally(() => setTimeout(() => inflight.delete(rt), 5_000));
    inflight.set(rt, p);
  }
  return p;
}

/** Establishes who is calling: a verified Supabase token (refreshing it if it has expired) and their profile. */
export const requireSession = asyncHandler(async (req, res, next) => {
  let token = readCookie(req, ACCESS_COOKIE);
  let verified = token ? await verifyAccessToken(token) : null;

  if (!verified) {
    const rt = readCookie(req, REFRESH_COOKIE);
    const fresh = rt ? await refreshOnce(rt) : null;
    if (fresh) {
      const v = await verifyAccessToken(fresh.access_token);
      if (v) {
        token = fresh.access_token;
        verified = v;
        setSessionCookies(res, fresh);
      }
    }
  }
  if (!verified || !token) {
    clearSessionCookies(res);
    throw new HttpError(401, 'unauthenticated', 'Please sign in to continue.');
  }

  const claims: Claims = { sub: verified.sub, phone: verified.phone, email: verified.email };
  const profile = await withUser(claims, async (c) => {
    const { rows } = await c.query<Profile>(
      `SELECT id, role::text AS role, full_name, phone, email FROM public.profiles WHERE auth_user_id = auth.uid()`
    );
    return rows[0];
  });
  if (!profile) throw new HttpError(403, 'no_profile', 'Your account is not set up yet. Please contact WASHO.');

  req.session = { accessToken: token, claims, profile };
  req.db = (fn) => withUser(claims, fn);
  next();
});

/** The role comes from profiles.role in the database; the database's own checks still apply to every call. */
export const requireRole = (...roles: Role[]): RequestHandler => (req, _res, next) => {
  if (!req.session || !roles.includes(req.session.profile.role)) {
    return next(new HttpError(403, 'forbidden', 'You do not have access to that.'));
  }
  next();
};

/**
 * Cookie auth needs CSRF protection. Browsers always send Origin on cross-site writes, so any
 * state-changing request from a foreign origin is refused.
 */
export const sameOriginWrites: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl) don't send Origin
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch {
    /* fall through */
  }
  next(new HttpError(403, 'bad_origin', 'Cross-site request blocked.'));
};

const limiterBase = { standardHeaders: 'draft-7', legacyHeaders: false, skip: () => config.env === 'test' } as const;

export const authLimiter = rateLimit({
  ...limiterBase,
  windowMs: 10 * 60_000,
  limit: 60,
  message: { success: false, code: 'rate_limited', message: 'Too many attempts. Please wait a few minutes.' },
});
export const apiLimiter = rateLimit({
  ...limiterBase,
  windowMs: 60_000,
  limit: 240,
  message: { success: false, code: 'rate_limited', message: 'Too many requests. Please slow down.' },
});

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  const e = err as { type?: string };
  if (e?.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'bad_json', message: 'Malformed request body.' });
  }
  if (e?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, code: 'too_large', message: 'That upload is too large.' });
  }
  const pg = fromPg(err);
  if (pg) return res.status(pg.status).json({ success: false, code: pg.code, message: pg.message });
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, code: 'server_error', message: 'Something went wrong on our side. Please try again.' });
}
