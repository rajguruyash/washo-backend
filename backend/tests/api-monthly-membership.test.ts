/**
 * A membership chosen as washes in a MONTH (at least 4, any mix of Body and Deep), over HTTP: the estimate, where the washes land, paying, and everything that then
 * shows the plan. Razorpay is a local stand-in; the database rules are real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const monthly = (body: number, deep: number, weekdays: number[] = [1, 4]) => ({ body, deep, weekdays });
const checkout = (c: Client, v: { vehicle: { id: string }; addr: { id: string } }, m: ReturnType<typeof monthly>, o: Record<string, unknown> = {}) =>
  c.post('/api/payments/membership-checkout', { vehicle_id: v.vehicle.id, address_id: v.addr.id, monthly: m, duration_months: 1, time_slot: 'morning', start_date: istDate(4), ...o });

describe('the estimate', () => {
  it('anyone gets the rate-card price of a monthly plan, the same as the equivalent weekly plan; at least 4 and at most 28 a month, in plain words', async () => {
    const anon = new Client();
    const est = (body: unknown) => anon.post('/api/membership-estimate', body);
    const m = expectOk(await est({ vehicle_type: 'car', monthly: { body: 4, deep: 0 }, duration_months: 1 })).body.estimate;
    const w = expectOk(await est({ vehicle_type: 'car', weekly_pattern: [{ weekday: 1, kind: 'body' }], duration_months: 1 })).body.estimate;
    expect(m.final_cents).toBe(60000);
    expect(m.final_cents).toBe(w.final_cents);
    expect(m).toMatchObject({ washes_per_month: 4, washes_total: 4, monthly: { body: 4, deep: 0 } });
    const mix = expectOk(await est({ vehicle_type: 'car', monthly: { body: 2, deep: 3 }, duration_months: 3 })).body.estimate;
    expect(mix).toMatchObject({ washes_per_month: 5, washes_total: 15, subtotal_cents: 288000 });
    expect(mix.frequency_discount.label).toBe('5 washes a month');

    const few = await est({ vehicle_type: 'car', monthly: { body: 2, deep: 1 }, duration_months: 1 });
    expect(few.status).toBe(422);
    expect(few.body.message).toBe('Choose at least 4 washes a month (you chose 3)');
    expect((await est({ vehicle_type: 'car', monthly: { body: 20, deep: 9 }, duration_months: 1 })).body.message).toMatch(/at most 28 washes a month/);
    expect((await est({ vehicle_type: 'bike', monthly: { body: 2, deep: 2 }, duration_months: 1 })).body.message).toMatch(/Bikes have one wash type/);
    expect((await est({ vehicle_type: 'car', monthly: { body: 4, deep: 0 }, duration_months: 2 })).status).toBe(400);
    // exactly one way of choosing
    expect((await est({ vehicle_type: 'car', duration_months: 1 })).status).toBe(400);
    expect((await est({ vehicle_type: 'car', monthly: { body: 4, deep: 0 }, weekly_pattern: [{ weekday: 1, kind: 'body' }], duration_months: 1 })).status).toBe(400);
    expect((await est({ vehicle_type: 'car', monthly: { body: -1, deep: 5 }, duration_months: 1 })).status).toBe(400);
    expect((await est({ vehicle_type: 'car', monthly: { body: 4.5, deep: 0 }, duration_months: 1 })).status).toBe(400);
  });
});

describe('where the washes land', () => {
  it('shows the dates, kinds and how busy each day is; says when they do not fit; refuses a visitor', async () => {
    const cust = await customerWithVehicle('car');
    const body = { vehicle_id: cust.vehicle.id, monthly: monthly(2, 2, [1, 4]), duration_months: 1, time_slot: 'morning', start_date: istDate(4) };
    const r = expectOk(await cust.c.post('/api/membership-preview', body)).body;
    expect(r).toMatchObject({ total: 4, fits: true });
    expect(r.dates).toHaveLength(4);
    expect(r.dates.filter((d: any) => d.kind === 'deep')).toHaveLength(2);
    expect(r.dates.every((d: any) => ['ok', 'busy', 'full'].includes(d.state))).toBe(true);
    const tight = expectOk(await cust.c.post('/api/membership-preview', { ...body, monthly: monthly(12, 0, [3]) })).body;
    expect(tight.fits).toBe(false);
    expect((await cust.c.post('/api/membership-preview', { ...body, monthly: monthly(1, 1, [1]) })).body.message).toMatch(/at least 4 washes a month/);
    expect((await new Client().post('/api/membership-preview', body)).status).toBe(401);
    // the weekly preview still works the way it did
    expectOk(await cust.c.post('/api/membership-preview', { vehicle_id: cust.vehicle.id, weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4) }));
  });
});

describe('paying for it', () => {
  it('the order is exactly the estimate; after the verified payment the membership holds every wash, and every screen says "washes a month"', async () => {
    const cust = await customerWithVehicle('car');
    const want = expectOk(await new Client().post('/api/membership-estimate', { vehicle_type: 'car', monthly: { body: 3, deep: 2 }, duration_months: 3 })).body.estimate;
    const order = expectOk(await checkout(cust.c, cust, monthly(3, 2, [1, 3, 5]), { duration_months: 3 })).body.order;
    expect(order.amount).toBe(want.final_cents);
    const paid = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    expect(paid.membership_id).toBeTruthy();

    const list = expectOk(await cust.c.get('/api/memberships')).body.memberships;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ washes_per_month: 5, monthly_body: 3, monthly_deep: 2, preferred_weekdays: [1, 3, 5], duration_months: 3, washes_total: 15, final_amount_cents: want.final_cents });
    const one = expectOk(await cust.c.get(`/api/memberships/${paid.membership_id}`)).body;
    expect(one.washes).toHaveLength(15);
    expect(one.washes.filter((w: any) => w.wash_kind === 'deep')).toHaveLength(6);
    expect(one.washes.every((w: any) => w.status === 'confirmed')).toBe(true);
    expect(one.washes.every((w: any) => [1, 3, 5].includes(new Date(`${w.scheduled_date}T00:00:00Z`).getUTCDay()))).toBe(true);

    const reqs = expectOk(await cust.c.get('/api/membership-requests')).body.requests;
    expect(reqs[0]).toMatchObject({ status: 'active', washes_per_month: 5, monthly_body: 3, monthly_deep: 2 });

    // WASHO sees the same
    const admin = await staffClient('admin');
    const mem = expectOk(await admin.c.get('/api/admin/memberships')).body.memberships.find((m: any) => m.id === paid.membership_id);
    expect(mem).toMatchObject({ washes_per_month: 5, monthly_body: 3, monthly_deep: 2, preferred_weekdays: [1, 3, 5], washes_total: 15 });
  });

  it('the specialist\'s queue labels the plan a month, not a week', async () => {
    const cust = await customerWithVehicle('car');
    const order = expectOk(await checkout(cust.c, cust, monthly(4, 1, [2, 5]), { duration_months: 3 })).body.order;
    const paid = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    const admin = await staffClient('admin');
    const worker = await staffClient('worker');
    const first = expectOk(await cust.c.get(`/api/memberships/${paid.membership_id}`)).body.washes[0];
    expectOk(await admin.c.post(`/api/admin/bookings/${first.id}/assign`, { worker_profile_id: worker.profileId }));
    const row = expectOk(await worker.c.get('/api/worker/queue?days=60')).body.queue.find((w: any) => w.booking_id === first.id);
    expect(row.membership_label).toBe('5 washes a month · 3 months');
    expect(row.washes_total).toBe(15);
  });

  it('refuses in plain words: too few washes, too few days for that many, and a mobile number is still needed to pay', async () => {
    const cust = await customerWithVehicle('car');
    const few = await checkout(cust.c, cust, monthly(2, 1, [1, 3]));
    expect(few.status).toBe(422);
    expect(few.body.message).toMatch(/Choose at least 4 washes a month/);
    const days = await checkout(cust.c, cust, monthly(5, 0, [1]));
    expect(days.status).toBe(422);
    expect(days.body.message).toMatch(/Pick at least 2 days of the week so your 5 washes a month fit/);
    expect((await checkout(cust.c, cust, monthly(4, 0, [7]))).status).toBe(400);
    expect((await checkout(cust.c, cust, { body: 4, deep: 0, weekdays: [1], extra: 1 } as never, { monthly: undefined })).status).toBe(400);
    // exactly one of the two ways
    expect((await cust.c.post('/api/payments/membership-checkout', { vehicle_id: cust.vehicle.id, duration_months: 1, time_slot: 'morning', start_date: istDate(4) })).status).toBe(400);
    // email sign-up customers still need a number
    const email = `m-${Date.now()}@example.com`;
    const e = new Client();
    expect((await e.post('/api/auth/email/signup', { email, password: 'Sunny-day-42' })).status).toBe(201);
    expectOk(await e.put('/api/me', { full_name: 'Mona Rao', email }));
    const addr = expectOk(await e.post('/api/addresses', { society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: 'B-909', parking_location: 'P1' })).body.address;
    const vehicle = expectOk(await e.post('/api/vehicles', { vehicle_type: 'car', make: 'Hyundai', model: 'Creta', registration_number: `MH12ZZ${1000 + Math.floor(Math.random() * 8000)}`, color: 'White', address_id: addr.id })).body.vehicle;
    const needPhone = await checkout(e, { vehicle, addr }, monthly(4, 0, [1]));
    expect(needPhone.status).toBe(409);
    expect(needPhone.body.code).toBe('phone_required');
  });

  it('exact dates: the counts must be exactly the month times the months, and they are used as given', async () => {
    const cust = await customerWithVehicle('car');
    const shown = expectOk(await cust.c.post('/api/membership-preview', { vehicle_id: cust.vehicle.id, monthly: monthly(2, 2, [0, 1, 2, 3, 4, 5, 6]), duration_months: 3, time_slot: 'morning', start_date: istDate(4) })).body;
    const dates = shown.dates.map((d: any) => ({ date: d.date, kind: d.kind }));
    expect(dates).toHaveLength(12);
    const wrong = await checkout(cust.c, cust, monthly(2, 2, []), { duration_months: 3, custom_dates: dates.slice(0, 11) });
    expect(wrong.status).toBe(422);
    expect(wrong.body.message).toMatch(/Choose exactly 6 Body washes and 6 Deep cleans/);
    const order = expectOk(await checkout(cust.c, cust, monthly(2, 2, []), { duration_months: 3, custom_dates: dates })).body.order;
    const paid = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    const washes = expectOk(await cust.c.get(`/api/memberships/${paid.membership_id}`)).body.washes;
    expect(washes.map((w: any) => w.scheduled_date)).toEqual(dates.map((d: any) => d.date));
  });

  it('weekly plans keep working exactly as before', async () => {
    const cust = await customerWithVehicle('car');
    const order = expectOk(await cust.c.post('/api/payments/membership-checkout', { vehicle_id: cust.vehicle.id, address_id: cust.addr.id, weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4) })).body.order;
    expect(order.amount).toBe(Math.round((8 * 15000 + 4 * 22000) * 0.9));
    const paid = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    const m = expectOk(await cust.c.get('/api/memberships')).body.memberships.find((x: any) => x.id === paid.membership_id);
    expect(m).toMatchObject({ frequency_per_week: 3, washes_per_month: null, monthly_body: null, washes_total: 12 });
  });
});

describe('the renewal email', () => {
  it('says washes a month for a monthly plan and per week for an older one', async () => {
    const { renewalEmail } = await import('../src/emails');
    const base = { name: 'Asha', membershipId: 'abc', vehicle: 'Creta', plate: 'MH12AB1234', endDate: '2026-11-08', daysLeft: 5, washesDone: 3, washesTotal: 15, months: 3 };
    expect(renewalEmail({ ...base, perWeek: 1, perMonth: 5 }).html).toContain('5 washes a month');
    expect(renewalEmail({ ...base, perWeek: 3, perMonth: null }).html).toContain('3 washes per week');
    expect(renewalEmail({ ...base, perWeek: 1, perMonth: 5 }).html).not.toContain('per week');
  });
});
