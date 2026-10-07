/** GREEN tests for 20261004000011_direct_membership_checkout.sql: pay directly, no WASHO approval step. */
import { describe, expect, it } from 'vitest';
import { PATTERN_3, createAddress, createCustomer, createVehicle, inTx, istDate, uid } from './helpers';

async function setup(s: any, vtype: 'bike' | 'car' | 'suv' = 'car') {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, vtype);
  const start = await istDate(s, 4);
  return { u, addr, veh, start };
}
const checkout = async (s: any, c: any, o: { pattern?: unknown[]; months?: number; slot?: string; start?: string; veh?: string } = {}) => {
  await s.as('authenticated', c.u.authId);
  return (await s.q(`select public.start_membership_checkout($1,$2::jsonb,$3,$4::public.time_slot,$5::date,$6,'Basement P1','Gate 4321') r`,
    [o.veh ?? c.veh, JSON.stringify(o.pattern ?? PATTERN_3), o.months ?? 1, o.slot ?? 'morning', o.start ?? c.start, c.addr]))[0].r;
};
const settle = async (s: any, order: string, cents: number, profile: string, status = 'captured') => {
  await s.as('service_role');
  return (await s.q(`select app_private.settle_payment($1,$2,$3,'INR',$4,$5) r`, [order, `pay_${uid().slice(0, 8)}`, cents, status, profile]))[0].r;
};
const attach = async (s: any, paymentId: string) => {
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [paymentId, order]);
  return order;
};

describe('start_membership_checkout', () => {
  it('prices from the rate card and opens a pending payment in one call; nothing is created for the customer yet', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const r = await checkout(s, c);
      // 3 a week (Body, Deep, Body), 1 month: 8 x 150 + 4 x 220 = 2080, minus 10% = 1872
      expect(r).toMatchObject({ amount_cents: 187200, currency: 'INR' });
      expect(r.payment_id).toBeTruthy();
      expect(r.receipt).toMatch(/^MR-/);
      await s.as('postgres');
      const req = (await s.q('select status, quoted_amount_cents, reviewed_by_profile_id, quoted_breakdown from public.membership_requests where id=$1', [r.request_id]))[0];
      expect(req).toMatchObject({ status: 'accepted', quoted_amount_cents: 187200, reviewed_by_profile_id: null });
      expect(req.quoted_breakdown).toMatchObject({ subtotal_cents: 208000, final_cents: 187200, adjustment: { cents: 0 } });
      expect((await s.q('select count(*)::int n from public.memberships'))[0].n).toBe(0);
      expect((await s.q('select count(*)::int n from public.bookings'))[0].n).toBe(0);
      const pay = (await s.q('select status::text s, amount_cents, payment_kind, fulfilment_status from public.payments where id=$1', [r.payment_id]))[0];
      expect(pay).toEqual({ s: 'pending', amount_cents: 187200, payment_kind: 'membership', fulfilment_status: 'pending' });
    }));

  it('verified payment activates the membership and schedules every wash, with no admin step at all', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const r = await checkout(s, c, { pattern: [1, 2, 3, 4, 5].map((d, i) => ({ weekday: d, kind: i % 2 ? 'deep' : 'body' })), months: 3 });
      const order = await attach(s, r.payment_id);
      const res = await settle(s, order, r.amount_cents, c.u.profileId);
      expect(res.status).toBe('fulfilled');
      await s.as('postgres');
      const m = (await s.q('select status, duration_months, quantity_per_period, final_amount_cents from public.memberships where id=$1', [res.membership_id]))[0];
      expect(m).toMatchObject({ status: 'active', duration_months: 3, quantity_per_period: 20, final_amount_cents: r.amount_cents });
      expect((await s.q(`select count(*)::int n from public.bookings where membership_id=$1 and status='confirmed'`, [res.membership_id]))[0].n).toBe(60);
      expect((await s.q('select status from public.membership_requests where id=$1', [r.request_id]))[0].status).toBe('active');
    }));

  it('a double-tap or a refresh with the same plan returns the SAME open payment', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const a = await checkout(s, c);
      const orderA = await attach(s, a.payment_id);
      const b = await checkout(s, c);
      expect(b.payment_id).toBe(a.payment_id);
      expect(b.request_id).toBe(a.request_id);
      expect(b.provider_order_id).toBe(orderA); // the Razorpay order is reused
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.membership_requests where status in ('submitted','quoted','accepted')`))[0].n).toBe(1);
    }));

  it('a different plan for the same vehicle replaces the unfinished one; a late payment for the old one becomes a refund request, never a lost payment', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const first = await checkout(s, c);
      const oldOrder = await attach(s, first.payment_id);
      const second = await checkout(s, c, { months: 6 });
      expect(second.payment_id).not.toBe(first.payment_id);
      await s.as('postgres');
      expect((await s.q('select status from public.membership_requests where id=$1', [first.request_id]))[0].status).toBe('cancelled');
      expect((await s.q('select status::text s from public.payments where id=$1', [first.payment_id]))[0].s).toBe('failed');
      expect((await s.q(`select count(*)::int n from public.membership_requests where vehicle_id=$1 and status in ('submitted','quoted','accepted')`, [c.veh]))[0].n).toBe(1);

      const late = await settle(s, oldOrder, first.amount_cents, c.u.profileId);
      expect(late.status).toBe('unfulfilled');
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.refunds where payment_id=$1', [first.payment_id]))[0].n).toBe(1);
      expect((await s.q('select count(*)::int n from public.memberships'))[0].n).toBe(0);
    }));

  it('replaces an older request that was waiting for WASHO to quote it', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      await s.as('authenticated', c.u.authId);
      const old = (await s.q(`select public.create_membership_request($1,$2::jsonb,1,'morning',$3::date,$4,'P1') id`, [c.veh, JSON.stringify(PATTERN_3), c.start, c.addr]))[0].id;
      const r = await checkout(s, c);
      await s.as('postgres');
      expect((await s.q('select status from public.membership_requests where id=$1', [old]))[0].status).toBe('cancelled');
      expect(r.request_id).not.toBe(old);
    }));

  it('enforces the same rules as a request: ownership, one wash per day, 1 to 7 a week, start notice', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const other = await setup(s);
      const err = async (o: any) => { await s.as('authenticated', c.u.authId); return s.err(`select public.start_membership_checkout('${o.veh ?? c.veh}','${JSON.stringify(o.pattern ?? PATTERN_3)}'::jsonb,${o.months ?? 1},'morning','${o.start ?? c.start}'::date,'${c.addr}')`); };
      expect(await err({ veh: other.veh })).toMatch(/Vehicle not found/);
      expect(await err({ pattern: [{ weekday: 1, kind: 'deep' }, { weekday: 1, kind: 'body' }] })).toMatch(/different day/);
      expect(await err({ months: 2 })).toMatch(/1, 3, 6 or 12 months/);
      expect(await err({ start: await istDate(s, 0) })).toMatch(/can start from/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.payments'))[0].n).toBe(0); // nothing half-created
    }));

  it('works for 7 a week and for bikes; anonymous and non-customers cannot use it', async () =>
    inTx(async (s) => {
      const bike = await setup(s, 'bike');
      const r = await checkout(s, bike, { pattern: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, kind: 'body' })) });
      // 7 a week, 4 weeks, bike: 28 x 65 = 1820, minus 10% = 1638
      expect(r.amount_cents).toBe(163800);
      await s.as('anon');
      expect(await s.err(`select public.start_membership_checkout('${bike.veh}','${JSON.stringify(PATTERN_3)}'::jsonb,1,'morning','${bike.start}'::date)`)).toMatch(/permission denied/);
    }));
});
