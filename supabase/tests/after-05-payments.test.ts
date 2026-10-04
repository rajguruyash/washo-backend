/** GREEN tests for 20261004000005_payment_intents_and_settlement.sql */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, serviceId, uid } from './helpers';

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const PATTERN_3 = [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }];

/** Customer + vehicle + an on-demand payment intent with an attached Razorpay order. */
async function onDemand(s: any, o: { vtype?: 'bike' | 'car' | 'suv'; code?: string; days?: number; slot?: string } = {}) {
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId, o.vtype ?? 'car');
  const svc = await serviceId(s, o.code ?? 'car-body-wash');
  const date = await istDate(s, o.days ?? 4);
  await s.as('authenticated', u.authId);
  const intent = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,$4::public.time_slot,null,'Basement P1',null,'website') i`, [veh, svc, date, o.slot ?? 'morning']))[0].i;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
  return { u, veh, svc, date, intent, order };
}

const settle = async (s: any, order: string, o: { pid?: string; cents?: number; cur?: string; status?: string; as?: string | null } = {}) => {
  await s.as('service_role');
  const r = await s.q(`select app_private.settle_payment($1,$2,$3,$4,$5,$6) r`, [order, o.pid ?? `pay_${uid().slice(0, 8)}`, o.cents, o.cur ?? 'INR', o.status ?? 'captured', o.as ?? null]);
  return r[0].r;
};
const count = async (s: any, table: string, where = 'true') => { await s.as('postgres'); return (await s.q(`select count(*)::int n from public.${table} where ${where}`))[0].n; };
const auditEvents = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select event_type from public.audit_events where entity_id=$1 order by created_at`, [id])).map((r: any) => r.event_type); };

describe('on-demand payment intent', () => {
  it('prices on the server: the customer supplies no amount', async () =>
    inTx(async (s) => {
      const cases: [string, 'bike' | 'car' | 'suv', number][] = [
        ['bike-body-wash', 'bike', 6500], ['car-body-wash', 'car', 15000], ['car-deep-cleaning', 'car', 22000],
        ['suv-deep-cleaning', 'suv', 25000], ['car-body-wash', 'suv', 15000],
      ];
      for (const [code, vt, cents] of cases) {
        const { intent } = await onDemand(s, { code, vtype: vt });
        expect(intent.amount_cents, `${code} on ${vt}`).toBe(cents);
      }
    }));

  it('creates a pending payment and NO booking', async () =>
    inTx(async (s) => {
      const { intent, u } = await onDemand(s);
      await s.as('postgres');
      const p = (await s.q('select * from public.payments where id=$1', [intent.payment_id]))[0];
      expect(p).toMatchObject({ status: 'pending', payment_kind: 'on_demand', booking_id: null, membership_id: null, fulfilment_status: 'pending', customer_profile_id: u.profileId });
      expect(p.intent).toMatchObject({ kind: 'on_demand', unit_price_cents: 15000, source: 'website' });
      expect(await count(s, 'bookings')).toBe(0);
    }));

  it('rejects other people\'s vehicles, incompatible services, too-soon slots and busy vehicles', async () =>
    inTx(async (s) => {
      const a = await createCustomer(s);
      const b = await createCustomer(s);
      const bikeVeh = await createVehicle(s, a.profileId, 'bike');
      const carVeh = await createVehicle(s, a.profileId, 'car');
      const bVeh = await createVehicle(s, b.profileId, 'car');
      const carWash = await serviceId(s, 'car-body-wash');
      const suvDeep = await serviceId(s, 'suv-deep-cleaning');
      const date = await istDate(s, 4);
      const call = (veh: string, svc: string, d: string, slot = 'morning') =>
        s.err(`select public.create_booking_payment_intent('${veh}','${svc}','${d}'::date,'${slot}'::public.time_slot)`);
      await s.as('authenticated', a.authId);
      expect(await call(bVeh, carWash, date)).toMatch(/Vehicle not found/);
      expect(await call(bikeVeh, carWash, date)).toMatch(/not available for your vehicle/);
      expect(await call(carVeh, suvDeep, date)).toMatch(/not available for your vehicle/);
      expect(await call(carVeh, carWash, date)).toBeNull();
      // Deterministic "too soon": demand 30 days of lead time, so even a date 4 days out is rejected.
      await s.as('postgres');
      await s.q(`update public.pricing_settings set value_int = 24 * 30 where key = 'on_demand_min_lead_hours'`);
      await s.as('authenticated', a.authId);
      expect(await call(carVeh, carWash, date, 'afternoon')).toMatch(/starts too soon/);
      await s.as('postgres');
      await s.q(`update public.pricing_settings set value_int = 2 where key = 'on_demand_min_lead_hours'`);
      await s.as('authenticated', a.authId);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4,'night','confirmed')`, [a.profileId, carVeh, carWash, date]);
      await s.as('authenticated', a.authId);
      expect(await call(carVeh, carWash, date, 'afternoon')).toMatch(/already has a wash booked/);
    }));

  it('workers and anon cannot create intents', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const c = await createCustomer(s);
      const veh = await createVehicle(s, c.profileId);
      const svc = await serviceId(s, 'car-body-wash');
      const date = await istDate(s, 4);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.create_booking_payment_intent('${veh}','${svc}','${date}'::date,'morning')`)).toMatch(/Customer profile not found/);
      await s.as('anon');
      expect(await s.err(`select public.create_booking_payment_intent('${veh}','${svc}','${date}'::date,'morning')`)).toMatch(/permission denied/);
    }));
});

describe('settle_payment: on-demand', () => {
  it('a verified capture of the exact amount creates the confirmed booking, from the stored intent', async () =>
    inTx(async (s) => {
      const { intent, order, u, date, veh } = await onDemand(s);
      const r = await settle(s, order, { cents: 15000, as: u.profileId });
      expect(r).toMatchObject({ status: 'fulfilled', payment_id: intent.payment_id });
      await s.as('postgres');
      const b = (await s.q(`select *, to_char(scheduled_date,'YYYY-MM-DD') as d from public.bookings where id=$1`, [r.booking_id]))[0];
      expect(b).toMatchObject({ status: 'confirmed', booking_type: 'on_demand', customer_profile_id: u.profileId, vehicle_id: veh, price_cents: 15000, source: 'website', time_slot: 'morning' });
      expect(b.d).toBe(date);
      expect(b.reference_code).toMatch(/^WSH-[A-Z2-9]{6}$/);
      const p = (await s.q('select * from public.payments where id=$1', [intent.payment_id]))[0];
      expect(p).toMatchObject({ status: 'paid', booking_id: r.booking_id, fulfilment_status: 'fulfilled' });
      expect(p.provider_payment_id).toMatch(/^pay_/);
      const ev = (await s.q('select event_type from public.booking_events where booking_id=$1 order by created_at', [r.booking_id])).map((x: any) => x.event_type);
      expect(ev).toEqual(['booking_created', 'payment_received']);
      expect((await s.q('select count(*)::int n from public.notifications where profile_id=$1', [u.profileId]))[0].n).toBe(2);
      expect(await auditEvents(s, intent.payment_id)).toContain('payment_settled');
    }));

  it('settling twice (browser verify + webhook) does the work once', async () =>
    inTx(async (s) => {
      const { order, intent } = await onDemand(s);
      const first = await settle(s, order, { pid: 'pay_same', cents: 15000 });
      const second = await settle(s, order, { pid: 'pay_same', cents: 15000 });
      expect(first.status).toBe('fulfilled');
      expect(second).toMatchObject({ status: 'already_settled', booking_id: first.booking_id });
      expect(await count(s, 'bookings')).toBe(1);
      expect((await auditEvents(s, intent.payment_id)).filter((e) => e === 'payment_settled')).toHaveLength(1);
    }));

  it('a second, different capture on the same order is flagged, never applied', async () =>
    inTx(async (s) => {
      const { order, intent } = await onDemand(s);
      await settle(s, order, { pid: 'pay_a', cents: 15000 });
      const dup = await settle(s, order, { pid: 'pay_b', cents: 15000 });
      expect(dup.status).toBe('duplicate_payment');
      expect(await count(s, 'bookings')).toBe(1);
      expect(await auditEvents(s, intent.payment_id)).toContain('duplicate_capture');
    }));

  it('rejects a wrong amount or currency, audits it, and creates nothing', async () =>
    inTx(async (s) => {
      const { order, intent } = await onDemand(s);
      expect(await settle(s, order, { cents: 100 })).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
      expect(await settle(s, order, { cents: 15000, cur: 'USD' })).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
      expect(await count(s, 'bookings')).toBe(0);
      await s.as('postgres');
      expect((await s.q('select status::text from public.payments where id=$1', [intent.payment_id]))[0].status).toBe('pending');
      expect((await auditEvents(s, intent.payment_id)).filter((e) => e === 'payment_amount_mismatch')).toHaveLength(2);
    }));

  it('rejects a payment that is not captured', async () =>
    inTx(async (s) => {
      const { order } = await onDemand(s);
      expect(await settle(s, order, { cents: 15000, status: 'failed' })).toMatchObject({ status: 'not_captured' });
      expect(await settle(s, order, { cents: 15000, status: 'authorized' })).toMatchObject({ status: 'not_captured' });
      expect(await count(s, 'bookings')).toBe(0);
    }));

  it('rejects settlement on behalf of the wrong customer', async () =>
    inTx(async (s) => {
      const { order, intent } = await onDemand(s);
      const other = await createCustomer(s);
      expect(await settle(s, order, { cents: 15000, as: other.profileId })).toMatchObject({ status: 'rejected', reason: 'not_your_payment' });
      expect(await count(s, 'bookings')).toBe(0);
      expect(await auditEvents(s, intent.payment_id)).toContain('payment_rejected');
    }));

  it('ignores unknown orders and refuses a reused provider payment id', async () =>
    inTx(async (s) => {
      expect(await settle(s, 'order_nope', { cents: 1 })).toMatchObject({ status: 'unknown_order' });
      const a = await onDemand(s);
      const b = await onDemand(s, { days: 5 });
      await settle(s, a.order, { pid: 'pay_dupe', cents: 15000 });
      expect(await settle(s, b.order, { pid: 'pay_dupe', cents: 15000 })).toMatchObject({ status: 'rejected', reason: 'payment_id_reused' });
    }));

  it('money taken but the vehicle was booked meanwhile: kept as paid/unfulfilled with an automatic refund request', async () =>
    inTx(async (s) => {
      const { order, intent, u, veh, svc, date } = await onDemand(s);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4,'night','confirmed')`, [u.profileId, veh, svc, date]);
      const r = await settle(s, order, { cents: 15000 });
      expect(r).toMatchObject({ status: 'unfulfilled', reason: 'vehicle_already_booked' });
      await s.as('postgres');
      const p = (await s.q('select status::text, fulfilment_status, booking_id from public.payments where id=$1', [intent.payment_id]))[0];
      expect(p).toEqual({ status: 'paid', fulfilment_status: 'unfulfilled', booking_id: null });
      const refund = await s.q('select amount_cents, status::text from public.refunds where payment_id=$1', [intent.payment_id]);
      expect(refund).toEqual([{ amount_cents: 15000, status: 'requested' }]);
      expect(await auditEvents(s, intent.payment_id)).toContain('payment_unfulfilled');
      // calling again is still idempotent
      expect((await settle(s, order, { pid: p && (await s.q('select provider_payment_id from public.payments where id=$1', [intent.payment_id]))[0].provider_payment_id, cents: 15000 })).status).toBe('unfulfilled');
      expect(await count(s, 'refunds')).toBe(1);
    }));

  it('a date that passed before payment landed is also refunded, not booked', async () =>
    inTx(async (s) => {
      const { order, intent } = await onDemand(s);
      await s.as('postgres');
      await s.q(`update public.payments set intent = jsonb_set(intent, '{scheduled_date}', to_jsonb((current_date - 3)::text)) where id=$1`, [intent.payment_id]);
      expect(await settle(s, order, { cents: 15000 })).toMatchObject({ status: 'unfulfilled', reason: 'date_passed' });
      expect(await count(s, 'bookings')).toBe(0);
      expect(await count(s, 'refunds', `payment_id='${intent.payment_id}'`)).toBe(1);
    }));
});

describe('settle_payment: access', () => {
  it('customers, workers and anon cannot settle, attach, or reach the fulfilment functions', async () =>
    inTx(async (s) => {
      const { u, order, intent } = await onDemand(s);
      const w = await createWorker(s);
      for (const who of [['authenticated', u.authId], ['authenticated', w.authId], ['anon', null]] as const) {
        await s.as(who[0], who[1]);
        expect(await s.err(`select app_private.settle_payment('${order}','pay_x',15000,'INR','captured')`)).toMatch(/permission denied/);
        expect(await s.err(`select app_private.attach_provider_order('${intent.payment_id}','order_zzz')`)).toMatch(/permission denied/);
        expect(await s.err(`select app_private.fulfil_on_demand(null::public.payments)`)).toMatch(/permission denied/);
      }
    }));

  it('washo_api (the Render server role) can settle', async () =>
    inTx(async (s) => {
      const { order } = await onDemand(s);
      await s.as('washo_api');
      const r = (await s.q(`select app_private.settle_payment($1,'pay_api',15000,'INR','captured') r`, [order]))[0].r;
      expect(r.status).toBe('fulfilled');
    }));

  it('a customer sees only their own payment status', async () =>
    inTx(async (s) => {
      const { u, intent } = await onDemand(s);
      const other = await createCustomer(s);
      await s.as('authenticated', u.authId);
      expect((await s.q('select public.my_payment_status($1) r', [intent.payment_id]))[0].r).toMatchObject({ status: 'pending', fulfilment_status: 'pending' });
      await s.as('authenticated', other.authId);
      expect((await s.q('select public.my_payment_status($1) r', [intent.payment_id]))[0].r).toBeNull();
    }));
});

// ───────────────────────── memberships ─────────────────────────
async function membershipRequest(s: any, o: { pattern?: any[]; months?: number; vtype?: 'bike' | 'car' | 'suv'; adj?: number; start?: number } = {}) {
  const admin = await createAdmin(s);
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId, o.vtype ?? 'car');
  const start = await istDate(s, o.start ?? 4);
  await s.as('authenticated', u.authId);
  const id = (await s.q(`select public.create_membership_request($1,$2::jsonb,$3,'morning',$4::date,null,'Basement P1') id`, [veh, JSON.stringify(o.pattern ?? PATTERN_3), o.months ?? 3, start]))[0].id;
  await s.as('authenticated', admin.authId);
  await s.q(`select public.admin_review_membership_request($1,'quote',$2,$3)`, [id, o.adj ?? 0, o.adj ? 'Special arrangement' : null]);
  await s.as('authenticated', u.authId);
  const acc = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [acc.payment_id, order]);
  return { admin, u, veh, id, acc, order, start };
}

describe('settle_payment: membership', () => {
  it('nothing exists before payment is verified', async () =>
    inTx(async (s) => {
      await membershipRequest(s);
      expect(await count(s, 'memberships')).toBe(0);
      expect(await count(s, 'bookings')).toBe(0);
      expect(await count(s, 'membership_schedule_occurrences')).toBe(0);
    }));

  it('verified payment activates the membership and generates every scheduled wash', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s, { months: 3 });
      const r = await settle(s, m.order, { cents: 533520, as: m.u.profileId });
      expect(r.status).toBe('fulfilled');
      await s.as('postgres');

      const mem = (await s.q('select * from public.memberships where id=$1', [r.membership_id]))[0];
      expect(mem).toMatchObject({ status: 'active', duration_months: 3, quantity_per_period: 12, base_amount_cents: 624000, discount_amount_cents: 90480, final_amount_cents: 533520, membership_request_id: m.id });
      expect(mem.pricing_snapshot).toMatchObject({ subtotal_cents: 624000, final_cents: 533520, request_id: m.id });

      const svcs = await s.q(`select sv.code, ms.quantity_per_period q from public.membership_services ms join public.services sv on sv.id=ms.service_id where ms.membership_id=$1 order by 1`, [r.membership_id]);
      expect(svcs).toEqual([{ code: 'car-body-wash', q: 8 }, { code: 'car-deep-cleaning', q: 4 }]);

      const washes = await s.q(`select to_char(b.scheduled_date,'YYYY-MM-DD') d, b.status::text st, b.booking_type::text bt, b.source, b.time_slot::text slot, sv.code, b.reference_code
                                  from public.bookings b join public.services sv on sv.id=b.service_id where b.membership_id=$1 order by b.scheduled_date`, [r.membership_id]);
      expect(washes).toHaveLength(36); // 3 per week x 4 weeks x 3 months
      for (const w of washes) {
        expect([1, 3, 5]).toContain(dow(w.d));
        expect(w).toMatchObject({ st: 'confirmed', bt: 'membership', source: 'membership_schedule', slot: 'morning' });
        expect(w.code).toBe(dow(w.d) === 3 ? 'car-deep-cleaning' : 'car-body-wash'); // Mon/Fri body, Wed deep
        expect(w.reference_code).toMatch(/^WSH-/);
      }
      expect(new Set(washes.map((w: any) => w.d)).size).toBe(36); // no two washes on one day
      expect(washes[0].d >= m.start).toBe(true);
      expect((await s.q('select count(*)::int n from public.membership_schedule_occurrences'))[0].n).toBe(36);

      // everything inside the membership's own term
      expect((await s.q(`select count(*)::int n from public.bookings b join public.memberships m on m.id=b.membership_id where b.membership_id=$1 and (b.scheduled_date::timestamptz < m.start_at or b.scheduled_date::timestamptz > m.end_at)`, [r.membership_id]))[0].n).toBe(0);

      const req = (await s.q('select status, membership_id from public.membership_requests where id=$1', [m.id]))[0];
      expect(req).toEqual({ status: 'active', membership_id: r.membership_id });
      const pay = (await s.q('select status::text, membership_id, fulfilment_status from public.payments where id=$1', [m.acc.payment_id]))[0];
      expect(pay).toEqual({ status: 'paid', membership_id: r.membership_id, fulfilment_status: 'fulfilled' });
      expect(await auditEvents(s, r.membership_id)).toContain('membership_activated');
    }));

  it('wash counts follow washes-per-week x 4 x months', async () =>
    inTx(async (s) => {
      for (const [pattern, months, expected] of [
        [[{ weekday: 2, kind: 'body' }], 1, 4],                                            // 1/week, 1 month
        [[{ weekday: 2, kind: 'body' }, { weekday: 4, kind: 'deep' }], 1, 8],              // 2/week
        [PATTERN_3, 12, 144],                                                              // 3/week, 12 months
      ] as [any[], number, number][]) {
        const m = await membershipRequest(s, { pattern, months });
        const quoted = (await s.q('select quoted_amount_cents q from public.membership_requests where id=$1', [m.id]))[0]?.q ?? (await (async () => { await s.as('postgres'); return (await s.q('select quoted_amount_cents q from public.membership_requests where id=$1', [m.id]))[0].q; })());
        const r = await settle(s, m.order, { cents: quoted });
        expect(r.status, JSON.stringify(r)).toBe('fulfilled');
        expect(await count(s, 'bookings', `membership_id='${r.membership_id}'`)).toBe(expected);
      }
    }));

  it('a 12-month, 3/week membership applies the 15% cap and still fits its term', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s, { months: 12 });
      await s.as('postgres');
      expect((await s.q('select quoted_amount_cents q from public.membership_requests where id=$1', [m.id]))[0].q).toBe(2121600); // 85% of 2,496,000
      const r = await settle(s, m.order, { cents: 2121600 });
      expect(r.status).toBe('fulfilled');
      await s.as('postgres');
      const mem = (await s.q('select base_amount_cents b, discount_amount_cents d, final_amount_cents f from public.memberships where id=$1', [r.membership_id]))[0];
      expect(mem).toEqual({ b: 2496000, d: 374400, f: 2121600 });
    }));

  it('WASHO adjustments flow into base/discount correctly (discount and surcharge)', async () =>
    inTx(async (s) => {
      const down = await membershipRequest(s, { adj: -33520 });
      const r1 = await settle(s, down.order, { cents: 500000 });
      await s.as('postgres');
      expect((await s.q('select base_amount_cents b, discount_amount_cents d, final_amount_cents f from public.memberships where id=$1', [r1.membership_id]))[0])
        .toEqual({ b: 624000, d: 90480 + 33520, f: 500000 });

      const up = await membershipRequest(s, { adj: 10000 });
      const r2 = await settle(s, up.order, { cents: 543520 });
      await s.as('postgres');
      expect((await s.q('select base_amount_cents b, discount_amount_cents d, final_amount_cents f from public.memberships where id=$1', [r2.membership_id]))[0])
        .toEqual({ b: 634000, d: 90480, f: 543520 });
    }));

  it('rejects the wrong amount and creates nothing', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s);
      expect(await settle(s, m.order, { cents: 100000 })).toMatchObject({ status: 'rejected', reason: 'amount_mismatch' });
      expect(await settle(s, m.order, { cents: 533520, as: (await createCustomer(s)).profileId })).toMatchObject({ reason: 'not_your_payment' });
      expect(await count(s, 'memberships')).toBe(0);
      expect(await count(s, 'bookings')).toBe(0);
    }));

  it('is idempotent: a second settle (webhook after verify) creates no second membership or washes', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s);
      await settle(s, m.order, { pid: 'pay_m', cents: 533520 });
      const again = await settle(s, m.order, { pid: 'pay_m', cents: 533520 });
      expect(again.status).toBe('already_settled');
      expect(await count(s, 'memberships')).toBe(1);
      expect(await count(s, 'bookings')).toBe(36);
    }));

  it('a day the vehicle is already booked is skipped, and the customer still gets every wash', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s, { months: 1 });
      await s.as('postgres');
      // Occupy the first Monday on/after the start date with an on-demand wash.
      const monday = (await s.q(`select d::text from generate_series($1::date, $1::date + 13, '1 day') d where extract(dow from d)=1 limit 1`, [m.start]))[0].d;
      const svc = await serviceId(s, 'car-body-wash');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4,'night','confirmed')`, [m.u.profileId, m.veh, svc, monday]);
      const r = await settle(s, m.order, { cents: 187200 });
      expect(r.status, JSON.stringify(r)).toBe('fulfilled');
      expect(await count(s, 'bookings', `membership_id='${r.membership_id}'`)).toBe(12);
      expect(await count(s, 'bookings', `membership_id='${r.membership_id}' and scheduled_date='${monday}'`)).toBe(0);
    }));

  it('paying after the requested start date shifts the start forward instead of scheduling the past', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s, { months: 1 });
      await s.as('postgres');
      await s.q(`update public.membership_requests set start_date = current_date - 10 where id=$1`, [m.id]);
      const r = await settle(s, m.order, { cents: 187200 });
      expect(r.status, JSON.stringify(r)).toBe('fulfilled');
      await s.as('postgres');
      const first = (await s.q(`select min(scheduled_date)::text d from public.bookings where membership_id=$1`, [r.membership_id]))[0].d;
      const min = (await s.q(`select ((now() at time zone 'Asia/Kolkata')::date + 2)::text d`))[0].d;
      expect(first >= min).toBe(true);
    }));

  it('if the request is no longer accepted when money lands, it is refunded, not activated', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s);
      await s.as('postgres');
      await s.q(`update public.membership_requests set status='cancelled' where id=$1`, [m.id]);
      const r = await settle(s, m.order, { cents: 533520 });
      expect(r).toMatchObject({ status: 'unfulfilled', reason: 'request_not_accepted' });
      expect(await count(s, 'memberships')).toBe(0);
      expect(await count(s, 'refunds', `payment_id='${m.acc.payment_id}'`)).toBe(1);
    }));

  it('a payment that was superseded by a newer attempt but captured late is refunded', async () =>
    inTx(async (s) => {
      const m = await membershipRequest(s);
      await s.as('postgres');
      await s.q(`update public.payments set status='failed' where id=$1`, [m.acc.payment_id]);
      const r = await settle(s, m.order, { cents: 533520 });
      expect(r).toMatchObject({ status: 'unfulfilled', reason: 'payment_superseded' });
      expect(await count(s, 'memberships')).toBe(0);
      expect(await count(s, 'refunds', `payment_id='${m.acc.payment_id}'`)).toBe(1);
    }));
});
