/**
 * The Admin page's create / edit / archive: customers (with vehicles and addresses), specialists, washes, services, prices and
 * discounts. Supabase is a local stand-in; the database rules are real. "Delete" is always archive.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE } from './fakeSupabase';
import { Client, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, randomPhone, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];
const uniq = () => Math.random().toString(36).slice(2, 8);

describe('only admins', () => {
  it('everything under /admin/* management is closed to customers, specialists and signed-out visitors', async () => {
    const cust = await customerWithVehicle('car');
    const worker = await staffClient('worker');
    const calls: [string, string, unknown?][] = [
      ['get', '/api/admin/customers'], ['post', '/api/admin/customers', {}], ['get', '/api/admin/workers'], ['get', '/api/admin/services'],
      ['get', '/api/admin/pricing'], ['post', '/api/admin/bookings', {}], ['put', '/api/admin/discounts', {}], ['put', '/api/admin/pricing-settings', {}],
    ];
    for (const [m, path, body] of calls) {
      expect((await (cust.c as any)[m](path, body)).status, `customer ${path}`).toBe(403);
      expect((await (worker.c as any)[m](path, body)).status, `worker ${path}`).toBe(403);
      expect((await (new Client() as any)[m](path, body)).status, `anonymous ${path}`).toBe(401);
    }
  });
});

describe('customers', () => {
  it('registers a customer by phone: the number is waiting for them, unverified, and a duplicate is refused', async () => {
    const admin = await staffClient('admin');
    const phone = randomPhone();
    const created = expectOk(await admin.c.post('/api/admin/customers', { full_name: 'Kavya Rao', phone, email: 'Kavya@Example.com' })).body.customer;
    expect(created).toMatchObject({ full_name: 'Kavya Rao', phone: `+91${phone}` });
    expect(await dbOne('select full_name, email, phone, role::text role from public.profiles where id = $1', [created.id])).toMatchObject({ full_name: 'Kavya Rao', email: 'kavya@example.com', role: 'customer' });
    expect((await dbOne('select phone_confirmed_at from auth.users u join public.profiles p on p.auth_user_id = u.id where p.id = $1', [created.id])).phone_confirmed_at).toBeNull();

    const dup = await admin.c.post('/api/admin/customers', { full_name: 'Someone Else', phone });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('phone_taken');
    expect((await admin.c.post('/api/admin/customers', { full_name: 'X', phone: '12345' })).status).toBe(400);

    // they sign in the normal way with that number and find their own record
    const c = new Client();
    expectOk(await c.post('/api/auth/otp/request', { phone }));
    expectOk(await c.post('/api/auth/otp/verify', { phone, code: FAKE.otpCode }));
    expect(expectOk(await c.get('/api/me')).body.user).toMatchObject({ id: created.id, full_name: 'Kavya Rao', needs_profile: false });
  });

  it('lists, searches and shows a customer with their vehicles, addresses and washes; edits name and email but never the phone', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;
    const list = expectOk(await admin.c.get(`/api/admin/customers?q=${encodeURIComponent('Asha')}`)).body.customers;
    expect(list.find((x: any) => x.id === me.id)).toMatchObject({ archived: false, vehicles: 1 });

    const detail = expectOk(await admin.c.get(`/api/admin/customers/${me.id}`)).body;
    expect(detail.customer).toMatchObject({ id: me.id, archived: false });
    expect(detail.vehicles).toHaveLength(1);
    expect(detail.addresses).toHaveLength(1);

    expectOk(await admin.c.put(`/api/admin/customers/${me.id}`, { full_name: 'Asha K. Kulkarni', email: 'asha.k@example.com', phone: '9999999999' }));
    expect(await dbOne('select full_name, email, phone from public.profiles where id = $1', [me.id])).toEqual({ full_name: 'Asha K. Kulkarni', email: 'asha.k@example.com', phone: me.phone }); // phone untouched
    expect((await admin.c.put(`/api/admin/customers/${me.id}`, { full_name: 'A' })).status).toBe(400);
    expect((await admin.c.get(`/api/admin/customers/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('archives a customer: hidden from the list, signed out, locked at Supabase, and restorable; a customer with a scheduled wash cannot be archived', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;

    // a scheduled wash blocks it, with a message that says why
    const svc = (await dbOne(`select id from public.services where code = 'car-body-wash'`)).id;
    const order = expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(3), time_slot: 'morning', address_id: cust.addr.id })).body.order;
    expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id)));
    const blocked = await admin.c.post(`/api/admin/customers/${me.id}/archive`, { archived: true });
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toMatch(/1 scheduled wash/);
    const booking = expectOk(await cust.c.get('/api/bookings')).body.bookings[0];
    expectOk(await admin.c.post(`/api/admin/bookings/${booking.id}/cancel`, { reason: 'Customer moved away' }));

    const done = expectOk(await admin.c.post(`/api/admin/customers/${me.id}/archive`, { archived: true, reason: 'Moved away' }));
    expect(done.body).toMatchObject({ archived: true, login_locked: true });
    expect(fake.isBanned((await dbOne('select auth_user_id from public.profiles where id = $1', [me.id])).auth_user_id)).toBe(true);
    expect(expectOk(await admin.c.get('/api/admin/customers')).body.customers.find((x: any) => x.id === me.id)).toBeUndefined();
    expect(expectOk(await admin.c.get('/api/admin/customers?status=archived')).body.customers.find((x: any) => x.id === me.id)).toMatchObject({ archived: true });

    // their open session stops working at once, and cannot be used again
    const gone = await cust.c.get('/api/me');
    expect(gone.status).toBe(403);
    expect(gone.body.code).toBe('account_archived');
    const fresh = new Client();
    await fresh.post('/api/auth/otp/request', { phone: me.phone.replace('+91', '') });
    const again = await fresh.post('/api/auth/otp/verify', { phone: me.phone.replace('+91', ''), code: FAKE.otpCode });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('account_archived');

    // restored: the same person signs in again, with everything as they left it
    expectOk(await admin.c.post(`/api/admin/customers/${me.id}/archive`, { archived: false }));
    const back = new Client();
    expectOk(await back.post('/api/auth/otp/request', { phone: me.phone.replace('+91', '') }));
    expectOk(await back.post('/api/auth/otp/verify', { phone: me.phone.replace('+91', ''), code: FAKE.otpCode }));
    expect(expectOk(await back.get('/api/vehicles')).body.vehicles).toHaveLength(1);
  });

  it("manages a customer's vehicles and addresses; the customer sees the changes, and archived ones disappear for them", async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;

    const vid = expectOk(await admin.c.post(`/api/admin/customers/${me.id}/vehicles`, { vehicle_type: 'bike', model: 'Activa', registration_number: 'mh12 zz 4321', color: 'Red' })).body.vehicle_id;
    expectOk(await admin.c.put(`/api/admin/vehicles/${vid}`, { vehicle_type: 'bike', model: 'Activa 6G', registration_number: 'MH12ZZ4321', color: 'Grey' }));
    expect((await admin.c.post(`/api/admin/customers/${me.id}/vehicles`, { vehicle_type: 'car', model: 'Swift', registration_number: 'MH12ZZ4321' })).body.message).toMatch(/already has a vehicle with that registration/);
    expect(expectOk(await cust.c.get('/api/vehicles')).body.vehicles.map((v: any) => v.model).sort()).toEqual(['Activa 6G', 'Creta']);
    expectOk(await admin.c.post(`/api/admin/vehicles/${vid}/active`, { active: false }));
    expect(expectOk(await cust.c.get('/api/vehicles')).body.vehicles.map((v: any) => v.model)).toEqual(['Creta']);

    const aid = expectOk(await admin.c.post(`/api/admin/customers/${me.id}/addresses`, { label: 'Office', society_name: 'Eon Free Zone', building_block: 'A', flat_number: 'A-1', parking_location: 'Gate 2' })).body.address_id;
    expectOk(await admin.c.put(`/api/admin/addresses/${aid}`, { label: 'Office', society_name: 'Eon Free Zone', building_block: 'A', flat_number: 'A-2', parking_location: 'Gate 3', is_default: true }));
    const mine = expectOk(await cust.c.get('/api/addresses')).body.addresses;
    expect(mine).toHaveLength(2);
    expect(mine.find((a: any) => a.id === aid)).toMatchObject({ flat_number: 'A-2', is_default: true });
    expectOk(await admin.c.post(`/api/admin/addresses/${aid}/archived`, { archived: true }));
    expect(expectOk(await cust.c.get('/api/addresses')).body.addresses).toHaveLength(1);
    const detail = expectOk(await admin.c.get(`/api/admin/customers/${me.id}`)).body;
    expect(detail.addresses.find((a: any) => a.id === aid)).toMatchObject({ archived: true });
    expect((await admin.c.post(`/api/admin/customers/${me.id}/addresses`, { society_name: 'X', building_block: 'A', flat_number: '1', parking_location: 'P', pincode: '41' })).status).toBe(400);
  });
});

describe('specialists', () => {
  it('lists active ones, archives one (returning their washes to the pool, locking the login) and restores them', async () => {
    const admin = await staffClient('admin');
    const worker = await staffClient('worker', { name: `Ravi ${uniq()}` });
    const m = await activeMembership();
    expectOk(await admin.c.post(`/api/admin/memberships/${m.membershipId}/assign-worker`, { worker_profile_id: worker.profileId }));
    const queue = () => worker.c.get('/api/worker/queue');
    expect((await dbOne('select assigned_worker_profile_id w from public.memberships where id = $1', [m.membershipId])).w).toBe(worker.profileId);

    const listed = expectOk(await admin.c.get('/api/admin/workers')).body.workers.find((w: any) => w.id === worker.profileId);
    expect(listed).toMatchObject({ archived: false, memberships: 1 });

    const res = expectOk(await admin.c.post(`/api/admin/workers/${worker.profileId}/archive`, { archived: true, reason: 'Left' }));
    expect(res.body).toMatchObject({ archived: true, released_memberships: 1, login_locked: true });
    expect((await dbOne('select assigned_worker_profile_id w from public.memberships where id = $1', [m.membershipId])).w).toBeNull();
    expect(expectOk(await admin.c.get('/api/admin/workers')).body.workers.find((w: any) => w.id === worker.profileId)).toBeUndefined();
    expect(expectOk(await admin.c.get('/api/admin/workers?status=archived')).body.workers.find((w: any) => w.id === worker.profileId)).toMatchObject({ archived: true });
    // their session is over, and they cannot be given work
    const closed = await queue();
    expect(closed.status).toBe(403);
    expect(closed.body.code).toBe('account_archived');
    const reassign = await admin.c.post(`/api/admin/memberships/${m.membershipId}/assign-worker`, { worker_profile_id: worker.profileId });
    expect(reassign.status).toBe(422);
    expect(reassign.body.message).toMatch(/archived/);
    expect((await new Client().post('/api/auth/email/login', { email: worker.email, password: worker.password })).status).toBe(403);

    expectOk(await admin.c.post(`/api/admin/workers/${worker.profileId}/archive`, { archived: false }));
    const back = new Client();
    expectOk(await back.loginStaff(worker.email, worker.password));
    expectOk(await admin.c.post(`/api/admin/memberships/${m.membershipId}/assign-worker`, { worker_profile_id: worker.profileId }));
  });

  it('sets a new password for a specialist; the old one stops working', async () => {
    const admin = await staffClient('admin');
    const worker = await staffClient('worker');
    expect((await admin.c.post(`/api/admin/workers/${worker.profileId}/reset-password`, { password: 'short' })).status).toBe(400);
    expectOk(await admin.c.post(`/api/admin/workers/${worker.profileId}/reset-password`, { password: 'Brand-new-pass-9' }));
    expect((await new Client().loginStaff(worker.email, worker.password)).status).toBe(401);
    expectOk(await new Client().loginStaff(worker.email, 'Brand-new-pass-9'));
    // only a specialist
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;
    expect((await admin.c.post(`/api/admin/workers/${me.id}/reset-password`, { password: 'Brand-new-pass-9' })).status).toBe(404);
  });
});

describe('washes booked by WASHO', () => {
  it('books a paid-in-cash wash for a customer, who sees it; edits its details; a complimentary one costs nothing', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;
    const svc = (await dbOne(`select id from public.services where code = 'car-body-wash'`)).id;

    const made = expectOk(await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(3), time_slot: 'morning', payment: 'cash', note: 'Ring twice' }));
    expect(made.body.price_cents).toBe(15000);
    const mine = expectOk(await cust.c.get('/api/bookings')).body.bookings;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'confirmed', price_cents: 15000 });
    expect((await dbOne('select source from public.bookings where id = $1', [made.body.booking_id])).source).toBe('admin');
    // it shows in the admin's list for that day
    expect(expectOk(await admin.c.get(`/api/admin/bookings?from=${istDate(3)}&to=${istDate(3)}`)).body.bookings.find((b: any) => b.id === made.body.booking_id)).toBeTruthy();

    expectOk(await admin.c.put(`/api/admin/bookings/${made.body.booking_id}`, { parking_location: 'Gate 2, level 1', note: 'Call first' }));
    const detail = expectOk(await admin.c.get(`/api/admin/bookings/${made.body.booking_id}`)).body.booking;
    expect(detail).toMatchObject({ parking_location: 'Gate 2, level 1', notes: 'Call first', source: 'admin' });

    // the same vehicle on the same day is refused; a complimentary wash on another day is free
    expect((await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(3), time_slot: 'night', payment: 'free' })).body.message).toMatch(/already has a wash booked that day/);
    const free = expectOk(await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(5), time_slot: 'night', payment: 'free' }));
    expect(free.body.price_cents).toBe(0);

    // validation
    expect((await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(7), time_slot: 'night', payment: 'credit' })).status).toBe(400);
    expect((await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(-1), time_slot: 'night', payment: 'free' })).body.message).toMatch(/today or a later date/);
  });
});

describe('services, prices and discounts', () => {
  it('adds a service that customers can then see and book; a price change is what the next customer pays; retiring hides it', async () => {
    const admin = await staffClient('admin');
    const code = `ceramic-${uniq()}`;
    const sid = expectOk(await admin.c.post('/api/admin/services', { code, name: 'Ceramic Boost', vehicle_type: 'car', description: 'A protective coat', tagline: 'Shine that lasts', duration_minutes: 60, includes: ['Foam wash', 'Ceramic spray'], sort_order: 40 })).body.service_id;
    expect((await admin.c.post('/api/admin/services', { code, name: 'Again', vehicle_type: 'car' })).body.message).toMatch(/already exists/);

    // not bookable until it has a price
    const cust = await customerWithVehicle('car');
    const book = () => cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: sid, scheduled_date: istDate(3), time_slot: 'morning', address_id: cust.addr.id });
    expect((await book()).body.message).toMatch(/No price is set/);
    expectOk(await admin.c.put(`/api/admin/services/${sid}/price`, { vehicle_type: 'car', price_cents: 45000 }));
    const catalog = expectOk(await new Client().get('/api/catalog')).body.services;
    expect(catalog.find((s: any) => s.code === code)).toMatchObject({ name: 'Ceramic Boost', includes: ['Foam wash', 'Ceramic spray'], unit_prices: [{ vehicle_type: 'car', price_cents: 45000 }] });
    expect(expectOk(await book()).body.order.amount).toBe(45000);

    // a new price starts now; the old rule is kept
    expectOk(await admin.c.put(`/api/admin/services/${sid}`, { name: 'Ceramic Boost Plus', description: 'Longer lasting', tagline: 'Shine', duration_minutes: 75, includes: ['Foam wash'], sort_order: 41 }));
    const list = expectOk(await admin.c.get('/api/admin/services')).body.services.find((s: any) => s.id === sid);
    expect(list).toMatchObject({ name: 'Ceramic Boost Plus', is_active: true, used_by_memberships: false, prices: [{ vehicle_type: 'car', price_cents: 45000 }] });
    expect((await admin.c.put(`/api/admin/services/${sid}/price`, { vehicle_type: 'car', price_cents: 50 })).status).toBe(400);
    expect((await admin.c.put(`/api/admin/services/${sid}/price`, { vehicle_type: 'bike', price_cents: 5000 })).body.message).toMatch(/not offered for that vehicle type/);

    // retire: gone from the customer catalogue, restorable
    expectOk(await admin.c.post(`/api/admin/services/${sid}/active`, { active: false }));
    expect(expectOk(await new Client().get('/api/catalog')).body.services.find((s: any) => s.code === code)).toBeUndefined();
    expectOk(await admin.c.post(`/api/admin/services/${sid}/active`, { active: true }));
    expect(expectOk(await new Client().get('/api/catalog')).body.services.find((s: any) => s.code === code)).toBeTruthy();

    // what memberships are built from cannot be retired
    const carBody = expectOk(await admin.c.get('/api/admin/services')).body.services.find((s: any) => s.code === 'car-body-wash');
    expect(carBody.used_by_memberships).toBe(true);
    expect((await admin.c.post(`/api/admin/services/${carBody.id}/active`, { active: false })).body.message).toMatch(/memberships are built from/);
  });

  it('changing a discount or the cap changes the membership estimate; removing a discount removes it; settings are validated', async () => {
    const admin = await staffClient('admin');
    const plan = { vehicle_type: 'car', weekly_pattern: [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }], duration_months: 1 };
    const estimate = async () => expectOk(await new Client().post('/api/membership-estimate', plan)).body.estimate.final_cents as number;
    const before = await estimate();
    expect(before).toBe(187200);

    const pricing = expectOk(await admin.c.get('/api/admin/pricing')).body;
    expect(pricing.discounts.find((d: any) => d.kind === 'frequency' && d.key === 3)).toMatchObject({ discount_bp: 1000 });
    expect(pricing.settings.find((s: any) => s.key === 'max_total_discount_bp')).toMatchObject({ value: 1500 });

    try {
      expectOk(await admin.c.put('/api/admin/discounts', { kind: 'frequency', key: 3, discount_bp: 500, label: '3 a week' }));
      expect(await estimate()).toBe(197600); // 5% off 2080
      expectOk(await admin.c.post('/api/admin/discounts/remove', { kind: 'frequency', key: 3 }));
      expect(await estimate()).toBe(208000);
      expect((await admin.c.post('/api/admin/discounts/remove', { kind: 'frequency', key: 3 })).status).toBe(404);
      expect((await admin.c.put('/api/admin/discounts', { kind: 'frequency', key: 3, discount_bp: 9000, label: 'Free' })).status).toBe(400);
      expect((await admin.c.put('/api/admin/discounts', { kind: 'duration', key: 2, discount_bp: 500, label: 'Two months' })).body.message).toMatch(/1, 3, 6 or 12/);
      expect((await admin.c.put('/api/admin/pricing-settings', { key: 'max_total_discount_bp', value: 9000 })).body.message).toMatch(/not allowed/);
      expect((await admin.c.put('/api/admin/pricing-settings', { key: 'drop_table', value: 1 })).body.message).toMatch(/not allowed/);
    } finally {
      // leave the shared test database as it was
      expectOk(await admin.c.put('/api/admin/discounts', { kind: 'frequency', key: 3, discount_bp: 1000, label: '3 washes a week' }));
    }
    expect(await estimate()).toBe(187200);
  });
});

describe('history of washes', () => {
  /** Three washes for one vehicle: yesterday (done), three days ago (cancelled), 60 days ago (done). */
  async function history() {
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;
    const svc = (await dbOne(`select id from public.services where code = 'car-body-wash'`)).id;
    const at = async (daysAgo: number, status: string, cents: number) =>
      (
        await dbOne(
          `insert into public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status, source, price_cents, address_id)
           values ($1, $2, $3, 'on_demand', (now() at time zone 'Asia/Kolkata')::date - $4::int, 'morning', $5, 'website', $6, $7) returning id, reference_code`,
          [me.id, cust.vehicle.id, svc, daysAgo, status, cents, cust.addr.id]
        )
      ).id as string;
    const done = await at(1, 'completed', 15000);
    const cancelled = await at(3, 'cancelled', 15000);
    const old = await at(60, 'completed', 15000);
    return { cust, me, done, cancelled, old };
  }

  it('lists past washes newest first (last 30 days by default) with totals for the same filter', async () => {
    const admin = await staffClient('admin');
    const h = await history();
    const out = expectOk(await admin.c.get(`/api/admin/history?q=${encodeURIComponent(h.cust.reg)}`)).body;
    expect(out.bookings.map((b: any) => b.id)).toEqual([h.done, h.cancelled]);
    expect(out.bookings[0]).toMatchObject({ status: 'completed', customer_name: 'Asha Kulkarni', service_name: 'Car Body Wash', price_cents: 15000, registration_number: h.cust.reg });
    expect(out.summary).toEqual({ total: 2, completed: 1, cancelled: 1, single_wash_cents: 15000 });

    // widen the range to reach the old one
    const from = istDate(-90);
    const wide = expectOk(await admin.c.get(`/api/admin/history?from=${from}&to=${istDate(0)}&q=${encodeURIComponent(h.cust.reg)}`)).body;
    expect(wide.bookings.map((b: any) => b.id)).toEqual([h.done, h.cancelled, h.old]);
    expect(wide.summary).toMatchObject({ total: 3, completed: 2, cancelled: 1, single_wash_cents: 30000 });
  });

  it('filters by status, by specialist and by search, and pages through the results', async () => {
    const admin = await staffClient('admin');
    const worker = await staffClient('worker');
    const h = await history();
    const base = `from=${istDate(-90)}&to=${istDate(0)}&q=${encodeURIComponent(h.cust.reg)}`;
    expect(expectOk(await admin.c.get(`/api/admin/history?${base}&status=completed`)).body.bookings.map((b: any) => b.id)).toEqual([h.done, h.old]);
    expect(expectOk(await admin.c.get(`/api/admin/history?${base}&status=cancelled`)).body.summary.total).toBe(1);

    await dbOne(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1, $2)`, [h.done, worker.profileId]);
    const mine = expectOk(await admin.c.get(`/api/admin/history?${base}&worker=${worker.profileId}`)).body;
    expect(mine.bookings.map((b: any) => b.id)).toEqual([h.done]);
    expect(mine.bookings[0].worker_name).toBeTruthy();

    // search by customer name, phone, reference code
    const ref = (await dbOne('select reference_code from public.bookings where id = $1', [h.cancelled])).reference_code;
    expect(expectOk(await admin.c.get(`/api/admin/history?${base.replace(/&q=.*/, '')}&q=${ref}`)).body.bookings.map((b: any) => b.id)).toEqual([h.cancelled]);
    expect(expectOk(await admin.c.get(`/api/admin/history?${base.replace(/&q=.*/, '')}&q=nobody-by-this-name`)).body.bookings).toEqual([]);

    // paging: one at a time, and the total stays the whole count
    const p1 = expectOk(await admin.c.get(`/api/admin/history?${base}&limit=1&offset=0`)).body;
    const p2 = expectOk(await admin.c.get(`/api/admin/history?${base}&limit=1&offset=1`)).body;
    expect(p1.bookings.map((b: any) => b.id)).toEqual([h.done]);
    expect(p2.bookings.map((b: any) => b.id)).toEqual([h.cancelled]);
    expect(p1.summary.total).toBe(3);
  });

  it('is for admins only', async () => {
    const cust = await customerWithVehicle('car');
    const worker = await staffClient('worker');
    expect((await cust.c.get('/api/admin/history')).status).toBe(403);
    expect((await worker.c.get('/api/admin/history')).status).toBe(403);
    expect((await new Client().get('/api/admin/history')).status).toBe(401);
  });
});

