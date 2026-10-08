import crypto from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { FAKE, FakeSupabase, startFakeSupabase } from './fakeSupabase';

export interface Resp<T = any> {
  status: number;
  body: T;
  headers: Headers;
  setCookies: string[];
}

export let fake: FakeSupabase;
let server: Server;
let base = '';
/** The address the website under test listens on (for the few tests that need the raw bytes of a response). */
export const siteUrl = () => base;

/** Boots the fake Supabase (real local database behind it) and the website API pointed at it. */
export async function boot() {
  const db = process.env.SB_TEST_DB;
  if (!db) throw new Error('SB_TEST_DB is not set. Run API tests through supabase/tests/run.sh api');
  fake = await startFakeSupabase(db);
  process.env.SUPABASE_URL = fake.url;
  process.env.SUPABASE_ANON_KEY = FAKE.anonKey;
  process.env.SUPABASE_JWT_SECRET = FAKE.jwtSecret;
  process.env.SUPABASE_SERVICE_ROLE_KEY = FAKE.serviceKey;
  process.env.RAZORPAY_KEY_ID = FAKE.razorpayKeyId;
  process.env.RAZORPAY_KEY_SECRET = FAKE.razorpayKeySecret;
  process.env.RAZORPAY_WEBHOOK_SECRET = FAKE.razorpayWebhookSecret;
  process.env.RAZORPAY_API_BASE = fake.razorpayBase;
  process.env.GEOCODE_URL = `${fake.url}/geo`;
  process.env.GEOCODE_MIN_INTERVAL_MS = '0';
  process.env.CRON_SECRET = 'test-cron-secret-0123456789';
  process.env.DATABASE_URL = process.env.SB_API_DB_URL || `postgresql://washo_api:washo_api_test@localhost:5432/${db}`;
  // The suite books far more washes on the same few days than a real day could take: lift the crowd limits for it (capacity tests set their own).
  await fake.admin.query(`DO $$ BEGIN IF to_regclass('public.capacity_rules') IS NOT NULL THEN UPDATE public.capacity_rules SET day_busy = 400, day_full = 500, slot_busy = 400, slot_full = 500; END IF; END $$`);
  // Email goes nowhere in tests unless a test records it: an admin's second-step code is emailed, so admins could not sign in without a transport.
  const { setMailTransport } = await import('../src/notify');
  setMailTransport(async () => undefined);
  const { createApp } = await import('../src/app');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function shutdown() {
  await new Promise<void>((r) => server.close(() => r()));
  const { pool } = await import('../src/db');
  await pool.end();
  await fake.close();
}

/** A browser: keeps cookies between requests. */
export class Client {
  cookies = new Map<string, string>();

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  }

  async req<T = any>(method: string, path: string, body?: unknown, o: { headers?: Record<string, string>; raw?: Buffer; contentType?: string } = {}): Promise<Resp<T>> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    let payload: any;
    if (o.raw) {
      headers['content-type'] = o.contentType ?? 'application/octet-stream';
      payload = new Uint8Array(o.raw);
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${path}`, { method, headers, body: payload, redirect: 'manual' });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = decodeURIComponent(pair.slice(i + 1));
      if (!value || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed, headers: res.headers, setCookies };
  }
  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b?: unknown) => this.req<T>('POST', p, b ?? {});
  put = <T = any>(p: string, b?: unknown) => this.req<T>('PUT', p, b ?? {});
  del = <T = any>(p: string) => this.req<T>('DELETE', p);

  async loginCustomer(phone = randomPhone(), source?: string) {
    const a = await this.post('/api/auth/otp/request', { phone });
    if (a.status !== 200) throw new Error(`otp request failed: ${JSON.stringify(a.body)}`);
    const v = await this.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode, source });
    if (v.status !== 200) throw new Error(`otp verify failed: ${JSON.stringify(v.body)}`);
    return { phone, ...v.body };
  }

  /** Email + password. An ADMIN's password is only step one: the code Supabase made is always FAKE.otpCode here, so step two follows straight away. */
  async loginStaff(email: string, password: string) {
    const first = await this.post('/api/auth/email/login', { email, password });
    if (first.status === 200 && first.body.step === 'code') return this.post('/api/auth/admin/code/verify', { code: FAKE.otpCode });
    return first;
  }
}

let n = 0;
// Unique across files and runs (the test database is shared): a collision would hand a "new" customer someone else's data.
export const randomPhone = () => `9${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;

/** A date `days` from today in Pune, as YYYY-MM-DD. */
export function istDate(days = 0): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** A signed-in customer with a complete profile, an address and a vehicle. */
export async function customerWithVehicle(type: 'bike' | 'car' | 'suv' = 'car') {
  const c = new Client();
  const { phone } = await c.loginCustomer();
  expectOk(await c.put('/api/me', { full_name: 'Asha Kulkarni', email: 'asha@example.com' }));
  const addr = expectOk(
    await c.post('/api/addresses', { society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: 'B-702', parking_location: 'Basement P1' })
  ).body.address;
  const reg = `MH12${crypto.randomBytes(2).toString('hex').toUpperCase()}${1000 + ++n}`;
  const vehicle = expectOk(await c.post('/api/vehicles', { vehicle_type: type, make: 'Hyundai', model: type === 'bike' ? 'Activa' : 'Creta', registration_number: reg, color: 'White', address_id: addr.id })).body.vehicle;
  return { c, phone, addr, vehicle, reg };
}

export function expectOk<T extends Resp>(r: T): T {
  if (r.status >= 300) throw new Error(`Expected success, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
}

export const PATTERN_3 = [
  { weekday: 1, kind: 'body' },
  { weekday: 3, kind: 'deep' },
  { weekday: 5, kind: 'body' },
];

export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]), crypto.randomBytes(64)]);
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(32)]);

export async function staffClient(role: 'worker' | 'admin', o: { name?: string; phone?: string; email?: string; password?: string; access?: 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support' | null } = {}) {
  const s = await fake.createStaff(role, o);
  const c = new Client();
  expectOk(await c.loginStaff(s.email, s.password));
  return { c, ...s };
}

/** Build a plan -> pay -> verified: returns the customer and their active membership. (No WASHO approval step.) */
export async function activeMembership(o: { type?: 'bike' | 'car' | 'suv'; pattern?: unknown[]; months?: number; admin?: Client; notes?: string } = {}) {
  const cust = await customerWithVehicle(o.type ?? 'car');
  const order = expectOk(
    await cust.c.post('/api/payments/membership-checkout', {
      vehicle_id: cust.vehicle.id, weekly_pattern: o.pattern ?? PATTERN_3, duration_months: o.months ?? 1, time_slot: 'morning',
      start_date: istDate(4), address_id: cust.addr.id, customer_notes: o.notes ?? 'Gate code 4321',
    })
  ).body.order;
  const paid = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
  return { ...cust, membershipId: paid.membership_id as string };
}
