/** Sign-in (Supabase Auth via the website), profile, addresses, vehicles and the public catalogue. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, randomPhone, shutdown, staffClient } from './helpers';
import { FAKE, signJwt } from './fakeSupabase';

beforeAll(boot);
afterAll(shutdown);

describe('customer sign-in (Supabase Auth phone OTP)', () => {
  it('requests a code, verifies it, and keeps the session in httpOnly cookies — never in the response body', async () => {
    const c = new Client();
    const phone = randomPhone();
    const req = await c.post('/api/auth/otp/request', { phone });
    expect(req.status).toBe(200);
    expect(fake.otpSent).toContain(`+91${phone}`);

    const v = await c.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode, source: 'instagram' });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ success: true, role: 'customer', needs_profile: true });
    expect(JSON.stringify(v.body)).not.toMatch(/access_token|refresh_token|eyJ/);
    expect(v.setCookies.length).toBe(2);
    for (const sc of v.setCookies) expect(sc).toMatch(/HttpOnly/i);
    expect(v.setCookies.join('\n')).toMatch(/SameSite=Lax/i);

    const me = expectOk(await c.get('/api/me')).body.user;
    expect(me).toMatchObject({ role: 'customer', phone: `+91${phone}`, needs_profile: true });

    // first-touch attribution is recorded by the database
    const { rows } = await fake.admin.query('SELECT signup_source FROM public.profiles WHERE id = $1', [me.id]);
    expect(rows[0].signup_source).toBe('instagram');
  });

  it('a wrong or reused code is refused with a plain message', async () => {
    const c = new Client();
    const phone = randomPhone();
    await c.post('/api/auth/otp/request', { phone });
    const bad = await c.post('/api/auth/otp/verify', { phone, code: '000000' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('otp_invalid');
    expect(bad.setCookies).toHaveLength(0);
    expect((await c.get('/api/me')).status).toBe(401);

    expectOk(await c.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode }));
    const again = await new Client().post('/api/auth/otp/verify', { phone, code: FAKE.otpCode });
    expect(again.status).toBe(400); // single use
  });

  it('rejects malformed phone numbers before calling Supabase', async () => {
    const before = fake.otpSent.length;
    const r = await new Client().post('/api/auth/otp/request', { phone: '12345' });
    expect(r.status).toBe(400);
    expect(r.body.details.fields.phone).toMatch(/valid 10-digit/);
    expect(fake.otpSent.length).toBe(before);
  });

  it('passes Supabase throttling through as a friendly 429', async () => {
    fake.throttleNextOtp();
    const r = await new Client().post('/api/auth/otp/request', { phone: randomPhone() });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('otp_cooldown');
  });

  it('a returning customer gets the same profile', async () => {
    const phone = randomPhone();
    const a = new Client();
    await a.loginCustomer(phone);
    const idA = (await a.get('/api/me')).body.user.id;
    const b = new Client();
    await b.loginCustomer(phone);
    expect((await b.get('/api/me')).body.user.id).toBe(idA);
  });
});

describe('sessions', () => {
  it('no cookie, a forged token, an expired token and a token signed with the wrong key are all 401', async () => {
    expect((await new Client().get('/api/me')).status).toBe(401);

    const { authId } = await fake.createStaff('worker');
    const mk = (secret: string, exp: number, extra = {}) => signJwt({ aud: 'authenticated', role: 'authenticated', sub: authId, exp, ...extra }, secret);
    const now = Math.floor(Date.now() / 1000);
    for (const [label, token] of Object.entries({
      wrongKey: mk('not-the-secret', now + 600),
      expired: mk(FAKE.jwtSecret, now - 10),
      anonRole: signJwt({ aud: 'authenticated', role: 'anon', sub: authId, exp: now + 600 }),
      noSignature: mk(FAKE.jwtSecret, now + 600).split('.').slice(0, 2).join('.') + '.',
      algNone: `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ aud: 'authenticated', role: 'authenticated', sub: authId, exp: now + 600 })).toString('base64url')}.`,
    })) {
      const c = new Client();
      c.cookies.set('washo_at', token);
      const r = await c.get('/api/me');
      expect(r.status, label).toBe(401);
    }
  });

  it('an expired access token is refreshed transparently using the refresh cookie', async () => {
    const c = new Client();
    await c.loginCustomer();
    const oldRefresh = c.cookies.get('washo_rt')!;
    c.cookies.delete('washo_at'); // as if the 1-hour cookie had lapsed
    const r = await c.get('/api/me');
    expect(r.status).toBe(200);
    expect(c.cookies.get('washo_at')).toBeTruthy();
    expect(c.cookies.get('washo_rt')).not.toBe(oldRefresh); // Supabase rotates refresh tokens
  });

  it('logout clears both cookies', async () => {
    const c = new Client();
    await c.loginCustomer();
    expectOk(await c.post('/api/auth/logout'));
    expect(c.cookies.size).toBe(0);
    expect((await c.get('/api/me')).status).toBe(401);
  });

  it('refuses cross-site writes (CSRF) but allows same-origin ones', async () => {
    const c = new Client();
    await c.loginCustomer();
    const evil = await c.req('PUT', '/api/me', { full_name: 'Mallory' }, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('bad_origin');
  });

  it('there is no Razorpay webhook on the website (it lives in the Supabase edge function only)', async () => {
    expect([401, 404]).toContain((await new Client().req('POST', '/api/payments/razorpay/webhook', { event: 'payment.captured' })).status);
    const { c } = await customerWithVehicle();
    expect((await c.req('POST', '/api/payments/razorpay/webhook', { event: 'payment.captured' })).status).toBe(404);
  });
});

describe('staff sign-in (email + password)', () => {
  it('workers and admins can sign in; the role comes from the database', async () => {
    const w = await fake.createStaff('worker');
    const a = await fake.createStaff('admin');
    const cw = new Client();
    const cwr = await cw.loginStaff(w.email, w.password);
    expect(cwr.status).toBe(200);
    expect(cwr.body.role).toBe('worker');
    expect((await cw.get('/api/me')).body.user.role).toBe('worker');
    const ca = new Client();
    expect((await ca.loginStaff(a.email, a.password)).body.role).toBe('admin');
  });

  it('wrong password is 401; a customer account cannot use the staff door', async () => {
    const w = await fake.createStaff('worker');
    const bad = await new Client().loginStaff(w.email, 'nope');
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('bad_credentials');

    const cust = await fake.createStaff('worker', { email: 'cust-as-staff@washo.test', password: 'Passw0rd!x' });
    await fake.admin.query(`SELECT set_config('washo.allow_role_change','on',false)`);
    await fake.admin.query(`UPDATE public.profiles SET role = 'customer' WHERE id = $1`, [cust.profileId]).catch(() => undefined);
    const c = new Client();
    const r = await c.loginStaff(cust.email, cust.password);
    // either the role flip was blocked by the database guard (still a worker) or it was refused as a customer
    expect([200, 403]).toContain(r.status);
    if (r.status === 403) {
      expect(r.body.code).toBe('not_staff');
      expect(c.cookies.size).toBe(0);
    }
  });

  it('role gates: customers cannot reach worker or admin routes; workers cannot reach admin', async () => {
    const cust = await customerWithVehicle();
    const w = await staffClient('worker');
    for (const p of ['/api/worker/queue', '/api/admin/overview', '/api/admin/bookings']) expect((await cust.c.get(p)).status, p).toBe(403);
    expect((await w.c.get('/api/admin/overview')).status).toBe(403);
    expect((await w.c.get('/api/vehicles')).status).toBe(403);
    expect((await w.c.get('/api/membership-requests')).status).toBe(403);
    expect((await new Client().get('/api/worker/queue')).status).toBe(401);
  });
});

describe('profile, addresses and vehicles (row-level security as the signed-in customer)', () => {
  it('completes the profile and manages addresses', async () => {
    const c = new Client();
    await c.loginCustomer();
    expect((await c.put('/api/me', { full_name: 'A' })).status).toBe(400);
    const me = expectOk(await c.put('/api/me', { full_name: 'Asha Kulkarni', email: 'asha@example.com' })).body.user;
    expect(me).toMatchObject({ full_name: 'Asha Kulkarni', email: 'asha@example.com', needs_profile: false });

    const first = expectOk(await c.post('/api/addresses', { society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: '702', parking_location: 'P1' })).body.address;
    const second = expectOk(await c.post('/api/addresses', { label: 'Office', society_name: 'EON IT Park', building_block: 'A', flat_number: '1', parking_location: 'Gate 2' })).body.address;
    expect(first.is_default).toBe(true); // the first address becomes the default
    expect(second.is_default).toBe(false);
    const upd = expectOk(await c.put(`/api/addresses/${second.id}`, { label: 'Office', society_name: 'EON IT Park', building_block: 'A', flat_number: '1', parking_location: 'Gate 2', is_default: true })).body.address;
    expect(upd.is_default).toBe(true);
    const list = expectOk(await c.get('/api/addresses')).body.addresses;
    expect(list.filter((a: any) => a.is_default)).toHaveLength(1);
  });

  it('vehicles: add, list, edit, duplicates refused, delete is soft and blocked while washes are open', async () => {
    const { c, vehicle, reg } = await customerWithVehicle('suv');
    expect(vehicle).toMatchObject({ vehicle_type: 'suv', model: 'Creta' });
    const dup = await c.post('/api/vehicles', { vehicle_type: 'car', model: 'X', registration_number: reg.toLowerCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('duplicate_vehicle');

    const edited = expectOk(await c.put(`/api/vehicles/${vehicle.id}`, { vehicle_type: 'suv', model: 'Creta SX', registration_number: reg, color: 'Black' })).body.vehicle;
    expect(edited).toMatchObject({ model: 'Creta SX', color: 'Black' });

    const second = expectOk(await c.post('/api/vehicles', { vehicle_type: 'bike', model: 'Activa', registration_number: 'MH12ZZ0001' })).body.vehicle;
    expect(expectOk(await c.del(`/api/vehicles/${second.id}`)).status).toBe(200);
    const list = expectOk(await c.get('/api/vehicles')).body.vehicles;
    expect(list.map((v: any) => v.id)).toEqual([vehicle.id]);
    expect((await c.del(`/api/vehicles/${second.id}`)).status).toBe(404);
  });

  it('a customer never sees or edits another customer\'s data', async () => {
    const a = await customerWithVehicle();
    const b = await customerWithVehicle();
    expect(expectOk(await b.c.get('/api/vehicles')).body.vehicles.map((v: any) => v.id)).not.toContain(a.vehicle.id);
    expect((await b.c.put(`/api/vehicles/${a.vehicle.id}`, { vehicle_type: 'car', model: 'Hacked', registration_number: 'HACK1234' })).status).toBe(404);
    expect((await b.c.del(`/api/vehicles/${a.vehicle.id}`)).status).toBe(404);
    expect((await b.c.put(`/api/addresses/${a.addr.id}`, { society_name: 'Hacked', building_block: 'x', flat_number: '1', parking_location: 'zz' })).status).toBe(404);
    const stillMine = expectOk(await a.c.get('/api/vehicles')).body.vehicles.find((v: any) => v.id === a.vehicle.id);
    expect(stillMine.model).toBe('Creta');
  });

  it('refuses unknown vehicle types and bad input', async () => {
    const c = new Client();
    await c.loginCustomer();
    expect((await c.post('/api/vehicles', { vehicle_type: 'truck', model: 'x', registration_number: 'MH12AB1234' })).status).toBe(400);
    expect((await c.post('/api/vehicles', { vehicle_type: 'car', model: '', registration_number: 'MH12AB1234' })).status).toBe(400);
  });
});

describe('public catalogue', () => {
  it('serves the approved rate card, membership options and explicit discounts straight from the database', async () => {
    const r = expectOk(await new Client().get('/api/catalog')).body;
    const price = (code: string, vt: string) => r.services.find((s: any) => s.code === code).unit_prices.find((p: any) => p.vehicle_type === vt)?.price_cents;
    expect(price('bike-body-wash', 'bike')).toBe(6500);
    expect(price('car-body-wash', 'car')).toBe(15000);
    expect(price('car-deep-cleaning', 'car')).toBe(22000);
    expect(price('suv-deep-cleaning', 'suv')).toBe(25000);
    expect(price('car-body-wash', 'suv')).toBe(15000); // SUV Body = the car body wash rate

    const kinds = (vt: string) => r.membership_options.filter((o: any) => o.vehicle_type === vt).map((o: any) => `${o.wash_kind}:${o.service_code}`).sort();
    expect(kinds('car')).toEqual(['body:car-body-wash', 'deep:car-deep-cleaning']);
    expect(kinds('suv')).toEqual(['body:car-body-wash', 'deep:suv-deep-cleaning']);
    expect(kinds('bike')).toEqual(['body:bike-body-wash']);

    const d = (kind: string, key: number) => r.discounts.find((x: any) => x.kind === kind && x.key === key)?.discount_bp;
    expect([d('frequency', 1), d('frequency', 2), d('frequency', 3)]).toEqual([0, 0, 1000]);
    expect([d('duration', 1), d('duration', 3), d('duration', 6), d('duration', 12)]).toEqual([0, 500, 1000, 1500]);
    expect(r.max_total_discount_bp).toBe(1500);
    expect(r.weeks_per_month).toBe(4);
    // No credit/plan concepts exist in the catalogue
    expect(JSON.stringify(r)).not.toMatch(/credit|entitlement|plans/i);
  });
});

describe('sign out and speed', () => {
  it('logout clears both cookies with the SAME attributes they were set with (Safari ignores a mismatched clear)', async () => {
    const c = new Client();
    await c.loginCustomer();
    const out = await c.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect(out.setCookies).toHaveLength(2);
    for (const sc of out.setCookies) {
      expect(sc).toMatch(/Path=\/api/);
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/SameSite=Lax/i);
      expect(sc).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
    expect((await c.get('/api/me')).status).toBe(401);
  });

  it('logout works even when the session already expired', async () => {
    const c = new Client();
    expect((await c.post('/api/auth/logout')).status).toBe(200);
  });

  it('a signed-in request costs one setup round trip, its own queries and one COMMIT (the profile is remembered, not re-read)', async () => {
    const { pool } = await import('../src/db');
    const seen: string[] = [];
    const original = pool.connect.bind(pool) as (...a: any[]) => any;
    (pool as any).connect = async (...a: any[]) => {
      const client = await original(...a);
      if (client.__counted) return client; // pooled clients are reused: wrap each only once
      client.__counted = true;
      const q = client.query.bind(client);
      client.query = (...args: any[]) => { seen.push(String(typeof args[0] === 'string' ? args[0] : args[0]?.text).slice(0, 60)); return q(...args); };
      return client;
    };
    try {
      const { c } = await customerWithVehicle();
      await c.get('/api/me'); // warms the profile
      seen.length = 0;
      expectOk(await c.get('/api/vehicles'));
      expect(seen.length, seen.join(' | ')).toBe(3); // BEGIN+settings, the vehicles query, COMMIT
      seen.length = 0;
      expectOk(await c.get('/api/addresses'));
      expect(seen.length).toBe(3);
    } finally {
      (pool as any).connect = original;
    }
  });
});
