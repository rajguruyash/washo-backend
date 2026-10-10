import crypto from 'crypto';
import { Request, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { adminAccessFor } from '../access';
import * as adminStep from '../adminSession';
import { config } from '../config';
import { HttpError, parse } from '../errors';
import { ACCESS_COOKIE, asyncHandler, authLimiter, clearSessionCookies, readCookie, requireRole, requireSession, setSessionCookies } from '../middleware/http';
import { Claims, withUser } from '../db';
import { phoneLoginEmail, phoneSchema } from '../phone';
import { Profile, forgetProfile, needsProfile, profileFor, profileForOrRepair } from '../profile';
import { adminSignInCodeEmail } from '../emails';
import { customerPassword, strongPassword } from '../password';
import { mailConfigured, sendMail } from '../notify';
import { gotrue, gotrueAdmin } from '../supabase';
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

    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileForOrRepair(claims);
    } catch (err) {
      // Signed in at Supabase but unusable here: do not leave half a session behind, and say why.
      await gotrue.logout(session.access_token);
      throw err;
    }
    // A text message alone must never open an admin account (a stolen or swapped SIM would be enough): admins sign in with their email, password and emailed code.
    if (profile.role === 'admin') {
      await gotrue.logout(session.access_token);
      throw new HttpError(403, 'admin_use_email', 'Admins sign in with their email and password. Choose "Continue with Email".');
    }
    setSessionCookies(res, session);
    await recordSource(claims, source);
    res.json({ success: true, role: profile.role, needs_profile: needsProfile(profile) });
  })
);

// ───────────────────────── email + password ─────────────────────────
// A customer can sign up or sign in with an email and a password. There is NO email verification and NO emailed code for customers: the password is
// their key (and a mobile number is asked for, unverified, before they pay). Specialists use the same form. An ADMIN's password is only the first step:
// a code is then emailed to them (through Resend) and the session starts only when it comes back (below).
const emailSchema = z.email('Enter a valid email address.').max(254);
const loginBody = z.object({ email: emailSchema, password: z.string().min(1, 'Enter your password.').max(200) });

const COOLDOWN_MS = 30_000;
const HOURLY_MAX = 6;
const asked = new Map<string, number[]>(); // address -> when admin codes were last asked for (this server only; Supabase and the IP limiter back it up)
const tooMany = (email: string): HttpError | null => {
  const now = Date.now();
  const recent = (asked.get(email) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length && now - recent[recent.length - 1] < COOLDOWN_MS) return new HttpError(429, 'otp_cooldown', 'Please wait a little before asking for another code.');
  if (recent.length >= HOURLY_MAX) return new HttpError(429, 'otp_cooldown', 'Too many codes were asked for this account. Please try again in an hour.');
  recent.push(now);
  asked.set(email, recent);
  if (asked.size > 2000) asked.clear();
  return null;
};

/** Tests only: forget who was sent a code, so one admin can sign in again at once. */
export const forgetCodeCooldowns = () => asked.clear();

// Wrong passwords for one address: after 8 in 15 minutes it waits, whoever is asking (Supabase has its own limits behind this one).
const failures = new Map<string, number[]>();
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 8;
const recentFailures = (key: string) => (failures.get(key) ?? []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);
const lockedOut = (key: string) => recentFailures(key).length >= FAIL_MAX;
const noteFailure = (key: string) => {
  failures.set(key, [...recentFailures(key), Date.now()]);
  if (failures.size > 2000) failures.clear();
};

// A new account is a bigger step than a sign-in, so a single address (a robot) may only make so many an hour. Mobile networks and apartment wifi put many
// real people behind one address, so the number is generous.
const signupLimiter = rateLimit({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.env === 'test',
  windowMs: 60 * 60_000,
  limit: 30,
  message: { success: false, code: 'rate_limited', message: 'Too many new accounts from here. Please try again later.' },
});

const maskEmail = (e: string) => e.replace(/^(.)(.*)(.)@/, (_m, a: string, mid: string, z: string) => (mid ? `${a}***${z}@` : `${a}***@`));

authRouter.post(
  '/auth/email/signup',
  authLimiter,
  signupLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, source } = parse(z.object({ email: emailSchema, password: customerPassword, source: sourceSchema }), req.body);
    const addr = email.trim().toLowerCase();
    await gotrueAdmin.createEmailUser(addr, password);
    const session = await gotrue.passwordLogin(addr, password);
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileForOrRepair(claims);
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    if (profile.role !== 'customer') {
      await gotrue.logout(session.access_token);
      throw new HttpError(403, 'not_customer', 'That email cannot be used to sign up.');
    }
    setSessionCookies(res, session);
    await recordSource(claims, source);
    res.status(201).json({ success: true, role: profile.role, needs_profile: needsProfile(profile) });
  })
);

authRouter.post(
  '/auth/email/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parse(loginBody, req.body);
    const addr = email.trim().toLowerCase();
    if (lockedOut(addr)) throw new HttpError(429, 'login_limit', 'Too many wrong passwords for this account. Please wait 15 minutes, or sign in with your mobile number.');
    let session;
    try {
      session = await gotrue.passwordLogin(addr, password);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'bad_credentials') noteFailure(addr);
      throw err;
    }
    failures.delete(addr);
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileForOrRepair(claims); // an older login with no profile is set up now, instead of being told its account is missing
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    if (profile.role !== 'admin') {
      setSessionCookies(res, session);
      return res.json({ success: true, role: profile.role, needs_profile: needsProfile(profile) });
    }

    // An admin: the password was only the first step. The login Supabase just gave is thrown away; nothing is signed in until the emailed code comes back.
    await gotrue.logout(session.access_token);
    if (!adminStep.secondStepAvailable() || !mailConfigured()) {
      throw new HttpError(503, 'two_step_unavailable', 'Admin sign-in needs email to be set up on the server, and it is not right now. Please try again shortly.');
    }
    const sentTo = await sendAdminCode(res, { sub: session.user.id, email: addr });
    res.json({ success: true, step: 'code', email_hint: maskEmail(sentTo), resend_in_seconds: 30 });
  })
);

/** Makes a code for the admin, emails it, and remembers (signed, in their browser) that the password was right. */
async function sendAdminCode(res: Parameters<typeof adminStep.begin>[0], who: { sub: string; email: string }): Promise<string> {
  const limited = tooMany(`admin:${who.email}`);
  if (limited) throw limited;
  const code = await gotrueAdmin.loginCode(who.email);
  const to = config.admin.codeTo || who.email; // normally their own address (ADMIN_CODE_TO is a temporary escape hatch, see config)
  try {
    await sendMail({ to, ...adminSignInCodeEmail(code) });
  } catch (err) {
    console.error(`Admin sign-in code email to ${maskEmail(to)} failed:`, (err as Error).message);
    throw new HttpError(503, 'otp_unavailable', 'We could not email the code. Please try again in a moment.');
  }
  adminStep.begin(res, who);
  return to;
}

authRouter.post(
  '/auth/admin/code/verify',
  authLimiter,
  asyncHandler(async (req, res) => {
    const step = adminStep.pending(req);
    if (!step) throw new HttpError(401, 'step_expired', 'That took too long. Please enter your email and password again.');
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{4,10}$/, 'Enter the code from your email.') }), req.body);
    let session;
    try {
      session = await gotrue.verifyEmailOtp(step.email, code);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'otp_invalid') {
        const left = adminStep.wrongCode(res, step);
        if (left === 0) throw new HttpError(429, 'too_many_codes', 'Too many wrong codes. Please enter your email and password again.');
        throw new HttpError(400, 'otp_invalid', `That code isn't right, or it has expired. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
      }
      throw err;
    }
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    if (session.user.id !== step.sub) {
      await gotrue.logout(session.access_token);
      throw new HttpError(401, 'step_expired', 'That took too long. Please enter your email and password again.');
    }
    let profile: Profile;
    try {
      profile = await profileFor(claims, { fresh: true });
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    if (profile.role !== 'admin') {
      await gotrue.logout(session.access_token);
      throw new HttpError(403, 'forbidden', 'You do not have access to that.');
    }
    setSessionCookies(res, session);
    adminStep.finish(res, claims.sub);
    // A record of the sign-in for the activity log. Best effort: it never blocks a sign-in.
    await withUser(claims, (c) => c.query(`SELECT public.admin_log_event('admin_signed_in')`)).catch((e) => console.warn('Sign-in not logged:', (e as Error).message));
    res.json({ success: true, role: 'admin' });
  })
);

authRouter.post(
  '/auth/admin/code/resend',
  authLimiter,
  asyncHandler(async (req, res) => {
    const step = adminStep.pending(req);
    if (!step) throw new HttpError(401, 'step_expired', 'That took too long. Please enter your email and password again.');
    if (!adminStep.secondStepAvailable() || !mailConfigured()) throw new HttpError(503, 'two_step_unavailable', 'We cannot email codes right now. Please try again shortly.');
    const sentTo = await sendAdminCode(res, { sub: step.sub, email: step.email });
    res.json({ success: true, email_hint: maskEmail(sentTo), resend_in_seconds: 30 });
  })
);

// ───────────────────────── mobile number + password ─────────────────────────
// How customers sign in on the website: a mobile number and a password, no code and no SMS (a code only helps if the phone company delivers it, and it
// costs every time). The password belongs to a login Supabase keeps under an address derived from the number (see phone.ts); the typed number is attached to it
// UNCONFIRMED and saved on the profile the same way "add your number" does, so it never links or merges with an account by itself and a number another account
// already has is refused. The session is a normal Supabase one in the usual httpOnly cookies, and stays for 30 days of use (see middleware/http.ts).
// If the same person ever signs in with a code on that number (the code link on the sign-in page), they land in this same account.
const mobileSignupBody = z.object({ phone: phoneSchema, password: customerPassword, name: z.string().trim().min(2, 'Enter your name.').max(80).optional(), source: sourceSchema });
const mobileLoginBody = z.object({ phone: phoneSchema, password: z.string().min(1, 'Enter your password.').max(200) });

authRouter.post(
  '/auth/mobile/signup',
  authLimiter,
  signupLimiter,
  asyncHandler(async (req, res) => {
    const { phone, password, name, source } = parse(mobileSignupBody, req.body);
    const loginEmail = phoneLoginEmail(phone);
    await gotrueAdmin.createPhoneAccount(loginEmail, password, phone, name); // refuses a number that already has an account; creates nothing in that case
    const session = await gotrue.passwordLogin(loginEmail, password);
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileForOrRepair(claims);
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    if (profile.role !== 'customer') {
      await gotrue.logout(session.access_token);
      throw new HttpError(403, 'not_customer', 'That number cannot be used to sign up.');
    }
    // The number goes on the profile in the standard +91 form, as "add your number" does it. A refusal (another profile already has it) must not undo the sign-up.
    await withUser(claims, (c) => c.query('SELECT public.set_my_phone($1)', [phone])).catch((err) => console.warn('The number could not be saved on the new profile:', (err as Error).message));
    forgetProfile(claims.sub);
    setSessionCookies(res, session);
    await recordSource(claims, source);
    const fresh = await profileFor(claims, { fresh: true }).catch(() => profile);
    res.status(201).json({ success: true, role: fresh.role, needs_profile: needsProfile(fresh) });
  })
);

authRouter.post(
  '/auth/mobile/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { phone, password } = parse(mobileLoginBody, req.body);
    const key = `mobile:${phone}`;
    const wrong = () => new HttpError(401, 'bad_credentials', 'Mobile number or password is incorrect.');
    if (lockedOut(key)) throw new HttpError(429, 'login_limit', 'Too many wrong passwords for this number. Please wait 15 minutes.');
    let session;
    try {
      session = await gotrue.passwordLogin(phoneLoginEmail(phone), password);
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 'bad_credentials')) throw err;
      // Not an account made this way: a number a code has confirmed and a password has been set on (by the person, or for them by WASHO).
      try {
        session = await gotrue.passwordLoginPhone(phone, password);
      } catch (err2) {
        if (err2 instanceof HttpError && err2.code === 'bad_credentials') {
          noteFailure(key);
          throw wrong();
        }
        throw err2;
      }
    }
    failures.delete(key);
    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    let profile: Profile;
    try {
      profile = await profileForOrRepair(claims);
    } catch (err) {
      await gotrue.logout(session.access_token);
      throw err;
    }
    // Staff and admins sign in with their email (an admin also needs the emailed code): a number and a password never open their consoles.
    if (profile.role !== 'customer') {
      await gotrue.logout(session.access_token);
      throw new HttpError(403, 'use_email', 'Specialists and admins sign in with their email and password. Choose "Continue with Email".');
    }
    setSessionCookies(res, session);
    res.json({ success: true, role: profile.role, needs_profile: needsProfile(profile) });
  })
);

// A forgotten password: sign in with a code ("Get a code instead"), then choose a new password WITHOUT the old one. Only for ~15 minutes after a code sign-in:
// the session's own token says how it was signed in (amr), so a session that came from a password or has been open for days cannot do this. Anyone who can
// receive the code at that number may set the password; that is what a code is for.
const CODE_FRESH_SECONDS = 15 * 60;
authRouter.post(
  '/auth/mobile/password',
  authLimiter,
  requireSession,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const { password } = parse(z.object({ password: customerPassword }), req.body);
    const s = req.session!;
    const now = Math.floor(Date.now() / 1000);
    const fresh = (s.claims.amr ?? []).some((a) => a.method === 'otp' && now - a.timestamp <= CODE_FRESH_SECONDS);
    if (!fresh) {
      throw new HttpError(403, 'code_needed', 'To choose a new password without the old one, sign out and sign in with a code first ("Get a code instead").');
    }
    await gotrue.updatePassword(s.accessToken, password);
    res.json({ success: true });
  })
);

// A signed-in person changes their own password (the old one is checked first). Staff and admins need the stronger rule.
authRouter.post(
  '/auth/password',
  authLimiter,
  requireSession,
  asyncHandler(async (req, res) => {
    const s = req.session!;
    const email = s.claims.email; // the address this LOGIN uses (a contact email on the profile does not mean a password exists)
    if (!email) throw new HttpError(409, 'no_password', 'You sign in with your mobile number, so there is no password to change.');
    const b = parse(z.object({ current_password: z.string().min(1, 'Enter your current password.').max(200), new_password: s.profile.role === 'customer' ? customerPassword : strongPassword }), req.body);
    if (b.new_password === b.current_password) throw new HttpError(400, 'validation_error', 'Choose a different password.', { fields: { new_password: 'Choose a different password.' } });
    const key = email.toLowerCase();
    if (lockedOut(key)) throw new HttpError(429, 'login_limit', 'Too many wrong passwords. Please wait 15 minutes.');
    try {
      const check = await gotrue.passwordLogin(key, b.current_password);
      await gotrue.logout(check.access_token); // the check made a login of its own; drop it
    } catch (err) {
      if (err instanceof HttpError && err.code === 'bad_credentials') {
        noteFailure(key);
        throw new HttpError(400, 'validation_error', 'That is not your current password.', { fields: { current_password: 'That is not your current password.' } });
      }
      throw err;
    }
    await gotrue.updatePassword(s.accessToken, b.new_password);
    res.json({ success: true });
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
    if (profile.role === 'admin') {
      await gotrue.logout(session.access_token);
      return back('admin_use_email');
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
    const admin = p.role === 'admin' ? await adminAccessFor(req.session!.claims) : undefined;
    res.json({ success: true, user: { ...p, needs_profile: needsProfile(p), ...(p.role === 'admin' ? { admin: admin ? { ...admin, idle_minutes: config.admin.idleMinutes } : null } : {}) } });
  })
);
