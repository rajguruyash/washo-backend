/**
 * Sign-in against a database shaped like PRODUCTION TODAY: the original schema dump with none of the new migrations.
 * There is no profiles.email, no record_signup_source and no washo_api. Existing customers, workers and admins must still get in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, expectOk, fake, randomPhone, shutdown } from './helpers';

beforeAll(async () => {
  await boot();
  const { rows } = await fake.admin.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='email'`);
  if (rows[0].n !== 0) throw new Error('This suite must run against a database WITHOUT profiles.email (use ./supabase/tests/run.sh legacy)');
});
afterAll(shutdown);

describe('production-shaped schema (no profiles.email)', () => {
  it('the database really is missing the column and the migration functions', async () => {
    const { rows } = await fake.admin.query(`SELECT to_regprocedure('public.record_signup_source(text)') f, to_regprocedure('public.worker_queue(integer)') w`);
    expect(rows[0]).toEqual({ f: null, w: null });
  });

  it('customer OTP: verify succeeds, the session is established, /api/me answers and the profile gap is preserved', async () => {
    const c = new Client();
    const phone = randomPhone();
    await c.post('/api/auth/otp/request', { phone });
    // `source` is sent the way the website sends it; the missing record_signup_source function must not break sign-in
    const v = await c.post('/api/auth/otp/verify', { phone, code: '123456', source: 'qr' });
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ success: true, role: 'customer', needs_profile: true });
    expect(c.cookies.get('washo_at')).toBeTruthy();

    const me = await c.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ role: 'customer', phone: `+91${phone}`, full_name: null, needs_profile: true, email: null });
  });

  it('a customer can finish the profile; the name is saved even though the email column does not exist yet', async () => {
    const c = new Client();
    await c.loginCustomer();
    const saved = expectOk(await c.put('/api/me', { full_name: 'Asha Kulkarni', email: 'asha@example.com' })).body.user;
    expect(saved).toMatchObject({ full_name: 'Asha Kulkarni', needs_profile: false });
    const again = expectOk(await c.get('/api/me')).body.user;
    expect(again.full_name).toBe('Asha Kulkarni');
    expect(again.needs_profile).toBe(false);
  });

  it('a returning customer maps to the same profile through auth_user_id', async () => {
    const phone = randomPhone();
    const a = new Client();
    await a.loginCustomer(phone);
    const id = (await a.get('/api/me')).body.user.id;
    const b = new Client();
    await b.loginCustomer(phone);
    expect((await b.get('/api/me')).body.user.id).toBe(id);
  });

  it('existing worker and admin accounts sign in with email + password and land with the role from profiles.role', async () => {
    const w = await fake.createStaff('worker', { name: 'Ravi Patil', phone: '9876500001' });
    const a = await fake.createStaff('admin', { name: 'WASHO Admin' });
    const cw = new Client();
    const rw = await cw.loginStaff(w.email, w.password);
    expect(rw.status).toBe(200);
    expect(rw.body.role).toBe('worker');
    expect((await cw.get('/api/me')).body.user).toMatchObject({ role: 'worker', full_name: 'Ravi Patil', needs_profile: false, email: w.email });

    const ca = new Client();
    const ra = await ca.loginStaff(a.email, a.password);
    expect(ra.body.role).toBe('admin');
    expect((await ca.get('/api/me')).body.user).toMatchObject({ role: 'admin', email: a.email });
  });

  it('role gates still hold: customers are kept out of the staff areas, workers out of admin', async () => {
    const cust = new Client();
    await cust.loginCustomer();
    expect((await cust.get('/api/worker/queue')).status).toBe(403);
    expect((await cust.get('/api/admin/overview')).status).toBe(403);
    const w = await fake.createStaff('worker');
    const cw = new Client();
    await cw.loginStaff(w.email, w.password);
    expect((await cw.get('/api/admin/overview')).status).toBe(403);
  });

  it('a customer cannot use the staff door', async () => {
    const phone = randomPhone();
    const c = new Client();
    await c.loginCustomer(phone);
    const { rows } = await fake.admin.query(`SELECT id FROM auth.users WHERE phone = $1`, [`+91${phone}`]);
    await fake.admin.query(`UPDATE auth.users SET email = $2, encrypted_password = crypt('Passw0rd!x', gen_salt('bf')) WHERE id = $1`, [rows[0].id, `cust-${phone}@t.test`]);
    const s = new Client();
    const r = await s.loginStaff(`cust-${phone}@t.test`, 'Passw0rd!x');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('not_staff');
    expect(s.cookies.size).toBe(0);
  });

  it('authenticated but no profile row: a clear 403, never a silent hang', async () => {
    // an Auth user whose profile was never created (triggers off for the insert)
    const client = await fake.admin.connect();
    let id: string;
    try {
      await client.query('SET session_replication_role = replica');
      id = (await client.query(`INSERT INTO auth.users (id, instance_id, aud, role, phone, phone_confirmed_at, created_at, updated_at) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(), now(), now()) RETURNING id`, [`+91${randomPhone()}`])).rows[0].id;
    } finally {
      await client.query('SET session_replication_role = DEFAULT');
      client.release();
    }
    const c = new Client();
    c.cookies.set('washo_at', fake.makeSession(id).access_token);
    const me = await c.get('/api/me');
    expect(me.status).toBe(403);
    expect(me.body).toMatchObject({ code: 'no_profile' });
    expect(me.body.message).toMatch(/not set up yet/);
  });

  it('if the profile lookup itself fails, OTP verification says why (503) and leaves no half-session; /api/me says the same', async () => {
    const c = new Client();
    const phone = randomPhone();
    await c.post('/api/auth/otp/request', { phone });
    await fake.admin.query('REVOKE SELECT ON public.profiles FROM authenticated');
    try {
      const v = await c.post('/api/auth/otp/verify', { phone, code: '123456' });
      expect(v.status).toBe(503);
      expect(v.body.code).toBe('profile_unavailable');
      expect(v.body.message).toMatch(/signed in, but we could not load your profile/);
      expect(c.cookies.size).toBe(0);

      const signedIn = new Client();
      signedIn.cookies.set('washo_at', fake.makeSession((await fake.admin.query(`SELECT id FROM auth.users WHERE phone = $1`, [`+91${phone}`])).rows[0].id).access_token);
      const me = await signedIn.get('/api/me');
      expect(me.status).toBe(503);
      expect(me.body.code).toBe('profile_unavailable');
    } finally {
      await fake.admin.query('GRANT SELECT ON public.profiles TO authenticated');
    }
  });
});
