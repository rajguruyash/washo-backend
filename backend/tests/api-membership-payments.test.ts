/**
 * The primary WASHO product, end to end over HTTP:
 *   request -> WASHO quote -> customer accepts -> Razorpay -> verified payment -> membership active -> washes scheduled
 * plus on-demand payment, with the database enforcing every rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

let admin: Client;
beforeAll(async () => {
  admin = (await staffClient('admin')).c;
});

const request = (c: Client, o: Record<string, unknown>) =>
  c.post('/api/membership-requests', { weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4), ...o });

describe('membership request', () => {
  it('the customer sees NO price or estimate until WASHO has approved one', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id, duration_months: 12, customer_notes: 'Please call before arriving' }));
    expect(created.status).toBe(201);
    expect(created.body.reference_code).toMatch(/^MR-/);

    const mine = expectOk(await c.get('/api/membership-requests')).body.requests;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'submitted', frequency_per_week: 3, duration_months: 12, quoted_amount_cents: null, quoted_breakdown: null, vehicle_type: 'car' });
    // the whole payload carries no rupee figure and no internal quote
    expect(JSON.stringify(mine)).not.toMatch(/system_quote|subtotal|final_cents/);
    const one = expectOk(await c.get(`/api/membership-requests/${created.body.id}`)).body.request;
    expect(one.quoted_amount_cents).toBeNull();
    // and nothing can be paid yet
    const early = await c.post(`/api/membership-requests/${created.body.id}/accept`);
    expect(early.status).toBe(422);
    expect(early.body.message).toMatch(/not waiting for your approval/);
  });

  it('enforces 1 / 2 / 3 washes a week and the Body + Deep rules in the database', async () => {
    const car = await customerWithVehicle('car');
    const mk = async (pattern: unknown[], vehicleId = car.vehicle.id) => request(car.c, { vehicle_id: vehicleId, address_id: car.addr.id, weekly_pattern: pattern });

    expect((await mk([{ weekday: 1, kind: 'body' }, { weekday: 4, kind: 'body' }])).body.message).toMatch(/1 body wash \+ 1 deep cleaning/); // 2/week must be Body + Deep
    expect((await mk([{ weekday: 1, kind: 'deep' }, { weekday: 4, kind: 'deep' }])).body.message).toMatch(/1 body wash \+ 1 deep cleaning/);
    expect((await mk([{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'body' }, { weekday: 5, kind: 'body' }])).body.message).toMatch(/mixes body washes and deep cleanings/);
    expect((await mk([{ weekday: 1, kind: 'body' }, { weekday: 1, kind: 'deep' }])).body.message).toMatch(/different day/);
    expect((await mk([{ weekday: 1, kind: 'body' }, { weekday: 2, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 4, kind: 'deep' }])).status).toBe(400); // 4 a week does not exist
    expect((await mk([])).status).toBe(400);
    expect((await request(car.c, { vehicle_id: car.vehicle.id, address_id: car.addr.id, duration_months: 2 })).status).toBe(400);
    expect((await request(car.c, { vehicle_id: car.vehicle.id, address_id: car.addr.id, start_date: istDate(0) })).body.message).toMatch(/can start from/);

    // valid shapes: 1/week either kind, 2/week = Body + Deep, 3/week mixes (two bodies + one deep, or the reverse)
    for (const [i, pattern] of [
      [{ weekday: 2, kind: 'deep' }],
      [{ weekday: 2, kind: 'body' }, { weekday: 5, kind: 'deep' }],
      [{ weekday: 1, kind: 'deep' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }],
    ].entries()) {
      const v = expectOk(await car.c.post('/api/vehicles', { vehicle_type: 'car', model: `M${i}`, registration_number: `MH14XX${i}00${i}` })).body.vehicle;
      expect((await mk(pattern, v.id)).status, JSON.stringify(pattern)).toBe(201);
    }
  });

  it('bikes have a single wash type; SUVs can take car body + SUV deep', async () => {
    const bike = await customerWithVehicle('bike');
    const deep = await request(bike.c, { vehicle_id: bike.vehicle.id, address_id: bike.addr.id, weekly_pattern: [{ weekday: 1, kind: 'deep' }] });
    expect(deep.body.message).toMatch(/Bikes have one wash type/);
    expect((await request(bike.c, { vehicle_id: bike.vehicle.id, address_id: bike.addr.id, weekly_pattern: [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'body' }] })).status).toBe(201);

    const suv = await customerWithVehicle('suv');
    expect((await request(suv.c, { vehicle_id: suv.vehicle.id, address_id: suv.addr.id, weekly_pattern: [{ weekday: 2, kind: 'body' }, { weekday: 5, kind: 'deep' }] })).status).toBe(201);
  });

  it('one open request per vehicle; and a customer cannot request for someone else\'s vehicle', async () => {
    const a = await customerWithVehicle('car');
    const b = await customerWithVehicle('car');
    expectOk(await request(a.c, { vehicle_id: a.vehicle.id, address_id: a.addr.id }));
    const dup = await request(a.c, { vehicle_id: a.vehicle.id, address_id: a.addr.id });
    expect(dup.status).toBe(422);
    expect(dup.body.message).toMatch(/already have a membership request in progress/);
    const stolen = await request(b.c, { vehicle_id: a.vehicle.id, address_id: b.addr.id });
    expect(stolen.status).toBe(404);
  });

  it('a customer cannot see another customer\'s requests', async () => {
    const a = await customerWithVehicle('car');
    const b = await customerWithVehicle('car');
    const created = expectOk(await request(a.c, { vehicle_id: a.vehicle.id, address_id: a.addr.id })).body;
    expect(expectOk(await b.c.get('/api/membership-requests')).body.requests).toHaveLength(0);
    expect((await b.c.get(`/api/membership-requests/${created.id}`)).status).toBe(404);
    expect((await b.c.post(`/api/membership-requests/${created.id}/accept`)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('WASHO review (admin)', () => {
  it('admin sees the system quote with every discount as its own line, and the customer is told only the approved price', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id, duration_months: 12 })).body;

    const list = expectOk(await admin.get('/api/admin/membership-requests?status=submitted')).body.requests;
    const row = list.find((r: any) => r.id === created.id);
    expect(row.customer).toMatchObject({ name: 'Asha Kulkarni' });
    expect(row.vehicle).toMatchObject({ type: 'car', model: 'Creta' });
    // 3/week x 12 months: 144 washes. Body 96 x 150 + Deep 48 x 220 = 14400 + 10560 = 24960 -> 249,600 paise... in paise below
    const q = row.system_quote;
    expect(q).toMatchObject({ washes_total: 144, subtotal_cents: 2496000 });
    expect(q.frequency_discount).toMatchObject({ bp: 1000 });
    expect(q.duration_discount).toMatchObject({ bp: 1500 });
    expect(q.cap).toMatchObject({ max_bp: 1500, applied: true }); // 10% then 15% would exceed 15%: the cap is its own labelled line
    expect(q.final_cents).toBe(2496000 - Math.round(2496000 * 0.15));

    const quoted = expectOk(await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote', adjustment_cents: -50000, adjustment_reason: 'Neighbour referral' })).body.result;
    expect(quoted.quoted_amount_cents).toBe(q.final_cents - 50000);

    const mine = expectOk(await c.get(`/api/membership-requests/${created.id}`)).body.request;
    expect(mine.status).toBe('quoted');
    expect(mine.quoted_amount_cents).toBe(quoted.quoted_amount_cents);
    expect(mine.quoted_breakdown.adjustment).toEqual({ cents: -50000, reason: 'Neighbour referral' });
    expect(new Date(mine.quote_expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000); // 7 days
  });

  it('an adjustment needs a reason; reject needs a reason; customers and workers cannot review', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id })).body;
    expect((await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote', adjustment_cents: -100 })).body.message).toMatch(/needs a reason/);
    expect((await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'reject' })).body.message).toMatch(/reason/);
    expect((await c.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote' })).status).toBe(403);
    const w = await staffClient('worker');
    expect((await w.c.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote' })).status).toBe(403);

    expectOk(await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'reject', rejection_reason: 'We do not serve that block yet' }));
    const mine = expectOk(await c.get(`/api/membership-requests/${created.id}`)).body.request;
    expect(mine).toMatchObject({ status: 'rejected', rejection_reason: 'We do not serve that block yet', quoted_amount_cents: null });
  });

  it('the customer can decline a quote', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id })).body;
    expectOk(await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote' }));
    expectOk(await c.post(`/api/membership-requests/${created.id}/decline`));
    expect(expectOk(await c.get(`/api/membership-requests/${created.id}`)).body.request.status).toBe('declined');
    expect((await c.post(`/api/membership-requests/${created.id}/accept`)).status).toBe(422);
  });
});

describe('accept -> pay -> verified -> activated -> scheduled', () => {
  it('nothing exists until the payment is verified; then the membership and every wash appear', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id, duration_months: 3, customer_notes: 'Gate code 4321' })).body;
    expectOk(await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote' }));
    const quoted = expectOk(await c.get(`/api/membership-requests/${created.id}`)).body.request;

    const order = expectOk(await c.post(`/api/membership-requests/${created.id}/accept`)).body.order;
    expect(order).toMatchObject({ amount: quoted.quoted_amount_cents, currency: 'INR', key_id: expect.stringMatching(/^rzp_/) });
    expect(order.order_id).toMatch(/^order_/);

    // accepted, but still no membership, no washes
    expect(expectOk(await c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await c.get('/api/bookings')).body.bookings).toHaveLength(0);
    expect(expectOk(await c.get(`/api/payments/${order.payment_id}`)).body.payment).toMatchObject({ status: 'pending', membership_id: null });

    const paid = expectOk(await c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    expect(paid.status).toBe('fulfilled');

    const ms = expectOk(await c.get('/api/memberships')).body.memberships;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ status: 'active', duration_months: 3, final_amount_cents: quoted.quoted_amount_cents, washes_total: 36, washes_completed: 0, reference_code: created.reference_code, frequency_per_week: 3 });
    expect(ms[0].next_wash).toMatchObject({ status: 'confirmed', time_slot: 'morning' });

    const detail = expectOk(await c.get(`/api/memberships/${ms[0].id}`)).body;
    expect(detail.washes).toHaveLength(36);
    const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    for (const w of detail.washes) {
      expect([1, 3, 5]).toContain(dow(w.scheduled_date));
      expect(w.service_name).toBe(dow(w.scheduled_date) === 3 ? 'Car Deep Cleaning' : 'Car Body Wash');
      expect(w.occurrence_id).toBeTruthy();
    }
    expect(expectOk(await c.get(`/api/membership-requests/${created.id}`)).body.request).toMatchObject({ status: 'active', membership_id: ms[0].id });
    expect(expectOk(await c.get(`/api/payments/${order.payment_id}`)).body.payment).toMatchObject({ status: 'paid', fulfilment_status: 'fulfilled' });
  });

  it('replaying the verification does the work once', async () => {
    const m = await activeMembership({ admin });
    const before = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes.length;
    const { rows } = await fake.admin.query(`SELECT provider_order_id FROM public.payments WHERE membership_id = $1`, [m.membershipId]);
    const again = await m.c.post('/api/payments/verify', fake.checkout(rows[0].provider_order_id));
    expect(again.body.result?.status ?? again.body.message).toBeDefined();
    expect(expectOk(await m.c.get('/api/memberships')).body.memberships).toHaveLength(1);
    expect(expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes).toHaveLength(before);
  });

  it('a forged signature, a wrong amount, an uncaptured payment and someone else\'s order all fail — and activate nothing', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id })).body;
    expectOk(await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote' }));
    const order = expectOk(await c.post(`/api/membership-requests/${created.id}/accept`)).body.order;

    const good = fake.checkout(order.order_id);
    const forged = await c.post('/api/payments/verify', { ...good, razorpay_signature: 'f'.repeat(64) });
    expect(forged.status).toBe(422);
    expect(forged.body.message).toMatch(/could not verify/);

    const cheap = fake.checkout(order.order_id, { amount: 100 });
    const underpaid = await c.post('/api/payments/verify', cheap);
    expect(underpaid.status).toBeGreaterThanOrEqual(400);

    const failed = fake.checkout(order.order_id, { status: 'failed' });
    expect((await c.post('/api/payments/verify', failed)).status).toBeGreaterThanOrEqual(400);

    const attacker = await customerWithVehicle('car');
    const theirs = await attacker.c.post('/api/payments/verify', good);
    expect(theirs.status).toBeGreaterThanOrEqual(400);

    expect(expectOk(await c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await attacker.c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await c.get(`/api/payments/${order.payment_id}`)).body.payment.status).toBe('pending');

    // the genuine payment still works afterwards
    expect(expectOk(await c.post('/api/payments/verify', good)).body.result.status).toBe('fulfilled');
  });

  it('retrying acceptance reuses the open order rather than creating a second payment', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const created = expectOk(await request(c, { vehicle_id: vehicle.id, address_id: addr.id })).body;
    expectOk(await admin.post(`/api/admin/membership-requests/${created.id}/review`, { action: 'quote' }));
    const a = expectOk(await c.post(`/api/membership-requests/${created.id}/accept`)).body.order;
    const b = expectOk(await c.post(`/api/membership-requests/${created.id}/accept`)).body.order;
    expect(b.order_id).toBe(a.order_id);
    expect(b.payment_id).toBe(a.payment_id);
  });

  it('no client-side price: the on-demand route ignores any amount sent', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const { rows } = await fake.admin.query(`SELECT id FROM public.services WHERE code = 'car-body-wash'`);
    const order = expectOk(await c.post('/api/payments/on-demand', { vehicle_id: vehicle.id, service_id: rows[0].id, scheduled_date: istDate(3), time_slot: 'afternoon', address_id: addr.id, amount: 1, amount_cents: 1, price: 1 })).body.order;
    expect(order.amount).toBe(15000);
  });
});

describe('on-demand payment', () => {
  it('prices from the rate card, books only after verified payment, and lists the booking', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('suv');
    const svc = async (code: string) => (await fake.admin.query(`SELECT id FROM public.services WHERE code = $1`, [code])).rows[0].id;
    const deep = expectOk(await c.post('/api/payments/on-demand', { vehicle_id: vehicle.id, service_id: await svc('suv-deep-cleaning'), scheduled_date: istDate(3), time_slot: 'morning', address_id: addr.id, parking_location: 'Basement P1' })).body.order;
    expect(deep.amount).toBe(25000);
    expect(expectOk(await c.get('/api/bookings')).body.bookings).toHaveLength(0); // unpaid: no booking

    const paid = expectOk(await c.post('/api/payments/verify', fake.checkout(deep.order_id))).body.result;
    expect(paid).toMatchObject({ status: 'fulfilled' });
    const list = expectOk(await c.get('/api/bookings?scope=upcoming')).body.bookings;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'confirmed', booking_type: 'on_demand', service_name: 'SUV Deep Cleaning', price_cents: 25000, vehicle_type: 'suv', time_slot: 'morning' });
    expect(list[0].reference_code).toMatch(/^WSH-/);

    // SUV body wash uses the car body service
    const body = expectOk(await c.post('/api/payments/on-demand', { vehicle_id: vehicle.id, service_id: await svc('car-body-wash'), scheduled_date: istDate(4), time_slot: 'night', address_id: addr.id })).body.order;
    expect(body.amount).toBe(15000);
  });

  it('refuses services that do not fit the vehicle, busy days, too-soon slots and other people\'s vehicles', async () => {
    const bike = await customerWithVehicle('bike');
    const other = await customerWithVehicle('car');
    const svc = async (code: string) => (await fake.admin.query(`SELECT id FROM public.services WHERE code = $1`, [code])).rows[0].id;
    const go = (cust: typeof bike, vehicleId: string, service: string, date = istDate(3), slot = 'morning') =>
      cust.c.post('/api/payments/on-demand', { vehicle_id: vehicleId, service_id: service, scheduled_date: date, time_slot: slot });
    expect((await go(bike, bike.vehicle.id, await svc('car-deep-cleaning'))).body.message).toMatch(/not available for your vehicle/);
    expect((await go(bike, other.vehicle.id, await svc('bike-body-wash'))).status).toBe(422);
    expect((await go(bike, bike.vehicle.id, await svc('bike-body-wash'), istDate(-1))).body.message).toMatch(/too soon/);

    const ok = expectOk(await go(bike, bike.vehicle.id, await svc('bike-body-wash'), istDate(5)));
    expect(ok.body.order.amount).toBe(6500);
    expectOk(await bike.c.post('/api/payments/verify', fake.checkout(ok.body.order.order_id)));
    expect((await go(bike, bike.vehicle.id, await svc('bike-body-wash'), istDate(5), 'night')).body.message).toMatch(/already has a wash booked that day/);
  });

  it('a paid on-demand wash can be cancelled and raises a refund REQUEST (WASHO pays it out)', async () => {
    const { c, vehicle, addr } = await customerWithVehicle('car');
    const svcId = (await fake.admin.query(`SELECT id FROM public.services WHERE code = 'car-body-wash'`)).rows[0].id;
    const order = expectOk(await c.post('/api/payments/on-demand', { vehicle_id: vehicle.id, service_id: svcId, scheduled_date: istDate(6), time_slot: 'morning', address_id: addr.id })).body.order;
    expectOk(await c.post('/api/payments/verify', fake.checkout(order.order_id)));
    const booking = expectOk(await c.get('/api/bookings')).body.bookings[0];

    expectOk(await c.post(`/api/bookings/${booking.id}/cancel`, { reason: 'Plans changed' }));
    const detail = expectOk(await c.get(`/api/bookings/${booking.id}`)).body;
    expect(detail.booking).toMatchObject({ status: 'cancelled', cancel_reason: 'Plans changed' });
    expect(detail.events.map((e: any) => e.event_type)).toEqual(expect.arrayContaining(['booking_created', 'cancelled', 'refund_requested']));
    const attention = expectOk(await admin.get('/api/admin/attention')).body;
    const refund = attention.refunds.find((r: any) => r.amount_cents === 15000 && r.reason.includes('Plans changed'));
    expect(refund).toBeTruthy();
    // WASHO pays it back in Razorpay, then records it; the refund leaves the attention list
    expect((await admin.post(`/api/admin/refunds/${refund.id}/resolve`, { status: 'processed' })).body.message).toMatch(/Razorpay refund id/);
    expectOk(await admin.post(`/api/admin/refunds/${refund.id}/resolve`, { status: 'processed', provider_refund_id: 'rfnd_TEST123' }));
    expect(expectOk(await admin.get('/api/admin/attention')).body.refunds.some((r: any) => r.id === refund.id)).toBe(false);
    expect((await c.post(`/api/admin/refunds/${refund.id}/resolve`, { status: 'failed' })).status).toBe(403);
    expect((await c.post(`/api/bookings/${booking.id}/cancel`, {})).status).toBe(422); // already cancelled
  });
});

describe('membership washes: reschedule yes, cancel no', () => {
  it('the customer can move a wash within the rules, but cannot cancel it', async () => {
    const m = await activeMembership({ admin });
    const washes = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes;
    const wash = washes[0];

    const cancel = await m.c.post(`/api/bookings/${wash.id}/cancel`, { reason: 'no' });
    expect(cancel.status).toBe(422);
    expect(cancel.body.message).toMatch(/rescheduled but not cancelled/);

    const target = istDate(24);
    const tue = new Date(`${target}T00:00:00Z`).getUTCDay();
    const date = istDate(24 + ((9 - tue) % 7)); // a Tuesday near the end of the term, never a plan day
    expect((await m.c.post(`/api/bookings/${wash.id}/reschedule`, { date: istDate(1), time_slot: 'morning' })).body.message).toMatch(/earliest date/);
    expect((await m.c.post(`/api/bookings/${wash.id}/reschedule`, { date: istDate(400), time_slot: 'morning' })).body.message).toMatch(/within your membership/);
    expectOk(await m.c.post(`/api/bookings/${wash.id}/reschedule`, { date, time_slot: 'afternoon' }));
    const detail = expectOk(await m.c.get(`/api/bookings/${wash.id}`)).body;
    expect(detail.booking).toMatchObject({ scheduled_date: date, time_slot: 'afternoon', status: 'confirmed' });
    expect(detail.events.map((e: any) => e.event_type)).toContain('rescheduled');
  });

  it('another customer cannot reschedule it, and an on-demand booking has no reschedule', async () => {
    const m = await activeMembership({ admin });
    const other = await customerWithVehicle('car');
    const wash = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes[0];
    expect((await other.c.post(`/api/bookings/${wash.id}/reschedule`, { date: istDate(30), time_slot: 'morning' })).status).toBe(404);
  });
});
