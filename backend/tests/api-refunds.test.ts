/**
 * Cancel a paid wash -> full refund REQUEST -> an admin approves -> the server asks Razorpay to refund the original payment.
 * Razorpay's API is a local stand-in; the database rules are real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const dbOne = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];

/** A paid, confirmed single wash that the customer then cancels. */
async function cancelledWash(code = 'car-body-wash', type: 'bike' | 'car' | 'suv' = 'car') {
  const cust = await customerWithVehicle(type);
  const svc = (await dbOne(`select id from public.services where code = $1`, [code])).id;
  const order = expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(3), time_slot: 'morning', address_id: cust.addr.id })).body.order;
  const paid = fake.checkout(order.order_id);
  expectOk(await cust.c.post('/api/payments/verify', paid));
  const booking = expectOk(await cust.c.get('/api/bookings')).body.bookings[0];
  expectOk(await cust.c.post(`/api/bookings/${booking.id}/cancel`, { reason: 'Plans changed' }));
  const refund = await dbOne(`select id, amount_cents, status::text status from public.refunds where booking_id = $1`, [booking.id]);
  return { cust, booking, order, paid, refund };
}

describe('customer cancels a paid wash', () => {
  it('raises a refund request for the full amount and shows it on the booking, without Razorpay being asked yet', async () => {
    const w = await cancelledWash();
    expect(w.refund).toMatchObject({ amount_cents: 15000, status: 'requested' });
    expect([...fake.refunds.values()].filter((r) => r.payment_id === w.paid.razorpay_payment_id)).toHaveLength(0); // Razorpay is not asked yet

    const detail = expectOk(await w.cust.c.get(`/api/bookings/${w.booking.id}`)).body;
    expect(detail.booking.status).toBe('cancelled');
    expect(detail.refund).toEqual(expect.objectContaining({ amount_cents: 15000, status: 'requested' }));
    expect(JSON.stringify(detail.refund)).not.toMatch(/failure_reason|provider/);
    expect(detail.events.map((e: any) => e.event_type)).toEqual(expect.arrayContaining(['cancelled', 'refund_requested']));
  });
});

describe('admin approves the refund', () => {
  it('lists it, refunds the original Razorpay payment for the FULL amount, and records Razorpay\'s refund id', async () => {
    const w = await cancelledWash('car-deep-cleaning');
    const admin = await staffClient('admin');
    const open = expectOk(await admin.c.get('/api/admin/attention')).body.refunds;
    expect(open.find((r: any) => r.id === w.refund.id)).toMatchObject({ amount_cents: 22000, status: 'requested' });

    const res = expectOk(await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {}));
    expect(res.body.provider_refund_id).toMatch(/^rfnd_/);

    // Razorpay was asked to refund exactly the payment the customer made, for exactly what they paid
    const mine = [...fake.refunds.values()].filter((r) => r.payment_id === w.paid.razorpay_payment_id);
    expect(mine).toHaveLength(1);
    const asked = mine[0];
    expect(asked).toMatchObject({ payment_id: w.paid.razorpay_payment_id, amount: 22000, notes: { washo_refund_id: w.refund.id } });

    expect(await dbOne(`select status::text status, provider_refund_id from public.refunds where id = $1`, [w.refund.id])).toEqual({
      status: 'processed',
      provider_refund_id: res.body.provider_refund_id,
    });
    expect((await dbOne(`select status::text status from public.payments where provider_payment_id = $1`, [w.paid.razorpay_payment_id])).status).toBe('refunded');

    // the customer sees it, in the timeline too
    const detail = expectOk(await w.cust.c.get(`/api/bookings/${w.booking.id}`)).body;
    expect(detail.refund).toMatchObject({ amount_cents: 22000, status: 'processed' });
    expect(detail.events.map((e: any) => e.event_type)).toContain('refunded');

    // and it is off the admin's to-do list
    expect(expectOk(await admin.c.get('/api/admin/attention')).body.refunds.find((r: any) => r.id === w.refund.id)).toBeUndefined();
  });

  it('is never refunded twice', async () => {
    const w = await cancelledWash();
    const admin = await staffClient('admin');
    expectOk(await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {}));
    const again = await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {});
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.message).toMatch(/already processed/);
    expect([...fake.refunds.values()].filter((r) => r.notes.washo_refund_id === w.refund.id)).toHaveLength(1);
  });

  it('two admins pressing approve at once refund it once', async () => {
    const w = await cancelledWash();
    const a = await staffClient('admin');
    const b = await staffClient('admin');
    const [x, y] = await Promise.all([a.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {}), b.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {})]);
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
    expect([...fake.refunds.values()].filter((r) => r.notes.washo_refund_id === w.refund.id)).toHaveLength(1);
  });

  it('if Razorpay refuses, nothing is recorded as refunded, the reason is kept, and the admin can try again', async () => {
    const w = await cancelledWash();
    const admin = await staffClient('admin');
    fake.rejectNextRefund('Your account does not have enough balance to carry out the refund operation.');
    const r = await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {});
    expect(r.status).toBe(502);
    expect(r.body.message).toMatch(/does not have enough balance/);
    expect([...fake.refunds.values()].filter((x) => x.notes.washo_refund_id === w.refund.id)).toHaveLength(0);
    expect(await dbOne(`select status::text status, failure_reason from public.refunds where id = $1`, [w.refund.id])).toMatchObject({ status: 'failed', failure_reason: expect.stringMatching(/enough balance/) });
    expect((await dbOne(`select status::text status from public.payments where provider_payment_id = $1`, [w.paid.razorpay_payment_id])).status).toBe('paid');
    expect(expectOk(await admin.c.get('/api/admin/attention')).body.refunds.find((x: any) => x.id === w.refund.id)).toMatchObject({ status: 'failed', failure_reason: expect.stringMatching(/enough balance/) });
    // the customer is never shown the internal reason
    expect(JSON.stringify(expectOk(await w.cust.c.get(`/api/bookings/${w.booking.id}`)).body.refund)).not.toMatch(/balance/);

    const retry = expectOk(await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {}));
    expect(retry.body.provider_refund_id).toMatch(/^rfnd_/);
    expect((await dbOne(`select status::text status from public.refunds where id = $1`, [w.refund.id])).status).toBe('processed');
  });

  it('a Razorpay outage is reported to the admin and leaves the refund retryable', async () => {
    const w = await cancelledWash();
    const admin = await staffClient('admin');
    fake.failNextRazorpayCall(500);
    const r = await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {});
    expect(r.status).toBe(502);
    expect((await dbOne(`select status::text status from public.refunds where id = $1`, [w.refund.id])).status).toBe('failed');
    expectOk(await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {}));
    expect((await dbOne(`select status::text status from public.refunds where id = $1`, [w.refund.id])).status).toBe('processed');
  });

  it('if the server died after Razorpay refunded but before it was recorded, retrying records that refund and does not pay again', async () => {
    const w = await cancelledWash();
    const admin = await staffClient('admin');
    // Razorpay already has the refund WASHO asked for (the response never made it back)
    fake.refunds.set('rfnd_ALREADYMADE1', { payment_id: w.paid.razorpay_payment_id, amount: 15000, notes: { washo_refund_id: w.refund.id }, receipt: '', status: 'processed' });
    await dbOne(`update public.refunds set status = 'approved', approved_at = now() - interval '10 minutes' where id = $1`, [w.refund.id]);
    const res = expectOk(await admin.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {}));
    expect(res.body.provider_refund_id).toBe('rfnd_ALREADYMADE1');
    expect([...fake.refunds.values()].filter((x) => x.notes.washo_refund_id === w.refund.id)).toHaveLength(1);
    expect((await dbOne(`select status::text status, provider_refund_id from public.refunds where id = $1`, [w.refund.id]))).toEqual({ status: 'processed', provider_refund_id: 'rfnd_ALREADYMADE1' });
  });

  it('only an admin can approve; customers and specialists cannot, and nothing is refunded', async () => {
    const w = await cancelledWash();
    const worker = await staffClient('worker');
    expect((await w.cust.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {})).status).toBe(403);
    expect((await worker.c.post(`/api/admin/refunds/${w.refund.id}/approve`, {})).status).toBe(403);
    expect((await new Client().post(`/api/admin/refunds/${w.refund.id}/approve`, {})).status).toBe(401);
    expect([...fake.refunds.values()].filter((x) => x.notes.washo_refund_id === w.refund.id)).toHaveLength(0);
    expect((await dbOne(`select status::text status from public.refunds where id = $1`, [w.refund.id])).status).toBe('requested');
    const admin = await staffClient('admin');
    expect((await admin.c.post(`/api/admin/refunds/not-a-uuid/approve`, {})).status).toBe(400);
  });

  it('an admin can still record a refund they paid by hand in the Razorpay dashboard', async () => {
    const w = await cancelledWash();
    const admin = await staffClient('admin');
    expect((await admin.c.post(`/api/admin/refunds/${w.refund.id}/resolve`, { status: 'processed' })).status).toBe(422);
    expectOk(await admin.c.post(`/api/admin/refunds/${w.refund.id}/resolve`, { status: 'processed', provider_refund_id: 'rfnd_BYHAND0001' }));
    expect(await dbOne(`select status::text status, provider_refund_id from public.refunds where id = $1`, [w.refund.id])).toEqual({ status: 'processed', provider_refund_id: 'rfnd_BYHAND0001' });
    expect([...fake.refunds.values()].filter((r) => r.payment_id === w.paid.razorpay_payment_id)).toHaveLength(0); // nothing sent to Razorpay
  });
});
