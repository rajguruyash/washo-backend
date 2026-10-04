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
  /** The Razorpay API base URL the website server should use. */
  razorpayBase: string;
  /** Make the next Razorpay API call fail with this HTTP status. */
  failNextRazorpayCall(status?: number): void;
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
    rzpFail: 0,
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
    razorpayBase: `${url}/rzp`,
    failNextRazorpayCall: (status = 500) => {
      state.rzpFail = status;
    },
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
