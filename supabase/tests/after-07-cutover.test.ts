/**
 * GREEN tests for supabase/cutover/*.sql. The cutover files are NOT applied by the "safe" run; each test applies
 * them itself inside its own rolled-back transaction, so they can be exercised without committing anything.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createAdmin, createAuthUser, createCustomer, createVehicle, createWorker, inTx, istDate, nextPhone, serviceId, setRole, uid } from './helpers';

const cutoverDir = path.join(__dirname, '../cutover');
const apply = async (s: any, which: string[] = ['']) => {
  await s.as('postgres');
  for (const f of fs.readdirSync(cutoverDir).sort()) {
    if (which.some((w) => f.includes(w))) await s.c.query(fs.readFileSync(path.join(cutoverDir, f), 'utf8'));
  }
};
const PATTERN = [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }];

async function settleOnDemand(s: any, u: any, veh: string, svc: string) {
  const date = await istDate(s, 4);
  await s.as('authenticated', u.authId);
  const intent = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,'morning',null,'P1',null,'website') i`, [veh, svc, date]))[0].i;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 6)}`, intent.amount_cents]))[0].r;
  await s.as('postgres');
  return { bookingId: r.booking_id as string, paymentId: intent.payment_id as string, amount: intent.amount_cents as number, date };
}

async function paidMembership(s: any) {
  const admin = await createAdmin(s);
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId, 'car');
  const start = await istDate(s, 4);
  await s.as('authenticated', u.authId);
  const id = (await s.q(`select public.create_membership_request($1,$2::jsonb,1,'morning',$3::date,null,'P1') id`, [veh, JSON.stringify(PATTERN), start]))[0].id;
  await s.as('authenticated', admin.authId);
  await s.q(`select public.admin_review_membership_request($1,'quote')`, [id]);
  await s.as('authenticated', u.authId);
  const acc = (await s.q('select public.accept_membership_quote($1) r', [id]))[0].r;
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [acc.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 6)}`, acc.amount_cents]))[0].r;
  await s.as('postgres');
  const washes = await s.q(`select id, membership_schedule_occurrence_id occ from public.bookings where membership_id=$1 order by scheduled_date`, [r.membership_id]);
  return { admin, u, veh, membership: r.membership_id as string, washes };
}

/** Worker claims + starts + uploads photos, ready for worker_complete_wash. */
async function prepareWorkerWash(s: any, worker: any, bookingId: string) {
  await s.as('postgres');
  await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)`, [bookingId, worker.profileId]);
  await s.q(`update public.bookings set status='in_progress' where id=$1`, [bookingId]);
  await s.q(`insert into public.booking_photos (booking_id, worker_profile_id, phase, photo_type, storage_path) values ($1,$2,'before','front','x/b.jpg'),($1,$2,'after','front','x/a.jpg')`, [bookingId, worker.profileId]);
}

describe('cutover 01: credits retired, unpaid creators closed, cancellation fixed', () => {
  it('the old creators refuse with a clear "update the app" message instead of creating free things', async () =>
    inTx(async (s) => {
      await apply(s, ['0001']);
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      const svc = await serviceId(s, 'car-body-wash');
      await s.as('authenticated', u.authId);
      // The app calls the full 7-argument form. (Short forms are ambiguous across the overloads and refuse either way.)
      expect(await s.err(`select public.create_on_demand_booking('${veh}','${svc}', current_date+3,'morning', null, 'P1', null)`)).toMatch(/update the WASHO app/);
      expect(await s.err(`select public.create_on_demand_booking('${veh}','${svc}', current_date+3,'morning')`)).not.toBeNull();
      expect(await s.err(`select public.create_custom_membership('${veh}','${svc}',1,4,array[1],'morning')`)).toMatch(/update the WASHO app/);
      expect(await s.err(`select public.book_membership_credit_wash('${veh}','${svc}', current_date+3,'morning')`)).toMatch(/credits have been retired/i);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.bookings'))[0].n).toBe(0);
      expect((await s.q('select count(*)::int n from public.memberships'))[0].n).toBe(0);
    }));

  it('a worker completes a MEMBERSHIP wash without any credit logic, and the credit tables are gone', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s);
      const w = await createWorker(s);
      await apply(s); // everything, including the credit-table drop
      await prepareWorkerWash(s, w, m.washes[0].id);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${m.washes[0].id}')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select status::text s, completed_at is not null c from public.bookings where id=$1`, [m.washes[0].id]))[0]).toEqual({ s: 'completed', c: true });
      expect((await s.q(`select status::text s from public.membership_schedule_occurrences where id=$1`, [m.washes[0].occ]))[0].s).toBe('completed');
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='wash_completed'`, [m.washes[0].id]))[0].n).toBe(1);
      expect((await s.q(`select to_regclass('public.membership_entitlements') r`))[0].r).toBeNull();
    }));

  it('completion needs the assigned worker, a started wash and both photos; and is idempotent', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      const { bookingId } = await settleOnDemand(s, u, veh, await serviceId(s, 'car-body-wash'));
      const w = await createWorker(s);
      const other = await createWorker(s);
      await apply(s, ['0001']);
      await s.as('postgres');
      await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)`, [bookingId, w.profileId]);
      await s.as('authenticated', other.authId);
      expect(await s.err(`select public.worker_complete_wash('${bookingId}')`)).toMatch(/assigned worker/);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${bookingId}')`)).toMatch(/Start the wash/);
      await s.as('postgres');
      await s.q(`update public.bookings set status='in_progress' where id=$1`, [bookingId]);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${bookingId}')`)).toMatch(/before photo/);
      await s.as('postgres');
      await s.q(`insert into public.booking_photos (booking_id, worker_profile_id, phase, photo_type, storage_path) values ($1,$2,'before','front','x')`, [bookingId, w.profileId]);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${bookingId}')`)).toMatch(/after photo/);
      await s.as('postgres');
      await s.q(`insert into public.booking_photos (booking_id, worker_profile_id, phase, photo_type, storage_path) values ($1,$2,'after','front','y')`, [bookingId, w.profileId]);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${bookingId}')`)).toBeNull();
      expect(await s.err(`select public.worker_complete_wash('${bookingId}')`)).toBeNull(); // idempotent
    }));

  it('a customer cancels their paid on-demand wash: it works, is logged correctly, and raises a refund REQUEST', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      const { bookingId, paymentId, amount } = await settleOnDemand(s, u, veh, await serviceId(s, 'car-body-wash'));
      await apply(s, ['0001']);
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${bookingId}','Plans changed')`)).toBeNull();
      await s.as('postgres');
      const b = (await s.q('select status::text s, cancel_reason r from public.bookings where id=$1', [bookingId]))[0];
      expect(b).toEqual({ s: 'cancelled', r: 'Plans changed' });
      expect((await s.q(`select event_type from public.booking_events where booking_id=$1 order by created_at`, [bookingId])).map((e: any) => e.event_type))
        .toEqual(['booking_created', 'payment_received', 'cancelled', 'refund_requested']);
      expect(await s.q('select amount_cents, status::text from public.refunds where payment_id=$1', [paymentId])).toEqual([{ amount_cents: amount, status: 'requested' }]);
      // cancelling again does not double-request
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${bookingId}')`)).toMatch(/can no longer be cancelled/);
    }));

  it('cannot cancel someone else\'s or a finished booking', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const other = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      const { bookingId } = await settleOnDemand(s, u, veh, await serviceId(s, 'car-body-wash'));
      await apply(s, ['0001']);
      await s.as('authenticated', other.authId);
      expect(await s.err(`select public.cancel_customer_booking('${bookingId}')`)).toMatch(/Booking not found/);
      await s.as('postgres');
      await s.q(`update public.bookings set status='completed' where id=$1`, [bookingId]);
      await s.as('authenticated', u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${bookingId}')`)).toMatch(/can no longer be cancelled/);
    }));

  it('membership washes: the customer can reschedule but NOT cancel; an admin can cancel', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s);
      await apply(s, ['0001']);
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${m.washes[0].id}')`)).toMatch(/rescheduled but not cancelled/);
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.cancel_customer_booking('${m.washes[0].id}','Customer asked by phone')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select status::text s from public.membership_schedule_occurrences where id=$1`, [m.washes[0].occ]))[0].s).toBe('cancelled');
    }));
});

describe('cutover 02: credit tables are dropped if empty, archived (never deleted) if not', () => {
  it('empty tables are dropped', async () =>
    inTx(async (s) => {
      await apply(s, ['0001', '0002']);
      for (const t of ['membership_entitlements', 'entitlement_transactions', 'membership_periods']) {
        expect((await s.q(`select to_regclass('public.${t}') r`))[0].r).toBeNull();
      }
    }));

  it('tables with data are moved intact into a locked-down legacy_credits schema', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const veh = await createVehicle(s, u.profileId);
      const svc = await serviceId(s, 'car-body-wash');
      await s.as('postgres');
      await s.q('SET LOCAL session_replication_role = replica'); // seed historical rows past the immutability triggers
      const mem = (await s.q(`insert into public.memberships (customer_profile_id,status,duration_months,quantity_per_period,start_at,end_at,base_amount_cents,final_amount_cents,pricing_snapshot)
                              values ($1,'active',1,4,now(), now() + interval '1 month' - interval '1 day',1000,1000,'{}') returning id`, [u.profileId]))[0].id;
      const per = (await s.q(`insert into public.membership_periods (membership_id,period_start,period_end,included_quantity) values ($1,now(),now()+interval '1 month',4) returning id`, [mem]))[0].id;
      const ms = (await s.q(`insert into public.membership_services (membership_id,service_id,vehicle_id,quantity_per_period) values ($1,$2,$3,4) returning id`, [mem, svc, veh]))[0].id;
      const ent = (await s.q(`insert into public.membership_entitlements (membership_id,membership_period_id,membership_service_id,customer_profile_id,vehicle_id,service_id,allocated_quantity,consumed_quantity,expires_at)
                              values ($1,$2,$3,$4,$5,$6,4,1,now()+interval '6 months') returning id`, [mem, per, ms, u.profileId, veh, svc]))[0].id;
      await s.q(`insert into public.entitlement_transactions (entitlement_id,customer_profile_id,transaction_type,quantity_delta) values ($1,$2,'consumption',-1)`, [ent, u.profileId]);
      await s.q('SET LOCAL session_replication_role = origin');

      await apply(s, ['0001', '0002']);

      expect((await s.q(`select to_regclass('public.membership_entitlements') r`))[0].r).toBeNull();
      const counts = (await s.q(`select (select count(*)::int from legacy_credits.membership_entitlements) e, (select count(*)::int from legacy_credits.entitlement_transactions) t, (select count(*)::int from legacy_credits.membership_periods) p`))[0];
      expect(counts).toEqual({ e: 1, t: 1, p: 1 });
      expect((await s.q(`select consumed_quantity c from legacy_credits.membership_entitlements`))[0].c).toBe(1);
      expect((await s.q(`select obj_description('legacy_credits'::regnamespace) d`))[0].d).toMatch(/entitlements=1, transactions=1, periods=1/);
      // nobody but the database owner can read the archive
      await s.as('authenticated', u.authId);
      expect(await s.err('select * from legacy_credits.membership_entitlements')).toMatch(/permission denied/);
      await s.as('service_role');
      expect(await s.err('select * from legacy_credits.membership_entitlements')).toMatch(/permission denied/);
    }));
});

describe('cutover 03: workers see the pool, not customers', () => {
  async function scene(s: any) {
    const cust = await createCustomer(s);
    const veh = await createVehicle(s, cust.profileId);
    await s.as('postgres');
    await s.q(`insert into public.customer_addresses (customer_profile_id, society_name, building_block, flat_number, parking_location, is_default) values ($1,'Yashwin Orizzonte','B','B-702','Basement P1',true)`, [cust.profileId]);
    const addr = (await s.q('select id from public.customer_addresses where customer_profile_id=$1', [cust.profileId]))[0].id;
    const { bookingId } = await settleOnDemand(s, cust, veh, await serviceId(s, 'car-body-wash'));
    await s.q('update public.bookings set address_id=$2 where id=$1', [bookingId, addr]);
    return { cust, veh, bookingId, addr, w1: await createWorker(s), w2: await createWorker(s), admin: await createAdmin(s) };
  }

  it('before claiming, a worker cannot read the customer, vehicle, address or booking tables', async () =>
    inTx(async (s) => {
      const x = await scene(s);
      await apply(s, ['0003']);
      await s.as('authenticated', x.w1.authId);
      expect(await s.q(`select 1 from public.profiles where id=$1`, [x.cust.profileId])).toHaveLength(0);
      expect(await s.q(`select 1 from public.vehicles where id=$1`, [x.veh])).toHaveLength(0);
      expect(await s.q(`select 1 from public.customer_addresses where id=$1`, [x.addr])).toHaveLength(0);
      expect(await s.q(`select 1 from public.bookings where id=$1`, [x.bookingId])).toHaveLength(0);
      expect(await s.q(`select 1 from public.booking_events where booking_id=$1`, [x.bookingId])).toHaveLength(0);
    }));

  it('the pool shows only what is needed to decide: no name, phone, flat, parking or plate', async () =>
    inTx(async (s) => {
      const x = await scene(s);
      await apply(s, ['0003']);
      await s.as('authenticated', x.w1.authId);
      const pool = await s.q('select * from public.worker_pool(14)');
      expect(pool).toHaveLength(1);
      expect(Object.keys(pool[0]).sort()).toEqual(['booking_id', 'booking_type', 'city', 'area_locality', 'scheduled_date', 'service_name', 'society_name', 'time_slot', 'vehicle_type'].sort());
      expect(pool[0]).toMatchObject({ booking_id: x.bookingId, service_name: 'Car Body Wash', vehicle_type: 'car', society_name: 'Yashwin Orizzonte' });
      expect(JSON.stringify(pool[0])).not.toMatch(/B-702|Basement|MH12/);
    }));

  it('after claiming, that worker (and only that worker) sees the full details', async () =>
    inTx(async (s) => {
      const x = await scene(s);
      await apply(s, ['0003']);
      await s.as('authenticated', x.w1.authId);
      expect(await s.err(`select public.worker_claim_booking('${x.bookingId}')`)).toBeNull();
      expect(await s.q(`select 1 from public.bookings where id=$1`, [x.bookingId])).toHaveLength(1);
      expect(await s.q(`select 1 from public.profiles where id=$1`, [x.cust.profileId])).toHaveLength(1);
      expect(await s.q(`select 1 from public.vehicles where id=$1`, [x.veh])).toHaveLength(1);
      expect(await s.q(`select parking_location from public.customer_addresses where id=$1`, [x.addr])).toEqual([{ parking_location: 'Basement P1' }]);
      expect(await s.q('select * from public.worker_pool(14)')).toHaveLength(0); // no longer in the pool
      await s.as('authenticated', x.w2.authId);
      expect(await s.q(`select 1 from public.bookings where id=$1`, [x.bookingId])).toHaveLength(0);
      expect(await s.q(`select 1 from public.profiles where id=$1`, [x.cust.profileId])).toHaveLength(0);
      expect(await s.q(`select 1 from public.customer_addresses where id=$1`, [x.addr])).toHaveLength(0);
    }));

  it('customers and admins are unaffected; customers cannot read the pool', async () =>
    inTx(async (s) => {
      const x = await scene(s);
      await apply(s, ['0003']);
      await s.as('authenticated', x.cust.authId);
      expect(await s.q(`select 1 from public.bookings where id=$1`, [x.bookingId])).toHaveLength(1);
      expect(await s.err('select * from public.worker_pool(14)')).toMatch(/Only workers/);
      await s.as('authenticated', x.admin.authId);
      expect(await s.q(`select 1 from public.bookings where id=$1`, [x.bookingId])).toHaveLength(1);
      expect(await s.q(`select 1 from public.profiles where id=$1`, [x.cust.profileId])).toHaveLength(1);
      expect((await s.q('select * from public.worker_pool(14)')).length).toBe(1);
    }));
});

describe('cutover 04: wash photos are private', () => {
  async function bucket(s: any) {
    await s.as('postgres');
    await s.q(`insert into storage.buckets (id, name, public) values ('wash-photos','wash-photos', true) on conflict (id) do update set public = true`);
  }
  async function sceneWithPhoto(s: any) {
    const cust = await createCustomer(s);
    const other = await createCustomer(s);
    const veh = await createVehicle(s, cust.profileId);
    const { bookingId } = await settleOnDemand(s, cust, veh, await serviceId(s, 'car-body-wash'));
    const w1 = await createWorker(s);
    const w2 = await createWorker(s);
    const admin = await createAdmin(s);
    await s.as('postgres');
    await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)`, [bookingId, w1.profileId]);
    await s.q(`insert into storage.objects (bucket_id, name) values ('wash-photos', $1)`, [`${bookingId}/before_front.jpg`]);
    return { cust, other, bookingId, w1, w2, admin };
  }
  const visible = async (s: any) => (await s.q(`select name from storage.objects where bucket_id='wash-photos'`)).length;

  it('the bucket becomes private', async () =>
    inTx(async (s) => {
      await bucket(s);
      await apply(s, ['0004']);
      await s.as('postgres');
      expect((await s.q(`select public from storage.buckets where id='wash-photos'`))[0].public).toBe(false);
    }));

  it('only the booking\'s customer, its assigned worker and admins can see a photo', async () =>
    inTx(async (s) => {
      await bucket(s);
      const x = await sceneWithPhoto(s);
      await apply(s, ['0004']);
      for (const [who, expected] of [[x.cust, 1], [x.w1, 1], [x.admin, 1], [x.other, 0], [x.w2, 0]] as const) {
        await s.as('authenticated', who.authId);
        expect(await visible(s)).toBe(expected);
      }
      await s.as('anon');
      expect(await visible(s)).toBe(0);
    }));

  it('only the assigned worker can upload, and only into that booking\'s folder', async () =>
    inTx(async (s) => {
      await bucket(s);
      const x = await sceneWithPhoto(s);
      await apply(s, ['0004']);
      const up = (name: string) => s.err(`insert into storage.objects (bucket_id, name, owner) values ('wash-photos', '${name}', auth.uid())`);
      await s.as('authenticated', x.w1.authId);
      expect(await up(`${x.bookingId}/after_front.jpg`)).toBeNull();
      expect(await up(`${uid()}/after_front.jpg`)).toMatch(/row-level security/);   // someone else's booking
      expect(await up(`not-a-uuid/after_front.jpg`)).toMatch(/row-level security/); // junk path
      await s.as('authenticated', x.w2.authId);
      expect(await up(`${x.bookingId}/hack.jpg`)).toMatch(/row-level security/);   // a worker who isn't assigned
      await s.as('authenticated', x.cust.authId);
      expect(await up(`${x.bookingId}/hack.jpg`)).toMatch(/row-level security/);   // customers cannot upload
      await s.as('anon');
      expect(await up(`${x.bookingId}/hack.jpg`)).toMatch(/permission denied|row-level security/);
    }));
});

describe('cutover 05: profile phone is locked to the verified number', () => {
  it('a customer cannot write an arbitrary phone number, but can keep their verified one', async () =>
    inTx(async (s) => {
      await apply(s, ['0005']);
      const u = await createAuthUser(s, { email: 'p@t.test', phone: '+919877000001', phoneConfirmed: true });
      await s.as('authenticated', u.authId);
      expect(await s.err(`update public.profiles set phone='+919800000000' where id='${u.profileId}'`)).toMatch(/one-time code/);
      expect(await s.err(`update public.profiles set phone='98770 00001' where id='${u.profileId}'`)).toBeNull(); // same verified number, different format
      expect(await s.err(`update public.profiles set full_name='New Name' where id='${u.profileId}'`)).toBeNull();
    }));

  it('a user without a verified phone cannot set one; admins and server code can', async () =>
    inTx(async (s) => {
      await apply(s, ['0005']);
      const noPhone = await createAuthUser(s, { email: 'e@t.test' });
      const admin = await createAdmin(s);
      await s.as('authenticated', noPhone.authId);
      expect(await s.err(`update public.profiles set phone='+919811112222' where id='${noPhone.profileId}'`)).toMatch(/one-time code/);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`update public.profiles set phone='+919811112222' where id='${noPhone.profileId}'`)).toBeNull();
      await s.as('service_role');
      expect(await s.err(`update public.profiles set phone='+919811113333' where id='${noPhone.profileId}'`)).toBeNull();
    }));

  it('the legitimate phone-OTP login still links to the existing profile', async () =>
    inTx(async (s) => {
      await apply(s, ['0005']);
      const old = await createAuthUser(s, { email: 'old@t.test' });
      await s.as('postgres');
      await s.q(`update public.profiles set phone='+919844000009' where id=$1`, [old.profileId]);
      const fresh = await createAuthUser(s, { phone: '+919844000009', phoneConfirmed: true });
      await s.as('postgres');
      expect((await s.q('select auth_user_id from public.profiles where id=$1', [old.profileId]))[0].auth_user_id).toBe(fresh.authId);
      void nextPhone; void setRole;
    }));
});
