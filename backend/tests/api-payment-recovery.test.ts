/**
 * A customer pays in a UPI app (Google Pay) and the browser never reports back: the tab was cleared, the phone lost signal.
 * Razorpay has the money; WASHO must end up with the booking. Three ways it gets there, tested here:
 *   1. the customer's app re-checks with Razorpay (on open, and right after a "cancelled" payment window)
 *   2. Razorpay's own webhook
 *   3. an admin re-checks a stuck checkout, or books the wash and records the Razorpay payment by hand
 * Razorpay is a local stand-in; the database rules are real.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];

/** A customer starts paying for a single wash, and then the browser vanishes: no /payments/verify ever arrives. */
async function startedWash(code = 'car-body-wash', type: 'bike' | 'car' | 'suv' = 'car') {
  const cust = await customerWithVehicle(type);
  const svc = (await dbOne(`select id from public.services where code = $1`, [code])).id;
  const order = expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(3), time_slot: 'morning', address_id: cust.addr.id })).body.order;
  return { cust, order };
}
const bookings = async (c: Client) => expectOk(await c.get('/api/bookings')).body.bookings;
const sendWebhook = (hook: { body: string; signature: string }, headers: Record<string, string> = {}) =>
  new Client().req('POST', '/api/razorpay/webhook', undefined, { raw: Buffer.from(hook.body), contentType: 'application/json', headers: { 'x-razorpay-signature': hook.signature, ...headers } });

describe('the customer’s app re-checks with Razorpay', () => {
  it('a payment whose browser never reported back is recorded, once', async () => {
    const { cust, order } = await startedWash();
    fake.paidAtRazorpay(order.order_id); // money moved at Razorpay; the website heard nothing
    expect(await bookings(cust.c)).toHaveLength(0);

    const r = expectOk(await cust.c.post('/api/payments/reconcile', {}));
    expect(r.body.results).toEqual([expect.objectContaining({ status: 'fulfilled', payment_id: order.payment_id })]);
    const mine = await bookings(cust.c);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'confirmed', price_cents: 15000 });
    expect(await dbOne(`select status::text status, fulfilment_status from public.payments where id = $1`, [order.payment_id])).toEqual({ status: 'paid', fulfilment_status: 'fulfilled' });

    // asking again changes nothing and asks Razorpay about nothing: the payment is no longer waiting
    expect(expectOk(await cust.c.post('/api/payments/reconcile', {})).body.results).toEqual([]);
    expect(await bookings(cust.c)).toHaveLength(1);
  });

  it('nothing is recorded when Razorpay shows nothing paid', async () => {
    const { cust, order } = await startedWash();
    expect(expectOk(await cust.c.post('/api/payments/reconcile', {})).body.results).toEqual([]);
    expect(await bookings(cust.c)).toHaveLength(0);
    expect((await dbOne(`select status::text status from public.payments where id = $1`, [order.payment_id])).status).toBe('pending');
    // a failed attempt is not a payment either
    fake.paidAtRazorpay(order.order_id, { status: 'failed' });
    expect(expectOk(await cust.c.post('/api/payments/reconcile', {})).body.results).toEqual([]);
  });

  it('can be pointed at one checkout, and settles an authorised payment by capturing it first', async () => {
    const { cust, order } = await startedWash();
    const other = await startedWash(); // a different customer's checkout stays untouched
    fake.paidAtRazorpay(other.order.order_id);
    const pid = fake.paidAtRazorpay(order.order_id, { status: 'authorized' });
    const r = expectOk(await cust.c.post('/api/payments/reconcile', { payment_id: order.payment_id }));
    expect(r.body.results[0]).toMatchObject({ status: 'fulfilled' });
    expect(fake.payments.get(pid)!.status).toBe('captured');
    expect((await dbOne(`select status::text status from public.payments where id = $1`, [other.order.payment_id])).status).toBe('pending');
  });

  it('only ever looks at the signed-in customer’s own checkouts', async () => {
    const a = await startedWash();
    fake.paidAtRazorpay(a.order.order_id);
    const b = await customerWithVehicle('car');
    expect(expectOk(await b.c.post('/api/payments/reconcile', {})).body.results).toEqual([]);
    expect(expectOk(await b.c.post('/api/payments/reconcile', { payment_id: a.order.payment_id })).body.results).toEqual([]);
    expect((await dbOne(`select status::text status from public.payments where id = $1`, [a.order.payment_id])).status).toBe('pending');
    expect((await new Client().post('/api/payments/reconcile', {})).status).toBe(401);
  });

  it('recovers a membership payment too, and stays quiet when payments are not switched on', async () => {
    const cust = await customerWithVehicle('car');
    const order = expectOk(
      await cust.c.post('/api/payments/membership-checkout', {
        vehicle_id: cust.vehicle.id, weekly_pattern: [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }], duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: cust.addr.id,
      })
    ).body.order;
    fake.paidAtRazorpay(order.order_id);
    const { config } = await import('../src/config');
    const keep = { id: config.razorpay.keyId, secret: config.razorpay.keySecret };
    (config.razorpay as any).keyId = '';
    (config.razorpay as any).keySecret = '';
    try {
      expect(expectOk(await cust.c.post('/api/payments/reconcile', {})).body.results).toEqual([]); // no error on every page load
    } finally {
      (config.razorpay as any).keyId = keep.id;
      (config.razorpay as any).keySecret = keep.secret;
    }
    const r = expectOk(await cust.c.post('/api/payments/reconcile', {}));
    expect(r.body.results[0]).toMatchObject({ status: 'fulfilled' });
    expect(expectOk(await cust.c.get('/api/memberships')).body.memberships[0]).toMatchObject({ status: 'active', final_amount_cents: order.amount });
  });
});

describe('Razorpay’s webhook', () => {
  it('records a captured payment by itself, and a repeat is harmless', async () => {
    const { cust, order } = await startedWash('car-deep-cleaning');
    const payId = fake.paidAtRazorpay(order.order_id);
    expect(await bookings(cust.c)).toHaveLength(0);
    const r = await sendWebhook(fake.webhook('payment.captured', { id: payId, order_id: order.order_id }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, status: 'fulfilled' });
    expect((await bookings(cust.c))[0]).toMatchObject({ status: 'confirmed', price_cents: 22000 });

    const again = await sendWebhook(fake.webhook('payment.captured', { id: payId, order_id: order.order_id }));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ handled: true, status: 'already_settled' });
    expect(await bookings(cust.c)).toHaveLength(1);
    // order.paid says the same thing
    expect((await sendWebhook(fake.webhook('order.paid', { id: payId, order_id: order.order_id }))).body.status).toBe('already_settled');
  });

  it('is refused without a valid signature, and nothing is recorded', async () => {
    const { cust, order } = await startedWash();
    const payId = fake.paidAtRazorpay(order.order_id);
    const good = fake.webhook('payment.captured', { id: payId, order_id: order.order_id });
    expect((await sendWebhook({ ...good, signature: 'deadbeef'.repeat(8) })).status).toBe(400);
    expect((await sendWebhook(fake.webhook('payment.captured', { id: payId, order_id: order.order_id }, { secret: 'not-the-secret' }))).status).toBe(400);
    // a body edited after signing
    expect((await sendWebhook({ body: good.body.replace(order.order_id, 'order_forged'), signature: good.signature })).status).toBe(400);
    const noSig = await new Client().req('POST', '/api/razorpay/webhook', undefined, { raw: Buffer.from(good.body), contentType: 'application/json' });
    expect(noSig.status).toBe(400);
    expect(await bookings(cust.c)).toHaveLength(0);
  });

  it('ignores events it does not act on, orders that are not WASHO’s, and a paid amount that is not the price', async () => {
    const { cust, order } = await startedWash();
    const payId = fake.paidAtRazorpay(order.order_id);
    const failed = await sendWebhook(fake.webhook('payment.failed', { id: payId, order_id: order.order_id }));
    expect(failed.status).toBe(200);
    expect(failed.body.handled).toBe(false);
    expect(await bookings(cust.c)).toHaveLength(0);

    fake.orders.set('order_someone_elses', { amount: 5000, currency: 'INR', receipt: '' });
    const foreign = fake.paidAtRazorpay('order_someone_elses');
    const f = await sendWebhook(fake.webhook('payment.captured', { id: foreign, order_id: 'order_someone_elses' }));
    expect(f.status).toBe(200);
    expect(f.body.status).toBe('unknown_order');

    const wrong = await startedWash();
    const short = fake.paidAtRazorpay(wrong.order.order_id, { amount: 100 });
    const w = await sendWebhook(fake.webhook('payment.captured', { id: short, order_id: wrong.order.order_id }));
    expect(w.body.status).toBe('rejected');
    expect(await bookings(wrong.cust.c)).toHaveLength(0);
  });

  it('says so plainly when the secret has not been set on the server', async () => {
    const { config } = await import('../src/config');
    const keep = config.razorpay.webhookSecret;
    (config.razorpay as any).webhookSecret = '';
    try {
      expect((await sendWebhook(fake.webhook('payment.captured', { id: 'pay_x', order_id: 'order_x' }))).status).toBe(503);
    } finally {
      (config.razorpay as any).webhookSecret = keep;
    }
  });

  it('answers a Razorpay outage with a server error, so Razorpay delivers it again', async () => {
    const { cust, order } = await startedWash();
    const payId = fake.paidAtRazorpay(order.order_id);
    fake.failNextRazorpayCall(500);
    expect((await sendWebhook(fake.webhook('payment.captured', { id: payId, order_id: order.order_id }))).status).toBeGreaterThanOrEqual(500);
    expect(await bookings(cust.c)).toHaveLength(0);
    expect((await sendWebhook(fake.webhook('payment.captured', { id: payId, order_id: order.order_id }))).status).toBe(200); // the retry
    expect(await bookings(cust.c)).toHaveLength(1);
  });
});

describe('the admin can rescue a stuck payment', () => {
  const age = (paymentId: string) => dbOne(`update public.payments set created_at = now() - interval '20 minutes' where id = $1`, [paymentId]);

  it('lists checkouts that were started and never confirmed, and re-checks one with Razorpay', async () => {
    const admin = await staffClient('admin');
    const { cust, order } = await startedWash();
    // a checkout that is still in progress is not shown
    expect(expectOk(await admin.c.get('/api/admin/attention')).body.pending.find((p: any) => p.id === order.payment_id)).toBeUndefined();
    await age(order.payment_id);
    const row = expectOk(await admin.c.get('/api/admin/attention')).body.pending.find((p: any) => p.id === order.payment_id);
    expect(row).toMatchObject({ amount_cents: 15000, payment_kind: 'on_demand', customer_name: 'Asha Kulkarni' });

    // not paid at Razorpay: nothing happens
    expect(expectOk(await admin.c.post(`/api/admin/payments/${order.payment_id}/reconcile`, {})).body.status).toBe('not_paid');
    expect(await bookings(cust.c)).toHaveLength(0);
    // paid at Razorpay: recorded, and it leaves the list
    fake.paidAtRazorpay(order.order_id);
    const done = expectOk(await admin.c.post(`/api/admin/payments/${order.payment_id}/reconcile`, {}));
    expect(done.body).toMatchObject({ status: 'fulfilled' });
    expect(done.body.booking_id).toBeTruthy();
    expect(await bookings(cust.c)).toHaveLength(1);
    expect(expectOk(await admin.c.get('/api/admin/attention')).body.pending.find((p: any) => p.id === order.payment_id)).toBeUndefined();
    expect(expectOk(await admin.c.post(`/api/admin/payments/${order.payment_id}/reconcile`, {})).body.status).toBe('already_recorded');
  });

  it('is for admins only, and unknown payments are a 404', async () => {
    const admin = await staffClient('admin');
    const worker = await staffClient('worker');
    const { cust, order } = await startedWash();
    expect((await cust.c.post(`/api/admin/payments/${order.payment_id}/reconcile`, {})).status).toBe(403);
    expect((await worker.c.post(`/api/admin/payments/${order.payment_id}/reconcile`, {})).status).toBe(403);
    expect((await new Client().post(`/api/admin/payments/${order.payment_id}/reconcile`, {})).status).toBe(401);
    expect((await admin.c.post(`/api/admin/payments/${crypto.randomUUID()}/reconcile`, {})).status).toBe(404);
  });
});

describe('the admin books the wash and records the Razorpay payment by hand', () => {
  async function setup() {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const me = expectOk(await cust.c.get('/api/me')).body.user;
    const svc = (await dbOne(`select id from public.services where code = 'car-body-wash'`)).id;
    const body = (extra: Record<string, unknown> = {}) => ({ customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(3), time_slot: 'morning', payment: 'online', ...extra });
    const payment = (o: { amount?: number; status?: string } = {}) => {
      const orderId = `order_${crypto.randomBytes(5).toString('hex')}`;
      fake.orders.set(orderId, { amount: o.amount ?? 15000, currency: 'INR', receipt: '' });
      return fake.paidAtRazorpay(orderId, { status: o.status });
    };
    return { admin, cust, me, body, payment };
  }

  it('checks with Razorpay, records it as a paid Razorpay payment, and a cancellation can be refunded through Razorpay', async () => {
    const { admin, cust, body, payment } = await setup();
    const payId = payment();
    const made = expectOk(await admin.c.post('/api/admin/bookings', body({ razorpay_payment_id: payId, note: 'Paid on Google Pay, browser lost it' })));
    expect(made.body.price_cents).toBe(15000);
    expect((await bookings(cust.c))[0]).toMatchObject({ status: 'confirmed', price_cents: 15000 });
    expect(await dbOne(`select provider, provider_payment_id, status::text status, amount_cents from public.payments where booking_id = $1`, [made.body.booking_id])).toEqual({ provider: 'razorpay', provider_payment_id: payId, status: 'paid', amount_cents: 15000 });

    // cancel it, and the refund goes back through Razorpay like any other online payment
    expectOk(await cust.c.post(`/api/bookings/${made.body.booking_id}/cancel`, { reason: 'Plans changed' }));
    const refund = await dbOne(`select id from public.refunds where booking_id = $1`, [made.body.booking_id]);
    const approved = expectOk(await admin.c.post(`/api/admin/refunds/${refund.id}/approve`, {}));
    expect(approved.body.provider_refund_id).toMatch(/^rfnd_/);
    expect([...fake.refunds.values()].filter((r) => r.payment_id === payId)).toEqual([expect.objectContaining({ amount: 15000 })]);
  });

  it('refuses a payment that is not what it should be: unknown, not captured, the wrong amount, already used', async () => {
    const { admin, body, payment } = await setup();
    const book = (id: string | undefined, extra: Record<string, unknown> = {}) => admin.c.post('/api/admin/bookings', body({ razorpay_payment_id: id, ...extra }));
    expect((await book(undefined)).status).toBe(400);
    expect((await book('not-an-id')).status).toBe(400);
    expect((await book('pay_doesnotexist12')).body.message).toMatch(/Razorpay does not know that payment id/);
    expect((await book(payment({ status: 'authorized' }))).body.message).toMatch(/"authorized", not captured/);
    expect((await book(payment({ amount: 10000 }))).body.message).toMatch(/for ₹100 but this wash costs ₹150/);
    const ok = payment();
    expectOk(await book(ok));
    expect((await book(ok, { date: istDate(5) })).body.message).toMatch(/already recorded against another booking/);
  });

  it('cannot be used by anyone but an admin', async () => {
    const { cust, body, payment } = await setup();
    expect((await cust.c.post('/api/admin/bookings', body({ razorpay_payment_id: payment() }))).status).toBe(403);
  });
});
