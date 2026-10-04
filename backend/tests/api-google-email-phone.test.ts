/**
 * Continue with Google (PKCE through Supabase Auth), email + password for every role, and the verified mobile number a Google
 * customer must add before booking. Supabase is a local stand-in; the database rules are real.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE } from './fakeSupabase';
import { Client, boot, customerWithVehicle, expectOk, fake, randomPhone, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const email = () => `g-${crypto.randomBytes(5).toString('hex')}@example.com`;

/** Starts Google sign-in in this "browser" and returns what Supabase would be sent. */
async function startGoogle(c: Client, query = '') {
  const r = await c.get(`/api/auth/google${query}`);
  expect(r.status).toBe(302);
  const to = new URL(r.headers.get('location')!);
  return { response: r, to, challenge: to.searchParams.get('code_challenge')! };
}

/** The whole dance for a customer: start, "approve in Google", come back to the callback. */
async function googleCustomer(o: { email?: string; name?: string; query?: string } = {}) {
  const c = new Client();
  const { challenge } = await startGoogle(c, o.query);
  const code = await fake.googleSignIn({ email: o.email ?? email(), name: o.name ?? 'Meera Joshi', challenge });
  const back = await c.get(`/api/auth/callback?code=${code}`);
  return { c, back };
}

describe('Continue with Google', () => {
  it('sends the browser to Supabase with a PKCE challenge, and keeps the matching secret in an httpOnly cookie, not in any URL', async () => {
    const c = new Client();
    const { response, to, challenge } = await startGoogle(c);
    expect(`${to.origin}${to.pathname}`).toBe(`${fake.url}/auth/v1/authorize`);
    expect(to.searchParams.get('provider')).toBe('google');
    expect(to.searchParams.get('redirect_to')).toMatch(/\/api\/auth\/callback$/);
    expect(to.searchParams.get('code_challenge_method')).toBe('s256');

    const cookie = response.setCookies[0];
    expect(cookie).toMatch(/^washo_pkce=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const saved = JSON.parse(Buffer.from(decodeURIComponent(cookie.split(';')[0].split('=')[1]), 'base64url').toString());
    expect(crypto.createHash('sha256').update(saved.v).digest('base64url')).toBe(challenge);
    expect(response.headers.get('location')).not.toContain(saved.v); // only the hash travels
  });

  it('a new Google customer is signed in, named from Google, and sent to finish setup (no mobile number yet)', async () => {
    const { c, back } = await googleCustomer({ name: 'Meera Joshi' });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/app/welcome');
    expect(back.setCookies.filter((s) => /^washo_(at|rt)=/.test(s)).length).toBe(2);
    for (const sc of back.setCookies) expect(sc).toMatch(/HttpOnly/i);
    expect(c.cookies.has('washo_pkce')).toBe(false); // one use

    const me = expectOk(await c.get('/api/me')).body.user;
    expect(me).toMatchObject({ role: 'customer', full_name: 'Meera Joshi', phone: null, needs_profile: true });
    expect(me.email).toMatch(/@example\.com$/);
  });

  it('source attribution travels with the sign-in', async () => {
    const { c } = await googleCustomer({ query: '?source=instagram' });
    const me = expectOk(await c.get('/api/me')).body.user;
    const { rows } = await fake.admin.query('SELECT signup_source FROM public.profiles WHERE id = $1', [me.id]);
    expect(rows[0].signup_source).toBe('instagram');
  });

  it('a code that was not issued for THIS browser is refused: no session, back to the login page', async () => {
    const victim = new Client();
    const { challenge } = await startGoogle(victim);
    const code = await fake.googleSignIn({ email: email(), challenge });

    const attacker = new Client(); // never started the flow, so holds no verifier
    const noCookie = await attacker.get(`/api/auth/callback?code=${code}`);
    expect(noCookie.status).toBe(302);
    expect(noCookie.headers.get('location')).toBe('/login?error=google_failed');
    expect(noCookie.setCookies.some((s) => /^washo_at=[^;]+/.test(s))).toBe(false);

    const other = new Client();
    await startGoogle(other); // has a verifier, but for a different challenge
    const wrong = await other.get(`/api/auth/callback?code=${code}`);
    expect(wrong.headers.get('location')).toBe('/login?error=google_failed');
    expect((await other.get('/api/me')).status).toBe(401);
  });

  it('a code works once', async () => {
    const c = new Client();
    const { challenge } = await startGoogle(c);
    const code = await fake.googleSignIn({ email: email(), challenge });
    const keep = new Map(c.cookies);
    expect((await c.get(`/api/auth/callback?code=${code}`)).headers.get('location')).toBe('/app/welcome');
    const replay = new Client();
    replay.cookies = keep; // same verifier, code already spent
    expect((await replay.get(`/api/auth/callback?code=${code}`)).headers.get('location')).toBe('/login?error=google_failed');
  });

  it('cancelling in Google, or a missing code, goes back to the login page with a reason', async () => {
    const c = new Client();
    await startGoogle(c);
    expect((await c.get('/api/auth/callback?error=access_denied&error_description=denied')).headers.get('location')).toBe('/login?error=google_cancelled');
    expect((await new Client().get('/api/auth/callback')).headers.get('location')).toBe('/login?error=google_failed');
  });

  it('a returning Google customer who has a mobile number goes where they were headed, and never to another website', async () => {
    const first = await googleCustomer({ email: 'returning@example.com' });
    const phone = randomPhone();
    expectOk(await first.c.post('/api/auth/phone/request', { phone }));
    expectOk(await first.c.post('/api/auth/phone/verify', { phone, code: FAKE.otpCode }));

    const again = new Client();
    const { challenge } = await startGoogle(again, '?next=/app/bookings');
    const code = await fake.googleSignIn({ email: 'returning@example.com', challenge });
    expect((await again.get(`/api/auth/callback?code=${code}`)).headers.get('location')).toBe('/app/bookings');

    for (const evil of ['https://evil.example/app', '//evil.example', '/app//evil.example', '/login', '/worker']) {
      const c = new Client();
      const s = await startGoogle(c, `?next=${encodeURIComponent(evil)}`);
      const k = await fake.googleSignIn({ email: 'returning@example.com', challenge: s.challenge });
      expect((await c.get(`/api/auth/callback?code=${k}`)).headers.get('location')).toBe('/app');
    }
  });
});

describe('a mobile number for people who signed in with Google', () => {
  it('until it is verified they cannot pay for anything; once it is, they can', async () => {
    const { c } = await googleCustomer();
    for (const path of ['/api/payments/on-demand', '/api/payments/membership-checkout']) {
      const r = await c.post(path, {});
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('phone_required');
    }
    const phone = randomPhone();
    expectOk(await c.post('/api/auth/phone/request', { phone }));
    expect(fake.otpSent).toContain(`+91${phone}`);

    const bad = await c.post('/api/auth/phone/verify', { phone, code: '000000' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('otp_invalid');
    expect(expectOk(await c.get('/api/me')).body.user.phone).toBeNull();

    const ok = expectOk(await c.post('/api/auth/phone/verify', { phone, code: FAKE.otpCode }));
    expect(ok.body.user).toMatchObject({ phone: `+91${phone}`, needs_profile: false, full_name: 'Meera Joshi' });
    expect(JSON.stringify(ok.body)).not.toMatch(/access_token|refresh_token|eyJ/);
    expect(expectOk(await c.get('/api/me')).body.user).toMatchObject({ phone: `+91${phone}`, needs_profile: false });
    const { rows } = await fake.admin.query('SELECT phone FROM public.profiles WHERE id = $1', [ok.body.user.id]);
    expect(rows[0].phone).toBe(`+91${phone}`);

    // the number guard no longer applies: the request now reaches normal validation
    const r = await c.post('/api/payments/membership-checkout', {});
    expect(r.status).toBe(400);
  });

  it('a number that belongs to another WASHO account is refused, and nothing changes', async () => {
    const taken = await customerWithVehicle('car'); // signed up by phone
    const { c } = await googleCustomer();
    const r = await c.post('/api/auth/phone/request', { phone: taken.phone });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('phone_taken');
    expect(expectOk(await c.get('/api/me')).body.user.phone).toBeNull();
  });

  it('Supabase throttling shows as a friendly wait', async () => {
    const { c } = await googleCustomer();
    fake.throttleNextOtp();
    const r = await c.post('/api/auth/phone/request', { phone: randomPhone() });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('otp_cooldown');
  });

  it('a code for a different number, or from someone else\'s sign-in, does not verify', async () => {
    const a = await googleCustomer();
    const b = await googleCustomer();
    const pa = randomPhone();
    expectOk(await a.c.post('/api/auth/phone/request', { phone: pa }));
    expect((await a.c.post('/api/auth/phone/verify', { phone: randomPhone(), code: FAKE.otpCode })).status).toBe(400);
    expect((await b.c.post('/api/auth/phone/verify', { phone: pa, code: FAKE.otpCode })).status).toBe(400);
    expect(expectOk(await a.c.get('/api/me')).body.user.phone).toBeNull();
  });

  it('is only for customers who have no verified number', async () => {
    const withPhone = await customerWithVehicle('car');
    expect((await withPhone.c.post('/api/auth/phone/request', { phone: randomPhone() })).body.code).toBe('phone_already_set');
    expect((await withPhone.c.post('/api/auth/phone/verify', { phone: randomPhone(), code: FAKE.otpCode })).body.code).toBe('phone_already_set');
    const worker = await staffClient('worker');
    expect((await worker.c.post('/api/auth/phone/request', { phone: randomPhone() })).status).toBe(403);
    expect((await new Client().post('/api/auth/phone/request', { phone: randomPhone() })).status).toBe(401);
    expect((await (await googleCustomer()).c.post('/api/auth/phone/request', { phone: '12345' })).status).toBe(400);
  });

  it('saving your name does not clear the need for a number', async () => {
    const { c } = await googleCustomer();
    const saved = expectOk(await c.put('/api/me', { full_name: 'Meera J', email: '' }));
    expect(saved.body.user.needs_profile).toBe(true);
  });
});

describe('sign in with email', () => {
  it('works for specialists and admins, and sends each to their own home', async () => {
    const w = await fake.createStaff('worker');
    const a = await fake.createStaff('admin');
    const cw = new Client();
    const rw = expectOk(await cw.post('/api/auth/email/login', { email: w.email.toUpperCase(), password: w.password }));
    expect(rw.body).toMatchObject({ role: 'worker', needs_profile: false });
    expect(JSON.stringify(rw.body)).not.toMatch(/access_token|refresh_token|eyJ/);
    expect(rw.setCookies.length).toBe(2);
    expect(expectOk(await cw.get('/api/me')).body.user.role).toBe('worker');
    const ca = new Client();
    expect(expectOk(await ca.post('/api/auth/email/login', { email: a.email, password: a.password })).body.role).toBe('admin');
  });

  it('refuses a wrong password plainly, without a session', async () => {
    const w = await fake.createStaff('worker');
    const c = new Client();
    const r = await c.post('/api/auth/email/login', { email: w.email, password: 'nope-nope' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('bad_credentials');
    expect(r.setCookies).toHaveLength(0);
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await c.post('/api/auth/email/login', { email: 'not-an-email', password: 'x' })).status).toBe(400);
  });
});
