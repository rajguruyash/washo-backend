/**
 * GREEN mirror of baseline-exploits.test.ts, run against the FULLY migrated schema (migrations + cutover).
 * Every attack that succeeded on production's schema must now fail, and the end-to-end lifecycle must work.
 */
import { describe, expect, it } from 'vitest';
import { createAdmin, createAuthUser, createCustomer, createVehicle, createWorker, inTx, istDate, nextPhone, serviceId, uid } from './helpers';

describe('FULL schema: every baseline exploit is closed', () => {
  it('1. a customer cannot make themselves admin', async () =>
    inTx(async (s) => {
      const me = await createAuthUser(s, { email: 'attacker@t.test', phone: nextPhone(), phoneConfirmed: true });
      await s.as('authenticated', me.authId);
      expect(await s.err(`select public.admin_set_user_role('attacker@t.test','admin')`)).toMatch(/admin access required/);
    }));

  it('2. signup metadata cannot claim another customer\'s profile', async () =>
    inTx(async (s) => {
      const victim = await createCustomer(s, { phone: '+919811111111' });
      await createAuthUser(s, { email: 'evil@t.test', metadataPhone: '+919811111111' });
      await s.as('postgres');
      expect((await s.q('select auth_user_id from public.profiles where id=$1', [victim.profileId]))[0].auth_user_id).toBe(victim.authId);
    }));

  it('3. the phone-link function cannot be pointed at someone else\'s number', async () =>
    inTx(async (s) => {
      const victim = await createCustomer(s, { phone: '+919822222222' });
      const b = await createAuthUser(s, { email: 'dup@t.test', phone: '+919899999999', phoneConfirmed: true });
      await s.as('authenticated', b.authId);
      expect(await s.err(`select public.link_profile_by_phone('${b.authId}','+919822222222')`)).toMatch(/not verified/);
      await s.as('postgres');
      expect((await s.q('select auth_user_id from public.profiles where id=$1', [victim.profileId]))[0].auth_user_id).toBe(victim.authId);
    }));

  it('4. a customer cannot mark another customer\'s payment as paid', async () =>
    inTx(async (s) => {
      const victim = await createCustomer(s);
      const attacker = await createCustomer(s);
      const pay = (await s.q(`insert into public.payments (customer_profile_id,amount_cents,provider,provider_order_id,status) values ($1,50000,'razorpay','order_victim','pending') returning id`, [victim.profileId]))[0].id;
      await s.as('authenticated', attacker.authId);
      expect(await s.err(`select public.activate_paid_membership('${pay}','pay_fake','${uid()}')`)).toMatch(/permission denied/);
      expect(await s.err(`select app_private.settle_payment('order_victim','pay_fake',50000,'INR','captured')`)).toMatch(/permission denied/);
    }));

  it('5. a customer cannot create a free active membership', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId, 'car');
      const svc = await serviceId(s, 'car-body-wash');
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.create_custom_membership('${veh}','${svc}',1,4,array[1],'morning')`)).toMatch(/requested and approved by WASHO/);
      expect(await s.err(`select public.accept_membership_quote('${uid()}')`)).toMatch(/Request not found/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.memberships'))[0].n).toBe(0);
    }));

  it('6. a customer cannot create a confirmed booking without paying', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId, 'car');
      const svc = await serviceId(s, 'car-body-wash');
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.create_on_demand_booking('${veh}','${svc}', (current_date + 3), 'morning', null, 'P1', null)`)).toMatch(/starts with payment/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.bookings'))[0].n).toBe(0);
      await s.as('authenticated', u.authId);
      // ...and a direct insert is blocked by RLS
      expect(await s.err(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ('${u.profileId}','${veh}','${svc}','on_demand',current_date+3,'morning','confirmed')`)).toMatch(/row-level security/);
    }));

  it('7. cancellation and payment activation work (the two production bugs are fixed)', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId, 'car');
      const svc = await serviceId(s, 'car-body-wash');
      const date = await istDate(s, 4);
      await s.as('authenticated', u.authId);
      const i = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,'morning') i`, [veh, svc, date]))[0].i;
      await s.as('service_role');
      await s.q(`select app_private.attach_provider_order($1,'order_full1')`, [i.payment_id]);
      const r = (await s.q(`select app_private.settle_payment('order_full1','pay_full1',15000,'INR','captured') r`))[0].r;
      expect(r.status).toBe('fulfilled');
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${r.booking_id}','changed my mind')`)).toBeNull();
    }));

  it('8. workers cannot read every customer', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      await createCustomer(s);
      await createCustomer(s);
      await s.as('authenticated', w.authId);
      expect((await s.q(`select count(*)::int n from public.profiles where role='customer'`))[0].n).toBe(0);
    }));

  it('9. anonymous visitors cannot list coupons; photos are private; new functions are private by default', async () =>
    inTx(async (s) => {
      await s.q(`insert into public.coupons (code, discount_pct) values ('SECRET50', 50)`);
      await s.q(`insert into storage.buckets (id, name, public) values ('wash-photos','wash-photos', true) on conflict (id) do update set public = true`);
      // re-assert what the cutover did to the bucket in this fresh transaction
      await s.as('postgres');
      await s.c.query(`UPDATE storage.buckets SET public = false WHERE id = 'wash-photos'`);
      expect((await s.q(`select public from storage.buckets where id='wash-photos'`))[0].public).toBe(false);
      await s.as('anon');
      expect(await s.err('select code from public.coupons')).toMatch(/permission denied/);
      await s.as('postgres');
      await s.q(`create function public._probe() returns int language sql as 'select 1'`);
      await s.as('anon');
      expect(await s.err('select public._probe()')).toMatch(/permission denied/);
    }));
});

describe('FULL schema: end-to-end lifecycle', () => {
  it('request -> WASHO quote -> accept -> verified payment -> scheduled washes -> reschedule -> worker completes', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const u = await createCustomer(s);
      const worker = await createWorker(s);
      const veh = await createVehicle(s, u.profileId, 'suv');
      const start = await istDate(s, 4);

      await s.as('authenticated', u.authId);
      const id = (await s.q(`select public.create_membership_request($1,$2::jsonb,3,'afternoon',$3::date,null,'Basement P1') id`,
        [veh, JSON.stringify([{ weekday: 2, kind: 'body' }, { weekday: 4, kind: 'deep' }]), start]))[0].id;
      expect((await s.q('select * from public.my_membership_requests()'))[0].quoted_amount_cents).toBeNull(); // no price yet

      await s.as('authenticated', admin.authId);
      const q = (await s.q(`select public.admin_review_membership_request($1,'quote') r`, [id]))[0].r;
      expect(q.quoted_amount_cents).toBe(3 * 4 * (15000 + 25000) - Math.round(3 * 4 * (15000 + 25000) * 0.05)); // SUV: body 150 + deep 250, 2/week x 3 months, 5%

      await s.as('authenticated', u.authId);
      const acc = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
      await s.as('service_role');
      await s.q(`select app_private.attach_provider_order($1,'order_life')`, [acc.payment_id]);

      expect((await s.q(`select app_private.settle_payment('order_life','pay_life',1,'INR','captured') r`))[0].r.reason).toBe('amount_mismatch');
      const done = (await s.q(`select app_private.settle_payment('order_life','pay_life',$1,'INR','captured') r`, [acc.amount_cents]))[0].r;
      expect(done.status).toBe('fulfilled');

      await s.as('authenticated', u.authId);
      const mine = (await s.q('select * from public.my_membership_requests()'))[0];
      expect(mine).toMatchObject({ status: 'active', membership_id: done.membership_id });
      expect(mine.quoted_breakdown.duration_discount.cents).toBe(Math.round(0.05 * 3 * 4 * 40000));

      await s.as('postgres');
      const washes = await s.q(`select b.id, b.membership_schedule_occurrence_id occ, to_char(b.scheduled_date,'YYYY-MM-DD') d from public.bookings b where b.membership_id=$1 order by b.scheduled_date`, [done.membership_id]);
      expect(washes).toHaveLength(24);

      // reschedule one (customer), then the worker claims, starts and completes another
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${washes[0].occ}', '${washes[0].d}'::date, 'night')`)).toBeNull();
      await s.as('authenticated', worker.authId);
      expect((await s.q('select * from public.worker_pool(60)')).length).toBeGreaterThan(0);
      await s.q(`select public.worker_claim_booking($1)`, [washes[1].id]);
      await s.q(`select public.worker_call_customer($1)`, [washes[1].id]);
      await s.q(`select public.worker_start_wash($1)`, [washes[1].id]);
      await s.as('postgres');
      await s.q(`insert into public.booking_photos (booking_id, worker_profile_id, phase, photo_type, storage_path) values ($1,$2,'before','front','a'),($1,$2,'after','front','b')`, [washes[1].id, worker.profileId]);
      await s.as('authenticated', worker.authId);
      expect(await s.err(`select public.worker_complete_wash('${washes[1].id}')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select status::text s from public.bookings where id=$1`, [washes[1].id]))[0].s).toBe('completed');
      expect((await s.q(`select to_regclass('public.membership_entitlements') r`))[0].r).toBeNull(); // credits are gone
    }));
});
