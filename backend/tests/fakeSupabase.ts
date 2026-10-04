/**
 * A stand-in for the parts of Supabase the website talks to, backed by a REAL local copy of the WASHO database
 * (the production schema + every migration). Used by the API tests and by `npm run dev:stack`.
 *
 *   Auth       phone OTP (code is always 123456 locally), email+password, refresh, logout   (GoTrue's wire format)
 *   Functions  create-razorpay-order and verify-razorpay-payment: the same steps as supabase/functions/*, run
 *              against the real database functions. Razorpay itself is simulated.
 *   Storage    upload / sign / serve
 *
 * It contains NO business rules: pricing, quotes, settlement, worker rules all run inside Postgres.
 */
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { Pool, PoolClient } from 'pg';

// Same two rules as supabase/functions/_shared/razorpay.ts (unit-tested there). Repeated here so this file also runs under
// plain ts-node (dev:stack), where that ESM file cannot be required.
const verifyCheckoutSignature = (orderId: string, paymentId: string, signature: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex') === signature;
const httpStatusForSettle = (status: string) => (['fulfilled', 'already_settled', 'unfulfilled'].includes(status) ? 200 : status === 'not_captured' ? 409 : status === 'unknown_order' ? 404 : 400);


export const FAKE = {
  jwtSecret: 'test-jwt-secret-test-jwt-secret-1234',
  anonKey: 'test-anon-key',
  serviceKey: 'test-service-role-key',
  razorpayKeyId: 'rzp_test_KEYID',
  razorpayKeySecret: 'rzp_test_SECRET',
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
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  otpSent: string[];
  makeSession(authUserId: string, extra?: Record<string, unknown>): { access_token: string; refresh_token: string; expires_in: number };
  /** Make the next /auth/v1/otp call fail the way Supabase does when it throttles. */
  throttleNextOtp(): void;
  /** Create an email+password staff account (what admin_create_worker does) with the given role. */
  createStaff(role: 'worker' | 'admin', o?: { email?: string; password?: string; name?: string; phone?: string }): Promise<{ authId: string; profileId: string; email: string; password: string }>;
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
    orders: new Map<string, { amount: number; currency: string; receipt: string }>(),
    payments: new Map<string, { order_id: string; amount: number; currency: string; status: string }>(),
    objects: new Map<string, { bytes: Buffer; contentType: string }>(),
    otpSent: [] as string[],
    throttle: false,
  };

  const session = (authUserId: string, extra: Record<string, unknown> = {}) => {
    const expires_in = 3600;
    const access_token = signJwt({ aud: 'authenticated', role: 'authenticated', sub: authUserId, exp: Math.floor(Date.now() / 1000) + expires_in, ...extra });
    const refresh_token = crypto.randomBytes(12).toString('hex');
    state.refresh.set(refresh_token, authUserId);
    return { access_token, refresh_token, expires_in };
  };

  async function userRow(authUserId: string) {
    const { rows } = await admin.query('SELECT id, phone, email FROM auth.users WHERE id = $1', [authUserId]);
    return rows[0] as { id: string; phone: string | null; email: string | null } | undefined;
  }
  const full = async (authUserId: string) => {
    const u = await userRow(authUserId);
    return { ...session(authUserId, { phone: u?.phone ?? undefined, email: u?.email ?? undefined }), token_type: 'bearer', user: { id: authUserId, phone: u?.phone ?? undefined, email: u?.email ?? undefined } };
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

  // ───────── the two edge functions, same steps as supabase/functions/*/index.ts ─────────
  async function createOrder(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
    const sub = verifyBearer(req);
    if (!sub) return send(res, 401, { error: 'Sign in to continue' });
    try {
      let payment: any;
      if (body.type === 'membership') {
        payment = await asRole('authenticated', sub, async (c) => (await c.query('SELECT public.accept_membership_quote($1) AS r', [body.request_id])).rows[0].r);
      } else if (body.type === 'on_demand') {
        payment = await asRole('authenticated', sub, async (c) =>
          (
            await c.query('SELECT public.create_booking_payment_intent($1,$2,$3::date,$4::public.time_slot,$5,$6,$7,$8) AS r', [
              body.vehicle_id, body.service_id, body.scheduled_date, body.time_slot, body.address_id ?? null, body.parking_location ?? null, body.target_completion_time ?? null,
              body.source === 'website' ? 'website' : 'mobile_app',
            ])
          ).rows[0].r
        );
      } else return send(res, 400, { error: 'Unknown payment type' });

      const u = await userRow(sub);
      const prefill = { contact: u?.phone ?? '', email: u?.email ?? '' };
      if (payment.provider_order_id) {
        return send(res, 200, { order_id: payment.provider_order_id, amount: payment.amount_cents, currency: payment.currency, key_id: FAKE.razorpayKeyId, payment_id: payment.payment_id, prefill });
      }
      const orderId = `order_${crypto.randomBytes(6).toString('hex')}`;
      state.orders.set(orderId, { amount: payment.amount_cents, currency: 'INR', receipt: payment.receipt });
      await asRole('service_role', null, async (c) => {
        const pid = (await c.query('SELECT public.svc_profile_id_for_auth_user($1) AS id', [sub])).rows[0].id;
        await c.query('SELECT public.svc_attach_provider_order($1,$2,$3)', [payment.payment_id, orderId, pid]);
      });
      return send(res, 200, { order_id: orderId, amount: payment.amount_cents, currency: payment.currency, key_id: FAKE.razorpayKeyId, payment_id: payment.payment_id, prefill });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  }

  async function verifyPayment(req: http.IncomingMessage, res: http.ServerResponse, body: any) {
    const sub = verifyBearer(req);
    if (!sub) return send(res, 401, { error: 'Sign in to continue' });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return send(res, 400, { error: 'Missing payment details' });
    if (!verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature, FAKE.razorpayKeySecret)) {
      return send(res, 400, { error: 'We could not verify this payment. If money was deducted it will be reconciled automatically.' });
    }
    const p = state.payments.get(razorpay_payment_id);
    if (!p) return send(res, 502, { error: 'Could not confirm the payment with Razorpay. Please wait a moment and refresh.' });
    if (p.order_id !== razorpay_order_id) return send(res, 400, { error: 'Payment does not match the order' });
    try {
      const result = await asRole('service_role', null, async (c) => {
        const pid = (await c.query('SELECT public.svc_profile_id_for_auth_user($1) AS id', [sub])).rows[0].id;
        return (await c.query('SELECT public.svc_settle_payment($1,$2,$3,$4,$5,$6,$7) AS r', [razorpay_order_id, razorpay_payment_id, p.amount, p.currency, p.status, pid, 'verify'])).rows[0].r;
      });
      return send(res, httpStatusForSettle(result.status), result);
    } catch (e) {
      return send(res, 500, { error: 'We received your payment but could not finish the booking.' });
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://x');
      const path = url.pathname;
      const raw = await readBody(req);
      const json = () => (raw.length ? JSON.parse(raw.toString()) : {});

      // ───────── Auth ─────────
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
        if (type !== 'sms' || state.otps.get(phone) !== token) return send(res, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
        state.otps.delete(phone);
        let { rows } = await admin.query('SELECT id FROM auth.users WHERE phone = $1', [phone]);
        if (!rows.length) {
          rows = (
            await admin.query(
              `INSERT INTO auth.users (id, instance_id, aud, role, phone, phone_confirmed_at, raw_user_meta_data, created_at, updated_at)
               VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(), '{}'::jsonb, now(), now()) RETURNING id`,
              [phone]
            )
          ).rows;
        }
        return send(res, 200, await full(rows[0].id));
      }
      if (path === '/auth/v1/token' && req.method === 'POST') {
        const grant = url.searchParams.get('grant_type');
        if (grant === 'refresh_token') {
          const id = state.refresh.get(json().refresh_token);
          if (!id) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
          return send(res, 200, await full(id));
        }
        if (grant === 'password') {
          const { email, password } = json();
          const { rows } = await admin.query('SELECT id FROM auth.users WHERE email = $1 AND encrypted_password = crypt($2, encrypted_password)', [email, password]);
          if (!rows.length) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
          return send(res, 200, await full(rows[0].id));
        }
      }
      if (path === '/auth/v1/logout' && req.method === 'POST') return send(res, 204, {});

      // ───────── Edge functions ─────────
      if (path === '/functions/v1/create-razorpay-order' && req.method === 'POST') return createOrder(req, res, json());
      if (path === '/functions/v1/verify-razorpay-payment' && req.method === 'POST') return verifyPayment(req, res, json());

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
    objects: state.objects,
    otpSent: state.otpSent,
    makeSession: session,
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
