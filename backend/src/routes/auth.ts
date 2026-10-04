import crypto from 'crypto';
import { Request, Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { HttpError, parse } from '../errors';
import { ACCESS_COOKIE, asyncHandler, authLimiter, clearSessionCookies, readCookie, requireRole, requireSession, setSessionCookies } from '../middleware/http';
import { Claims, withUser } from '../db';
import { phoneSchema } from '../phone';
import { Profile, forgetProfile, needsProfile, profileFor } from '../profile';
import { gotrue } from '../supabase';
import { verifyAccessToken } from '../jwt';

export const authRouter = Router();

const homeFor = (role: Profile['role']) => (role === 'admin' ? '/admin' : role === 'worker' ? '/worker' : '/app');

/** Only ever a path inside this site, never another address. */
const safeNext = (n: unknown): string | null =>
  typeof n === 'string' && /^\/(app|worker|admin)(\/[A-Za-z0-9\-._~%/?=&]*)?$/.test(n) && !n.includes('//') ? n : null;

/**
 * First-touch attribution is write-once in the database. It runs in a savepoint: if the database does not have the function
 * yet, or refuses, that must never undo or abort the sign-in.
 */
async function recordSource(claims: Claims, source: string | undefined) {
  if (!source) return;
  await withUser(claims, async (c) => {
    await c.query('SAVEPOINT src');
    try {
      await c.query('SELECT public.record_signup_source($1)', [source.toLowerCase()]);
      await c.query('RELEASE SAVEPOINT src');
    } catch (err) {
      await c.query('ROLLBACK TO SAVEPOINT src');
      console.warn('record_signup_source skipped:', (err as Error).message);
    }
  }).catch((err) => console.warn('signup source not recorded:', (err as Error).message));
}

const sourceSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/i).optional().catch(undefined);

// Supabase Auth owns the codes, their expiry, attempt limits and the SMS (Twilio Verify). This is a thin relay
// that keeps the resulting tokens in httpOnly cookies, so the browser never holds a token it could leak.
authRouter.post(
  '/auth/otp/request',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    await gotrue.sendOtp(phone);
    res.json({ success: true, resend_in_seconds: 30 });
  })
);

authRouter.post(
  '/auth/otp/verify',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { phone, code, source } = parse(
      z.object({
        phone: phoneSchema,
        code: z.string().regex(/^\d{4,8}$/, 'Enter the code from your SMS.'),
        source: sourceSchema,
      }),
      req.body
    );
    const session = await gotrue.verifyOtp(phone, code);
    setSessionCookies(res, session);

    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    await recordSource(claims, source);

    let profile: Profile;
    try {
      profile = await profileFor(claims, { fresh: true });
    } catch (err) {
      // Signed in at Supabase but unusable here: do not leave half a session behind, and say why.
      clearSessionCookies(res);
      throw err;
    }
    res.json({ success: true, role: profile.role, needs_profile: needsProfile(profile) });
  })
);

// Specialists and WASHO admins sign in with the email + password WASHO created for them. Customers never use this:
// a customer account is refused here even with the right password.
authRouter.post(
  '/auth/staff/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.email('Enter your email address.'), password: z.string().min(1, 'Enter your password.').max(200) }), req.body);
    const session = await gotrue.passwordLogin(email.trim().toLowerCase(), password);
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileFor(claims, { fresh: true });
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    if (profile.role !== 'worker' && profile.role !== 'admin') {
      await gotrue.logout(session.access_token);
      throw new HttpError(403, 'not_staff', 'This sign-in is for WASHO staff. Customers sign in with their mobile number.');
    }
    setSessionCookies(res, session);
    res.json({ success: true, role: profile.role });
  })
);

// Email + password, for any account that has one (specialists and admins today). Where they land depends on their role.
authRouter.post(
  '/auth/email/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(z.object({ email: z.email('Enter your email address.'), password: z.string().min(1, 'Enter your password.').max(200) }), req.body);
    const session = await gotrue.passwordLogin(email.trim().toLowerCase(), password);
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileFor(claims, { fresh: true });
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    setSessionCookies(res, session);
    res.json({ success: true, role: profile.role, needs_profile: needsProfile(profile) });
  })
);

// ───────────────────────── Continue with Google (OAuth through Supabase Auth, PKCE) ─────────────────────────
// 1. /auth/google   makes a one-time secret (the verifier), keeps it in an httpOnly cookie, and sends the browser to Supabase
//                   with only its hash. Supabase sends it on to Google.
// 2. /auth/callback Supabase returns here with a one-time code. Only this browser holds the verifier that unlocks it, so a code
//                   that was meant for someone else (or intercepted) is useless. The session then lives in the usual httpOnly cookies.
// Needs the Google provider switched on in Supabase Auth, and <site>/api/auth/callback in its Redirect URLs.
const PKCE_COOKIE = 'washo_pkce';
const pkceCookie = { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/api/auth' } as const;
const siteOrigin = (req: Request) => config.publicUrl || `${req.protocol}://${req.get('host')}`;

authRouter.get(
  '/auth/google',
  authLimiter,
  asyncHandler(async (req, res) => {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const saved = { v: verifier, n: safeNext(req.query.next), s: parse(sourceSchema, req.query.source) ?? null };
    res.cookie(PKCE_COOKIE, Buffer.from(JSON.stringify(saved)).toString('base64url'), { ...pkceCookie, maxAge: 10 * 60_000 });
    res.redirect(302, gotrue.googleAuthorizeUrl(`${siteOrigin(req)}/api/auth/callback`, challenge));
  })
);

authRouter.get(
  '/auth/callback',
  authLimiter,
  asyncHandler(async (req, res) => {
    const raw = readCookie(req, PKCE_COOKIE);
    res.clearCookie(PKCE_COOKIE, pkceCookie);
    const back = (why: string) => res.redirect(302, `/login?error=${why}`);

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (req.query.error) return back(req.query.error === 'access_denied' ? 'google_cancelled' : 'google_failed');
    if (!code || !raw) return back('google_failed');
    let saved: { v?: string; n?: string | null; s?: string | null };
    try {
      saved = JSON.parse(Buffer.from(raw, 'base64url').toString());
    } catch {
      return back('google_failed');
    }
    if (!saved.v) return back('google_failed');

    let session;
    try {
      session = await gotrue.exchangeCode(code, saved.v);
    } catch (err) {
      console.warn('Google sign-in could not be completed:', (err as Error).message);
      return back('google_failed');
    }
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    await recordSource(claims, parse(sourceSchema, saved.s ?? undefined));
    let profile: Profile;
    try {
      profile = await profileFor(claims, { fresh: true });
    } catch (err) {
      await gotrue.logout(session.access_token);
      if (err instanceof HttpError && err.code === 'account_archived') return back('archived');
      console.error('Google sign-in: signed in at Supabase but the profile could not be loaded:', (err as Error).message);
      return back('google_profile');
    }
    setSessionCookies(res, session);
    const home = homeFor(profile.role);
    const next = safeNext(saved.n);
    res.redirect(302, needsProfile(profile) ? '/app/welcome' : next && next.startsWith(home) ? next : home);
  })
);

// ───────────────────────── a mobile number for people who signed in with Google ─────────────────────────
// A specialist has to ring the customer, so a customer without a verified number cannot book. Supabase texts a code to the NEW
// number; only when it is confirmed does it become theirs. A number that already belongs to another WASHO account is refused.
const customerOnly = [requireSession, requireRole('customer')];

authRouter.post(
  '/auth/phone/request',
  authLimiter,
  ...customerOnly,
  asyncHandler(async (req, res) => {
    const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
    if (req.session!.profile.phone) throw new HttpError(409, 'phone_already_set', 'Your mobile number is already verified.');
    await gotrue.requestPhoneChange(req.session!.accessToken, phone);
    res.json({ success: true, resend_in_seconds: 30 });
  })
);

authRouter.post(
  '/auth/phone/verify',
  authLimiter,
  ...customerOnly,
  asyncHandler(async (req, res) => {
    const { phone, code } = parse(z.object({ phone: phoneSchema, code: z.string().regex(/^\d{4,8}$/, 'Enter the code from your SMS.') }), req.body);
    if (req.session!.profile.phone) throw new HttpError(409, 'phone_already_set', 'Your mobile number is already verified.');
    const session = await gotrue.verifyPhoneChange(req.session!.accessToken, phone, code);
    setSessionCookies(res, session);
    const verified = session.user.phone;
    if (!verified) throw new HttpError(503, 'otp_unavailable', 'We could not confirm that number. Please try again.');
    const claims = { sub: session.user.id, phone: verified, email: session.user.email };
    // Supabase has confirmed the number. If an older WASHO record already has it (booked by phone before), this account joins it;
    // otherwise the number is simply set on this profile. The database only accepts the number this login has verified.
    await withUser(claims, async (c) => {
      await c.query('SELECT public.link_profile_by_phone($1, $2)', [claims.sub, verified]);
      await c.query(`UPDATE public.profiles SET phone = $1, updated_at = now() WHERE auth_user_id = auth.uid() AND COALESCE(phone, '') = ''`, [verified]);
    });
    forgetProfile(claims.sub);
    const profile = await profileFor(claims, { fresh: true });
    res.json({ success: true, user: { ...profile, needs_profile: needsProfile(profile) } });
  })
);

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const at = readCookie(req, ACCESS_COOKIE);
    if (at && (await verifyAccessToken(at))) await gotrue.logout(at);
    clearSessionCookies(res);
    res.json({ success: true });
  })
);

authRouter.get(
  '/me',
  requireSession,
  asyncHandler(async (req, res) => {
    const p = req.session!.profile;
    res.json({ success: true, user: { ...p, needs_profile: needsProfile(p) } });
  })
);
