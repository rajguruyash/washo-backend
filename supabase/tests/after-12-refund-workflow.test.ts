/** GREEN tests for 20261004000012_refund_workflow.sql: cancel -> full refund REQUEST -> admin approves -> recorded as processed. */
import { describe, expect, it } from 'vitest';
import { PATTERN_3, createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, serviceId, uid } from './helpers';

async function paidWash(s: any, code = 'car-body-wash') {
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId, 'car');
  const date = await istDate(s, 4);
  const svc = await serviceId(s, code);
  await s.as('authenticated', u.authId);
  const intent = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,'morning',null,'P1',null,'website') i`, [veh, svc, date]))[0].i;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  const providerPayment = `pay_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, providerPayment, intent.amount_cents]))[0].r;
  await s.as('postgres');
  return { u, veh, bookingId: r.booking_id as string, paymentId: intent.payment_id as string, providerPayment, amount: intent.amount_cents as number };
}

async function cancelled(s: any) {
  const w = await paidWash(s);
  await s.as('authenticated', w.u.authId);
  expect(await s.err(`select public.cancel_customer_booking('${w.bookingId}','Plans changed')`)).toBeNull();
  await s.as('postgres');
  const refund = (await s.q('select id, amount_cents, status::text status from public.refunds where payment_id=$1', [w.paymentId]))[0];
  return { ...w, refundId: refund.id as string, refund };
}

describe('cancel -> refund request', () => {
  it('cancelling a paid on-demand wash raises a refund request for the FULL amount paid', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      expect(w.refund).toMatchObject({ amount_cents: w.amount, status: 'requested' });
      expect((await s.q(`select event_type from public.booking_events where booking_id=$1 order by created_at, id`, [w.bookingId])).map((e: any) => e.event_type).sort())
        .toEqual(['booking_created', 'cancelled', 'payment_received', 'refund_requested']);
      // nothing has been paid out yet: the payment is still "paid"
      expect((await s.q('select status::text s from public.payments where id=$1', [w.paymentId]))[0].s).toBe('paid');
    }));

  it('membership washes still cannot be cancelled by the customer', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const addr = await createAddress(s, u.profileId);
      const veh = await createVehicle(s, u.profileId, 'car');
      const start = await istDate(s, 4);
      await s.as('authenticated', u.authId);
      const r = (await s.q(`select public.start_membership_checkout($1,$2::jsonb,1,'morning',$3::date,$4,'P1',null) r`, [veh, JSON.stringify(PATTERN_3), start, addr]))[0].r;
      await s.as('service_role');
      const order = `order_${uid().slice(0, 8)}`;
      await s.q('select app_private.attach_provider_order($1,$2)', [r.payment_id, order]);
      const res = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, r.amount_cents]))[0].r;
      await s.as('postgres');
      const wash = (await s.q(`select id from public.bookings where membership_id=$1 order by scheduled_date limit 1`, [res.membership_id]))[0].id;
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${wash}')`)).toMatch(/rescheduled but not cancelled/);
    }));
});

describe('admin approves and the refund is recorded', () => {
  it('only an admin can approve, record or fail a refund', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      const worker = await createWorker(s);
      for (const who of [{ role: 'authenticated', id: w.u.authId }, { role: 'authenticated', id: worker.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toMatch(/admin access required|permission denied/i);
        expect(await s.err(`select public.admin_finish_refund('${w.refundId}','rfnd_123456')`)).toMatch(/admin access required|permission denied/i);
        expect(await s.err(`select public.admin_fail_refund('${w.refundId}','x')`)).toMatch(/admin access required|permission denied/i);
        expect(await s.err(`select public.admin_resolve_refund('${w.refundId}','processed','rfnd_123456')`)).toMatch(/admin access required|permission denied/i);
      }
      await s.as('postgres');
      expect((await s.q('select status::text s from public.refunds where id=$1', [w.refundId]))[0].s).toBe('requested');
    }));

  it('begin claims the refund and returns exactly what Razorpay needs; a second claim is refused', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      const admin = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      const claim = (await s.q('select public.admin_begin_refund($1) r', [w.refundId]))[0].r;
      expect(claim).toMatchObject({ refund_id: w.refundId, amount_cents: w.amount, currency: 'INR', provider_payment_id: w.providerPayment, booking_id: w.bookingId });
      expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toMatch(/already being paid out/);
      // a claim older than two minutes (the server died mid-call) can be taken again
      await s.as('postgres');
      await s.q(`update public.refunds set approved_at = now() - interval '5 minutes' where id=$1`, [w.refundId]);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toBeNull();
    }));

  it('finish records the Razorpay refund id, marks the payment refunded and tells the customer', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      const admin = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      await s.q('select public.admin_begin_refund($1)', [w.refundId]);
      expect((await s.q(`select public.admin_finish_refund($1,'rfnd_ABC12345') r`, [w.refundId]))[0].r).toBe(true);
      // idempotent for the same Razorpay refund
      expect((await s.q(`select public.admin_finish_refund($1,'rfnd_ABC12345') r`, [w.refundId]))[0].r).toBe(true);
      expect(await s.err(`select public.admin_finish_refund('${w.refundId}','rfnd_OTHER999')`)).toMatch(/already processed/);
      expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toMatch(/already processed/);
      await s.as('postgres');
      expect((await s.q('select status::text s, provider_refund_id id from public.refunds where id=$1', [w.refundId]))[0]).toEqual({ s: 'processed', id: 'rfnd_ABC12345' });
      expect((await s.q('select status::text s from public.payments where id=$1', [w.paymentId]))[0].s).toBe('refunded');
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='refunded'`, [w.bookingId]))[0].n).toBe(1);
      // the customer sees the refund, and only their own
      await s.as('authenticated', w.u.authId);
      expect((await s.q('select status::text s from public.refunds where booking_id=$1', [w.bookingId])).map((r: any) => r.s)).toEqual(['processed']);
      const other = await createCustomer(s);
      await s.as('authenticated', other.authId);
      expect(await s.q('select id from public.refunds')).toEqual([]);
    }));

  it('a refund Razorpay refused keeps the reason and can be approved again', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      const admin = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      await s.q('select public.admin_begin_refund($1)', [w.refundId]);
      await s.q(`select public.admin_fail_refund($1,'The payment has not been captured')`, [w.refundId]);
      await s.as('postgres');
      expect((await s.q('select status::text s, failure_reason r from public.refunds where id=$1', [w.refundId]))[0]).toEqual({ s: 'failed', r: 'The payment has not been captured' });
      expect((await s.q('select status::text s from public.payments where id=$1', [w.paymentId]))[0].s).toBe('paid');
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toBeNull(); // straight away: failed is not a live claim
      await s.as('postgres');
      expect((await s.q('select status::text s, failure_reason r from public.refunds where id=$1', [w.refundId]))[0]).toEqual({ s: 'approved', r: null });
    }));

  it('recording a refund paid by hand goes through the same bookkeeping, and needs the Razorpay refund id', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      const admin = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_resolve_refund('${w.refundId}','processed')`)).toMatch(/Razorpay refund id/);
      expect(await s.err(`select public.admin_resolve_refund('${w.refundId}','processed','rfnd_BYHAND1')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select status::text s from public.payments where id=$1', [w.paymentId]))[0].s).toBe('refunded');
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='refunded'`, [w.bookingId]))[0].n).toBe(1);
    }));

  it('a payment with no captured Razorpay payment cannot be refunded through Razorpay', async () =>
    inTx(async (s) => {
      const w = await cancelled(s);
      const admin = await createAdmin(s);
      await s.as('postgres');
      await s.q(`update public.payments set provider_payment_id = null where id=$1`, [w.paymentId]);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_begin_refund('${w.refundId}')`)).toMatch(/no captured Razorpay payment/);
    }));
});
