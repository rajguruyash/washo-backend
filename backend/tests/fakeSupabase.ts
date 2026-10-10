/**
 * A stand-in for the parts of Supabase the website talks to, backed by a REAL local copy of the WASHO database
 * (the production schema + every migration). Used by the API tests and by `npm run dev:stack`.
 *
 *   Auth       phone OTP (code is always 123456 locally), email+password, refresh, logout   (GoTrue's wire format)
 *   Razorpay   a stand-in for Razorpay's REST API (orders, payments, capture) under /rzp; the website server talks to it exactly as
 *              it talks to api.razorpay.com. Checkout itself is simulated by checkout().
 *   Storage    upload / sign / serve
 *
 * It contains NO business rules: pricing, quotes, settlement, worker rules all run inside Postgres.
 */
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { Pool, PoolClient } from 'pg';


export const FAKE = {
  jwtSecret: 'test-jwt-secret-test-jwt-secret-1234',
  anonKey: 'test-anon-key',
  serviceKey: 'test-service-role-key',
  razorpayKeyId: 'rzp_test_KEYID',
  razorpayKeySecret: 'rzp_test_SECRET',
  razorpayWebhookSecret: 'whsec_test_SECRET',
  otpCode: '123456',
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function signJwt(payload: Record<string, unknown>, secret = FAKE.jwtSecret): string {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
}

export interface FakeSupabase {
  url: string;
  admin: Pool; // superuser connection to the local database (fixtures)
  close(): Promise<void>;
  /** Simulates the customer paying in Razorpay Checkout; returns what the browser would send to /payments/verify. */
  checkout(orderId: string, o?: { status?: string; amount?: number }): { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
  orders: Map<string, { amount: number; currency: string; receipt: string }>;
  payments: Map<string, { order_id: string; amount: number; currency: string; status: string }>;
  /** Refunds Razorpay has been asked to make (id -> payment, amount in paise, notes). */
  refunds: Map<string, { payment_id: string; amount: number; notes: Record<string, string>; receipt: string; status: string }>;
  /** Make the next refund request be refused with this message (HTTP 400, like Razorpay's BAD_REQUEST_ERROR). */
  rejectNextRefund(description: string): void;
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  otpSent: string[];
  makeSession(authUserId: string, extra?: Record<string, unknown>): { access_token: string; refresh_token: string; expires_in: number };
  /**
   * A payment that exists at Razorpay (money moved) without the website ever hearing about it: the customer paid in a UPI app and the
   * browser never reported back. Returns its id.
   */
  paidAtRazorpay(orderId: string, o?: { status?: string; amount?: number }): string;
  /** A Razorpay webhook as it would arrive: the exact body and the signature header over it. */
  webhook(event: string, payment: { id: string; order_id: string }, o?: { secret?: string }): { body: string; signature: string };
  /** The Razorpay API base URL the website server should use. */
  razorpayBase: string;
  /** True if an admin locked this login through the Auth admin API. */
  isBanned(authUserId: string): boolean;
  /** Make the next Razorpay API call fail with this HTTP status. */
  failNextRazorpayCall(status?: number): void;
  /** How many location lookups reached the stand-in for OpenStreetMap, and a way to make the next one fail. */
  geoCalls(): number;
  failNextGeocode(): void;
  /**
   * Simulates the person finishing "Continue with Google": returns the one-time code Supabase would put in the callback URL.
   * It only works for the browser that holds the verifier matching `challenge` (PKCE).
   */
  googleSignIn(o: { email: string; name?: string; challenge: string }): Promise<string>;
  /** Make the next /auth/v1/otp call fail the way Supabase does when it throttles. */
  throttleNextOtp(): void;
  /** Create an email+password staff account (what admin_create_worker does) with the given role. */
  createStaff(role: 'worker' | 'admin', o?: { email?: string; password?: string; name?: string; phone?: string; access?: 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support' | null }): Promise<{ authId: string; profileId: string; email: string; password: string }>;
}

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

export async function startFakeSupabase(dbName: string): Promise<FakeSupabase> {
  if (!/^washo_[a-z_]+$/.test(dbName)) throw new Error(`Refusing to use database "${dbName}"`);
  const admin = new Pool({ database: dbName, max: 4 });

  const state = {
    otps: new Map<string, string>(),
    refresh: new Map<string, string>(), // refresh token -> auth user id
    amr: new Map<string, unknown[]>(), // refresh token -> how that session was signed in (the token's `amr` claim, which survives a refresh)
    orders: new Map<string, { amount: number; currency: string; receipt: string }>(),
    payments: new Map<string, { order_id: string; amount: number; currency: string; status: string }>(),
    refunds: new Map<string, { payment_id: string; amount: number; notes: Record<string, string>; receipt: string; status: string }>(),
    objects: new Map<string, { bytes: Buffer; contentType: string }>(),
    otpSent: [] as string[],
    throttle: false,
    rzpFail: 0,
    geoCalls: 0,
    geoFail: false,
    rzpRejectRefund: '' as string,
    phoneChange: new Map<string, string>(), // auth user id -> the number a code was sent to
    emailOtps: new Map<string, string>(), // email -> the sign-in code Supabase Auth made for it (the website mails it; tests read it from the mail)
    banned: new Set<string>(), // auth user ids locked through the admin API
    codes: new Map<string, { userId: string; challenge: string }>(), // Google one-time codes
  };

  const session = (authUserId: string, extra: Record<string, unknown> = {}) => {
    const expires_in = 3600;
    const access_token = signJwt({ aud: 'authenticated', role: 'authenticated', sub: authUserId, exp: Math.floor(Date.now() / 1000) + expires_in, ...extra });
    const refresh_token = crypto.randomBytes(12).toString('hex');
    state.refresh.set(refresh_token, authUserId);
    state.amr.set(refresh_token, (extra.amr as unknown[] | undefined) ?? []);
    return { access_token, refresh_token, expires_in };
  };

  async function userRow(authUserId: string) {
    const { rows } = await admin.query('SELECT id, phone, email FROM auth.users WHERE id = $1', [authUserId]);
    return rows[0] as { id: string; phone: string | null; email: string | null } | undefined;
  }
  const full = async (authUserId: string, amr?: unknown[]) => {
    if (state.banned.has(authUserId)) throw Object.assign(new Error('banned'), { banned: true });
    const u = await userRow(authUserId);
    return { ...session(authUserId, { phone: u?.phone ?? undefined, email: u?.email ?? undefined, ...(amr ? { amr } : {}) }), token_type: 'bearer', user: { id: authUserId, phone: u?.phone ?? undefined, email: u?.email ?? undefined } };
  };

  async function asRole<T>(role: 'authenticated' | 'service_role', authUserId: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(authUserId ? { sub: authUserId, role } : { role })]);
      await c.query(`SET LOCAL ROLE ${role}`);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  function verifyBearer(req: http.IncomingMessage): string | null {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const ok = crypto.createHmac('sha256', FAKE.jwtSecret).update(`${h}.${p}`).digest('base64url') === s;
    const body = ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : null;
    return body && body.exp * 1000 > Date.now() ? body.sub : null;
  }

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  async function googleCode({ email, name, challenge }: { email: string; name?: string; challenge: string }) {
    let { rows } = await admin.query('SELECT id FROM auth.users WHERE email = $1', [email]);
    if (!rows.length) {
      // Google users arrive with a verified email, a name in their metadata, and NO phone. The database trigger makes them a customer.
      rows = (
        await admin.query(
          `INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
           VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(), '{"provider":"google","providers":["google"]}'::jsonb, $2::jsonb, now(), now()) RETURNING id`,
          [email, JSON.stringify({ full_name: name ?? null, name: name ?? null, email, email_verified: true, iss: 'https://accounts.google.com' })]
        )
      ).rows;
    }
    const code = crypto.randomBytes(16).toString('hex');
    state.codes.set(code, { userId: rows[0].id, challenge });
    return code;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://x');
      const path = url.pathname;
      const raw = await readBody(req);
      const json = () => (raw.length ? JSON.parse(raw.toString()) : {});

      // ───────── Auth ─────────
      // Stands in for Supabase + Google when clicking through locally: "approves" immediately as a fixed Google account and
      // sends the browser back with a one-time code, like the real flow does after Google's consent screen.
      if (path === '/auth/v1/authorize' && req.method === 'GET') {
        const back = url.searchParams.get('redirect_to');
        const challenge = url.searchParams.get('code_challenge');
        if (url.searchParams.get('provider') !== 'google' || !back || !challenge) return send(res, 400, { msg: 'unsupported authorize request' });
        const code = await googleCode({ email: 'dev.google@example.com', name: 'Dev Google', challenge });
        res.writeHead(302, { Location: `${back}${back.includes('?') ? '&' : '?'}code=${code}` });
        return res.end();
      }
      // ───────── Auth admin API (service role) ─────────
      if (path.startsWith('/auth/v1/admin/')) {
        if (req.headers.authorization !== `Bearer ${FAKE.serviceKey}`) return send(res, 401, { code: 401, error_code: 'not_admin', msg: 'User not allowed' });
        if (path === '/auth/v1/admin/users' && req.method === 'POST') {
          const b = json();
          if (b.email) {
            const email = String(b.email).toLowerCase();
            const dup = await admin.query('SELECT id FROM auth.users WHERE lower(email) = $1', [email]);
            if (dup.rows.length) return send(res, 422, { code: 422, error_code: 'email_exists', msg: 'A user with this email address has already been registered' });
            if (b.password !== undefined && String(b.password).length < 8) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
            // Like GoTrue: an email AND a phone in one call. The phone is checked first, so a refused number creates nothing.
            const phoneDigits = String(b.phone ?? '').replace(/\D/g, '');
            if (phoneDigits) {
              const dupPhone = await admin.query(`SELECT 1 FROM auth.users WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $1`, [phoneDigits]);
              if (dupPhone.rows.length) return send(res, 422, { code: 422, error_code: 'phone_exists', msg: 'Phone number already registered by another user' });
            }
            const { rows } = await admin.query(
              `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
               VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, CASE WHEN $4::text IS NULL THEN '' ELSE crypt($4, gen_salt('bf')) END, $2, $5, $6, '{"provider":"email","providers":["email"]}'::jsonb, $3::jsonb, now(), now()) RETURNING id`,
              [email, b.email_confirm ? new Date() : null, JSON.stringify(b.user_metadata ?? {}), b.password ?? null, phoneDigits ? b.phone : null, phoneDigits && b.phone_confirm ? new Date() : null]
            );
            return send(res, 200, { id: rows[0].id, email });
          }
          const digits = String(b.phone ?? '').replace(/\D/g, '');
          if (digits) {
            const dup = await admin.query(`SELECT 1 FROM auth.users WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $1`, [digits]);
            if (dup.rows.length) return send(res, 422, { code: 422, error_code: 'phone_exists', msg: 'Phone number already registered by another user' });
          }
          const { rows } = await admin.query(
            `INSERT INTO auth.users (id, instance_id, aud, role, phone, phone_confirmed_at, raw_user_meta_data, created_at, updated_at)
             VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, $2, $3::jsonb, now(), now()) RETURNING id`,
            [b.phone ?? null, b.phone_confirm ? new Date() : null, JSON.stringify(b.user_metadata ?? {})]
          );
          return send(res, 200, { id: rows[0].id, phone: b.phone });
        }
        if (path === '/auth/v1/admin/generate_link' && req.method === 'POST') {
          const b = json();
          const email = String(b.email ?? '').toLowerCase();
          const { rows } = await admin.query('SELECT id FROM auth.users WHERE lower(email) = $1', [email]);
          if (!rows.length) return send(res, 404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
          if (b.type !== 'magiclink') return send(res, 400, { msg: 'fake supabase: only magiclink' });
          state.emailOtps.set(email, FAKE.otpCode);
          // what GoTrue returns: the one-time code and the link; it sends NO email for an admin-generated link
          return send(res, 200, { id: rows[0].id, email, action_link: 'http://127.0.0.1/auth/v1/verify?token=x&type=magiclink', email_otp: FAKE.otpCode, hashed_token: 'hashed', verification_type: 'magiclink' });
        }
        const um = path.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
        if (um && req.method === 'PUT') {
          const id = decodeURIComponent(um[1]);
          const b = json();
          if (b.ban_duration !== undefined) {
            if (b.ban_duration === 'none') state.banned.delete(id);
            else state.banned.add(id);
          }
          if (b.phone !== undefined) {
            const digits = String(b.phone).replace(/\D/g, '');
            if (digits) {
              const dup = await admin.query(`SELECT 1 FROM auth.users WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $1 AND id <> $2`, [digits, id]);
              if (dup.rows.length) return send(res, 422, { code: 422, error_code: 'phone_exists', msg: 'Phone number already registered by another user' });
            }
            await admin.query(`UPDATE auth.users SET phone = $1, phone_confirmed_at = $2, updated_at = now() WHERE id = $3`, [digits ? b.phone : null, digits && b.phone_confirm ? new Date() : null, id]);
          }
          if (b.password !== undefined) {
            if (String(b.password).length < 8) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
            await admin.query(`UPDATE auth.users SET encrypted_password = crypt($1, gen_salt('bf')), updated_at = now() WHERE id = $2`, [b.password, id]);
          }
          return send(res, 200, { id });
        }
        return send(res, 404, { msg: 'fake supabase: no admin route' });
      }
      if (path === '/auth/v1/user' && req.method === 'PUT') {
        const uid = verifyBearer(req);
        if (!uid) return send(res, 401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
        const { phone, password } = json();
        if (password !== undefined) {
          if (String(password).length < 8) return send(res, 422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 8 characters.' });
          await admin.query(`UPDATE auth.users SET encrypted_password = crypt($1, gen_salt('bf')), updated_at = now() WHERE id = $2`, [password, uid]);
          if (!phone) return send(res, 200, { id: uid });
        }
        if (phone) {
          const digits = String(phone).replace(/\D/g, '');
          const { rows } = await admin.query(`SELECT id FROM auth.users WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $1 AND id <> $2`, [digits, uid]);
          if (rows.length) return send(res, 422, { code: 422, error_code: 'phone_exists', msg: 'Phone number already registered by another user' });
          if (state.throttle) {
            state.throttle = false;
            return send(res, 429, { code: 429, error_code: 'over_sms_send_rate_limit', msg: 'For security purposes, you can only request this after 60 seconds.' });
          }
          state.phoneChange.set(uid, phone);
          state.otps.set(phone, FAKE.otpCode);
          state.otpSent.push(phone);
        }
        return send(res, 200, { id: uid, new_phone: phone });
      }
      if (path === '/auth/v1/otp' && req.method === 'POST') {
        if (state.throttle) {
          state.throttle = false;
          return send(res, 429, { code: 429, error_code: 'over_sms_send_rate_limit', msg: 'For security purposes, you can only request this after 60 seconds.' });
        }
        const { phone } = json();
        state.otps.set(phone, FAKE.otpCode);
        state.otpSent.push(phone);
        return send(res, 200, {});
      }
      if (path === '/auth/v1/verify' && req.method === 'POST') {
        const { phone, token, type } = json();
        if (type === 'phone_change') {
          const uid = verifyBearer(req);
          if (!uid || state.phoneChange.get(uid) !== phone || state.otps.get(phone) !== token) {
            return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
          }
          state.otps.delete(phone);
          state.phoneChange.delete(uid);
          // what GoTrue does: set and confirm the number (the database's own trigger then links the profile)
          await admin.query('UPDATE auth.users SET phone = $1, phone_confirmed_at = now(), updated_at = now() WHERE id = $2', [phone, uid]);
          return send(res, 200, await full(uid, [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }]));
        }
        if (type === 'email') {
          const email = String(json().email ?? '').toLowerCase();
          if (state.emailOtps.get(email) !== token) return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' });
          state.emailOtps.delete(email);
          const { rows } = await admin.query('SELECT id FROM auth.users WHERE lower(email) = $1', [email]);
          if (!rows.length) return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Email link is invalid or has expired' });
          try {
            return send(res, 200, await full(rows[0].id, [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }]));
          } catch (e) {
            if ((e as { banned?: boolean }).banned) return send(res, 400, { code: 400, error_code: 'user_banned', msg: 'User is banned' });
            throw e;
          }
        }
        if (type !== 'sms' || state.otps.get(phone) !== token) return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        state.otps.delete(phone);
        let { rows } = await admin.query('SELECT id FROM auth.users WHERE phone = $1', [phone]);
        // what GoTrue does when the number is confirmed by the person who holds the code (the database's own trigger then links the profile)
        if (rows.length) await admin.query('UPDATE auth.users SET phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() WHERE id = $1', [rows[0].id]);
        if (!rows.length) {
          rows = (
            await admin.query(
              `INSERT INTO auth.users (id, instance_id, aud, role, phone, phone_confirmed_at, raw_user_meta_data, created_at, updated_at)
               VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(), '{}'::jsonb, now(), now()) RETURNING id`,
              [phone]
            )
          ).rows;
        }
        return send(res, 200, await full(rows[0].id, [{ method: 'otp', timestamp: Math.floor(Date.now() / 1000) }]));
      }
      if (path === '/auth/v1/token' && req.method === 'POST') {
        const grant = url.searchParams.get('grant_type');
        if (grant === 'refresh_token') {
          const id = state.refresh.get(json().refresh_token);
          if (!id) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
          return send(res, 200, await full(id, state.amr.get(String(json().refresh_token))));
        }
        if (grant === 'pkce') {
          const { auth_code, code_verifier } = json();
          const hit = state.codes.get(auth_code);
          state.codes.delete(auth_code); // single use
          const ok = hit && code_verifier && crypto.createHash('sha256').update(code_verifier).digest('base64url') === hit.challenge;
          if (!ok) return send(res, 400, { code: 400, error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' });
          return send(res, 200, await full(hit!.userId, [{ method: 'oauth', timestamp: Math.floor(Date.now() / 1000) }]));
        }
        if (grant === 'password') {
          const { email, password, phone } = json();
          if (email && phone) return send(res, 400, { code: 400, error_code: 'validation_failed', msg: 'Only an email address or phone number should be provided on login.' });
          if (phone) {
            // Like GoTrue: the password is checked first, and only a number a code has CONFIRMED can sign in with it.
            const digits = String(phone).replace(/\D/g, '');
            const { rows } = await admin.query(
              `SELECT id, phone_confirmed_at FROM auth.users WHERE regexp_replace(coalesce(phone,''), '\\D', '', 'g') = $1 AND encrypted_password <> '' AND encrypted_password = crypt($2, encrypted_password)`,
              [digits, password]
            );
            if (!rows.length) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
            if (!rows[0].phone_confirmed_at) return send(res, 400, { code: 400, error_code: 'phone_not_confirmed', msg: 'Phone not confirmed' });
            return send(res, 200, await full(rows[0].id, [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }]));
          }
          const { rows } = await admin.query('SELECT id FROM auth.users WHERE email = $1 AND encrypted_password = crypt($2, encrypted_password)', [email, password]);
          if (!rows.length) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          return send(res, 200, await full(rows[0].id, [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }]));
        }
      }
      if (path === '/auth/v1/logout' && req.method === 'POST') return send(res, 204, {});

      // ───────── OpenStreetMap Nominatim stand-in (reverse geocoding for "use my location") ─────────
      if (path === '/geo/reverse') {
        state.geoCalls += 1;
        if (state.geoFail) {
          state.geoFail = false;
          return send(res, 503, { error: 'busy' });
        }
        const lat = Number(url.searchParams.get('lat'));
        // near Yashwin Orizzonte, Kharadi -> a society; anywhere else in Pune -> only a road
        if (Math.abs(lat - 18.5515) < 0.002) {
          return send(res, 200, { name: 'Yashwin Orizzonte', category: 'building', type: 'apartments', display_name: 'Yashwin Orizzonte, Kharadi, Pune, Maharashtra, 411014, India',
            address: { building: 'Yashwin Orizzonte Phase 1', road: 'EON Road', suburb: 'Kharadi', city: 'Pune', state: 'Maharashtra', postcode: '411014' } });
        }
        return send(res, 200, { name: '', category: 'highway', type: 'residential', display_name: 'Some Road, Hadapsar, Pune, Maharashtra, 411028, India',
          address: { road: 'Some Road', suburb: 'Hadapsar', city: 'Pune', postcode: '411 028' } });
      }

      // ───────── Razorpay REST API (orders, payments, capture) ─────────
      if (path.startsWith('/rzp/v1/')) {
        const ok = req.headers.authorization === 'Basic ' + Buffer.from(`${FAKE.razorpayKeyId}:${FAKE.razorpayKeySecret}`).toString('base64');
        if (!ok) return send(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
        if (state.rzpFail) {
          const code = state.rzpFail;
          state.rzpFail = 0;
          return send(res, code, { error: { code: 'SERVER_ERROR', description: 'Simulated Razorpay failure' } });
        }
        if (path === '/rzp/v1/orders' && req.method === 'POST') {
          const b = json();
          if (!Number.isInteger(b.amount) || b.amount < 100) return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Order amount less than minimum amount allowed' } });
          const id = `order_${crypto.randomBytes(7).toString('hex')}`;
          state.orders.set(id, { amount: b.amount, currency: b.currency ?? 'INR', receipt: b.receipt ?? '' });
          return send(res, 200, { id, entity: 'order', amount: b.amount, currency: b.currency ?? 'INR', receipt: b.receipt, status: 'created' });
        }
        const om = path.match(/^\/rzp\/v1\/orders\/([^/]+)\/payments$/);
        if (om && req.method === 'GET') {
          const orderId = decodeURIComponent(om[1]);
          const items = [...state.payments.entries()].filter(([, p]) => p.order_id === orderId).map(([id, p]) => ({ id, entity: 'payment', ...p }));
          return send(res, 200, { entity: 'collection', count: items.length, items });
        }
        const rm = path.match(/^\/rzp\/v1\/payments\/([^/]+)\/(refund|refunds)$/);
        if (rm) {
          const paymentId = decodeURIComponent(rm[1]);
          const p = state.payments.get(paymentId);
          if (!p) return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
          if (rm[2] === 'refunds' && req.method === 'GET') {
            const items = [...state.refunds.entries()].filter(([, r]) => r.payment_id === paymentId).map(([id, r]) => ({ id, entity: 'refund', ...r }));
            return send(res, 200, { entity: 'collection', count: items.length, items });
          }
          if (rm[2] === 'refund' && req.method === 'POST') {
            const b = json();
            if (state.rzpRejectRefund) {
              const description = state.rzpRejectRefund;
              state.rzpRejectRefund = '';
              return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description } });
            }
            if (p.status !== 'captured') return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The payment has not been captured' } });
            const already = [...state.refunds.values()].filter((r) => r.payment_id === paymentId).reduce((s, r) => s + r.amount, 0);
            if (!Number.isInteger(b.amount) || b.amount < 100 || already + b.amount > p.amount) {
              return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The refund amount provided is greater than amount captured' } });
            }
            const id = `rfnd_${crypto.randomBytes(7).toString('hex')}`;
            const r = { payment_id: paymentId, amount: b.amount, notes: b.notes ?? {}, receipt: b.receipt ?? '', status: 'processed' };
            state.refunds.set(id, r);
            return send(res, 200, { id, entity: 'refund', payment_id: paymentId, amount: b.amount, currency: p.currency, notes: r.notes, receipt: r.receipt, status: r.status });
          }
        }
        const pm = path.match(/^\/rzp\/v1\/payments\/([^/]+)(\/capture)?$/);
        if (pm) {
          const p = state.payments.get(decodeURIComponent(pm[1]));
          if (!p) return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
          if (pm[2] && req.method === 'POST') {
            if (p.status !== 'authorized') return send(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'This payment has already been captured' } });
            p.status = 'captured';
          }
          return send(res, 200, { id: decodeURIComponent(pm[1]), entity: 'payment', order_id: p.order_id, amount: p.amount, currency: p.currency, status: p.status });
        }
        return send(res, 404, { error: { description: 'not found' } });
      }

      // ───────── Storage ─────────
      const upload = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      if (upload && !path.startsWith('/storage/v1/object/sign') && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${FAKE.serviceKey}`) return send(res, 401, { message: 'unauthorized' });
        const key = `${upload[1]}/${decodeURIComponent(upload[2])}`;
        if (state.objects.has(key)) return send(res, 409, { message: 'The resource already exists' });
        state.objects.set(key, { bytes: raw, contentType: String(req.headers['content-type']) });
        return send(res, 200, { Key: key });
      }
      const sign = path.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
      if (sign && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${FAKE.serviceKey}`) return send(res, 401, { message: 'unauthorized' });
        const key = `${sign[1]}/${decodeURIComponent(sign[2])}`;
        if (!state.objects.has(key)) return send(res, 400, { message: 'Object not found' });
        return send(res, 200, { signedURL: `/object/sign/${sign[1]}/${sign[2]}?token=signed-${crypto.randomBytes(4).toString('hex')}` });
      }
      const served = path.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
      if (served && req.method === 'GET') {
        const o = state.objects.get(`${served[1]}/${decodeURIComponent(served[2])}`);
        if (!o || !url.searchParams.get('token')) return send(res, 404, {});
        res.writeHead(200, { 'Content-Type': o.contentType });
        return res.end(o.bytes);
      }
      send(res, 404, { message: `fake supabase: no route ${req.method} ${path}` });
    } catch (e) {
      if ((e as { banned?: boolean }).banned) return send(res, 400, { code: 400, error_code: 'user_banned', msg: 'User is banned' });
      console.error('fakeSupabase error:', e);
      send(res, 500, { message: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    admin,
    orders: state.orders,
    payments: state.payments,
    refunds: state.refunds,
    rejectNextRefund: (description) => {
      state.rzpRejectRefund = description;
    },
    objects: state.objects,
    otpSent: state.otpSent,
    razorpayBase: `${url}/rzp`,
    isBanned: (id) => state.banned.has(id),
    geoCalls: () => state.geoCalls,
    failNextGeocode: () => {
      state.geoFail = true;
    },
    failNextRazorpayCall: (status = 500) => {
      state.rzpFail = status;
    },
    makeSession: session,
    googleSignIn: (o) => googleCode(o),
    throttleNextOtp: () => {
      state.throttle = true;
    },
    checkout(orderId, o = {}) {
      const order = state.orders.get(orderId);
      if (!order) throw new Error(`unknown order ${orderId}`);
      const paymentId = `pay_${crypto.randomBytes(6).toString('hex')}`;
      state.payments.set(paymentId, { order_id: orderId, amount: o.amount ?? order.amount, currency: order.currency, status: o.status ?? 'captured' });
      return {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: crypto.createHmac('sha256', FAKE.razorpayKeySecret).update(`${orderId}|${paymentId}`).digest('hex'),
      };
    },
    paidAtRazorpay(orderId, o = {}) {
      const order = state.orders.get(orderId);
      if (!order) throw new Error(`unknown order ${orderId}`);
      const paymentId = `pay_${crypto.randomBytes(6).toString('hex')}`;
      state.payments.set(paymentId, { order_id: orderId, amount: o.amount ?? order.amount, currency: order.currency, status: o.status ?? 'captured' });
      return paymentId;
    },
    webhook(event, payment, o = {}) {
      const body = JSON.stringify({ entity: 'event', event, payload: { payment: { entity: { id: payment.id, order_id: payment.order_id, status: 'captured' } } } });
      return { body, signature: crypto.createHmac('sha256', o.secret ?? FAKE.razorpayWebhookSecret).update(body).digest('hex') };
    },
    async createStaff(role, o = {}) {
      const email = o.email ?? `${role}-${crypto.randomBytes(4).toString('hex')}@washo.test`;
      const password = o.password ?? 'Str0ng-pass!';
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        const id = crypto.randomUUID();
        await c.query(
          `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
           VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), $4::jsonb, now(), now())`,
          [id, email, password, JSON.stringify({ full_name: o.name ?? `Test ${role}`, phone: o.phone ?? null })]
        );
        await c.query("SELECT set_config('washo.allow_role_change','on',true)");
        const p = await c.query(
          `INSERT INTO public.profiles (auth_user_id, role, full_name, phone) VALUES ($1, $2, $3, $4)
           ON CONFLICT (auth_user_id) DO UPDATE SET role = EXCLUDED.role, full_name = EXCLUDED.full_name, phone = EXCLUDED.phone RETURNING id`,
          [id, role, o.name ?? `Test ${role}`, o.phone ?? null]
        );
        // An admin also has a role (migration 27); the default is the owner's, which can do everything.
        if (role === 'admin' && o.access !== null && (await c.query(`SELECT to_regclass('public.admin_access') AS t`)).rows[0].t) { // (a database from before migration 27 has no roles table)
          await c.query(`INSERT INTO public.admin_access (profile_id, access) VALUES ($1, $2) ON CONFLICT (profile_id) DO UPDATE SET access = EXCLUDED.access`, [p.rows[0].id, o.access ?? 'super_admin']);
        }
        await c.query('COMMIT');
        return { authId: id, profileId: p.rows[0].id as string, email, password };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await admin.end();
    },
  };
}
