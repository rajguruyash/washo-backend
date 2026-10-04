import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { ACCESS_COOKIE, REFRESH_COOKIE, asyncHandler, authLimiter, clearSessionCookies, readCookie, requireSession, setSessionCookies } from '../middleware/http';
import { withUser } from '../db';
import { phoneSchema } from '../phone';
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
    const profile = await withUser(claims, async (c) => {
      // First-touch attribution is write-once in the database; a returning customer's call is a no-op.
      if (source) await c.query('SELECT public.record_signup_source($1)', [source.toLowerCase()]).catch(() => undefined);
      const { rows } = await c.query(`SELECT role::text AS role, full_name FROM public.profiles WHERE auth_user_id = auth.uid()`);
      return rows[0] as { role: string; full_name: string | null } | undefined;
    });
    res.json({ success: true, role: profile?.role ?? 'customer', needs_profile: !profile?.full_name });
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
    const profile = await withUser(claims, async (c) => (await c.query(`SELECT role::text AS role FROM public.profiles WHERE auth_user_id = auth.uid()`)).rows[0] as { role: string } | undefined);
    if (!profile || (profile.role !== 'worker' && profile.role !== 'admin')) {
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
