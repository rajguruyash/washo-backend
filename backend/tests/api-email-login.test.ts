/**
 * Email sign-in. A customer signs up or in with an email and a password: no verification email and no emailed code. An ADMIN's password is only the first
 * step: a code is emailed to them (Resend is replaced by a recorder; Supabase Auth is a local stand-in; the database rules are real) and the session only starts
 * when it comes back. Customers who sign in with an email still give a mobile number (typed, not confirmed) before they pay.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE } from './fakeSupabase';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient, PATTERN_3 } from './helpers';

let sent: { to: string; subject: string; html: string }[] = [];
let setMailTransport: (t: ((m: { to: string; subject: string; html: string }) => Promise<void>) | null) => void;
beforeAll(async () => {
  await boot();
  ({ setMailTransport } = await import('../src/notify')); // after boot: the server's configuration is read the first time it is loaded
});
afterAll(shutdown);
beforeEach(() => { sent = []; setMailTransport(async (m) => { sent.push(m); }); });

const mail = () => `e-${crypto.randomBytes(5).toString('hex')}@example.com`;
const PASS = 'Sunny-day-42';
const signup = (c: Client, email: string, password = PASS, extra: Record<string, unknown> = {}) => c.post('/api/auth/email/signup', { email, password, ...extra });
const login = (c: Client, email: string, password = PASS) => c.post('/api/auth/email/login', { email, password });
const sessionCookies = (r: { setCookies: string[] }) => r.setCookies.filter((s) => /^washo_(at|rt)=/.test(s));
const codeIn = (m: { html: string }) => m.html.match(/>(\d{4,10})<\/span>/)![1];

describe('signing up with an email and a password', () => {
  it('makes a customer account and signs them in at once: httpOnly cookies, no email sent, no code', async () => {
    const email = mail();
    const c = new Client();
    const r = await signup(c, email.toUpperCase());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ success: true, role: 'customer', needs_profile: true }); // they still have to give a name
    expect(sessionCookies(r)).toHaveLength(2);
    for (const sc of r.setCookies) expect(sc).toMatch(/HttpOnly/i);
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|eyJ|password/);
    expect(sent).toHaveLength(0); // nothing is emailed to a customer, ever
    const me = expectOk(await c.get('/api/me')).body.user;
    expect(me).toMatchObject({ role: 'customer', phone: null, needs_profile: true, email });
    expect(me.admin).toBeUndefined();
    // naming themselves is all setup needs
    expect(expectOk(await c.put('/api/me', { full_name: 'Ira Deshmukh', email })).body.user).toMatchObject({ needs_profile: false, phone: null });
    // and the same email + password signs in again, to the same account
    const again = new Client();
    const back = expectOk(await login(again, email));
    expect(back.body).toMatchObject({ role: 'customer', needs_profile: false });
    expect(expectOk(await again.get('/api/me')).body.user.id).toBe(me.id);
  });

  it('has a password rule a person can follow: 8 or more characters with a letter and a number', async () => {
    for (const [password, field] of [['short1', /at least 8/], ['allletters', /number/], ['12345678', /letters/], ['x'.repeat(73) + '1', /at most 72/]] as const) {
      const r = await signup(new Client(), mail(), password);
      expect(r.status, password).toBe(400);
      expect(r.body.details.fields.password).toMatch(field);
    }
    expect((await signup(new Client(), 'not-an-email')).status).toBe(400);
    expect((await signup(new Client(), mail(), null as unknown as string)).status).toBe(400);
  });

  it('refuses an address that already has an account (customer or staff), without giving anything away', async () => {
    const email = mail();
    expect((await signup(new Client(), email)).status).toBe(201);
    const again = await signup(new Client(), email, 'Another-pass-9');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('email_taken');
    expect(again.body.message).toMatch(/Sign in instead/);
    expect(sessionCookies(again)).toHaveLength(0);
    // the original password still works, the second attempt changed nothing
    expectOk(await login(new Client(), email));
    expect((await login(new Client(), email, 'Another-pass-9')).status).toBe(401);
    const w = await fake.createStaff('worker');
    expect((await signup(new Client(), w.email)).status).toBe(409);
  });

  it('a new account is a customer even if the sign-up asks for more', async () => {
    const c = new Client();
    const r = await signup(c, mail(), PASS, { role: 'admin', access: 'super_admin', full_name: 'Mallory' });
    expect(r.status).toBe(201);
    expect(expectOk(await c.get('/api/me')).body.user.role).toBe('customer');
    expect((await c.get('/api/admin/overview')).status).toBe(403);
  });
});

describe('signing in with an email and a password', () => {
  it('a customer or a specialist is signed in at once, with no code; a wrong password is a plain 401 for every case', async () => {
    const email = mail();
    expect((await signup(new Client(), email)).status).toBe(201);
    const w = await fake.createStaff('worker');
    for (const [e, p] of [[email, PASS], [w.email, w.password]] as const) {
      const c = new Client();
      const ok = expectOk(await login(c, e, p));
      expect(sessionCookies(ok)).toHaveLength(2);
      expect(ok.body.step).toBeUndefined();
    }
    expect(sent).toHaveLength(0);
    for (const [e, p] of [[email, 'wrong-pass-1'], [mail(), PASS], [w.email, 'wrong-pass-1']] as const) {
      const bad = await login(new Client(), e, p);
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('bad_credentials'); // the same answer whether the address exists or not
      expect(sessionCookies(bad)).toHaveLength(0);
    }
  });

  it('waits after 8 wrong passwords for the same address, even for the right one', async () => {
    const email = mail();
    expect((await signup(new Client(), email)).status).toBe(201);
    for (let i = 0; i < 8; i++) expect((await login(new Client(), email, 'wrong-pass-1')).status).toBe(401);
    const locked = await login(new Client(), email);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('login_limit');
    // another address is unaffected
    expectOk(await login(new Client(), (await fake.createStaff('worker')).email, 'Str0ng-pass!'));
  });

  it('an older login with no profile (made before profiles were automatic) is set up at sign-in', async () => {
    const email = mail();
    const c0 = await fake.admin.connect();
    let authId: string;
    try {
      await c0.query('BEGIN');
      await c0.query('ALTER TABLE auth.users DISABLE TRIGGER on_auth_user_created_create_customer_profile');
      authId = (await c0.query(
        `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1::text, crypt($2, gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, now(), now()) RETURNING id`,
        [email, PASS]
      )).rows[0].id;
      await c0.query('ALTER TABLE auth.users ENABLE TRIGGER on_auth_user_created_create_customer_profile');
      await c0.query('COMMIT');
    } catch (err) {
      await c0.query('ROLLBACK');
      throw err;
    } finally {
      c0.release();
    }
    const count = async () => (await fake.admin.query('select count(*)::int n from public.profiles where auth_user_id = $1', [authId])).rows[0].n;
    expect(await count()).toBe(0);
    const c = new Client();
    expect(expectOk(await login(c, email)).body).toMatchObject({ role: 'customer', needs_profile: true });
    expect(await count()).toBe(1);
    expect(expectOk(await c.get('/api/me')).body.user).toMatchObject({ role: 'customer', email });
  });

  it('a locked (archived) account is told so', async () => {
    const email = mail();
    expect((await signup(new Client(), email)).status).toBe(201);
    const id = (await fake.admin.query(`select id from auth.users where lower(email) = $1`, [email])).rows[0].id;
    await fetch(`${fake.url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: { apikey: FAKE.serviceKey, Authorization: `Bearer ${FAKE.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ban_duration: '876000h' }) });
    expect(fake.isBanned(id)).toBe(true);
    const r = await login(new Client(), email);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('account_archived');
  });

  it('the old emailed-code sign-in for customers is gone', async () => {
    const c = new Client();
    expect((await c.post('/api/auth/email/otp/request', { email: mail() })).status).toBe(404);
    expect((await c.post('/api/auth/email/otp/verify', { email: mail(), code: FAKE.otpCode })).status).toBe(404);
    expect((await c.post('/api/auth/staff/login', { email: mail(), password: PASS })).status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});

describe('an admin signs in in two steps', () => {
  const admin = (o: { access?: 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support' | null } = {}) => fake.createStaff('admin', { email: `admin-${crypto.randomBytes(4).toString('hex')}@example.com`, password: 'Admin-Secret-77', ...o });
  const rawToken = async (email: string, password: string) =>
    (await (await fetch(`${fake.url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: FAKE.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { access_token: string; refresh_token: string };

  it('the password alone signs nobody in: a code is emailed through Resend and nothing opens until it comes back', async () => {
    const a = await admin();
    const c = new Client();
    const first = expectOk(await login(c, a.email, a.password));
    expect(first.body).toMatchObject({ success: true, step: 'code', resend_in_seconds: 30 });
    expect(first.body.email_hint).toMatch(/^a\*\*\*[a-f0-9]@example\.com$/); // enough to know which inbox, not the address
    expect(first.body.role).toBeUndefined();
    expect(sessionCookies(first)).toHaveLength(0); // no session yet
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(a.email);
    expect(sent[0].subject).toMatch(/is your WASHO admin sign-in code$/);
    expect(codeIn(sent[0])).toBe(FAKE.otpCode);
    expect(JSON.stringify(first.body)).not.toContain(FAKE.otpCode); // the code goes to the inbox, never to the browser
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await c.get('/api/admin/overview')).status).toBe(401);

    const done = expectOk(await c.post('/api/auth/admin/code/verify', { code: FAKE.otpCode }));
    expect(done.body).toEqual({ success: true, role: 'admin' });
    expect(sessionCookies(done)).toHaveLength(2);
    for (const sc of done.setCookies) expect(sc).toMatch(/HttpOnly/i);
    expect(expectOk(await c.get('/api/me')).body.user).toMatchObject({ role: 'admin', admin: { access: 'super_admin' } });
    expectOk(await c.get('/api/admin/overview'));
    // the sign-in is in the activity log
    const logged = await fake.admin.query(`select count(*)::int n from public.audit_events where event_type = 'admin_signed_in' and actor_profile_id = $1`, [a.profileId]);
    expect(logged.rows[0].n).toBe(1);
    // the same code cannot be used again
    expect((await new Client().post('/api/auth/admin/code/verify', { code: FAKE.otpCode })).status).toBe(401); // (no step in progress there)
  });

  it('a wrong code counts down, five wrong ones cancel the step, and a code without the password step first is refused', async () => {
    const a = await admin();
    const c = new Client();
    expectOk(await login(c, a.email, a.password));
    const w1 = await c.post('/api/auth/admin/code/verify', { code: '000000' });
    expect(w1.status).toBe(400);
    expect(w1.body.message).toMatch(/isn't right.*4 tries left/);
    expect((await c.post('/api/auth/admin/code/verify', { code: 'abc' })).status).toBe(400);
    for (let i = 0; i < 3; i++) expect((await c.post('/api/auth/admin/code/verify', { code: '111111' })).status).toBe(400);
    const last = await c.post('/api/auth/admin/code/verify', { code: '222222' });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('too_many_codes');
    // the step is gone: even the right code does nothing now; they must start from the password
    const after = await c.post('/api/auth/admin/code/verify', { code: FAKE.otpCode });
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('step_expired');
    expect((await c.get('/api/me')).status).toBe(401);
    // nobody who skipped the password step can use a code
    const stranger = new Client();
    expect((await stranger.post('/api/auth/admin/code/verify', { code: FAKE.otpCode })).status).toBe(401);
    // a forged "password was right" cookie is worthless
    stranger.cookies.set('washo_2fa_pending', Buffer.from(JSON.stringify({ sub: a.authId, email: a.email, jti: 'x', exp: Date.now() + 60_000 })).toString('base64url') + '.AAAA');
    expect((await stranger.post('/api/auth/admin/code/verify', { code: FAKE.otpCode })).status).toBe(401);
    // and the page asking "am I signed in?" in the middle of the step does not throw the step away
    const mid = new Client();
    const b = await admin();
    expectOk(await login(mid, b.email, b.password));
    expect((await mid.get('/api/me')).status).toBe(401);
    expectOk(await mid.post('/api/auth/admin/code/verify', { code: FAKE.otpCode }));
  });

  it('a stolen password cannot become a session: a login token from Supabase without the second step is not accepted, and neither is a forged or borrowed second step', async () => {
    const a = await admin();
    const b = await admin();
    const tok = await rawToken(a.email, a.password); // what someone with only the password can get by talking to Supabase directly
    const thief = new Client();
    thief.cookies.set('washo_at', tok.access_token);
    thief.cookies.set('washo_rt', tok.refresh_token);
    for (const p of ['/api/me', '/api/admin/overview', '/api/admin/customers', '/api/admin/settings']) expect((await thief.get(p)).status, p).toBe(401);
    expect((await thief.post('/api/admin/campaigns', {})).status).toBe(401);
    thief.cookies.set('washo_2fa', 'forged.value');
    expect((await thief.get('/api/admin/overview')).status).toBe(401);

    // admin B's genuine second step cannot be lent to admin A's token
    const bClient = new Client();
    expectOk(await bClient.loginStaff(b.email, b.password));
    const lent = new Client();
    lent.cookies.set('washo_at', tok.access_token);
    lent.cookies.set('washo_rt', tok.refresh_token);
    lent.cookies.set('washo_2fa', bClient.cookies.get('washo_2fa')!);
    expect((await lent.get('/api/admin/overview')).status).toBe(401);
    // a worker or customer is not asked for any of this (it is only for admins)
    const w = await fake.createStaff('worker');
    const wt = await rawToken(w.email, w.password);
    const wc = new Client();
    wc.cookies.set('washo_at', wt.access_token);
    wc.cookies.set('washo_rt', wt.refresh_token);
    expect((await wc.get('/api/me')).status).toBe(200);
  });

  it('the second step runs out after 30 minutes without a request, slides while they are busy, and logging out ends it', async () => {
    const a = await admin();
    const c = new Client();
    expectOk(await c.loginStaff(a.email, a.password));
    const realNow = Date.now();
    const at = (minutes: number) => vi.spyOn(Date, 'now').mockReturnValue(realNow + minutes * 60_000);
    try {
      at(20);
      expectOk(await c.get('/api/admin/overview')); // busy: the clock slides
      at(40);
      expectOk(await c.get('/api/admin/overview')); // 40 minutes in, but only 20 since the last request
      at(72);
      const idle = await c.get('/api/admin/overview'); // 32 minutes since the last request
      expect(idle.status).toBe(401);
      expect(idle.body.code).toBe('unauthenticated');
      expect(idle.body.message).toMatch(/signed out after a while/);
      expect(c.cookies.has('washo_at')).toBe(false);
      expect(c.cookies.has('washo_2fa')).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
    const b = await admin(); // (one code every 30 seconds per admin, so a second sign-in is a second admin here)
    const again = new Client();
    expectOk(await again.loginStaff(b.email, b.password));
    expect((await again.post('/api/auth/logout')).status).toBe(200);
    expect(again.cookies.has('washo_2fa')).toBe(false);
    expect((await again.get('/api/admin/overview')).status).toBe(401);
  });

  it('a code can be sent again (after a wait), and only by someone who has the password step', async () => {
    const a = await admin();
    const c = new Client();
    expect((await c.post('/api/auth/admin/code/resend', {})).status).toBe(401);
    expectOk(await login(c, a.email, a.password));
    const soon = await c.post('/api/auth/admin/code/resend', {});
    expect(soon.status).toBe(429); // the 30-second wait between codes
    expect(sent).toHaveLength(1);
  });

  it('is refused (not let in on the password alone) when the code cannot be emailed', async () => {
    const a = await admin();
    setMailTransport(null);
    const noMail = await login(new Client(), a.email, a.password);
    expect(noMail.status).toBe(503);
    expect(noMail.body.code).toBe('two_step_unavailable');
    expect(sessionCookies(noMail)).toHaveLength(0);
    const b = await admin();
    setMailTransport(async () => { throw new Error('domain not verified'); });
    const c = new Client();
    const refused = await login(c, b.email, b.password);
    expect(refused.status).toBe(503);
    expect(refused.body.message).toMatch(/could not email the code/);
    expect(JSON.stringify(refused.body)).not.toContain('domain not verified');
    expect(sessionCookies(refused)).toHaveLength(0);
    expect(c.cookies.has('washo_2fa_pending')).toBe(false);
  });

  it('ADMIN_CODE_TO (a temporary escape hatch for an unverified sender domain) sends the code to that inbox instead, and the step still works', async () => {
    const { config } = await import('../src/config');
    const a = await admin();
    (config.admin as { codeTo: string }).codeTo = 'owner.inbox@example.com';
    try {
      const c = new Client();
      const first = expectOk(await login(c, a.email, a.password));
      expect(first.body.email_hint).toBe('o***x@example.com'); // the hint is about where it went
      expect(sent.at(-1)!.to).toBe('owner.inbox@example.com');
      expectOk(await c.post('/api/auth/admin/code/verify', { code: FAKE.otpCode }));
      expect(expectOk(await c.get('/api/me')).body.user.role).toBe('admin');
    } finally {
      (config.admin as { codeTo: string }).codeTo = '';
    }
  });

  it('an admin cannot sign in with a text message alone, and not with Google either', async () => {
    const a = await admin();
    const phone = String(9_200_000_000 + crypto.randomInt(0, 99_999_999));
    await fake.admin.query(`update auth.users set phone = $1, phone_confirmed_at = now() where id = $2`, [`+91${phone}`, a.authId]);
    const c = new Client();
    expectOk(await c.post('/api/auth/otp/request', { phone }));
    const r = await c.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('admin_use_email');
    expect(sessionCookies(r)).toHaveLength(0);
    expect((await c.get('/api/me')).status).toBe(401);
  });

  it('wrong password is the same 401 as for anyone, and sends no email', async () => {
    const a = await admin();
    const bad = await login(new Client(), a.email, 'Wrong-Secret-77');
    expect(bad.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('changing the password: the current one is checked, and an admin or specialist needs a strong one', async () => {
    const c = await staffClient('worker', { email: `chg-${crypto.randomBytes(4).toString('hex')}@example.com`, password: 'Worker-Secret-77' });
    const weak = await c.c.post('/api/auth/password', { current_password: 'Worker-Secret-77', new_password: 'short1A' });
    expect(weak.status).toBe(400);
    expect(weak.body.details.fields.new_password).toMatch(/at least 12/);
    expect((await c.c.post('/api/auth/password', { current_password: 'Worker-Secret-77', new_password: 'lowercase-only-1234' })).body.details.fields.new_password).toMatch(/upper and lower/);
    expect((await c.c.post('/api/auth/password', { current_password: 'Worker-Secret-77', new_password: 'Washo-Crew-Pass-2026' })).body.details.fields.new_password).toMatch(/too easy to guess/);
    const wrong = await c.c.post('/api/auth/password', { current_password: 'Nope-Nope-123', new_password: 'Brand-New-Secret-9' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.details.fields.current_password).toMatch(/not your current password/);
    expect((await c.c.post('/api/auth/password', { current_password: 'Worker-Secret-77', new_password: 'Worker-Secret-77' })).status).toBe(400);
    expectOk(await c.c.post('/api/auth/password', { current_password: 'Worker-Secret-77', new_password: 'Brand-New-Secret-9' }));
    expect((await login(new Client(), c.email, 'Worker-Secret-77')).status).toBe(401);
    expectOk(await login(new Client(), c.email, 'Brand-New-Secret-9'));
    expect((await new Client().post('/api/auth/password', { current_password: 'a', new_password: 'b' })).status).toBe(401);
  });

  it('a customer changes theirs under the customer rule; one who signs in by phone has no password to change', async () => {
    const email = mail();
    const c = new Client();
    expect((await signup(c, email)).status).toBe(201);
    expect((await c.post('/api/auth/password', { current_password: PASS, new_password: 'short1' })).status).toBe(400);
    expectOk(await c.post('/api/auth/password', { current_password: PASS, new_password: 'Rainy-night-7' }));
    expectOk(await login(new Client(), email, 'Rainy-night-7'));
    const byPhone = await customerWithVehicle('car');
    expect((await byPhone.c.post('/api/auth/password', { current_password: 'x', new_password: 'Rainy-night-7' })).status).toBe(409);
  });
});

describe('the mobile number is asked for when they pay, not before: typed, not confirmed', () => {
  async function emailCustomer() {
    const email = mail();
    const c = new Client();
    expect((await signup(c, email)).status).toBe(201);
    expectOk(await c.put('/api/me', { full_name: 'Ira Deshmukh', email }));
    const addr = expectOk(await c.post('/api/addresses', { society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: `B-${crypto.randomInt(100, 999)}`, parking_location: 'P1' })).body.address;
    const vehicle = expectOk(await c.post('/api/vehicles', { vehicle_type: 'car', make: 'Hyundai', model: 'Creta', registration_number: `MH12${crypto.randomBytes(2).toString('hex').toUpperCase()}${crypto.randomInt(1000, 9999)}`, color: 'White', address_id: addr.id })).body.vehicle;
    return { c, addr, vehicle, email };
  }
  const freshPhone = () => String(9_000_000_000 + crypto.randomInt(0, 99_999_999));
  const authPhone = async (email: string) => (await fake.admin.query(`select phone, phone_confirmed_at is not null as confirmed from auth.users where lower(email) = $1`, [email])).rows[0];

  it('they can look around and set up without one, but paying refuses until a number is on file; a typed number is enough (no code)', async () => {
    const n = await emailCustomer();
    expectOk(await n.c.get('/api/catalog'));
    expectOk(await n.c.get('/api/memberships'));
    const checkout = () => n.c.post('/api/payments/membership-checkout', { vehicle_id: n.vehicle.id, weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: n.addr.id });
    const refused = await checkout();
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('phone_required');
    const phone = freshPhone();
    const saved = expectOk(await n.c.put('/api/me/phone', { phone: `${phone.slice(0, 5)} ${phone.slice(5)}` }));
    expect(saved.body.user.phone).toBe(`+91${phone}`);
    expect(expectOk(await n.c.get('/api/me')).body.user.phone).toBe(`+91${phone}`);
    expectOk(await checkout());
  });

  it('the number is also put on the same login at Supabase, NOT confirmed: so signing in later WITH that number reaches the same account', async () => {
    const n = await emailCustomer();
    const phone = freshPhone();
    expectOk(await n.c.put('/api/me/phone', { phone }));
    expect(await authPhone(n.email)).toMatchObject({ phone: `+91${phone}`, confirmed: false });
    const profileBefore = expectOk(await n.c.get('/api/me')).body.user;
    // the same person now signs in with that number and its code
    const byPhone = new Client();
    expectOk(await byPhone.post('/api/auth/otp/request', { phone }));
    expectOk(await byPhone.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode }));
    const me = expectOk(await byPhone.get('/api/me')).body.user;
    expect(me.id).toBe(profileBefore.id); // the same profile, with their name, vehicles and bookings
    expect(me.full_name).toBe('Ira Deshmukh');
    expect((await authPhone(n.email)).confirmed).toBe(true);
    // and the email login still works (it was not orphaned)
    expectOk(await login(new Client(), n.email));
    expect(await fake.admin.query(`select count(*)::int n from public.profiles where auth_user_id = (select id from auth.users where lower(email) = $1)`, [n.email]).then((r) => r.rows[0].n)).toBe(1);
  });

  it('refuses a bad number, a number another account has (profile or login), and a number the customer signs in with', async () => {
    const n = await emailCustomer();
    for (const bad of ['12345', '5876543210', 'nine', '']) expect((await n.c.put('/api/me/phone', { phone: bad })).status, bad).toBe(400);
    expect((await new Client().put('/api/me/phone', { phone: freshPhone() })).status).toBe(401);

    const other = await customerWithVehicle('car'); // signs in by phone: that number is theirs
    const clash = await n.c.put('/api/me/phone', { phone: `${other.phone}` });
    expect(clash.status).toBe(422);
    expect(clash.body.message).toMatch(/already registered with WASHO/);
    expect(expectOk(await n.c.get('/api/me')).body.user.phone).toBeNull();
    expect((await authPhone(n.email)).phone).toBeNull(); // nothing was attached

    const typed = freshPhone();
    expectOk(await n.c.put('/api/me/phone', { phone: typed }));
    const second = await emailCustomer();
    expect((await second.c.put('/api/me/phone', { phone: typed })).status).toBe(422); // one number, one account

    // someone who signs in by phone cannot swap their number from here
    const swap = await other.c.put('/api/me/phone', { phone: freshPhone() });
    expect(swap.status).toBe(422);
    expect(swap.body.message).toMatch(/how you sign in/);
  });

  it('a mistyped number can be corrected, and the old one is released at Supabase', async () => {
    const n = await emailCustomer();
    const first = freshPhone();
    const second = freshPhone();
    expectOk(await n.c.put('/api/me/phone', { phone: first }));
    expectOk(await n.c.put('/api/me/phone', { phone: second }));
    expect(expectOk(await n.c.get('/api/me')).body.user.phone).toBe(`+91${second}`);
    expect((await authPhone(n.email)).phone).toBe(`+91${second}`);
    // the first number is free again for anyone
    const other = await emailCustomer();
    expectOk(await other.c.put('/api/me/phone', { phone: first }));
  });

  it('staff cannot use it', async () => {
    const w = await staffClient('worker');
    expect((await w.c.put('/api/me/phone', { phone: freshPhone() })).status).toBe(403);
  });
});
