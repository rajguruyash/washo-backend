/**
 * Mobile number + password: how customers sign in on the website. No code and no SMS. The password belongs to a login Supabase keeps under an address derived from
 * the number; the typed number is attached to it unconfirmed and saved on the profile like "add your number". Supabase Auth is a local stand-in; the database rules
 * are real.
 */
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAKE } from './fakeSupabase';
import { Client, PATTERN_3, activeMembership, boot, expectOk, fake, randomPhone, shutdown, staffClient } from './helpers';

let sent: { to: string; subject: string; html: string }[] = [];
let setMailTransport: (t: ((m: { to: string; subject: string; html: string }) => Promise<void>) | null) => void;
beforeAll(async () => {
  await boot();
  ({ setMailTransport } = await import('../src/notify'));
});
afterAll(shutdown);
beforeEach(() => {
  sent = [];
  setMailTransport(async (m) => { sent.push(m); });
});

const PASS = 'Sunny-day-42';
const signup = (c: Client, phone: string, password = PASS, extra: Record<string, unknown> = {}) => c.post('/api/auth/mobile/signup', { phone, password, ...extra });
const login = (c: Client, phone: string, password = PASS) => c.post('/api/auth/mobile/login', { phone, password });
const sessionCookies = (r: { setCookies: string[] }) => r.setCookies.filter((s) => /^washo_(at|rt)=/.test(s));
const authRows = async (phone: string) =>
  (await fake.admin.query(`select id, email, phone, email_confirmed_at is not null as email_confirmed, phone_confirmed_at is not null as phone_confirmed from auth.users where right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1`, [phone])).rows;
const profileRows = async (authId: string) => (await fake.admin.query(`select id, role, phone, email from public.profiles where auth_user_id = $1`, [authId])).rows;
const setAuthPassword = (id: string, password: string) =>
  fetch(`${fake.url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: { apikey: FAKE.serviceKey, Authorization: `Bearer ${FAKE.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });

describe('signing up with a mobile number and a password', () => {
  it('makes a customer account and signs them in at once: httpOnly cookies that outlast the browser, no code, no SMS, no tokens in the answer', async () => {
    const ph = randomPhone();
    const c = new Client();
    const r = await signup(c, ph);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ success: true, role: 'customer', needs_profile: true }); // they still give their name on the Welcome page
    const cookies = sessionCookies(r);
    expect(cookies).toHaveLength(2);
    for (const sc of cookies) expect(sc).toMatch(/HttpOnly/i);
    const rt = cookies.find((x) => x.startsWith('washo_rt='))!;
    expect(rt).toMatch(/Max-Age=2592000/); // 30 days: a persistent cookie, so closing the browser does not sign anyone out
    expect(rt).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|eyJ|password/i);
    expect(fake.otpSent.some((x) => x.endsWith(ph))).toBe(false); // nothing was texted or called
    expect(sent).toHaveLength(0);

    const me = expectOk(await c.get('/api/me')).body.user;
    expect(me).toMatchObject({ role: 'customer', phone: `+91${ph}`, needs_profile: true });
    expect(me.email).toBeNull(); // the internal login address is never shown as an email
    expect(JSON.stringify(me)).not.toContain('phone.washo.invalid');
  });

  it('the login it makes: a derived address with the password, the number attached but NOT confirmed (a typed number never merges or links by itself)', async () => {
    const ph = randomPhone();
    expect((await signup(new Client(), ph)).status).toBe(201);
    const rows = await authRows(ph);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: `91${ph}@phone.washo.invalid`, email_confirmed: true, phone_confirmed: false });
    const profiles = await profileRows(rows[0].id);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ role: 'customer', phone: `+91${ph}` });
  });

  it('accepts the number as people type it', async () => {
    for (const fmt of [(p: string) => p, (p: string) => `${p.slice(0, 5)} ${p.slice(5)}`, (p: string) => `+91 ${p}`, (p: string) => `0${p}`]) {
      const ph = randomPhone();
      const r = await signup(new Client(), fmt(ph));
      expect(r.status, fmt(ph)).toBe(201);
      expect(await authRows(ph)).toHaveLength(1);
    }
  });

  it('a number that already has an account is refused and nothing is created: another password sign-up, a number a code confirmed, a number an email customer added', async () => {
    // 1. the same number signing up twice
    const a = randomPhone();
    expect((await signup(new Client(), a)).status).toBe(201);
    const again = await signup(new Client(), a, 'Another-pass-9');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('phone_taken');
    expect(await authRows(a)).toHaveLength(1);
    // 2. a number that signed in with a code (confirmed)
    const b = randomPhone();
    await new Client().loginCustomer(b);
    const withCode = await signup(new Client(), b);
    expect(withCode.status).toBe(409);
    expect(await authRows(b)).toHaveLength(1);
    expect((await fake.admin.query(`select count(*)::int n from auth.users where email = $1`, [`91${b}@phone.washo.invalid`])).rows[0].n).toBe(0);
    // 3. a number an email customer typed and attached (unconfirmed)
    const e = new Client();
    expectOk(await e.post('/api/auth/email/signup', { email: `e-${crypto.randomBytes(4).toString('hex')}@example.com`, password: PASS }));
    const d = randomPhone();
    expectOk(await e.put('/api/me/phone', { phone: d }));
    const clash = await signup(new Client(), d);
    expect(clash.status).toBe(409);
    expect(await authRows(d)).toHaveLength(1);
  });

  it('says what is wrong in plain words, and never repeats the password', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ phone: '12345', password: PASS }, /valid 10-digit/i],
      [{ phone: '5123456789', password: PASS }, /valid 10-digit/i],
      [{ phone: randomPhone(), password: 'short1' }, /at least 8/i],
      [{ phone: randomPhone(), password: 'onlyletters' }, /number/i],
      [{ phone: randomPhone(), password: 'x1'.repeat(40) }, /at most 72/i],
    ];
    for (const [body, msg] of cases) {
      const r = await new Client().post('/api/auth/mobile/signup', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(r.body)).toMatch(msg);
      expect(JSON.stringify(r.body)).not.toContain(String(body.password));
    }
  });
});

describe('signing in with a mobile number and a password', () => {
  it('works from a new browser, with the number typed any way, and the same account comes back', async () => {
    const ph = randomPhone();
    const first = new Client();
    expect((await signup(first, ph)).status).toBe(201);
    const id = expectOk(await first.get('/api/me')).body.user.id;
    for (const typed of [ph, `${ph.slice(0, 5)} ${ph.slice(5)}`, `+91${ph}`]) {
      const c = new Client();
      const r = await login(c, typed);
      expect(r.status, typed).toBe(200);
      expect(r.body).toMatchObject({ success: true, role: 'customer' });
      expect(sessionCookies(r)).toHaveLength(2);
      expect(expectOk(await c.get('/api/me')).body.user.id).toBe(id);
    }
  });

  it('a wrong password and an unknown number get the same answer (no hint which numbers have an account)', async () => {
    const ph = randomPhone();
    await signup(new Client(), ph);
    const wrong = await login(new Client(), ph, 'Not-my-pass-1');
    const unknown = await login(new Client(), randomPhone());
    for (const r of [wrong, unknown]) {
      expect(r.status).toBe(401);
      expect(r.body.message).toBe('Mobile number or password is incorrect.');
      expect(sessionCookies(r)).toHaveLength(0);
    }
  });

  it('after 8 wrong passwords for a number it waits, even for the right one; another number is not affected', async () => {
    const ph = randomPhone();
    const other = randomPhone();
    await signup(new Client(), ph);
    await signup(new Client(), other);
    for (let i = 0; i < 8; i++) expect((await login(new Client(), ph, `Wrong-pass-${i}`)).status).toBe(401);
    const locked = await login(new Client(), ph, PASS);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('login_limit');
    expect(sessionCookies(locked)).toHaveLength(0);
    expect((await login(new Client(), other)).status).toBe(200);
  });

  it('stays signed in after the browser is closed: only the long cookie is left, and it quietly brings the short one back', async () => {
    const ph = randomPhone();
    const c = new Client();
    await signup(c, ph);
    expect(c.cookies.has('washo_at')).toBe(true);
    c.cookies.delete('washo_at'); // the short-lived access cookie is gone (it expires in about an hour, or a closed browser dropped it)
    const me = await c.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.phone).toBe(`+91${ph}`);
    expect(me.setCookies.some((s) => s.startsWith('washo_at='))).toBe(true); // a fresh one was issued
    expect(me.setCookies.find((s) => s.startsWith('washo_rt='))).toMatch(/Max-Age=2592000/); // and the 30 days start again from this visit
  });

  it('signing out ends it, and the same number and password sign in again', async () => {
    const ph = randomPhone();
    const c = new Client();
    await signup(c, ph);
    expectOk(await c.post('/api/auth/logout'));
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await login(c, ph)).status).toBe(200);
    expect(expectOk(await c.get('/api/me')).body.user.phone).toBe(`+91${ph}`);
  });

  it('a locked (archived) account is told so, and gets no session', async () => {
    const ph = randomPhone();
    await signup(new Client(), ph);
    const id = (await authRows(ph))[0].id;
    await fetch(`${fake.url}/auth/v1/admin/users/${id}`, { method: 'PUT', headers: { apikey: FAKE.serviceKey, Authorization: `Bearer ${FAKE.serviceKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ban_duration: '876000h' }) });
    const r = await login(new Client(), ph);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('account_archived');
    expect(sessionCookies(r)).toHaveLength(0);
  });

  it('an account a code confirmed can sign in with the password somebody set on it; without a password it cannot, and a wrong one is refused', async () => {
    const ph = randomPhone();
    await new Client().loginCustomer(ph); // an older account: number confirmed by a code, no password
    expect((await login(new Client(), ph)).status).toBe(401);
    const id = (await authRows(ph))[0].id;
    expect((await setAuthPassword(id, 'Set-by-washo-7')).status).toBe(200);
    const ok = await login(new Client(), ph, 'Set-by-washo-7');
    expect(ok.status).toBe(200);
    expect(sessionCookies(ok)).toHaveLength(2);
    expect((await login(new Client(), ph, 'Not-it-12345')).status).toBe(401);
  });

  it('a specialist or an admin cannot open their console with a number and a password', async () => {
    const w = await staffClient('worker');
    const ph = randomPhone();
    await fake.admin.query(`update auth.users set phone = $1, phone_confirmed_at = now() where id = $2`, [`91${ph}`, w.authId]);
    const r = await login(new Client(), ph, w.password);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('use_email');
    expect(sessionCookies(r)).toHaveLength(0);
  });
});

describe('the internal login address stays internal', () => {
  it('is not an email: never shown, never mailed (renewal reminders skip it, dry run or real)', async () => {
    const m = await activeMembership({ type: 'car', pattern: PATTERN_3, months: 1 });
    const profile = (await fake.admin.query(`select p.id, p.auth_user_id from public.profiles p join public.memberships mm on mm.customer_profile_id = p.id where mm.id = $1`, [m.membershipId])).rows[0];
    // this customer now has only the internal address (no contact email), and their membership ends in 4 days
    await fake.admin.query(`update public.profiles set email = null where id = $1`, [profile.id]);
    await fake.admin.query(`update auth.users set email = $1 where id = $2`, [`91${randomPhone()}@phone.washo.invalid`, profile.auth_user_id]);
    await fake.admin.query('alter table public.memberships disable trigger user');
    await fake.admin.query(
      `update public.memberships
          set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '4 day' - interval '1 month' + interval '1 day') at time zone 'Asia/Kolkata',
              end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '4 day') at time zone 'Asia/Kolkata'
        where id = $1`,
      [m.membershipId]
    );
    await fake.admin.query('alter table public.memberships enable trigger user');
    await fake.admin.query(`insert into public.app_settings (key, value) values ('renewal_emails', $1::jsonb) on conflict (key) do update set value = excluded.value`, [JSON.stringify({ on: true, week: { on: true, days: 7 }, last: { on: true, days: 2 }, ended: { on: true, days: 3 }, from_hour: 0, to_hour: 24 })]);
    const admin = await staffClient('admin');
    const dry = expectOk(await admin.c.post('/api/admin/reminders/run?dry=1')).body;
    expect((dry.would ?? []).filter((w: { membership_id: string }) => w.membership_id === m.membershipId)).toHaveLength(0);
    expectOk(await admin.c.post('/api/admin/reminders/run'));
    expect(sent.filter((x) => /phone\.washo\.invalid/.test(x.to))).toHaveLength(0);
    expect((await fake.admin.query(`select count(*)::int n from public.email_log where ref_id = $1`, [m.membershipId])).rows[0].n).toBe(0);
  });
});

describe('a forgotten password', () => {
  afterEach(() => vi.useRealTimers());
  const NEW_PASS = 'Fresh-start-77';
  const setNew = (c: Client, password = NEW_PASS) => c.post('/api/auth/mobile/password', { password });

  it('a code sign-in lands in the SAME account, and a new password can then be chosen without the old one; the old one stops working', async () => {
    const ph = randomPhone();
    const first = new Client();
    await signup(first, ph);
    const id = expectOk(await first.get('/api/me')).body.user.id;
    expectOk(await first.post('/api/auth/logout'));

    const viaCode = new Client();
    await viaCode.loginCustomer(`+91${ph}`); // "Get a code instead"
    expect(expectOk(await viaCode.get('/api/me')).body.user.id).toBe(id); // the same account, not a second one
    expectOk(await setNew(viaCode));

    expectOk(await viaCode.post('/api/auth/logout'));
    expect((await login(new Client(), ph, PASS)).status).toBe(401); // the old password is gone
    const again = new Client();
    expect((await login(again, ph, NEW_PASS)).status).toBe(200);
    expect(expectOk(await again.get('/api/me')).body.user.id).toBe(id);
  });

  it('a session that came from a PASSWORD cannot choose a new one without the old (it must go through a code first)', async () => {
    const ph = randomPhone();
    const c = new Client();
    await signup(c, ph);
    const r = await setNew(c);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('code_needed');
    expect((await login(new Client(), ph, PASS)).status).toBe(200); // nothing changed
  });

  it('the code only counts for 15 minutes, and still counts after the short cookie is renewed', async () => {
    const ph = randomPhone();
    const c = new Client();
    await signup(c, ph);
    expectOk(await c.post('/api/auth/logout'));
    await c.loginCustomer(`+91${ph}`);
    c.cookies.delete('washo_at'); // renewed from the long cookie: the token keeps saying how the session began
    expectOk(await c.get('/api/me'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const late = await setNew(c);
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('code_needed');
    vi.useRealTimers();
    expectOk(await setNew(c)); // inside the 15 minutes it works
  });

  it('refuses a weak password, a visitor, and a specialist', async () => {
    const ph = randomPhone();
    const c = new Client();
    await c.loginCustomer(ph);
    for (const bad of ['short1', 'onlyletters', '']) expect((await setNew(c, bad)).status, bad).toBe(400);
    expect((await setNew(new Client())).status).toBe(401);
    const w = await staffClient('worker');
    expect((await setNew(w.c)).status).toBe(403);
  });
});
