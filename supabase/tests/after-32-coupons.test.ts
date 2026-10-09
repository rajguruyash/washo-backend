/**
 * GREEN tests for 20261004000032_coupons.sql: a coupon the admin makes (a code and an extra percentage off) that a customer types on the last step. It is its own line on the price,
 * frozen into the quote, counted only when the membership is PAID for, and never refused to someone who had already paid. The mobile app's own `coupons` table is left alone.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, uid, type AdminAccess } from './helpers';

const denied = /your admin role cannot do this|admin access required|permission denied/i;
const as = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);

async function customer(s: any) {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, 'car');
  return { u, addr, veh };
}
/** Makes a coupon as the given role. Returns the coupon as the Admin page sees it. */
async function makeCoupon(s: any, o: { code?: string; pct?: number; label?: string | null; expires?: string | null; max?: number | null; once?: boolean; role?: AdminAccess } = {}) {
  const admin = await createAdmin(s, o.role ?? 'marketing');
  await as(s, admin);
  const code = o.code ?? `EXTRA${uid().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  const r = (await s.q('select public.admin_save_coupon(null,$1,$2,$3,$4::date,$5,$6) r', [code, Math.round((o.pct ?? 5) * 100), o.label ?? null, o.expires ?? null, o.max ?? null, o.once ?? true]))[0].r;
  return { ...r, admin };
}
const estimate = async (s: any, c: { u: { authId: string } }, coupon: string | null, plan = { body: 4, deep: 0, months: 3 }) => {
  await as(s, c.u);
  return (await s.q(`select public.estimate_monthly_price_with_coupon('car'::public.vehicle_type,$1,$2,$3,$4) q`, [plan.body, plan.deep, plan.months, coupon]))[0].q;
};
const estimateErr = async (s: any, c: { u: { authId: string } }, coupon: string | null, plan = { body: 4, deep: 0, months: 3 }) => {
  await as(s, c.u);
  return s.err(`select public.estimate_monthly_price_with_coupon('car'::public.vehicle_type,${plan.body},${plan.deep},${plan.months},$1)`, [coupon]);
};
/** Starts the checkout for a plan with an optional coupon (a car, Monday and Thursday, a month or three). */
async function checkout(s: any, c: { veh: string; addr: string; u: { authId: string } }, coupon: string | null, o: { body?: number; deep?: number; months?: number; weekdays?: number[] } = {}) {
  const start = await istDate(s, 4);
  await as(s, c.u);
  return (await s.q(
    `select public.start_monthly_membership_checkout($1,$2,$3,$4::integer[],$5,'morning',$6::date,$7,'Basement P1',null,null,null,$8) r`,
    [c.veh, o.body ?? 4, o.deep ?? 0, o.weekdays ?? [1, 4], o.months ?? 3, start, c.addr, coupon]
  ))[0].r;
}
async function pay(s: any, intent: any) {
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intent.amount_cents]))[0].r;
  await s.as('postgres');
  return r;
}
const listed = async (s: any, id: string) => {
  const admin = await createAdmin(s, 'super_admin');
  await as(s, admin);
  return (await s.q('select public.admin_list_coupons() r'))[0].r.find((x: any) => x.id === id);
};

describe('who can make coupons', () => {
  it('marketing, operations and the super admin; finance, support, a specialist, a customer and a visitor cannot even look', async () =>
    inTx(async (s) => {
      for (const role of ['marketing', 'operations', 'super_admin'] as AdminAccess[]) {
        const c = await makeCoupon(s, { role });
        expect(c.discount_bp).toBe(500);
        await as(s, c.admin);
        expect((await s.q('select public.admin_list_coupons() r'))[0].r.some((x: any) => x.id === c.id)).toBe(true);
        expect(await s.err('select public.admin_set_coupon_active($1,false)', [c.id])).toBeNull();
        expect((await s.q('select public.admin_coupon_uses($1) r', [c.id]))[0].r).toEqual([]);
      }
      const made = await makeCoupon(s);
      for (const role of ['finance', 'support'] as AdminAccess[]) {
        const a = await createAdmin(s, role);
        await as(s, a);
        for (const sql of ['select public.admin_list_coupons()', `select public.admin_save_coupon(null,'NOPE55',500,null,null,null,true)`, `select public.admin_set_coupon_active('${made.id}',false)`, `select public.admin_coupon_uses('${made.id}')`]) {
          expect(await s.err(sql), `${role}: ${sql}`).toMatch(denied);
        }
      }
      const noRole = await createAdmin(s, null);
      const worker = await createWorker(s);
      const cust = await customer(s);
      for (const who of [noRole, worker, cust.u]) {
        await as(s, who);
        expect(await s.err('select public.admin_list_coupons()')).toMatch(denied);
        expect(await s.err(`select public.admin_save_coupon(null,'NOPE55',500,null,null,null,true)`)).toMatch(denied);
      }
      await s.as('anon');
      expect(await s.err('select public.admin_list_coupons()')).toMatch(/permission denied/i);
    }));

  it('the coupon tables are closed: only the functions read them', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      for (const t of ['membership_coupons', 'membership_coupon_redemptions']) {
        await as(s, c.u);
        expect(await s.err(`select * from public.${t}`)).toMatch(/permission denied/i);
        await s.as('anon');
        expect(await s.err(`select * from public.${t}`)).toMatch(/permission denied/i);
      }
    }));

  it('the mobile app\'s own coupons table and function are not touched', async () =>
    inTx(async (s) => {
      await s.as('postgres');
      const cols = (await s.q(`select column_name from information_schema.columns where table_schema='public' and table_name='coupons' order by 1`)).map((r: any) => r.column_name);
      expect(cols).toEqual(expect.arrayContaining(['code', 'discount_pct', 'description', 'is_active', 'max_uses_per_customer']));
      expect(cols).not.toContain('discount_bp');
      expect((await s.q(`select count(*)::int n from pg_proc where proname = 'validate_coupon'`))[0].n).toBe(1);
    }));
});

describe('making and changing a coupon', () => {
  it('the code is kept in capitals, the percent is 0.01% to 50%, and the same code cannot be made twice (whatever the capitals)', async () =>
    inTx(async (s) => {
      const c = await makeCoupon(s, { code: ' extra5 ', pct: 5, label: 'Word of mouth' });
      expect(c).toMatchObject({ code: 'EXTRA5', discount_bp: 500, label: 'Word of mouth', is_active: true, once_per_customer: true, uses: 0, status: 'live' });
      await as(s, c.admin);
      const save = (code: string, bp: number | null, extra: Partial<{ label: string; expires: string; max: number; once: boolean | null }> = {}) =>
        s.err('select public.admin_save_coupon(null,$1,$2,$3,$4::date,$5,$6)', [code, bp, extra.label ?? null, extra.expires ?? null, extra.max ?? null, extra.once === undefined ? true : extra.once]);
      expect(await save('Extra5', 500)).toMatch(/already exists/);
      expect(await save('ab', 500)).toMatch(/3 to 20 letters and numbers/);
      expect(await save('HAS SPACE', 500)).toMatch(/3 to 20 letters and numbers/);
      expect(await save('NO-DASH', 500)).toMatch(/3 to 20 letters and numbers/);
      expect(await save('A'.repeat(21), 500)).toMatch(/3 to 20 letters and numbers/);
      expect(await save('ZERO00', 0)).toMatch(/between 0.01% and 50%/);
      expect(await save('HUGE00', 5001)).toMatch(/between 0.01% and 50%/);
      expect(await save('NULLPC', null)).toMatch(/between 0.01% and 50%/);
      expect(await save('LONGLB', 500, { label: 'x'.repeat(61) })).toMatch(/60 characters/);
      expect(await save('ZEROUS', 500, { max: 0 })).toMatch(/most uses/);
      expect(await save('NOONCE', 500, { once: null })).toMatch(/once or more than once/);
      expect(await save('OLDDAY', 500, { expires: '2020-01-01' })).toMatch(/cannot be in the past/);
      expect(await save('HALF05', 50)).toBeNull();   // 0.5%
      expect(await save('FIFTY0', 5000)).toBeNull(); // 50%
    }));

  it('can be changed (not its code), switched off and on, and is audited', async () =>
    inTx(async (s) => {
      const c = await makeCoupon(s, { code: 'WELCOME', pct: 5 });
      await as(s, c.admin);
      const next = (await s.q(`select public.admin_save_coupon($1,'welcome',750,'Spring',null,40,false) r`, [c.id]))[0].r;
      expect(next).toMatchObject({ code: 'WELCOME', discount_bp: 750, label: 'Spring', max_uses: 40, once_per_customer: false });
      expect(await s.err(`select public.admin_save_coupon($1,'OTHERCODE',750,null,null,null,true)`, [c.id])).toMatch(/code cannot be changed/);
      expect(await s.err(`select public.admin_save_coupon($1,null,0,null,null,null,true)`, [c.id])).toMatch(/between 0.01% and 50%/);
      expect(await s.err(`select public.admin_save_coupon($1,null,500,null,null,null,true)`, [uid()])).toMatch(/Coupon not found/);
      expect((await s.q('select public.admin_set_coupon_active($1,false) r', [c.id]))[0].r).toMatchObject({ is_active: false, status: 'off' });
      expect((await s.q('select public.admin_set_coupon_active($1,true) r', [c.id]))[0].r).toMatchObject({ is_active: true, status: 'live' });
      expect(await s.err(`select public.admin_set_coupon_active($1,true)`, [uid()])).toMatch(/Coupon not found/);
      expect(await s.err(`select public.admin_set_coupon_active($1,null)`, [c.id])).toMatch(/on or off/);
      await s.as('postgres');
      const events = (await s.q(`select event_type from public.audit_events where entity_type='coupon' and entity_id=$1 `, [c.id])).map((e: any) => e.event_type);
      expect(events.sort()).toEqual(['coupon_changed', 'coupon_created', 'coupon_switched_off', 'coupon_switched_on']);
    }));

  it('status says live, off, expired or used up', async () =>
    inTx(async (s) => {
      const live = await makeCoupon(s, { expires: await istDate(s, 30) });
      expect(live.status).toBe('live');
      const old = await makeCoupon(s);
      await s.as('postgres');
      await s.q(`update public.membership_coupons set expires_on = (now() at time zone 'Asia/Kolkata')::date - 1 where id = $1`, [old.id]);
      expect((await listed(s, old.id)).status).toBe('expired');
      const off = await makeCoupon(s);
      await as(s, off.admin);
      await s.q('select public.admin_set_coupon_active($1,false)', [off.id]);
      expect((await listed(s, off.id)).status).toBe('off');
    }));
});

describe('what the customer sees on the review step', () => {
  it('an extra percentage of the plan price, its own line, on top of the length discount: 4 Body for 3 months', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const none = await estimate(s, c, null);
      expect(none.coupon).toBeUndefined();
      expect(none).toMatchObject({ subtotal_cents: 180000, total_discount_cents: 9000, final_cents: 171000 });
      await makeCoupon(s, { code: 'EXTRA5', pct: 5 });
      const q = await estimate(s, c, ' extra5 ');
      expect(q.coupon).toMatchObject({ code: 'EXTRA5', bp: 500, cents: 9000 });
      expect(q).toMatchObject({ subtotal_cents: 180000, duration_discount: { bp: 500, cents: 9000 }, total_discount_cents: 18000, final_cents: 162000 });
      // nothing typed is the plain price
      expect(await estimate(s, c, '')).toEqual(none);
      expect(await estimate(s, c, '   ')).toEqual(none);
    }));

  it('the coupon comes on top of the 15% cap on the other two discounts: 12 a month for 12 months is 15% + the coupon', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await makeCoupon(s, { code: 'EXTRA10', pct: 10 });
      const q = await estimate(s, c, 'EXTRA10', { body: 12, deep: 0, months: 12 });
      expect(q.cap.applied).toBe(true);
      expect(q.coupon.cents).toBe(Math.round(q.subtotal_cents * 0.1));
      expect(q.total_discount_cents).toBe(Math.round(q.subtotal_cents * 0.15) + q.coupon.cents);
      expect(q.final_cents).toBe(q.subtotal_cents - q.total_discount_cents);
    }));

  it('says why a code cannot be used, in words a customer reads', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await makeCoupon(s, { code: 'GOODONE', pct: 5 });
      const off = await makeCoupon(s, { code: 'SWITCHED', pct: 5 });
      await as(s, off.admin);
      await s.q('select public.admin_set_coupon_active($1,false)', [off.id]);
      const old = await makeCoupon(s, { code: 'OLDONE', pct: 5 });
      await s.as('postgres');
      await s.q(`update public.membership_coupons set expires_on = (now() at time zone 'Asia/Kolkata')::date - 1 where id = $1`, [old.id]);
      const full = await makeCoupon(s, { code: 'FULLONE', pct: 5, max: 1 });
      const other = await customer(s);
      await pay(s, await checkout(s, other, 'FULLONE'));
      expect(await estimateErr(s, c, 'NOSUCHCODE')).toMatch(/That coupon code is not valid/);
      expect(await estimateErr(s, c, 'SWITCHED')).toMatch(/That coupon code is not valid/);
      expect(await estimateErr(s, c, 'a!')).toMatch(/That coupon code is not valid/);
      expect(await estimateErr(s, c, "X' OR 1=1 --")).toMatch(/That coupon code is not valid/);
      expect(await estimateErr(s, c, 'FREEFIRSTWASH')).toMatch(/That coupon code is not valid/);   // the mobile app's coupon is not a membership coupon
      expect(await estimateErr(s, c, 'OLDONE')).toMatch(/That coupon has expired/);
      expect(await estimateErr(s, c, 'FULLONE')).toMatch(/That coupon has been used up/);
      expect(await estimateErr(s, c, 'GOODONE')).toBeNull();
      expect(full.id).toBeTruthy();
    }));

  it('only a signed-in customer can ask: a visitor, a specialist and an admin cannot', async () =>
    inTx(async (s) => {
      await makeCoupon(s, { code: 'EXTRA5' });
      await s.as('anon');
      expect(await s.err(`select public.estimate_monthly_price_with_coupon('car',4,0,3,'EXTRA5')`)).toMatch(/permission denied/i);
      const worker = await createWorker(s);
      const admin = await createAdmin(s, 'super_admin');
      for (const who of [worker, admin]) {
        await as(s, who);
        expect(await s.err(`select public.estimate_monthly_price_with_coupon('car',4,0,3,'EXTRA5')`)).toMatch(/Sign in to use a coupon/);
      }
    }));
});

describe('paying with a coupon', () => {
  it('the payment is the discounted price, the membership keeps the line, and the use is counted once the membership is PAID for', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const coupon = await makeCoupon(s, { code: 'EXTRA5', pct: 5 });
      const intent = await checkout(s, c, 'extra5');
      expect(intent.amount_cents).toBe(162000);
      // an open checkout is not a use
      expect((await listed(s, coupon.id))).toMatchObject({ uses: 0, saved_cents: 0, status: 'live' });
      await s.as('postgres');
      const req = (await s.q('select system_quote, quoted_amount_cents from public.membership_requests where id = $1', [intent.request_id]))[0];
      expect(req.quoted_amount_cents).toBe(162000);
      expect(req.system_quote.coupon).toMatchObject({ code: 'EXTRA5', bp: 500, cents: 9000 });
      const paid = await pay(s, intent);
      const m = (await s.q('select base_amount_cents, discount_amount_cents, final_amount_cents, pricing_snapshot from public.memberships where id = $1', [paid.membership_id]))[0];
      expect(m).toMatchObject({ base_amount_cents: 180000, discount_amount_cents: 18000, final_amount_cents: 162000 });
      expect(m.pricing_snapshot.coupon).toMatchObject({ code: 'EXTRA5', cents: 9000 });
      expect(await s.q('select code, discount_bp, discount_cents, customer_profile_id from public.membership_coupon_redemptions where membership_id = $1', [paid.membership_id])).toEqual([
        { code: 'EXTRA5', discount_bp: 500, discount_cents: 9000, customer_profile_id: c.u.profileId },
      ]);
      expect(await listed(s, coupon.id)).toMatchObject({ uses: 1, saved_cents: 9000 });
      await as(s, (await createAdmin(s, 'marketing')));
      const uses = (await s.q('select public.admin_coupon_uses($1) r', [coupon.id]))[0].r;
      expect(uses).toHaveLength(1);
      expect(uses[0]).toMatchObject({ discount_cents: 9000, plan_cents: 162000, membership_id: paid.membership_id });
    }));

  it('no coupon, no use: a plain checkout pays the plain price and records nothing', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const coupon = await makeCoupon(s, { code: 'EXTRA5' });
      const intent = await checkout(s, c, null);
      expect(intent.amount_cents).toBe(171000);
      const paid = await pay(s, intent);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.membership_coupon_redemptions where membership_id = $1', [paid.membership_id]))[0].n).toBe(0);
      expect((await listed(s, coupon.id)).uses).toBe(0);
    }));

  it('retrying the same plan with the same coupon gives the same payment; a different coupon or none makes a new one', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await makeCoupon(s, { code: 'EXTRA5', pct: 5 });
      await makeCoupon(s, { code: 'BIGGER', pct: 10 });
      const a = await checkout(s, c, 'EXTRA5');
      const again = await checkout(s, c, ' extra5');
      expect(again.payment_id).toBe(a.payment_id);
      const bigger = await checkout(s, c, 'BIGGER');
      expect(bigger.payment_id).not.toBe(a.payment_id);
      expect(bigger.amount_cents).toBe(180000 - 9000 - 18000);
      const none = await checkout(s, c, null);
      expect(none.payment_id).not.toBe(bigger.payment_id);
      expect(none.amount_cents).toBe(171000);
      await s.as('postgres');
      expect((await s.q(`select status from public.payments where id = $1`, [a.payment_id]))[0].status).toBe('failed');
    }));

  it('a bad coupon stops the checkout before any payment is made', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 4);
      await as(s, c.u);
      expect(await s.err(`select public.start_monthly_membership_checkout($1,4,0,ARRAY[1,4]::integer[],3,'morning',$2::date,$3,'P1',null,null,null,'NOSUCHCODE')`, [c.veh, start, c.addr])).toMatch(/That coupon code is not valid/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.payments where customer_profile_id = $1', [c.u.profileId]))[0].n).toBe(0);
    }));

  it('once per customer: a second membership cannot use it again, unless the coupon allows that', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const coupon = await makeCoupon(s, { code: 'ONCEONLY', pct: 5, once: true });
      await pay(s, await checkout(s, c, 'ONCEONLY'));
      const veh2 = await createVehicle(s, c.u.profileId, 'car');
      expect(await estimateErr(s, c, 'ONCEONLY')).toMatch(/already used this coupon/);
      await as(s, coupon.admin);
      await s.q(`select public.admin_save_coupon($1,null,500,null,null,null,false)`, [coupon.id]);
      expect(await estimateErr(s, c, 'ONCEONLY')).toBeNull();
      const second = await checkout(s, { ...c, veh: veh2 }, 'ONCEONLY');
      await pay(s, second);
      expect((await listed(s, coupon.id)).uses).toBe(2);
      // someone else could always use it
      expect(await estimateErr(s, await customer(s), 'ONCEONLY')).toBeNull();
    }));

  it('"most uses" counts paid memberships; a customer who paid after it ran out is never refused, and it is recorded', async () =>
    inTx(async (s) => {
      const coupon = await makeCoupon(s, { code: 'LIMITED', pct: 5, max: 1 });
      const a = await customer(s), b = await customer(s);
      const intentA = await checkout(s, a, 'LIMITED');
      const intentB = await checkout(s, b, 'LIMITED');                 // both opened it while it still had a use left
      await pay(s, intentA);
      expect(await estimateErr(s, await customer(s), 'LIMITED')).toMatch(/used up/);
      expect((await listed(s, coupon.id)).status).toBe('used_up');
      const paidB = await pay(s, intentB);                              // B had already started: the price B saw is honoured
      expect(paidB.membership_id).toBeTruthy();
      expect((await listed(s, coupon.id)).uses).toBe(2);
    }));

  it('switching a coupon off stops new uses but not a checkout already open', async () =>
    inTx(async (s) => {
      const coupon = await makeCoupon(s, { code: 'SOON', pct: 5 });
      const c = await customer(s);
      const intent = await checkout(s, c, 'SOON');
      await as(s, coupon.admin);
      await s.q('select public.admin_set_coupon_active($1,false)', [coupon.id]);
      expect(await estimateErr(s, await customer(s), 'SOON')).toMatch(/not valid/);
      const paid = await pay(s, intent);
      expect(paid.membership_id).toBeTruthy();
      expect((await listed(s, coupon.id)).uses).toBe(1);
    }));

  it('a weekly plan (the older way) has no coupon, and the old functions are untouched', async () =>
    inTx(async (s) => {
      await makeCoupon(s, { code: 'EXTRA5' });
      const c = await customer(s);
      await as(s, c.u);
      const q = (await s.q(`select public.estimate_membership_price('car'::public.vehicle_type, $1::jsonb, 3) q`, [JSON.stringify([{ weekday: 1, kind: 'body' }])]))[0].q;
      expect(q.coupon).toBeUndefined();
    }));
});
