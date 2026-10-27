/**
 * Traffic over HTTP: a person signing in is recorded (phone, email, sign-up, admin), a signed-in person's requests mark them as seen, the admin dashboard and the Traffic tab
 * show it, only a role with Activity access can look, and a database without migration 50 gets a plain "not set up yet" instead of an error.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, randomPhone, shutdown, staffClient } from './helpers';

let forgetTraffic: () => void;
beforeAll(async () => {
  await boot();
  ({ forgetTraffic } = await import('../src/traffic'));
});
afterAll(shutdown);
beforeEach(() => forgetTraffic());

const boss = () => staffClient('admin', { access: 'super_admin' });
const summary = async (a: Client) => expectOk(await a.get('/api/admin/traffic/summary')).body.summary as any;
const details = async (a: Client, q = '') => expectOk(await a.get(`/api/admin/traffic${q}`)).body as any;
/** Seen-just-now is recorded after the answer is sent, so wait a moment for it. */
const until = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> => {
  const stop = Date.now() + ms;
  let v = await fn();
  while (!ok(v) && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 50));
    v = await fn();
  }
  return v;
};
const profileId = async (c: Client) => (await c.get('/api/me')).body.user.id as string;

describe('sign-ins are recorded', () => {
  it('a customer signing in with their mobile number shows in today\'s sign-ins, with who and how', async () => {
    const admin = await boss();
    const before = await summary(admin.c);
    const { c, phone } = await customerWithVehicle('car'); // signs in by phone and fills in the profile
    const after = await summary(admin.c);
    expect(after.signed_in_today.customers).toBe(before.signed_in_today.customers + 1);
    expect(after.signed_in_today.sign_ins).toBe(before.signed_in_today.sign_ins + 1);
    expect(after.active_now.customers).toBeGreaterThanOrEqual(before.active_now.customers + 1); // signing in is being seen

    const t = await details(admin.c);
    const mine = t.sign_ins.find((e: any) => String(e.phone ?? '').endsWith(phone.slice(-10)));
    expect(mine).toMatchObject({ role: 'customer', method: 'phone', source: 'website' });
    expect(t.live.some((p: any) => p.profile_id === mine.profile_id)).toBe(true);
    expect(t.people.some((p: any) => p.profile_id === mine.profile_id && p.sign_ins === 1)).toBe(true);
    expect(t.days.at(-1).customers_signed_in).toBeGreaterThanOrEqual(1);
    expect((await c.get('/api/me')).status).toBe(200);
  });

  it('email sign-up and sign-in, and the app, are told apart', async () => {
    const admin = await boss();
    const email = `traffic${crypto.randomBytes(4).toString('hex')}@example.com`;
    const c = new Client();
    expectOk(await c.post('/api/auth/email/signup', { email, password: 'Str0ng-pass-123' }));
    const again = new Client();
    expectOk(await again.req('POST', '/api/auth/email/login', { email, password: 'Str0ng-pass-123' }, { headers: { 'user-agent': 'okhttp/4.12.0' } }));
    const id = await profileId(c);
    const t = await details(admin.c);
    const mine = t.sign_ins.filter((e: any) => e.profile_id === id);
    expect(mine.map((e: any) => `${e.method}:${e.source}`).sort()).toEqual(['email:app', 'signup:website']);
  });

  it('an admin signing in (password, then the emailed code) is recorded as an admin', async () => {
    const before = await (async () => (await summary((await boss()).c)).signed_in_today.admins)();
    const second = await boss();
    const t = await details(second.c);
    expect(t.summary.signed_in_today.admins).toBeGreaterThanOrEqual(before + 1);
    expect(t.sign_ins.some((e: any) => e.role === 'admin' && e.method === 'admin_email')).toBe(true);
  });
});

describe('being seen', () => {
  it('a signed-in person using the site is active now; the phone app asking for notifications on its own is not', async () => {
    const admin = await boss();
    const { c } = await customerWithVehicle('car');
    const id = await profileId(c);
    // forget that they were seen (as if they had signed in long ago and the server had restarted)
    await fake.admin.query('delete from public.user_activity_days where profile_id = $1', [id]);
    forgetTraffic();

    // the app's background check: not a person being active
    expectOk(await c.req('GET', '/api/notifications', undefined, { headers: { 'user-agent': 'okhttp/4.12.0' } }));
    await new Promise((r) => setTimeout(r, 400));
    expect((await fake.admin.query('select count(*)::int n from public.user_activity_days where profile_id = $1', [id])).rows[0].n).toBe(0);

    // the same person really using the app
    expectOk(await c.req('GET', '/api/bookings?scope=upcoming', undefined, { headers: { 'user-agent': 'okhttp/4.12.0' } }));
    const t = await until(() => details(admin.c), (v) => v.live.some((p: any) => p.profile_id === id));
    expect(t.live.find((p: any) => p.profile_id === id)).toMatchObject({ role: 'customer', source: 'app' });
  });

  it('the same person is not written to the database on every request (once a minute is enough)', async () => {
    const { c } = await customerWithVehicle('car');
    const id = await profileId(c);
    const seenAt = async () => (await fake.admin.query('select last_seen_at from public.user_activity_days where profile_id = $1 order by day desc limit 1', [id])).rows[0].last_seen_at as Date;
    await fake.admin.query(`update public.user_activity_days set last_seen_at = now() - interval '30 minutes' where profile_id = $1`, [id]);
    forgetTraffic();
    expectOk(await c.get('/api/me'));
    const first = await until(seenAt, (d) => Date.now() - d.getTime() < 60_000);
    expect(Date.now() - first.getTime()).toBeLessThan(60_000);
    await fake.admin.query(`update public.user_activity_days set last_seen_at = now() - interval '30 minutes' where profile_id = $1`, [id]);
    for (let i = 0; i < 3; i++) expectOk(await c.get('/api/me')); // within the minute: nothing more is written
    await new Promise((r) => setTimeout(r, 400));
    expect(Date.now() - (await seenAt()).getTime()).toBeGreaterThan(25 * 60_000);
  });
});

describe('who may look', () => {
  it('only a role with Activity access; the others, customers and visitors are refused', async () => {
    const ops = await staffClient('admin', { access: 'operations' });
    const { c } = await customerWithVehicle('car');
    for (const who of [ops.c, c]) {
      expect((await who.get('/api/admin/traffic/summary')).status).toBe(403);
      expect((await who.get('/api/admin/traffic')).status).toBe(403);
    }
    expect((await new Client().get('/api/admin/traffic/summary')).status).toBe(401);
    expect((await new Client().get('/api/admin/traffic')).status).toBe(401);
  });

  it('a chosen day and the number of days are checked, and an odd request is handled', async () => {
    const admin = await boss();
    const t = await details(admin.c, '?day=2026-01-11&days=3');
    expect(t.day).toBe('2026-01-11');
    expect(t.days).toHaveLength(3);
    expect(t.sign_ins).toEqual([]);
    const odd = await details(admin.c, '?day=not-a-day&days=9999');
    expect(odd.day).toBe(odd.today); // an unusable day is today, and the number of days is capped
    expect(odd.days).toHaveLength(14);
  });
});

describe('a database without migration 50', () => {
  it('says "not ready" instead of failing, and sign-in still works', async () => {
    const admin = await boss();
    await fake.admin.query('alter function public.admin_traffic_summary() rename to admin_traffic_summary_off');
    await fake.admin.query('alter function public.admin_traffic(date, integer) rename to admin_traffic_off');
    await fake.admin.query('alter function public.record_sign_in(text, text) rename to record_sign_in_off');
    try {
      expect((await admin.c.get('/api/admin/traffic/summary')).body).toMatchObject({ success: true, ready: false, summary: null });
      expect((await admin.c.get('/api/admin/traffic')).body).toMatchObject({ success: true, ready: false });
      const c = new Client();
      expect((await c.loginCustomer(randomPhone())).success).toBe(true); // recording failed quietly
    } finally {
      await fake.admin.query('alter function public.admin_traffic_summary_off() rename to admin_traffic_summary');
      await fake.admin.query('alter function public.admin_traffic_off(date, integer) rename to admin_traffic');
      await fake.admin.query('alter function public.record_sign_in_off(text, text) rename to record_sign_in');
    }
    expect((await summary(admin.c)).active_now).toBeDefined();
  });
});
