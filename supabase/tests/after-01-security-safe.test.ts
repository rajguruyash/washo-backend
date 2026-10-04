/** GREEN tests for 20261004000001_security_safe_fixes.sql */
import { describe, expect, it } from 'vitest';
import { createAdmin, createAuthUser, createCustomer, createVehicle, createWorker, inTx, nextPhone } from './helpers';

describe('security fixes (safe set)', () => {
  describe('admin roles', () => {
    it('a customer can no longer promote themselves', async () =>
      inTx(async (s) => {
        const me = await createAuthUser(s, { email: 'attacker@t.test', phone: nextPhone(), phoneConfirmed: true });
        await s.as('authenticated', me.authId);
        expect(await s.err(`select public.admin_set_user_role('attacker@t.test','admin')`)).toMatch(/admin access required/);
        await s.as('postgres');
        expect((await s.q('select role from public.profiles where id=$1', [me.profileId]))[0].role).toBe('customer');
      }));

    it('anon cannot even call it', async () =>
      inTx(async (s) => {
        await s.as('anon');
        expect(await s.err(`select public.admin_set_user_role('x@t.test','admin')`)).toMatch(/permission denied/);
      }));

    it('a real admin can change roles, and it is audited', async () =>
      inTx(async (s) => {
        const admin = await createAdmin(s);
        const target = await createAuthUser(s, { email: 'newworker@t.test', phone: nextPhone(), phoneConfirmed: true });
        await s.as('authenticated', admin.authId);
        expect(await s.err(`select public.admin_set_user_role('newworker@t.test','worker')`)).toBeNull();
        await s.as('postgres');
        expect((await s.q('select role from public.profiles where id=$1', [target.profileId]))[0].role).toBe('worker');
        const a = await s.q(`select event_type, metadata from public.audit_events where entity_id=$1`, [target.profileId]);
        expect(a[0].event_type).toBe('role_changed');
        expect(a[0].metadata).toMatchObject({ from: 'customer', to: 'worker' });
      }));

    it('the audit trail is append-only and admin-readable only', async () =>
      inTx(async (s) => {
        const admin = await createAdmin(s);
        const cust = await createCustomer(s);
        await s.as('authenticated', admin.authId);
        await s.q(`select public.admin_set_user_role('${admin.email}','admin')`);
        await s.as('postgres');
        expect(await s.err(`delete from public.audit_events`)).toMatch(/cannot be deleted/);
        await s.as('authenticated', cust.authId);
        expect(await s.q('select * from public.audit_events')).toHaveLength(0);
      }));

    it('the two hardcoded emails are promoted to real roles, and email alone no longer grants admin', async () =>
      inTx(async (s) => {
        const owner = await createAuthUser(s, { email: 'someone-else@t.test' });
        await s.as('authenticated', owner.authId);
        expect((await s.q('select public.is_admin() a'))[0].a).toBe(false);
        // A user with one of the legacy emails created AFTER the migration is NOT auto-admin.
        const legacy = await createAuthUser(s, { email: 'admin@washo.in' });
        await s.as('authenticated', legacy.authId);
        expect((await s.q('select public.is_admin() a'))[0].a).toBe(false);
      }));
  });

  describe('phone linking', () => {
    it('signup metadata can no longer claim another customer\'s profile', async () =>
      inTx(async (s) => {
        const victim = await createCustomer(s, { phone: '+919811111111' });
        const attacker = await createAuthUser(s, { email: 'evil@t.test', metadataPhone: '+919811111111' });
        await s.as('postgres');
        expect((await s.q('select auth_user_id from public.profiles where id=$1', [victim.profileId]))[0].auth_user_id).toBe(victim.authId);
        expect(attacker.profileId).not.toBe(victim.profileId); // attacker got their own, separate profile
      }));

    it('an UNVERIFIED phone on the auth user does not link either', async () =>
      inTx(async (s) => {
        // Victim registered by email; their number only lives in profiles.phone (auth.users.phone is unique).
        const victim = await createAuthUser(s, { email: 'victim@t.test' });
        await s.as('postgres');
        await s.q(`update public.profiles set phone='+919833333333' where id=$1`, [victim.profileId]);
        await createAuthUser(s, { phone: '+919833333333', phoneConfirmed: false });
        await s.as('postgres');
        expect((await s.q('select auth_user_id from public.profiles where id=$1', [victim.profileId]))[0].auth_user_id).toBe(victim.authId);
      }));

    it('a VERIFIED phone login links to the existing profile (the legitimate mobile flow)', async () =>
      inTx(async (s) => {
        // Existing customer registered earlier by email with their number in the profile.
        const old = await createAuthUser(s, { email: 'old@t.test', metadataPhone: '+919844444444' });
        await s.as('postgres');
        await s.q(`update public.profiles set phone='+919844444444' where id=$1`, [old.profileId]);
        // They now sign in with phone OTP (phone confirmed): the same profile must be reused.
        const fresh = await createAuthUser(s, { phone: '+919844444444', phoneConfirmed: true });
        await s.as('postgres');
        const p = await s.q('select id, auth_user_id from public.profiles where id=$1', [old.profileId]);
        expect(p[0].auth_user_id).toBe(fresh.authId);
        expect((await s.q('select count(*)::int n from public.profiles where auth_user_id=$1', [fresh.authId]))[0].n).toBe(1);
      }));

    it('a phone confirmed AFTER the user row exists also links, and merges the empty duplicate', async () =>
      inTx(async (s) => {
        const old = await createAuthUser(s, { email: 'old2@t.test' });
        await s.as('postgres');
        await s.q(`update public.profiles set phone='+919855555555' where id=$1`, [old.profileId]);
        const veh = await createVehicle(s, old.profileId);
        const fresh = await createAuthUser(s, { phone: '+919855555555', phoneConfirmed: false }); // gets its own profile
        await s.as('postgres');
        await s.q(`update auth.users set phone_confirmed_at = now() where id=$1`, [fresh.authId]);
        const rows = await s.q('select id from public.profiles where auth_user_id=$1', [fresh.authId]);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(old.profileId);
        expect((await s.q('select customer_profile_id from public.vehicles where id=$1', [veh]))[0].customer_profile_id).toBe(old.profileId);
      }));

    it('the client-callable link function only links the caller\'s own VERIFIED phone', async () =>
      inTx(async (s) => {
        const victim = await createCustomer(s, { phone: '+919866666666' });
        const attacker = await createAuthUser(s, { email: 'a@t.test', phone: '+919877777777', phoneConfirmed: true });
        await s.as('authenticated', attacker.authId);
        expect(await s.err(`select public.link_profile_by_phone('${attacker.authId}','+919866666666')`)).toMatch(/not verified/);
        expect(await s.err(`select public.link_profile_by_phone('${victim.authId}','+919866666666')`)).toMatch(/Forbidden/);
        await s.as('anon');
        expect(await s.err(`select public.link_profile_by_phone('${attacker.authId}','+919866666666')`)).toMatch(/permission denied/);
        await s.as('postgres');
        expect((await s.q('select auth_user_id from public.profiles where id=$1', [victim.profileId]))[0].auth_user_id).toBe(victim.authId);
      }));

    it('the internal function is not reachable from the API at all', async () =>
      inTx(async (s) => {
        const u = await createCustomer(s);
        await s.as('authenticated', u.authId);
        expect(await s.err(`select app_private.link_profile_by_phone_internal('${u.authId}','+919000000000')`)).toMatch(/permission denied/);
      }));
  });

  describe('payment activation', () => {
    async function seed(s: any) {
      const victim = await createCustomer(s);
      const attacker = await createCustomer(s);
      const veh = await createVehicle(s, victim.profileId);
      await s.q(`insert into public.services (code,name,vehicle_type) values ('t-svc','Test Service','car') on conflict do nothing`);
      const svc = (await s.q(`select id from public.services where code='t-svc'`))[0].id;
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date+3,'morning','pending')`, [victim.profileId, veh, svc]);
      const booking = (await s.q('select id from public.bookings limit 1'))[0].id;
      const pay = (await s.q(`insert into public.payments (customer_profile_id,amount_cents,provider,provider_order_id,status) values ($1,15000,'razorpay','o_v','pending') returning id`, [victim.profileId]))[0].id;
      return { victim, attacker, booking, pay };
    }

    it('customers cannot call activate_paid_* any more', async () =>
      inTx(async (s) => {
        const { attacker, booking, pay } = await seed(s);
        await s.as('authenticated', attacker.authId);
        expect(await s.err(`select public.activate_paid_on_demand_booking('${pay}','x','${booking}')`)).toMatch(/permission denied/);
        expect(await s.err(`select public.activate_paid_membership('${pay}','x','${booking}')`)).toMatch(/permission denied/);
      }));

    it('the service role can activate, the event is now accepted, and the call is idempotent', async () =>
      inTx(async (s) => {
        const { booking, pay } = await seed(s);
        await s.as('service_role');
        expect(await s.err(`select public.activate_paid_on_demand_booking('${pay}','pay_1','${booking}')`)).toBeNull();
        expect((await s.q(`select public.activate_paid_on_demand_booking('${pay}','pay_1','${booking}') r`))[0].r).toBe(true);
        await s.as('postgres');
        expect((await s.q('select status::text from public.bookings where id=$1', [booking]))[0].status).toBe('confirmed');
        expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='payment_received'`, [booking]))[0].n).toBe(1);
      }));

    it('even the service role cannot attach a payment to someone else\'s booking', async () =>
      inTx(async (s) => {
        const { attacker, booking } = await seed(s);
        const pay = (await s.q(`insert into public.payments (customer_profile_id,amount_cents,provider,provider_order_id,status) values ($1,15000,'razorpay','o_a','pending') returning id`, [attacker.profileId]))[0].id;
        await s.as('service_role');
        expect(await s.err(`select public.activate_paid_on_demand_booking('${pay}','x','${booking}')`)).toMatch(/does not belong/);
      }));
  });

  describe('misc hardening', () => {
    it('customer cancellation no longer trips the event CHECK', async () =>
      inTx(async (s) => {
        const u = await createCustomer(s);
        const veh = await createVehicle(s, u.profileId);
        await s.q(`insert into public.services (code,name,vehicle_type) values ('t-svc','Test Service','car')`);
        const svc = (await s.q(`select id from public.services where code='t-svc'`))[0].id;
        await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',current_date+3,'morning','confirmed')`, [u.profileId, veh, svc]);
        const b = (await s.q('select id from public.bookings limit 1'))[0].id;
        await s.as('authenticated', u.authId);
        expect(await s.err(`select public.cancel_customer_booking('${b}','changed my mind')`)).toBeNull();
      }));

    it('coupon codes are no longer readable by anonymous visitors or customers', async () =>
      inTx(async (s) => {
        const u = await createCustomer(s);
        await s.q(`insert into public.coupons (code, discount_pct) values ('SECRET50', 50)`);
        await s.as('anon');
        expect(await s.err('select code from public.coupons')).toMatch(/permission denied/);
        await s.as('authenticated', u.authId);
        expect(await s.q('select code from public.coupons')).toHaveLength(0);
      }));

    it('functions created from now on are private by default', async () =>
      inTx(async (s) => {
        await s.q(`create function public._probe() returns int language sql as 'select 1'`);
        await s.as('anon');
        expect(await s.err('select public._probe()')).toMatch(/permission denied/);
      }));

    it('workers still work: a worker keeps is_worker() and the admin helper stays false for them', async () =>
      inTx(async (s) => {
        const w = await createWorker(s);
        await s.as('authenticated', w.authId);
        const r = (await s.q('select public.is_worker() w, public.is_admin() a'))[0];
        expect(r).toEqual({ w: true, a: false });
      }));
  });
});
