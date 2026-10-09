/**
 * Coupons over HTTP: the admin makes a code worth an extra percentage off (Marketing, Operations, the super admin), a customer types it on the review step, the price and the
 * Razorpay amount carry it as its own line, and it is counted when the membership is paid for. Razorpay is a local stand-in; the database rules are real.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

let forgetCouponTries: () => void;
beforeAll(async () => {
  await boot();
  ({ forgetCouponTries } = await import('../src/couponGuard'));
});
afterAll(shutdown);
beforeEach(() => forgetCouponTries());

type Role = 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support';
const staff = (access: Role) => staffClient('admin', { access });
const code = () => `EX${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const dbRows = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows;

const make = async (o: { code?: string; percent?: number; role?: Role; max_uses?: number | null; once_per_customer?: boolean; expires_on?: string | null; label?: string | null } = {}) => {
  const admin = await staff(o.role ?? 'marketing');
  const c = o.code ?? code();
  const r = expectOk(await admin.c.post('/api/admin/coupons', { code: c, discount_bp: Math.round((o.percent ?? 5) * 100), max_uses: o.max_uses ?? null, once_per_customer: o.once_per_customer ?? true, expires_on: o.expires_on ?? null, label: o.label ?? null })).body.coupon;
  return { ...r, admin };
};
const plan = { body: 4, deep: 0, weekdays: [1, 4] };
const estimate = (c: Client, coupon?: string, o: Record<string, unknown> = {}) => c.post('/api/membership-estimate', { vehicle_type: 'car', monthly: { body: 4, deep: 0 }, duration_months: 3, ...(coupon === undefined ? {} : { coupon }), ...o });
const checkout = (c: Client, v: { vehicle: { id: string }; addr: { id: string } }, coupon?: string, o: Record<string, unknown> = {}) =>
  c.post('/api/payments/membership-checkout', { vehicle_id: v.vehicle.id, address_id: v.addr.id, monthly: plan, duration_months: 3, time_slot: 'morning', start_date: istDate(4), ...(coupon === undefined ? {} : { coupon }), ...o });

describe('who can make coupons', () => {
  it('marketing, operations and the super admin; everyone else is refused, and so is a visitor', async () => {
    for (const role of ['marketing', 'operations', 'super_admin'] as Role[]) {
      const c = await make({ role });
      expect(c).toMatchObject({ discount_bp: 500, is_active: true, uses: 0, status: 'live' });
      expect(expectOk(await c.admin.c.get('/api/admin/coupons')).body.coupons.some((x: any) => x.id === c.id)).toBe(true);
    }
    const body = { code: code(), discount_bp: 500, once_per_customer: true };
    for (const role of ['finance', 'support'] as Role[]) {
      const a = await staff(role);
      expect((await a.c.get('/api/admin/coupons')).status).toBe(403);
      expect((await a.c.post('/api/admin/coupons', body)).status).toBe(403);
    }
    const cust = await customerWithVehicle('car');
    expect((await cust.c.get('/api/admin/coupons')).status).toBe(403);
    expect((await cust.c.post('/api/admin/coupons', body)).status).toBe(403);
    expect((await new Client().get('/api/admin/coupons')).status).toBe(401);
    expect((await new Client().post('/api/admin/coupons', body)).status).toBe(401);
  });

  it('makes, changes and switches off a coupon; says what is wrong in plain words; the code is kept in capitals', async () => {
    const m = await staff('marketing');
    const made = expectOk(await m.c.post('/api/admin/coupons', { code: ' extra5 ', discount_bp: 500, label: 'Word of mouth', once_per_customer: true })).body.coupon;
    expect(made.code).toBe('EXTRA5');
    const bad = async (body: Record<string, unknown>) => (await m.c.post('/api/admin/coupons', { code: code(), discount_bp: 500, once_per_customer: true, ...body }));
    expect((await bad({ code: 'extra5' })).status).toBe(422);                     // the same code twice
    expect((await bad({ code: 'extra5' })).body.message).toBe('A coupon with that code already exists');
    expect(JSON.stringify((await bad({ code: 'ab' })).body)).toMatch(/3 to 20 letters and numbers/);
    expect((await bad({ code: 'has space' })).status).toBe(422);
    expect((await bad({ discount_bp: 0 })).status).toBe(400);
    expect((await bad({ discount_bp: 5001 })).status).toBe(400);
    expect((await bad({ discount_bp: 'five' })).status).toBe(400);
    expect((await bad({ max_uses: 0 })).status).toBe(400);
    expect((await bad({ label: 'x'.repeat(61) })).status).toBe(400);
    expect((await bad({ expires_on: '2020-01-01' })).status).toBe(422);
    expect((await bad({ expires_on: 'soon' })).status).toBe(400);

    const next = expectOk(await m.c.put(`/api/admin/coupons/${made.id}`, { discount_bp: 750, label: 'Spring', max_uses: 25, once_per_customer: false })).body.coupon;
    expect(next).toMatchObject({ code: 'EXTRA5', discount_bp: 750, label: 'Spring', max_uses: 25, once_per_customer: false });
    expect((await m.c.put(`/api/admin/coupons/${made.id}`, { code: 'ANOTHER', discount_bp: 750, once_per_customer: false })).status).toBe(422);
    expect((await m.c.put(`/api/admin/coupons/${crypto.randomUUID()}`, { discount_bp: 750, once_per_customer: false })).status).toBe(404);
    expect((await m.c.put('/api/admin/coupons/not-an-id', { discount_bp: 750 })).status).toBe(400);
    expect(expectOk(await m.c.post(`/api/admin/coupons/${made.id}/active`, { active: false })).body.coupon).toMatchObject({ is_active: false, status: 'off' });
    expect(expectOk(await m.c.post(`/api/admin/coupons/${made.id}/active`, { active: true })).body.coupon.status).toBe('live');
    expect((await m.c.post(`/api/admin/coupons/${made.id}/active`, { active: 'yes' })).status).toBe(400);
    const events = (await dbRows(`select event_type from public.audit_events where entity_type = 'coupon' and entity_id = $1`, [made.id])).map((e) => e.event_type).sort();
    expect(events).toEqual(['coupon_changed', 'coupon_created', 'coupon_switched_off', 'coupon_switched_on']);
  });
});

describe('the review step', () => {
  it('shows the coupon as its own line and the price with it; no coupon is the plain price; only a signed-in customer can ask', async () => {
    const c = await make({ code: `EXTRA${crypto.randomBytes(2).toString('hex').toUpperCase()}`, percent: 5 });
    const cust = await customerWithVehicle('car');
    const plain = expectOk(await estimate(cust.c)).body.estimate;
    expect(plain).toMatchObject({ subtotal_cents: 180000, final_cents: 171000 });
    expect(plain.coupon).toBeUndefined();
    const withCoupon = expectOk(await estimate(cust.c, ` ${c.code.toLowerCase()} `)).body.estimate;
    expect(withCoupon.coupon).toMatchObject({ code: c.code, bp: 500, cents: 9000 });
    expect(withCoupon).toMatchObject({ total_discount_cents: 18000, final_cents: 162000 });
    expect(expectOk(await estimate(cust.c, '')).body.estimate).toEqual(plain);

    const visitor = await estimate(new Client(), c.code);
    expect(visitor.status).toBe(401);
    // a coupon is for a plan chosen as washes a month
    const weekly = await cust.c.post('/api/membership-estimate', { vehicle_type: 'car', weekly_pattern: [{ weekday: 1, kind: 'body' }], duration_months: 3, coupon: c.code });
    expect(weekly.status).toBe(400);
    // a visitor's plain price still works, and is not changed by there being coupons
    expect(expectOk(await estimate(new Client())).body.estimate.final_cents).toBe(171000);
  });

  it('says why a code cannot be used', async () => {
    const cust = await customerWithVehicle('car');
    const off = await make();
    expectOk(await off.admin.c.post(`/api/admin/coupons/${off.id}/active`, { active: false }));
    const old = await make();
    await fake.admin.query(`update public.membership_coupons set expires_on = (now() at time zone 'Asia/Kolkata')::date - 1 where id = $1`, [old.id]);
    const msg = async (coupon: string) => (await estimate(cust.c, coupon));
    expect((await msg('NOSUCHCODE')).status).toBe(422);
    expect((await msg('NOSUCHCODE')).body.message).toBe('That coupon code is not valid');
    expect((await msg(off.code)).body.message).toBe('That coupon code is not valid');
    expect((await msg(old.code)).body.message).toBe('That coupon has expired');
    expect((await msg('FREEFIRSTWASH')).body.message).toBe('That coupon code is not valid');   // the mobile app's own coupon
    expect((await msg('no way!')).body.message).toBe('That coupon code is not valid');
    expect((await estimate(cust.c, 'x'.repeat(31))).status).toBe(400);
  });

  it('guessing is slowed down: after 10 codes that did not work the customer is asked to wait; a code that works never counts', async () => {
    const good = await make();
    const cust = await customerWithVehicle('car');
    for (let i = 0; i < 12; i++) expectOk(await estimate(cust.c, good.code));
    for (let i = 0; i < 10; i++) expect((await estimate(cust.c, `WRONG${i}XX`)).status).toBe(422);
    const blocked = await estimate(cust.c, `WRONG99XX`);
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/wait a few minutes/);
    expect((await estimate(cust.c, good.code)).status).toBe(429);   // even the right code, while waiting
    expectOk(await estimate(cust.c));                                // the plain price is never held back
    // someone else is not affected
    const other = await customerWithVehicle('car');
    expectOk(await estimate(other.c, good.code));
  });
});

describe('paying with a coupon', () => {
  it('Razorpay is asked for the discounted amount, the use is counted when it is PAID, and the Admin page shows who used it', async () => {
    const c = await make({ percent: 5 });
    const cust = await customerWithVehicle('car');
    const order = expectOk(await checkout(cust.c, cust, ` ${c.code.toLowerCase()}`)).body.order;
    expect(order.amount).toBe(162000);
    expect((await dbRows('select uses from (select count(*)::int uses from public.membership_coupon_redemptions where coupon_id = $1) x', [c.id]))[0].uses).toBe(0);
    const paid = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    expect(paid.membership_id).toBeTruthy();
    const listed = expectOk(await c.admin.c.get('/api/admin/coupons')).body.coupons.find((x: any) => x.id === c.id);
    expect(listed).toMatchObject({ uses: 1, saved_cents: 9000 });
    const uses = expectOk(await c.admin.c.get(`/api/admin/coupons/${c.id}/uses`)).body.uses;
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ discount_cents: 9000, plan_cents: 162000 });
    // the customer's membership shows the line
    const m = expectOk(await cust.c.get(`/api/memberships/${paid.membership_id}`)).body.membership;
    expect(m.pricing_snapshot.coupon).toMatchObject({ code: c.code, cents: 9000 });
    // a finance admin cannot see who used it
    expect((await (await staff('finance')).c.get(`/api/admin/coupons/${c.id}/uses`)).status).toBe(403);
  });

  it('a checkout with no coupon is exactly the plain price; a bad coupon stops it before any payment; a coupon with an older weekly plan is refused', async () => {
    const cust = await customerWithVehicle('car');
    const plainOrder = expectOk(await checkout(cust.c, cust)).body.order;
    expect(plainOrder.amount).toBe(171000);
    const bad = await checkout(cust.c, cust, 'NOSUCHCODE');
    expect(bad.status).toBe(422);
    expect(bad.body.message).toBe('That coupon code is not valid');
    const weekly = await cust.c.post('/api/payments/membership-checkout', { vehicle_id: cust.vehicle.id, address_id: cust.addr.id, weekly_pattern: [{ weekday: 1, kind: 'body' }], duration_months: 3, time_slot: 'morning', start_date: istDate(4), coupon: 'EXTRA5' });
    expect(weekly.status).toBe(400);
  });

  it('once per customer, and the most uses, are enforced over HTTP', async () => {
    const once = await make({ percent: 5, once_per_customer: true });
    const cust = await customerWithVehicle('car');
    expectOk(await cust.c.post('/api/payments/verify', fake.checkout(expectOk(await checkout(cust.c, cust, once.code)).body.order.order_id)));
    const again = await estimate(cust.c, once.code);
    expect(again.status).toBe(422);
    expect(again.body.message).toBe('You have already used this coupon');
    expectOk(await estimate((await customerWithVehicle('car')).c, once.code));

    const one = await make({ percent: 5, max_uses: 1 });
    const a = await customerWithVehicle('car');
    expectOk(await a.c.post('/api/payments/verify', fake.checkout(expectOk(await checkout(a.c, a, one.code)).body.order.order_id)));
    const b = await customerWithVehicle('car');
    const full = await estimate(b.c, one.code);
    expect(full.status).toBe(422);
    expect(full.body.message).toBe('That coupon has been used up');
    expect(expectOk(await one.admin.c.get('/api/admin/coupons')).body.coupons.find((x: any) => x.id === one.id).status).toBe('used_up');
  });
});
