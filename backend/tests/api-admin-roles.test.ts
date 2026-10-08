/**
 * The back-office: roles and what each may do (ONE gate on every /api/admin path), the team, the dashboard, the activity log, complaints, app settings
 * (maintenance mode, big refunds) and data export. Supabase Auth and Razorpay are local stand-ins; the database rules are real.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FAKE } from './fakeSupabase';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, siteUrl, staffClient } from './helpers';

type Role = 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support';
let sent: { to: string; subject: string; html: string }[] = [];
let setMailTransport: (t: ((m: { to: string; subject: string; html: string }) => Promise<void>) | null) => void;
let forgetCodeCooldowns: () => void;
beforeAll(async () => {
  await boot();
  ({ setMailTransport } = await import('../src/notify'));
  ({ forgetCodeCooldowns } = await import('../src/routes/auth'));
});
afterAll(shutdown);
beforeEach(() => { sent = []; setMailTransport(async (m) => { sent.push(m); }); });

const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];
const as = (access: Role | null) => staffClient('admin', { access });

/** A paid single wash that its customer cancelled: a full refund request waiting for an admin. */
async function refundRequest(code = 'car-body-wash') {
  const cust = await customerWithVehicle('car');
  const svc = (await dbOne(`select id from public.services where code = $1`, [code])).id;
  const order = expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(5), time_slot: 'morning', address_id: cust.addr.id })).body.order;
  expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id)));
  const booking = expectOk(await cust.c.get('/api/bookings')).body.bookings[0];
  expectOk(await cust.c.post(`/api/bookings/${booking.id}/cancel`, { reason: 'Plans changed' }));
  const refund = await dbOne(`select id, amount_cents from public.refunds where booking_id = $1`, [booking.id]);
  return { cust, booking, refund };
}

describe('every admin path goes through one gate: signed in, a role, and a role that may do it', () => {
  it('a customer, a specialist, a visitor, and an admin without a role are all refused everywhere', async () => {
    const cust = await customerWithVehicle('car');
    const worker = await staffClient('worker');
    const noRole = await as(null);
    const paths = ['/api/admin/overview', '/api/admin/dashboard', '/api/admin/bookings', '/api/admin/settings', '/api/admin/team', '/api/admin/support', '/api/admin/export/customers', '/api/admin/not-a-real-path'];
    for (const p of paths) {
      expect((await new Client().get(p)).status, `visitor ${p}`).toBe(401);
      expect((await cust.c.get(p)).status, `customer ${p}`).toBe(403);
      expect((await worker.c.get(p)).status, `worker ${p}`).toBe(403);
      const r = await noRole.c.get(p);
      expect(r.status, `no role ${p}`).toBe(403);
      expect(r.body.code).toBe('no_admin_role');
    }
    expect(expectOk(await noRole.c.get('/api/me')).body.user.admin).toBeNull();
  });

  it('each role can use exactly its own areas: view is read-only, manage can change', async () => {
    const ops = await as('operations');
    const fin = await as('finance');
    const mkt = await as('marketing');
    const sup = await as('support');
    const owner = await as('super_admin');
    const status = async (c: { c: Client }, method: 'get' | 'post' | 'put', path: string, body: unknown = {}) => (method === 'get' ? await c.c.get(path) : method === 'post' ? await c.c.post(path, body) : await c.c.put(path, body)).status;
    const forbidden = 403;
    const notForbidden = (n: number) => n !== 403 && n !== 401;

    // operations: washes, people, content; not money, settings or the team
    expect(await status(ops, 'get', '/api/admin/bookings')).toBe(200);
    expect(notForbidden(await status(ops, 'post', '/api/admin/customers', {}))).toBe(true); // reaches the route (and fails validation)
    expect(await status(ops, 'get', '/api/admin/services')).toBe(200);
    expect(notForbidden(await status(ops, 'get', '/api/admin/capacity'))).toBe(true); // (needs a date range, so it may say 400: it got past the gate)
    expect(await status(ops, 'get', '/api/admin/attention')).toBe(forbidden);
    expect(await status(ops, 'post', `/api/admin/refunds/${crypto.randomUUID()}/approve`)).toBe(forbidden);
    expect(await status(ops, 'get', '/api/admin/settings')).toBe(forbidden);
    expect(await status(ops, 'put', '/api/admin/settings', { key: 'maintenance_mode', value: true })).toBe(forbidden);
    expect(await status(ops, 'get', '/api/admin/team')).toBe(forbidden);
    expect(await status(ops, 'get', '/api/admin/activity')).toBe(forbidden);
    expect(await status(ops, 'get', '/api/admin/support')).toBe(forbidden);
    expect(await status(ops, 'get', '/api/admin/export/payments')).toBe(forbidden);
    expect(await status(ops, 'get', '/api/admin/export/customers')).toBe(200);

    // finance: money, read-only elsewhere; cannot edit content or block people
    expect(await status(fin, 'get', '/api/admin/attention')).toBe(200);
    expect(await status(fin, 'get', '/api/admin/bookings')).toBe(200); // view
    expect(await status(fin, 'post', `/api/admin/bookings/${crypto.randomUUID()}/assign`, { worker_profile_id: crypto.randomUUID() })).toBe(forbidden); // not manage
    expect(await status(fin, 'post', '/api/admin/customers', {})).toBe(forbidden);
    expect(await status(fin, 'post', `/api/admin/customers/${crypto.randomUUID()}/archive`, { archived: true })).toBe(forbidden);
    expect(await status(fin, 'get', '/api/admin/customers')).toBe(forbidden);
    expect(await status(fin, 'put', `/api/admin/services/${crypto.randomUUID()}/price`, {})).toBe(forbidden);
    expect(await status(fin, 'get', '/api/admin/export/payments')).toBe(200);
    expect(await status(fin, 'get', '/api/admin/export/refunds')).toBe(200);
    expect(await status(fin, 'get', '/api/admin/export/customers')).toBe(forbidden);
    expect(await status(fin, 'get', '/api/admin/history')).toBe(200);

    // marketing: campaigns only (and the overview)
    expect(await status(mkt, 'get', '/api/admin/campaigns')).toBe(200);
    expect(await status(mkt, 'get', '/api/admin/dashboard')).toBe(200);
    expect(await status(mkt, 'get', '/api/admin/overview')).toBe(200);
    for (const p of ['/api/admin/bookings', '/api/admin/customers', '/api/admin/attention', '/api/admin/services', '/api/admin/support', '/api/admin/export/customers']) expect(await status(mkt, 'get', p), p).toBe(forbidden);

    // support: look at people and washes, answer complaints; no refunds, nothing is changed elsewhere
    expect(await status(sup, 'get', '/api/admin/support')).toBe(200);
    expect(await status(sup, 'get', '/api/admin/customers')).toBe(200);
    expect(await status(sup, 'get', '/api/admin/bookings')).toBe(200);
    expect(await status(sup, 'post', '/api/admin/customers', {})).toBe(forbidden);
    expect(await status(sup, 'post', `/api/admin/customers/${crypto.randomUUID()}/archive`, { archived: true })).toBe(forbidden);
    expect(await status(sup, 'get', '/api/admin/attention')).toBe(forbidden);
    expect(await status(sup, 'post', `/api/admin/refunds/${crypto.randomUUID()}/resolve`, { status: 'failed' })).toBe(forbidden);
    expect(await status(sup, 'get', '/api/admin/export/support')).toBe(200);

    // the super admin: everything, including the team; and an unknown path is closed to everybody else but is a plain 404 for them
    for (const p of ['/api/admin/overview', '/api/admin/dashboard', '/api/admin/settings', '/api/admin/team', '/api/admin/activity', '/api/admin/support', '/api/admin/attention', '/api/admin/customers']) expect(await status(owner, 'get', p), p).toBe(200);
    expect(await status(owner, 'get', '/api/admin/not-a-real-path')).toBe(404);
    for (const c of [ops, fin, mkt, sup]) expect(await status(c, 'get', '/api/admin/not-a-real-path')).toBe(forbidden);
  });

  it('/me tells the page what the admin may do, and the owner\'s email is always the super admin even if the roles table says otherwise', async () => {
    const fin = await as('finance');
    const me = expectOk(await fin.c.get('/api/me')).body.user;
    expect(me.admin.access).toBe('finance');
    expect(me.admin.areas).toMatchObject({ payments: 'manage', bookings: 'view' });
    expect(me.admin.areas.team).toBeUndefined();

    // the configured owner address with NO row in the roles table: the website still knows who the owner is
    const owner = await staffClient('admin', { email: 'rajguruyash29@gmail.com', access: null });
    const ownerMe = expectOk(await owner.c.get('/api/me')).body.user;
    expect(ownerMe.admin.access).toBe('super_admin');
    expect(Object.keys(ownerMe.admin.areas)).toHaveLength(21);
    expectOk(await owner.c.get('/api/admin/overview')); // passes the gate
  });

  it('a role change takes effect straight away', async () => {
    const owner = await as('super_admin');
    const ops = await as('operations');
    expect((await ops.c.get('/api/admin/attention')).status).toBe(403);
    expectOk(await owner.c.put(`/api/admin/team/${ops.profileId}/access`, { access: 'finance' }));
    expect((await ops.c.get('/api/admin/attention')).status).toBe(200);
    expect((await ops.c.get('/api/admin/customers')).status).toBe(403);
  });
});

describe('the team', () => {
  const strong = 'Team-Member-2026x';
  const email = () => `team-${crypto.randomBytes(4).toString('hex')}@example.com`;

  it('the super admin adds an admin with a role; they sign in in two steps and get only that role; a weak password or a taken email is refused', async () => {
    const owner = await as('super_admin');
    const addr = email();
    const weak = await owner.c.post('/api/admin/team', { full_name: 'Neha Kulkarni', email: addr, password: 'short', access: 'support' });
    expect(weak.status).toBe(400);
    expect(weak.body.details.fields.password).toMatch(/at least 12/);
    expect((await owner.c.post('/api/admin/team', { full_name: 'Neha Kulkarni', email: addr, password: strong, access: 'super_admin' })).status).toBe(400); // not a role you can hand out
    expect((await owner.c.post('/api/admin/team', { full_name: 'Neha Kulkarni', email: addr, password: 'Washo-Admin-2026!', access: 'support' })).body.details.fields.password).toMatch(/too easy to guess/);

    const made = expectOk(await owner.c.post('/api/admin/team', { full_name: 'Neha Kulkarni', email: addr.toUpperCase(), password: strong, access: 'support' }));
    expect(made.status).toBe(201);
    expect(made.body.admin).toMatchObject({ access: 'support', email: addr });
    expect(JSON.stringify(made.body)).not.toContain(strong);

    const taken = await owner.c.post('/api/admin/team', { full_name: 'Someone Else', email: addr, password: strong, access: 'finance' });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toMatch(/Use a different email/);

    // the new admin: password, then a code emailed to THEIR address, then in, with only the support role
    const c = new Client();
    const first = expectOk(await c.post('/api/auth/email/login', { email: addr, password: strong }));
    expect(first.body.step).toBe('code');
    expect(sent.at(-1)!.to).toBe(addr);
    expectOk(await c.post('/api/auth/admin/code/verify', { code: FAKE.otpCode }));
    const me = expectOk(await c.get('/api/me')).body.user;
    expect(me).toMatchObject({ role: 'admin', full_name: 'Neha Kulkarni', admin: { access: 'support' } });
    expect((await c.get('/api/admin/support')).status).toBe(200);
    expect((await c.get('/api/admin/attention')).status).toBe(403);
    expect((await c.get('/api/admin/team')).status).toBe(403);
    // it is in the activity log, with who did it
    const log = expectOk(await owner.c.get('/api/admin/activity?q=admin_account_created')).body.events;
    expect(log[0]).toMatchObject({ event_type: 'admin_account_created', actor_role: 'admin', metadata: { access: 'support' } });
  });

  it('only the super admin manages the team; nobody changes their own role, the super admin\'s role, or switches off the owner', async () => {
    const owner = await as('super_admin');
    const ops = await as('operations');
    const fin = await as('finance');
    expect((await ops.c.post('/api/admin/team', { full_name: 'Evil Admin', email: email(), password: strong, access: 'finance' })).status).toBe(403);
    expect((await ops.c.put(`/api/admin/team/${fin.profileId}/access`, { access: 'support' })).status).toBe(403);
    expect((await fin.c.post(`/api/admin/team/${ops.profileId}/active`, { active: false })).status).toBe(403);
    const list = expectOk(await owner.c.get('/api/admin/team')).body.team;
    expect(list.find((t: any) => t.id === owner.profileId)).toMatchObject({ access: 'super_admin' });
    expect(list.find((t: any) => t.id === fin.profileId)).toMatchObject({ access: 'finance', archived: false });
    expect((await owner.c.put(`/api/admin/team/${owner.profileId}/access`, { access: 'support' })).body.message).toMatch(/cannot change your own role/);
    const second = await as('super_admin');
    expect((await owner.c.put(`/api/admin/team/${second.profileId}/access`, { access: 'support' })).body.message).toMatch(/super admin's role cannot be changed/);
    expect((await owner.c.post(`/api/admin/team/${second.profileId}/active`, { active: false })).body.message).toMatch(/cannot be switched off/);
    expect((await owner.c.post(`/api/admin/team/${owner.profileId}/active`, { active: false })).body.message).toMatch(/your own account/);
  });

  it('switching an admin off locks their login at Supabase and signs them out; switching them back on restores it', async () => {
    const owner = await as('super_admin');
    const fin = await as('finance');
    expect((await fin.c.get('/api/admin/attention')).status).toBe(200);
    const off = expectOk(await owner.c.post(`/api/admin/team/${fin.profileId}/active`, { active: false }));
    expect(off.body.login_locked).toBe(true);
    expect(fake.isBanned(fin.authId)).toBe(true);
    const gone = await fin.c.get('/api/admin/attention');
    expect(gone.status).toBe(403);
    expect(gone.body.code).toBe('account_archived');
    const refused = await new Client().post('/api/auth/email/login', { email: fin.email, password: fin.password });
    expect(refused.status).toBe(403);
    expectOk(await owner.c.post(`/api/admin/team/${fin.profileId}/active`, { active: true }));
    expect(fake.isBanned(fin.authId)).toBe(false);
    forgetCodeCooldowns(); // (a second code for the same admin within 30 seconds is refused; that is tested elsewhere)
    const back = new Client();
    expectOk(await back.loginStaff(fin.email, fin.password));
    expect((await back.get('/api/admin/attention')).status).toBe(200);
  });

  it('an existing customer\'s email cannot be turned into an admin', async () => {
    const owner = await as('super_admin');
    const addr = email();
    expect((await new Client().post('/api/auth/email/signup', { email: addr, password: 'Customer-pass-1' })).status).toBe(201);
    const r = await owner.c.post('/api/admin/team', { full_name: 'Not An Admin', email: addr, password: strong, access: 'support' });
    expect(r.status).toBe(409);
    expect((await new Client().post('/api/auth/email/login', { email: addr, password: 'Customer-pass-1' })).body.role).toBe('customer');
  });
});

describe('the dashboard and the activity log', () => {
  it('shows today by Pune day, and gives money only to a role that may see payments', async () => {
    const fin = await as('finance');
    const ops = await as('operations');
    const before = expectOk(await fin.c.get('/api/admin/dashboard')).body.dashboard;
    const w = await refundRequest(); // a paid Rs 150 wash
    const after = expectOk(await fin.c.get('/api/admin/dashboard')).body.dashboard;
    expect(after.orders.paid_today - before.orders.paid_today).toBe(1);
    expect(after.money.collected_today_cents - before.money.collected_today_cents).toBe(15000);
    expect(after.new_customers.today - before.new_customers.today).toBe(1);
    expect(after.series).toHaveLength(14);
    expect(after.payment_problems).toMatchObject({ failed_today: 0 });
    const opsView = expectOk(await ops.c.get('/api/admin/dashboard')).body.dashboard;
    expect(opsView.money).toBeNull();
    expect(opsView.payment_problems).toBeNull();
    expect(opsView.new_customers.today).toBe(after.new_customers.today);
    expect(w.refund.amount_cents).toBe(15000);
  });

  it('the activity log is the super admin\'s: who did what and when, searchable', async () => {
    const owner = await as('super_admin');
    const ops = await as('operations');
    expect((await ops.c.get('/api/admin/activity')).status).toBe(403);
    expectOk(await owner.c.put('/api/admin/settings', { key: 'maintenance_message', value: 'Back at six' }));
    const all = expectOk(await owner.c.get('/api/admin/activity?limit=500')).body.events;
    expect(all.length).toBeGreaterThan(2);
    expect(all.find((e: any) => e.event_type === 'setting_changed')).toMatchObject({ actor_role: 'admin', metadata: { key: 'maintenance_message', to: 'Back at six' } });
    expect(all.find((e: any) => e.event_type === 'admin_signed_in')).toMatchObject({ actor_role: 'admin' });
    const found = expectOk(await owner.c.get('/api/admin/activity?q=maintenance_message')).body.events;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((e: any) => JSON.stringify(e).includes('maintenance_message'))).toBe(true);
    expect(expectOk(await owner.c.get('/api/admin/activity?q=zzz-nothing-like-this')).body.events).toEqual([]);
    expect(expectOk(await owner.c.get('/api/admin/activity?limit=2')).body.events).toHaveLength(2);
    expect((await owner.c.get('/api/admin/activity?before=not-a-date')).status).toBe(200); // a bad bound is ignored, not an error page
  });
});

describe('big refunds', () => {
  it('a refund at or above the threshold needs the super admin AND the amount typed back; below it, finance can approve', async () => {
    const owner = await as('super_admin');
    const fin = await as('finance');
    const ops = await as('operations');
    expect(expectOk(await fin.c.get('/api/admin/attention')).body.policy).toEqual({ threshold_cents: 100000, can_approve_big: false });
    expect(expectOk(await owner.c.get('/api/admin/attention')).body.policy).toEqual({ threshold_cents: 100000, can_approve_big: true });

    // under the threshold (Rs 150 < Rs 1,000): finance approves without any ceremony; operations cannot at all
    const small = await refundRequest();
    expect((await ops.c.post(`/api/admin/refunds/${small.refund.id}/approve`, {})).status).toBe(403);
    expect(expectOk(await fin.c.post(`/api/admin/refunds/${small.refund.id}/approve`, {})).body.provider_refund_id).toMatch(/^rfnd_/);

    // the owner makes Rs 100 the line: now Rs 150 is "big"
    expectOk(await owner.c.put('/api/admin/settings', { key: 'big_refund_threshold_cents', value: 10000 }));
    const big = await refundRequest();
    const noRole = await fin.c.post(`/api/admin/refunds/${big.refund.id}/approve`, { confirm_amount_cents: 15000 });
    expect(noRole.status).toBe(403);
    expect(noRole.body.code).toBe('big_refund');
    expect(noRole.body.message).toMatch(/needs the super admin/);
    expect((await fin.c.post(`/api/admin/refunds/${big.refund.id}/resolve`, { status: 'processed', provider_refund_id: 'rfnd_by_hand_1' })).status).toBe(403); // not by hand either
    const untyped = await owner.c.post(`/api/admin/refunds/${big.refund.id}/approve`, {});
    expect(untyped.status).toBe(422);
    expect(untyped.body.code).toBe('confirm_amount');
    expect((await owner.c.post(`/api/admin/refunds/${big.refund.id}/approve`, { confirm_amount_cents: 1500 })).status).toBe(422);
    expect((await dbOne(`select status::text s from public.refunds where id = $1`, [big.refund.id])).s).toBe('requested'); // nothing moved
    expect([...fake.refunds.values()].filter((r) => r.notes?.washo_refund_id === big.refund.id)).toHaveLength(0);
    expect(expectOk(await owner.c.post(`/api/admin/refunds/${big.refund.id}/approve`, { confirm_amount_cents: 15000 })).body.provider_refund_id).toMatch(/^rfnd_/);
    expect((await dbOne(`select status::text s from public.refunds where id = $1`, [big.refund.id])).s).toBe('processed');
    expectOk(await owner.c.put('/api/admin/settings', { key: 'big_refund_threshold_cents', value: 100000 }));
  });
});

describe('maintenance mode', () => {
  it('pauses new bookings, payments and claims for customers (with the message), lets everything already under way carry on, and ends when switched off', async () => {
    const owner = await as('super_admin');
    const ops = await as('operations');
    const cust = await customerWithVehicle('car');
    const svc = (await dbOne(`select id from public.services where code = 'car-body-wash'`)).id;
    const pay = (c: Client) => c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(6), time_slot: 'morning', address_id: cust.addr.id });

    // a payment that was started before maintenance can still be confirmed
    const started = expectOk(await pay(cust.c)).body.order;

    expect((await ops.c.put('/api/admin/settings', { key: 'maintenance_mode', value: true })).status).toBe(403);
    expectOk(await owner.c.put('/api/admin/settings', { key: 'maintenance_message', value: 'We are back at 6 pm.' }));
    expectOk(await owner.c.put('/api/admin/settings', { key: 'maintenance_mode', value: true }));
    const pub = (await new Client().get('/api/settings')).body;
    expect(pub).toMatchObject({ success: true, maintenance_mode: true, maintenance_message: 'We are back at 6 pm.' });
    const refused = await pay(cust.c);
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ code: 'maintenance', message: 'We are back at 6 pm.' });
    for (const [path, body] of [['/api/payments/membership-checkout', {}], ['/api/campaign/claim', {}]] as const) expect((await cust.c.post(path, body)).status, path).toBe(503);
    // ... but the customer can still look around, confirm the payment they already made, and the crew and admins carry on
    expectOk(await cust.c.get('/api/bookings'));
    expectOk(await cust.c.post('/api/payments/verify', fake.checkout(started.order_id)));
    expectOk(await owner.c.get('/api/admin/bookings'));
    expectOk(await (await staffClient('worker')).c.get('/api/worker/queue'));

    expectOk(await owner.c.put('/api/admin/settings', { key: 'maintenance_mode', value: false }));
    expect((await new Client().get('/api/settings')).body.maintenance_mode).toBe(false);
    expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(7), time_slot: 'morning', address_id: cust.addr.id }));
  });

  it('settings are validated', async () => {
    const owner = await as('super_admin');
    for (const [key, value] of [['maintenance_mode', 'yes'], ['maintenance_mode', 1], ['maintenance_message', 'x'], ['maintenance_message', 'x'.repeat(201)], ['big_refund_threshold_cents', -1], ['big_refund_threshold_cents', 1.5]] as const) {
      expect((await owner.c.put('/api/admin/settings', { key, value })).status, `${key}=${value}`).toBe(422); // the database's own message
    }
    expect((await owner.c.put('/api/admin/settings', { key: 'nope', value: 1 })).status).toBe(400);
    expect((await owner.c.put('/api/admin/settings', { key: 'maintenance_mode', value: null })).status).toBe(400);
    const got = expectOk(await owner.c.get('/api/admin/settings')).body;
    expect(got.settings).toMatchObject({ maintenance_mode: false, big_refund_threshold_cents: 100000 });
    expect(got.security).toMatchObject({ two_step: true, two_step_ready: true, idle_minutes: 30, super_admin_email: 'rajguruyash29@gmail.com' });
  });
});

describe('complaints', () => {
  it('a customer raises one, WASHO is emailed, the support role answers, and the customer sees the thread; nobody else can read it', async () => {
    const a = await customerWithVehicle('car');
    const b = await customerWithVehicle('car');
    const sup = await as('support');
    const ops = await as('operations');

    const made = expectOk(await a.c.post('/api/support', { category: 'specialist', subject: 'Specialist was late', message: 'He came two hours after the slot.' }));
    expect(made.status).toBe(201);
    expect(made.body.ticket.reference_code).toMatch(/^SUP-\d+$/);
    const id = made.body.ticket.id;
    await new Promise((r) => setTimeout(r, 30));
    const mail = sent.find((m) => m.subject.includes(made.body.ticket.reference_code));
    expect(mail?.to).toBe('contact.washo@gmail.com');
    expect(mail?.html).toContain('He came two hours after the slot.');

    expect(expectOk(await b.c.get('/api/support')).body.tickets).toEqual([]);
    expect((await b.c.get(`/api/support/${id}`)).status).toBe(404);
    expect((await b.c.post(`/api/support/${id}/reply`, { message: 'hello' })).status).toBe(404);
    expect((await ops.c.get(`/api/admin/support/${id}`)).status).toBe(403);
    expect((await new Client().get('/api/support')).status).toBe(401);
    expect((await (await staffClient('worker')).c.get('/api/support')).status).toBe(403);

    const list = expectOk(await sup.c.get('/api/admin/support?status=open')).body.tickets;
    expect(list.find((t: any) => t.id === id)).toMatchObject({ subject: 'Specialist was late', category: 'specialist', messages: 1, last_from_admin: false });
    const one = expectOk(await sup.c.get(`/api/admin/support/${id}`)).body;
    expect(one.messages).toHaveLength(1);
    expectOk(await sup.c.post(`/api/admin/support/${id}/reply`, { message: 'Sorry! We have spoken to him.' }));
    const mine = expectOk(await a.c.get(`/api/support/${id}`)).body;
    expect(mine.ticket.status).toBe('in_progress');
    expect(mine.messages.map((m: any) => m.from_admin)).toEqual([false, true]);
    expect(JSON.stringify(mine)).not.toMatch(/customer_phone|author/); // the customer sees "WASHO", not which colleague wrote it
    expectOk(await a.c.post(`/api/support/${id}/reply`, { message: 'Thanks.' }));
    expectOk(await sup.c.post(`/api/admin/support/${id}/status`, { status: 'resolved' }));
    expect(expectOk(await a.c.get('/api/support')).body.tickets[0]).toMatchObject({ status: 'resolved' });
    expectOk(await a.c.post(`/api/support/${id}/reply`, { message: 'Actually it happened again.' }));
    expect(expectOk(await a.c.get(`/api/support/${id}`)).body.ticket.status).toBe('open'); // reopened by the customer
    expectOk(await sup.c.post(`/api/admin/support/${id}/status`, { status: 'closed' }));
    expect((await a.c.post(`/api/support/${id}/reply`, { message: 'hello?' })).status).toBe(422);
    expect((await sup.c.post(`/api/admin/support/${id}/status`, { status: 'weird' })).status).toBe(400);
  });

  it('is validated, and a complaint about a wash must be about the customer\'s own wash', async () => {
    const a = await customerWithVehicle('car');
    const other = await refundRequest();
    expect((await a.c.post('/api/support', { category: 'other', subject: 'ab', message: 'Something is wrong here.' })).status).toBe(400);
    expect((await a.c.post('/api/support', { category: 'nonsense', subject: 'Title here', message: 'Something is wrong here.' })).status).toBe(400);
    expect((await a.c.post('/api/support', { category: 'other', subject: 'Title here', message: 'abc' })).status).toBe(400);
    expect((await a.c.post('/api/support', { category: 'booking', subject: 'Not mine', message: 'Something is wrong here.', booking_id: other.booking.id })).body.message).toMatch(/not yours/);
    const mine = await fake.admin.query(`select 1`); // (a customer's own wash is covered by the database tests)
    expect(mine.rows).toHaveLength(1);
    setMailTransport(async () => { throw new Error('mail down'); });
    expect((await a.c.post('/api/support', { category: 'other', subject: 'Mail is down', message: 'This still gets saved.' })).status).toBe(201); // a mail failure never loses a complaint
  });
});

describe('export', () => {
  it('downloads a CSV: a header row, UTF-8 for Excel, the right file name, never cached, and only for roles with that export', async () => {
    const fin = await as('finance');
    const ops = await as('operations');
    const w = await refundRequest();
    const r = await fin.c.get(`/api/admin/export/payments?from=${istDate(0)}&to=${istDate(0)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/csv; charset=utf-8/);
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="washo-payments-${istDate(0)}-to-${istDate(0)}.csv"`);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const csv = r.body as string; // (fetch's text() drops the byte-order mark, so the raw bytes are read below)
    const raw = new Uint8Array(await (await fetch(`${siteUrl()}/api/admin/export/payments?from=${istDate(0)}&to=${istDate(0)}`, { headers: { cookie: fin.c.cookieHeader() } })).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, so Excel reads names in any language
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Paid on (IST),Amount (Rs),For,Status,Razorpay payment,Razorpay order,Customer,Fulfilment');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.includes(',150,'))).toBe(true);
    expect(csv).not.toMatch(/\+91|@example\.com/); // money exports carry no contact details

    expect((await ops.c.get('/api/admin/export/payments')).status).toBe(403);
    expect((await fin.c.get('/api/admin/export/customers')).status).toBe(403);
    expect((await fin.c.get('/api/admin/export/everything')).status).toBe(403); // an export that does not exist is closed, not open
    expect((await (await as('super_admin')).c.get('/api/admin/export/everything')).status).toBe(403); // not even the owner: only the seven real kinds exist
    expect((await ops.c.get('/api/admin/export/customers?from=2026-02-01&to=2026-01-01')).status).toBe(422);
    expect((await new Client().get('/api/admin/export/payments')).status).toBe(401);
    expect((await w.cust.c.get('/api/admin/export/payments')).status).toBe(403);
    // a bad date is ignored (all dates), not an error page
    expect((await fin.c.get('/api/admin/export/payments?from=yesterday')).status).toBe(200);
  });

  it('keeps a customer\'s name from running as a spreadsheet formula, quotes commas, and is recorded in the activity log', async () => {
    const ops = await as('operations');
    const owner = await as('super_admin');
    const a = await customerWithVehicle('car');
    await fake.admin.query(`update public.profiles set full_name = $1 where id = (select id from public.profiles where phone = $2)`, ['=HYPERLINK("http://evil.test","click")', `+91${a.phone}`]);
    const b = await customerWithVehicle('car');
    await fake.admin.query(`update public.profiles set full_name = $1 where phone = $2`, ['Joshi, Ravi "RJ"', `+91${b.phone}`]);
    const csv = (await ops.c.get('/api/admin/export/customers')).body as string;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain('"Joshi, Ravi ""RJ"""');
    expect(csv).toContain(`+91${a.phone}`); // the customers export is the one that carries contact details
    const log = expectOk(await owner.c.get('/api/admin/activity?q=data_exported')).body.events;
    expect(log[0]).toMatchObject({ event_type: 'data_exported', metadata: { kind: 'customers', truncated: false } });
    expect(log[0].metadata.rows).toBeGreaterThan(1);
  });

  it('every kind a role may export works', async () => {
    const owner = await as('super_admin');
    for (const kind of ['customers', 'washes', 'memberships', 'payments', 'refunds', 'support', 'activity']) {
      const r = await owner.c.get(`/api/admin/export/${kind}`);
      expect(r.status, kind).toBe(200);
      expect((r.body as string).split('\r\n')[0].length, kind).toBeGreaterThan(10);
    }
  });
});

describe('strong passwords for the people who can see other people\'s data', () => {
  it('a specialist\'s password follows the strong rule when it is created or reset', async () => {
    const owner = await as('super_admin');
    const base = { full_name: 'Sunil More', email: `crew-${crypto.randomBytes(3).toString('hex')}@example.com`, phone: '9876500199' };
    expect((await owner.c.post('/api/admin/workers', { ...base, password: 'longenough1' })).status).toBe(400);
    expect((await owner.c.post('/api/admin/workers', { ...base, password: 'Washo-Crew-2026-x' })).status).toBe(400);
    const made = expectOk(await owner.c.post('/api/admin/workers', { ...base, password: 'Long-enough-pass-1' })).body.worker;
    expect((await owner.c.post(`/api/admin/workers/${made.id}/reset-password`, { password: 'weak' })).status).toBe(400);
  });
});
