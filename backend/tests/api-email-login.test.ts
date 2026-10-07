/**
 * Customers sign in with an emailed code: they ask for it, it arrives by email (Resend is replaced by a recorder; Supabase Auth is a local
 * stand-in; the database rules are real), they paste it in. No mobile number is asked for until they pay.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const ask = (c: Client, email: string) => c.post('/api/auth/email/otp/request', { email });
const enter = (c: Client, email: string, code: string) => c.post('/api/auth/email/otp/verify', { email, code });
const codeIn = (m: { html: string }) => m.html.match(/>(\d{4,10})<\/span>/)![1];

describe('asking for the code', () => {
  it('emails a code to the address, and never sends it to the browser', async () => {
    const c = new Client();
    const email = mail();
    const r = expectOk(await ask(c, email));
    expect(r.body).toEqual({ success: true, resend_in_seconds: 30 });
    expect(JSON.stringify(r.body)).not.toContain(FAKE.otpCode);
    expect(r.setCookies.filter((s) => /^washo_(at|rt)=/.test(s))).toHaveLength(0); // asking signs nobody in
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(email);
    expect(sent[0].subject).toMatch(/is your WASHO sign-in code$/);
    expect(codeIn(sent[0])).toBe(FAKE.otpCode);
    expect(sent[0].html).toContain('Copy it');
  });

  it('turns the address into a customer account the first time, and the same account the second time', async () => {
    const email = mail();
    const count = async () => (await fake.admin.query(`select count(*)::int n from auth.users where lower(email) = $1`, [email])).rows[0].n;
    expectOk(await ask(new Client(), email.toUpperCase())); // case does not matter
    expect(await count()).toBe(1);
    expect(sent[0].to).toBe(email);
    const c = new Client();
    expectOk(await enter(c, email.toUpperCase(), FAKE.otpCode));
    expect(expectOk(await c.get('/api/me')).body.user.email).toBe(email);
    // the same person later: the same account, not a second one (the cooldown between codes is per address)
    expect((await ask(new Client(), email)).status).toBe(429);
    expect(await count()).toBe(1);
  });

  it('refuses a bad address, waits between codes, and caps them per hour', async () => {
    const c = new Client();
    expect((await ask(c, 'not-an-email')).status).toBe(400);
    const email = mail();
    expectOk(await ask(c, email));
    const again = await ask(c, email);
    expect(again.status).toBe(429);
    expect(again.body.message).toMatch(/wait a little/);
    expect(sent).toHaveLength(1);
  });

  it('says plainly when email is not set up, or Resend refuses', async () => {
    setMailTransport(null);
    const down = await ask(new Client(), mail());
    expect(down.status).toBe(503);
    expect(down.body.message).toMatch(/cannot email codes/);
    setMailTransport(async () => { throw new Error('domain not verified'); });
    const refused = await ask(new Client(), mail());
    expect(refused.status).toBe(503);
    expect(refused.body.message).toMatch(/could not email that code/);
    expect(JSON.stringify(refused.body)).not.toContain('domain not verified');
  });
});

describe('pasting the code', () => {
  it('signs the customer in with httpOnly cookies, and a new one has no mobile number yet', async () => {
    const email = mail();
    const c = new Client();
    expectOk(await ask(c, email));
    const r = expectOk(await enter(c, email, codeIn(sent[0])));
    expect(r.body).toMatchObject({ success: true, role: 'customer', needs_profile: true }); // a new customer still has to give a name
    expect(r.setCookies.filter((s) => /^washo_(at|rt)=/.test(s))).toHaveLength(2);
    for (const sc of r.setCookies) expect(sc).toMatch(/HttpOnly/i);
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|eyJ/);
    const me = expectOk(await c.get('/api/me')).body.user;
    expect(me).toMatchObject({ role: 'customer', phone: null, needs_profile: true });
    expect(me.email).toBe(email);
    // naming themselves is all setup needs
    expect(expectOk(await c.put('/api/me', { full_name: 'Ira Deshmukh', email })).body.user).toMatchObject({ needs_profile: false, phone: null });
  });

  it('a wrong code, a used code, and another address\'s code are refused', async () => {
    const email = mail();
    const c = new Client();
    expectOk(await ask(c, email));
    const wrong = await enter(c, email, '000000');
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/isn't right/);
    expect((await enter(c, mail(), FAKE.otpCode)).status).toBe(400); // that address was never asked
    expect((await enter(c, email, 'abc')).status).toBe(400);
    expectOk(await enter(c, email, FAKE.otpCode));
    expect((await enter(new Client(), email, FAKE.otpCode)).status).toBe(400); // one use
  });

  it('a returning customer comes back to the same account (their bookings and details are there)', async () => {
    const c0 = await customerWithVehicle('car');
    const email = mail();
    expectOk(await c0.c.put('/api/me', { full_name: 'Asha Kulkarni', email }));
    // the same person later signs in by email instead: a separate login, but only after the number is verified do accounts merge (not here)
    const c = new Client();
    expectOk(await ask(c, email));
    expectOk(await enter(c, email, FAKE.otpCode));
    expect(expectOk(await c.get('/api/me')).body.user.role).toBe('customer');
  });

  it('specialists and admins cannot sign in with a code: they use their password', async () => {
    const w = await fake.createStaff('worker');
    const c = new Client();
    expectOk(await ask(c, w.email));
    const r = await enter(c, w.email, FAKE.otpCode);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('staff_use_password');
    expect(r.setCookies.filter((s) => /^washo_(at|rt)=/.test(s))).toHaveLength(0);
    expect((await c.get('/api/me')).status).toBe(401);
    // and the password still works
    expectOk(await new Client().post('/api/auth/email/login', { email: w.email, password: w.password }));
  });

  it('a locked (archived) account is told so', async () => {
    const email = mail();
    expectOk(await ask(new Client(), email));
    const id = (await fake.admin.query(`select id from auth.users where lower(email) = $1`, [email])).rows[0].id;
    await fetch(`${fake.url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: { apikey: FAKE.serviceKey, Authorization: `Bearer ${FAKE.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ban_duration: '876000h' }) });
    expect(fake.isBanned(id)).toBe(true);
    const r = await enter(new Client(), email, FAKE.otpCode);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('account_archived');
  });
});

describe('the mobile number is asked for when they pay, not before: typed, not confirmed', () => {
  async function emailCustomer() {
    const email = mail();
    const c = new Client();
    expectOk(await ask(c, email));
    expectOk(await enter(c, email, FAKE.otpCode));
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
    const again = new Client();
    expect((await ask(again, n.email)).status).toBe(429); // (the cooldown applies to the same address)
    expect(await fake.admin.query(`select count(*)::int n from public.profiles where auth_user_id = (select id from auth.users where lower(email) = $1)`, [n.email]).then((r) => r.rows[0].n)).toBe(1);
  });

  it('refuses a bad number, a number another account has (profile or login), and a number the customer signs in with', async () => {
    const n = await emailCustomer();
    for (const bad of ['12345', '5876543210', 'nine', '']) expect((await n.c.put('/api/me/phone', { phone: bad })).status, bad).toBe(400);
    expect((await new Client().put('/api/me/phone', { phone: freshPhone() })).status).toBe(401);

    const other = await customerWithVehicle('car'); // signs in by phone: that number is theirs
    const theirs = `${other.phone}`;
    const clash = await n.c.put('/api/me/phone', { phone: theirs });
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
