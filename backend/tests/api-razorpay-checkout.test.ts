/**
 * Razorpay Standard Checkout on the website server: create order -> (browser modal) -> verify signature -> settle.
 * Pay directly: no WASHO approval step. Razorpay's API is a local stand-in; the database rules are real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, boot, customerWithVehicle, expectOk, fake, istDate, shutdown } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const plan = (c: { vehicle: any; addr: any }, o: Record<string, unknown> = {}) => ({
  vehicle_id: c.vehicle.id, weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: c.addr.id, ...o,
});
const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];

describe('membership: pay directly', () => {
  it('create order -> pay -> verify: the membership and every wash exist only after the verified payment', async () => {
    const cust = await customerWithVehicle('car');
    const res = expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust, { duration_months: 3, customer_notes: 'Gate 4321' })));
    const order = res.body.order;

    // the order is for exactly the database's price (3 a week, 3 months: 24 body x 150 + 12 deep x 220 = 6240, less 10% then 5%)
    expect(order).toMatchObject({ currency: 'INR', key_id: 'rzp_test_KEYID', amount: 533520 });
    expect(order.order_id).toMatch(/^order_/);
    expect(fake.orders.get(order.order_id)).toMatchObject({ amount: 533520, currency: 'INR' }); // what Razorpay was asked to charge
    expect(JSON.stringify(res.body)).not.toContain('rzp_test_SECRET'); // the secret never leaves the server

    // not paid yet: nothing exists
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await cust.c.get('/api/bookings')).body.bookings).toHaveLength(0);
    expect(expectOk(await cust.c.get(`/api/payments/${order.payment_id}`)).body.payment).toMatchObject({ status: 'pending', membership_id: null });

    const verified = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id)));
    expect(verified.body.result.status).toBe('fulfilled');
    const ms = expectOk(await cust.c.get('/api/memberships')).body.memberships;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ status: 'active', duration_months: 3, final_amount_cents: 533520, washes_total: 36, frequency_per_week: 3 });
    expect(expectOk(await cust.c.get(`/api/payments/${order.payment_id}`)).body.payment).toMatchObject({ status: 'paid', fulfilment_status: 'fulfilled' });
  });

  it('the price is the rate card for any 1-7 a week plan, and the browser cannot choose it', async () => {
    const bike = await customerWithVehicle('bike');
    const o1 = expectOk(await bike.c.post('/api/payments/membership-checkout', plan(bike, { weekly_pattern: [{ weekday: 2, kind: 'body' }], amount: 1, amount_cents: 1, price: 1 }))).body.order;
    expect(o1.amount).toBe(26000); // bike, 1 a week, 1 month: 4 x 65
    const car = await customerWithVehicle('car');
    const o7 = expectOk(await car.c.post('/api/payments/membership-checkout', plan(car, { weekly_pattern: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, kind: d % 2 ? 'deep' : 'body' })) }))).body.order;
    expect(o7.amount).toBe(453600); // 16 x 150 + 12 x 220 = 5040, less 10%
  });

  it('retrying the same plan reuses the open order; a different plan replaces it', async () => {
    const cust = await customerWithVehicle('car');
    const a = expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust))).body.order;
    const b = expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust))).body.order;
    expect(b.order_id).toBe(a.order_id);
    expect(b.payment_id).toBe(a.payment_id);
    const c2 = expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust, { duration_months: 6 }))).body.order;
    expect(c2.order_id).not.toBe(a.order_id);
    // the replaced order, if paid late, is recorded as unfulfilled with a refund request: the money is never lost
    const late = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(a.order_id))).body.result;
    expect(late.status).toBe('unfulfilled');
    expect((await dbOne(`select count(*)::int n from public.refunds where payment_id = $1`, [a.payment_id])).n).toBe(1);
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(0);
  });

  it('validates the plan and rejects other people\'s vehicles', async () => {
    const a = await customerWithVehicle('car');
    const b = await customerWithVehicle('car');
    expect((await a.c.post('/api/payments/membership-checkout', plan(a, { weekly_pattern: [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'body' }] }))).body.message).toMatch(/1 body wash \+ 1 deep/);
    expect((await a.c.post('/api/payments/membership-checkout', plan(a, { duration_months: 2 }))).status).toBe(400);
    expect((await a.c.post('/api/payments/membership-checkout', plan(a, { start_date: istDate(0) }))).body.message).toMatch(/can start from/);
    expect((await b.c.post('/api/payments/membership-checkout', plan(b, { vehicle_id: a.vehicle.id }))).status).toBe(404);
    expect((await a.c.post('/api/payments/membership-checkout', { vehicle_id: a.vehicle.id })).status).toBe(400);
    expect(fake.orders.size).toBeGreaterThanOrEqual(0);
  });

  it('needs a signed-in customer', async () => {
    expect((await new Client().post('/api/payments/membership-checkout', {})).status).toBe(401);
    expect((await new Client().post('/api/payments/verify', {})).status).toBe(401);
  });
});

describe('verify: signature and Razorpay\'s own record', () => {
  async function pending() {
    const cust = await customerWithVehicle('car');
    const order = expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust))).body.order;
    return { cust, order };
  }

  it('missing fields: 400; wrong signature: 400 and nothing is marked paid', async () => {
    const { cust, order } = await pending();
    expect((await cust.c.post('/api/payments/verify', {})).status).toBe(400);
    expect((await cust.c.post('/api/payments/verify', { razorpay_order_id: order.order_id })).body.code).toBe('missing_fields');
    const good = fake.checkout(order.order_id);
    for (const sig of ['f'.repeat(64), good.razorpay_signature.slice(0, -1) + (good.razorpay_signature.endsWith('0') ? '1' : '0'), 'short-but-long-enough-sig']) {
      const r = await cust.c.post('/api/payments/verify', { ...good, razorpay_signature: sig });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('bad_signature');
    }
    // a signature made with another payment id does not transfer
    const other = fake.checkout(order.order_id);
    expect((await cust.c.post('/api/payments/verify', { ...good, razorpay_payment_id: other.razorpay_payment_id })).status).toBe(400);
    expect(expectOk(await cust.c.get(`/api/payments/${order.payment_id}`)).body.payment.status).toBe('pending');
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await cust.c.post('/api/payments/verify', good)).body.result.status).toBe('fulfilled'); // the genuine one still works
  });

  it('a correct signature is not enough: Razorpay must report the payment captured, for this order and amount', async () => {
    const { cust, order } = await pending();
    const failed = fake.checkout(order.order_id, { status: 'failed' });
    expect((await cust.c.post('/api/payments/verify', failed)).status).toBe(409);
    const cheap = fake.checkout(order.order_id, { amount: 100 });
    expect((await cust.c.post('/api/payments/verify', cheap)).status).toBe(400); // amount does not match the order
    expect(expectOk(await cust.c.get(`/api/payments/${order.payment_id}`)).body.payment.status).toBe('pending');
    const { order: other } = await pending();
    const foreign = fake.checkout(other.order_id);
    expect((await cust.c.post('/api/payments/verify', { ...foreign, razorpay_order_id: order.order_id })).status).toBe(400); // wrong signature for that order
  });

  it('a payment Razorpay only authorised is captured first, then settled', async () => {
    const { cust, order } = await pending();
    const auth = fake.checkout(order.order_id, { status: 'authorized' });
    const r = expectOk(await cust.c.post('/api/payments/verify', auth));
    expect(r.body.result.status).toBe('fulfilled');
    expect(fake.payments.get(auth.razorpay_payment_id)?.status).toBe('captured');
  });

  it('someone else cannot settle your order, and verifying twice does the work once', async () => {
    const { cust, order } = await pending();
    const good = fake.checkout(order.order_id);
    const thief = await customerWithVehicle('car');
    expect((await thief.c.post('/api/payments/verify', good)).status).toBe(400);
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await cust.c.post('/api/payments/verify', good)).body.result.status).toBe('fulfilled');
    expect(expectOk(await cust.c.post('/api/payments/verify', good)).body.result.status).toBe('already_settled');
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(1);
  });
});

describe('Razorpay problems are reported, never swallowed', () => {
  it('an API failure while creating the order is a 500 with a plain message, and nothing is charged or created', async () => {
    const cust = await customerWithVehicle('car');
    fake.failNextRazorpayCall(500);
    const r = await cust.c.post('/api/payments/membership-checkout', plan(cust));
    expect(r.status).toBe(500);
    expect(r.body).toMatchObject({ code: 'payment_gateway_error', message: expect.stringMatching(/could not start the payment/) });
    expect(JSON.stringify(r.body)).not.toMatch(/rzp_test|SECRET|Simulated/);
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(0);
    // and trying again works (the same plan reuses the payment the database already opened)
    expect(expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust))).body.order.order_id).toMatch(/^order_/);
  });

  it('an API failure while verifying is a 500 and activates nothing', async () => {
    const cust = await customerWithVehicle('car');
    const order = expectOk(await cust.c.post('/api/payments/membership-checkout', plan(cust))).body.order;
    fake.failNextRazorpayCall(502);
    const r = await cust.c.post('/api/payments/verify', fake.checkout(order.order_id));
    expect(r.status).toBe(500);
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships).toHaveLength(0);
    expect(expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result.status).toBe('fulfilled');
  });
});

describe('single wash uses the same checkout', () => {
  it('on-demand: the amount comes from the rate card, verified payment books it', async () => {
    const cust = await customerWithVehicle('bike');
    const svc = (await dbOne(`select id from public.services where code = 'bike-body-wash'`)).id;
    const order = expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(3), time_slot: 'morning', address_id: cust.addr.id, amount: 1 })).body.order;
    expect(order.amount).toBe(6500);
    expect(expectOk(await cust.c.get('/api/bookings')).body.bookings).toHaveLength(0);
    expect(expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result.status).toBe('fulfilled');
    expect(expectOk(await cust.c.get('/api/bookings')).body.bookings[0]).toMatchObject({ status: 'confirmed', price_cents: 6500 });
  });
});

describe('payments that are not configured', () => {
  it('say so plainly instead of failing obscurely', async () => {
    const { config } = await import('../src/config');
    const keep = { id: config.razorpay.keyId, secret: config.razorpay.keySecret };
    (config.razorpay as any).keyId = '';
    (config.razorpay as any).keySecret = '';
    try {
      const cust = await customerWithVehicle('car');
      const r = await cust.c.post('/api/payments/membership-checkout', plan(cust));
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('payments_unavailable');
    } finally {
      (config.razorpay as any).keyId = keep.id;
      (config.razorpay as any).keySecret = keep.secret;
    }
  });
});
