import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { ACCESS_COOKIE, REFRESH_COOKIE, asyncHandler, authLimiter, clearSessionCookies, readCookie, requireSession, setSessionCookies } from '../middleware/http';
import { withUser } from '../db';
import { phoneSchema } from '../phone';
import { Profile, profileFor } from '../profile';
import { gotrue } from '../supabase';
import { verifyAccessToken } from '../jwt';

export const authRouter = Router();

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
        source: z.string().regex(/^[a-z0-9_-]{1,32}$/i).optional().catch(undefined),
      }),
      req.body
    );
    const session = await gotrue.verifyOtp(phone, code);
    setSessionCookies(res, session);

    const claims = { sub: session.user.id, phone: session.user.phone, email: session.user.email };
    // First-touch attribution is write-once in the database. It runs in a savepoint: if the database does not have the function
    // yet, or refuses, that must never undo or abort the sign-in.
    await withUser(claims, async (c) => {
      if (!source) return;
      await c.query('SAVEPOINT src');
      try {
        await c.query('SELECT public.record_signup_source($1)', [source.toLowerCase()]);
        await c.query('RELEASE SAVEPOINT src');
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT src');
        console.warn('record_signup_source skipped:', (err as Error).message);
      }
    }).catch((err) => console.warn('signup source not recorded:', (err as Error).message));

    let profile: Profile;
    try {
      profile = await profileFor(claims);
    } catch (err) {
      // Signed in at Supabase but unusable here: do not leave half a session behind, and say why.
      clearSessionCookies(res);
      throw err;
    }
    res.json({ success: true, role: profile.role, needs_profile: profile.role === 'customer' && !profile.full_name });
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
      profile = await profileFor(claims);
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

authRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    const at = readCookie(req, ACCESS_COOKIE);
    if (at && (await verifyAccessToken(at))) await gotrue.logout(at);
    clearSessionCookies(res);
    void REFRESH_COOKIE;
    res.json({ success: true });
  })
);

authRouter.get(
  '/me',
  requireSession,
  asyncHandler(async (req, res) => {
    const p = req.session!.profile;
    res.json({ success: true, user: { ...p, needs_profile: p.role === 'customer' && !p.full_name } });
  })
);
