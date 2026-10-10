/**
 * GREEN tests for 20261004000033_coupons_single_wash.sql: a coupon works on memberships, on single washes, or on both, and a single wash can be paid for with one. The single-wash
 * payment function that exists today is left alone (the mobile app may use it); the coupon is taken off that payment, so the settlement and every other rule are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, inTx, istDate, serviceId, uid, type AdminAccess } from './helpers';

const as = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);

async function customer(s: any, vtype: 'bike' | 'car' | 'suv' = 'car') {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, vtype);
  return { u, addr, veh };
}
async function makeCoupon(s: any, o: { code?: string; pct?: number; applies?: 'membership' | 'single' | 'both'; max?: number | null; once?: boolean; role?: AdminAccess } = {}) {
  const admin = await createAdmin(s, o.role ?? 'marketing');
  await as(s, admin);
  const code = o.code ?? `SW${uid().slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  const r = (await s.q('select public.admin_save_coupon(null,$1,$2,null,null,$3,$4,$5) r', [code, Math.round((o.pct ?? 10) * 100), o.max ?? null, o.once ?? true, o.applies ?? 'both']))[0].r;
  return { ...r, admin };
}
const single = async (s: any, c: { u: { authId: string }; veh: string }, code: string | null, svc = 'car-body-wash') => {
  const id = await serviceId(s, svc);
  await as(s, c.u);
  return (await s.q('select public.estimate_single_wash_with_coupon($1,$2,$3) q', [c.veh, id, code]))[0].q;
};
const singleErr = async (s: any, c: { u: { authId: string }; veh: string }, code: string | null, svc = 'car-body-wash') => {
  const id = await serviceId(s, svc);
  await as(s, c.u);
  return s.err('select public.estimate_single_wash_with_coupon($1,$2,$3)', [c.veh, id, code]);
};
/** Starts a single-wash checkout with the coupon function. */
async function intent(s: any, c: { u: { authId: string }; veh: string }, code: string | null, o: { days?: number; svc?: string } = {}) {
  const id = await serviceId(s, o.svc ?? 'car-body-wash');
  const date = await istDate(s, o.days ?? 4);
  await as(s, c.u);
  return (await s.q(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website',$4) r`, [c.veh, id, date, code]))[0].r;
}
async function pay(s: any, i: any) {
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [i.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, i.amount_cents]))[0].r;
  await s.as('postgres');
  return r;
}
const listed = async (s: any, id: string) => {
  const a = await createAdmin(s, 'super_admin');
  await as(s, a);
  return (await s.q('select public.admin_list_coupons() r'))[0].r.find((x: any) => x.id === id);
};
const memberEstimateErr = async (s: any, c: { u: { authId: string } }, code: string) => {
  await as(s, c.u);
  return s.err(`select public.estimate_monthly_price_with_coupon('car'::public.vehicle_type,4,0,3,$1)`, [code]);
};

describe('what a coupon works on', () => {
  it('is chosen when it is made, shown on the Admin page, changeable, and only those three values are allowed', async () =>
    inTx(async (s) => {
      const both = await makeCoupon(s, { applies: 'both' });
      expect(both.applies_to).toBe('both');
      const one = await makeCoupon(s, { applies: 'single' });
      const m = await makeCoupon(s, { applies: 'membership' });
      expect([one.applies_to, m.applies_to]).toEqual(['single', 'membership']);
      await as(s, both.admin);
      expect(await s.err(`select public.admin_save_coupon(null,'BADKIND',500,null,null,null,true,'everything')`)).toMatch(/memberships, single washes or both/);
      expect(await s.err(`select public.admin_save_coupon(null,'NOKIND0',500,null,null,null,true,null)`)).toMatch(/memberships, single washes or both/);
      const changed = (await s.q(`select public.admin_save_coupon($1,null,1000,null,null,null,true,'single') r`, [both.id]))[0].r;
      expect(changed.applies_to).toBe('single');
      await s.as('postgres');
      const ev = await s.q(`select metadata from public.audit_events where entity_id=$1 and event_type='coupon_changed'`, [both.id]);
      expect(ev[0].metadata.from.applies_to).toBe('both');
      expect(ev[0].metadata.to.applies_to).toBe('single');
    }));

  it('a call without it (the website that is live today) makes a memberships coupon, as every coupon made before this did', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s, 'marketing');
      await as(s, admin);
      const r = (await s.q(`select public.admin_save_coupon(null,'OLDCALL',500,null,null,null,true) r`))[0].r;
      expect(r.applies_to).toBe('membership');
    }));

  it('a coupon for single washes is refused on a membership, and one for memberships is refused on a single wash, in plain words; "both" works on each', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const sw = await makeCoupon(s, { code: 'SINGLEONLY', applies: 'single' });
      const mb = await makeCoupon(s, { code: 'MEMBERONLY', applies: 'membership' });
      const both = await makeCoupon(s, { code: 'BOTHKINDS', applies: 'both' });
      expect(await memberEstimateErr(s, c, 'SINGLEONLY')).toMatch(/That coupon is for single washes only/);
      expect(await singleErr(s, c, 'MEMBERONLY')).toMatch(/That coupon is for memberships only/);
      expect(await memberEstimateErr(s, c, 'MEMBERONLY')).toBeNull();
      expect(await singleErr(s, c, 'SINGLEONLY')).toBeNull();
      expect(await memberEstimateErr(s, c, 'BOTHKINDS')).toBeNull();
      expect(await singleErr(s, c, 'BOTHKINDS')).toBeNull();
      expect([sw.id, mb.id, both.id].every(Boolean)).toBe(true);
    }));
});

describe('the single-wash price with a coupon', () => {
  it('is the rate-card price less the percentage, as its own number; no coupon (or nothing typed) is the plain price', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await makeCoupon(s, { code: 'EXTRA5', pct: 5, applies: 'single' });
      expect(await single(s, c, null)).toEqual({ list_cents: 15000, final_cents: 15000 });
      expect(await single(s, c, '  ')).toEqual({ list_cents: 15000, final_cents: 15000 });
      const q = await single(s, c, ' extra5 ');
      expect(q).toMatchObject({ list_cents: 15000, final_cents: 14250, coupon: { code: 'EXTRA5', bp: 500, cents: 750 } });
      const deep = await single(s, c, 'EXTRA5', 'car-deep-cleaning');
      expect(deep.list_cents).toBe(22000);
      expect(deep.coupon.cents).toBe(1100);
      expect(deep.final_cents).toBe(20900);
    }));

  it('rounds half up to the paisa, never takes it below Rs 1, and says why a code cannot be used', async () =>
    inTx(async (s) => {
      const bike = await customer(s, 'bike');
      await makeCoupon(s, { code: 'SEVENHALF', pct: 7.5, applies: 'both' });   // 7.5% of 6500 = 487.5
      const q = await single(s, bike, 'SEVENHALF', 'bike-body-wash');
      expect(q.coupon.cents).toBe(488);
      expect(q.final_cents).toBe(6500 - 488);
      const off = await makeCoupon(s, { code: 'SWITCHEDOFF', applies: 'both' });
      await as(s, off.admin);
      await s.q('select public.admin_set_coupon_active($1,false)', [off.id]);
      expect(await singleErr(s, bike, 'SWITCHEDOFF', 'bike-body-wash')).toMatch(/That coupon code is not valid/);
      expect(await singleErr(s, bike, 'NOSUCHCODE', 'bike-body-wash')).toMatch(/That coupon code is not valid/);
      expect(await singleErr(s, bike, 'FREEFIRSTWASH', 'bike-body-wash')).toMatch(/That coupon code is not valid/);   // the mobile app's own coupon
      expect(await singleErr(s, bike, "x'; drop table--", 'bike-body-wash')).toMatch(/That coupon code is not valid/);
    }));

  it('only for the signed-in customer\'s own vehicle and a service that fits it; not for a visitor', async () =>
    inTx(async (s) => {
      const a = await customer(s), b = await customer(s);
      await makeCoupon(s, { code: 'EXTRA5', applies: 'both' });
      const bodyId = await serviceId(s, 'car-body-wash');
      await as(s, a.u);
      expect(await s.err('select public.estimate_single_wash_with_coupon($1,$2,$3)', [b.veh, bodyId, 'EXTRA5'])).toMatch(/Vehicle not found/);
      const bikeId = await serviceId(s, 'bike-body-wash');
      await as(s, a.u);
      expect(await s.err('select public.estimate_single_wash_with_coupon($1,$2,$3)', [a.veh, bikeId, 'EXTRA5'])).toMatch(/not available for your vehicle/);
      await s.as('anon');
      expect(await s.err('select public.estimate_single_wash_with_coupon($1,$2,$3)', [a.veh, bodyId, 'EXTRA5'])).toMatch(/permission denied/i);
    }));
});

describe('paying for a single wash with a coupon', () => {
  it('the payment is the discounted amount, the wash is booked at it, and the use is counted when it is PAID', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const coupon = await makeCoupon(s, { code: 'EXTRA5', pct: 5, applies: 'single' });
      const i = await intent(s, c, 'extra5');
      expect(i).toMatchObject({ amount_cents: 14250, list_price_cents: 15000, coupon: { code: 'EXTRA5', cents: 750 } });
      await s.as('postgres');
      const p = (await s.q('select amount_cents, intent from public.payments where id=$1', [i.payment_id]))[0];
      expect(p.amount_cents).toBe(14250);
      expect(p.intent.coupon).toMatchObject({ code: 'EXTRA5', bp: 500, cents: 750 });
      expect(p.intent.list_price_cents).toBe(15000);
      expect((await listed(s, coupon.id)).uses).toBe(0);                      // an open checkout is not a use
      const paid = await pay(s, i);
      expect(paid.status).toBe('fulfilled');
      const b = (await s.q('select price_cents, booking_type::text t from public.bookings where id=$1', [paid.booking_id]))[0];
      expect(b).toEqual({ price_cents: 14250, t: 'on_demand' });
      expect(await s.q('select code, discount_cents, membership_id, customer_profile_id from public.membership_coupon_redemptions where booking_id=$1', [paid.booking_id])).toEqual([
        { code: 'EXTRA5', discount_cents: 750, membership_id: null, customer_profile_id: c.u.profileId },
      ]);
      expect(await listed(s, coupon.id)).toMatchObject({ uses: 1, saved_cents: 750 });
      const a = await createAdmin(s, 'marketing');
      await as(s, a);
      const uses = (await s.q('select public.admin_coupon_uses($1) r', [coupon.id]))[0].r;
      expect(uses).toHaveLength(1);
      expect(uses[0]).toMatchObject({ kind: 'single', discount_cents: 750, plan_cents: 14250, booking_id: paid.booking_id, reference_code: expect.stringMatching(/./) });
    }));

  it('no coupon: the payment is the plain price and nothing is recorded; the existing function still works exactly as before', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const coupon = await makeCoupon(s, { code: 'EXTRA5' });
      const i = await intent(s, c, null);
      expect(i.amount_cents).toBe(15000);
      expect(i.coupon).toBeUndefined();
      const paid = await pay(s, i);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.membership_coupon_redemptions where booking_id=$1', [paid.booking_id]))[0].n).toBe(0);
      expect((await listed(s, coupon.id)).uses).toBe(0);
      // the function the mobile app may call, untouched
      const veh2 = await createVehicle(s, c.u.profileId, 'car');
      const id = await serviceId(s, 'car-body-wash');
      const date = await istDate(s, 5);
      await as(s, c.u);
      const old = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,'morning',null,'P1',null,'website') r`, [veh2, id, date]))[0].r;
      expect(old.amount_cents).toBe(15000);
    }));

  it('a coupon that cannot be used stops the checkout before any payment exists', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await makeCoupon(s, { code: 'MEMBERONLY', applies: 'membership' });
      const id = await serviceId(s, 'car-body-wash');
      const date = await istDate(s, 4);
      await as(s, c.u);
      expect(await s.err(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website',$4)`, [c.veh, id, date, 'MEMBERONLY'])).toMatch(/for memberships only/);
      expect(await s.err(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website',$4)`, [c.veh, id, date, 'NOSUCHCODE'])).toMatch(/not valid/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.payments where customer_profile_id=$1', [c.u.profileId]))[0].n).toBe(0);
    }));

  it('the other checks of a single wash still apply with a coupon (a taken day, a start that is too soon, someone else\'s vehicle)', async () =>
    inTx(async (s) => {
      const c = await customer(s), other = await customer(s);
      await makeCoupon(s, { code: 'EXTRA5', applies: 'both' });
      const id = await serviceId(s, 'car-body-wash');
      const date = await istDate(s, 4);
      const later = await istDate(s, 6);
      await as(s, c.u);
      await s.q(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website',$4)`, [c.veh, id, date, 'EXTRA5']);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'morning','confirmed')`, [c.u.profileId, c.veh, id, date]);
      await as(s, c.u);
      expect(await s.err(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website',$4)`, [c.veh, id, date, 'EXTRA5'])).toMatch(/already has a wash/);
      expect(await s.err(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website',$4)`, [other.veh, id, later, 'EXTRA5'])).toMatch(/Vehicle not found/);
      await as(s, c.u);
      expect(await s.err(`select public.create_booking_payment_intent_with_coupon($1,$2,(now() at time zone 'Asia/Kolkata')::date - 1,'morning',null,'P1',null,'website',$3)`, [c.veh, id, 'EXTRA5'])).toMatch(/too soon/);
    }));

  it('once per customer counts across single washes and memberships; the most uses counts paid ones; a payment already started is honoured', async () =>
    inTx(async (s) => {
      const a = await customer(s), b = await customer(s);
      const once = await makeCoupon(s, { code: 'ONCEEACH', applies: 'both', once: true });
      await pay(s, await intent(s, a, 'ONCEEACH'));
      expect(await singleErr(s, a, 'ONCEEACH')).toMatch(/already used this coupon/);
      expect(await memberEstimateErr(s, a, 'ONCEEACH')).toMatch(/already used this coupon/);   // used on a single wash: used
      expect(await singleErr(s, b, 'ONCEEACH')).toBeNull();                                    // someone else may
      await as(s, once.admin);
      await s.q(`select public.admin_save_coupon($1,null,1000,null,null,null,false,'both')`, [once.id]);
      expect(await singleErr(s, a, 'ONCEEACH')).toBeNull();                                    // switched to "can use again"

      const limited = await makeCoupon(s, { code: 'JUSTONE', applies: 'single', max: 1 });
      const x = await customer(s), y = await customer(s);
      const ix = await intent(s, x, 'JUSTONE'), iy = await intent(s, y, 'JUSTONE', { days: 5 });   // both started it while it had a use left
      await pay(s, ix);
      expect(await singleErr(s, await customer(s), 'JUSTONE')).toMatch(/used up/);
      expect((await listed(s, limited.id)).status).toBe('used_up');
      const paidY = await pay(s, iy);                                                        // y had already started: honoured
      expect(paidY.status).toBe('fulfilled');
      expect((await listed(s, limited.id)).uses).toBe(2);
    }));

  it('a coupon works on a membership and a single wash and each use is told apart on the Admin page', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const coupon = await makeCoupon(s, { code: 'EITHER', pct: 5, applies: 'both', once: false });
      const start = await istDate(s, 4);
      await as(s, c.u);
      const m = (await s.q(`select public.start_monthly_membership_checkout($1,4,0,ARRAY[1,4]::integer[],3,'morning',$2::date,$3,'P1',null,null,null,'EITHER') r`, [c.veh, start, c.addr]))[0].r;
      await pay(s, m);
      const veh2 = await createVehicle(s, c.u.profileId, 'car');
      await pay(s, await intent(s, { u: c.u, veh: veh2 }, 'EITHER', { days: 6 }));
      const a = await createAdmin(s, 'super_admin');
      await as(s, a);
      const uses = (await s.q('select public.admin_coupon_uses($1) r', [coupon.id]))[0].r;
      expect(uses.map((u: any) => u.kind).sort()).toEqual(['membership', 'single']);
      expect((await listed(s, coupon.id)).uses).toBe(2);
    }));
});

describe('who can do what', () => {
  it('the single-wash coupon functions are for signed-in customers only; the redemption table stays closed', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await makeCoupon(s, { code: 'EXTRA5', applies: 'both' });
      const id = await serviceId(s, 'car-body-wash');
      const date = await istDate(s, 4);
      await s.as('anon');
      expect(await s.err(`select public.create_booking_payment_intent_with_coupon($1,$2,$3::date,'morning',null,'P1',null,'website','EXTRA5')`, [c.veh, id, date])).toMatch(/permission denied/i);
      const admin = await createAdmin(s, 'super_admin');
      await as(s, admin);
      expect(await s.err(`select public.estimate_single_wash_with_coupon($1,$2,'EXTRA5')`, [c.veh, id])).toMatch(/Sign in to use a coupon|permission denied/i);
      await as(s, c.u);
      expect(await s.err('select * from public.membership_coupon_redemptions')).toMatch(/permission denied/i);
    }));
});
