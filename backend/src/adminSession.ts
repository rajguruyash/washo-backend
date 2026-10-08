import crypto from 'crypto';
import type { Request, Response } from 'express';
import { config } from './config';

/**
 * Admin sign-in is two steps: the password, then a code emailed to the admin (through Resend). This file holds what remembers the middle of that
 * and the end of it, both as SIGNED cookies (only this server can make them):
 *
 *   washo_2fa_pending   "this browser got the password right a moment ago": who, which address got the code, when it runs out.
 *   washo_2fa           "this browser has finished both steps": who, when they signed in, when they were last seen.
 *
 * Supabase issues a login token from the password alone, and that cannot be changed, so a stolen password could be turned into a token by talking to
 * Supabase directly. That token is not enough to use the website: every admin request must also carry washo_2fa for the same person, which only a
 * finished second step produces. It slides while the admin is busy and runs out after `idleMinutes` without a request (and after 12 hours always).
 */
const PENDING_COOKIE = 'washo_2fa_pending';
const DONE_COOKIE = 'washo_2fa';
const PENDING_MS = 10 * 60_000;
const ABSOLUTE_MS = 12 * 3_600_000;
const MAX_WRONG_CODES = 5;
const idleMs = () => config.admin.idleMinutes * 60_000;

const secret = (): Buffer | null => {
  if (config.admin.secret) return Buffer.from(config.admin.secret);
  const key = config.supabase.serviceRoleKey;
  if (key) return crypto.createHmac('sha256', key).update('washo-admin-2fa-v1').digest();
  return config.isProd ? null : Buffer.from('washo-dev-only-admin-secret');
};

/** True when this server can hold a second step at all. If not, admins are refused (never let in on a password alone). */
export const secondStepAvailable = () => secret() !== null;

const seal = (payload: Record<string, unknown>): string => {
  const key = secret();
  if (!key) throw new Error('No secret for the admin second step');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
};

function unseal<T>(token: string | undefined): T | null {
  const key = secret();
  if (!key || !token) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = crypto.createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  } catch {
    return null;
  }
}

const base = (path: string) => ({ httpOnly: true, sameSite: 'lax', secure: config.isProd, path }) as const;
const cookie = (path: string, maxAge: number) => ({ ...base(path), maxAge }) as const;
const readCookieRaw = (req: Request, name: string): string | undefined => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
};

export interface Pending { sub: string; email: string; jti: string; exp: number }
const wrong = new Map<string, number>(); // jti -> wrong codes so far (this server only; a restart simply forgets, and the pending step expires on its own)

/** The password was right: remember that for ten minutes, until the code comes back. */
export function begin(res: Response, who: { sub: string; email: string }): Pending {
  const p: Pending = { ...who, jti: crypto.randomBytes(12).toString('base64url'), exp: Date.now() + PENDING_MS };
  res.cookie(PENDING_COOKIE, seal(p as unknown as Record<string, unknown>), cookie('/api/auth', PENDING_MS));
  return p;
}

export function pending(req: Request): Pending | null {
  const p = unseal<Pending>(readCookieRaw(req, PENDING_COOKIE));
  return p && p.exp > Date.now() && typeof p.sub === 'string' && typeof p.email === 'string' ? p : null;
}

/** One more wrong code. Returns how many tries are left; at zero the step is cancelled and the admin starts again from the password. */
export function wrongCode(res: Response, p: Pending): number {
  const n = (wrong.get(p.jti) ?? 0) + 1;
  if (wrong.size > 500) wrong.clear();
  wrong.set(p.jti, n);
  if (n >= MAX_WRONG_CODES) {
    res.clearCookie(PENDING_COOKIE, base('/api/auth'));
    return 0;
  }
  return MAX_WRONG_CODES - n;
}

/** Both steps are done: forget the pending step and start the signed-in clock. */
export function finish(res: Response, sub: string): void {
  res.clearCookie(PENDING_COOKIE, base('/api/auth'));
  const now = Date.now();
  res.cookie(DONE_COOKIE, seal({ sub, iat: now, seen: now }), cookie('/api', idleMs()));
}

/**
 * Forget a finished second step (signing out, or a session that is no longer good). The PENDING cookie is deliberately left alone: the page asks "am I signed in?"
 * while the admin is still typing the emailed code, and that answer ("no") must not throw away the step they are in the middle of.
 */
export function clear(res: Response): void {
  res.clearCookie(DONE_COOKIE, base('/api'));
}

export type StepCheck = 'ok' | 'missing' | 'idle';
/** Called on every admin request: the second step must be done for THIS person, recently. Slides the clock while they are active. */
export function check(req: Request, res: Response, sub: string): StepCheck {
  const t = unseal<{ sub: string; iat: number; seen: number }>(readCookieRaw(req, DONE_COOKIE));
  if (!t || t.sub !== sub || typeof t.iat !== 'number' || typeof t.seen !== 'number') return 'missing';
  const now = Date.now();
  if (now - t.iat > ABSOLUTE_MS || now - t.seen > idleMs()) return 'idle';
  if (now - t.seen > 30_000) res.cookie(DONE_COOKIE, seal({ sub, iat: t.iat, seen: now }), cookie('/api', idleMs()));
  return 'ok';
}
