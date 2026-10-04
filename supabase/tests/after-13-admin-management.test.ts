/** GREEN tests for 20261004000013_admin_management.sql: admin create / edit / ARCHIVE for people, washes, services and prices. */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, paidMembership, confirmedBooking, serviceId, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;

async function sid(s: any, code: string) {
  return serviceId(s, code);
}

describe('only an admin can use any of it', () => {
  it('customers, specialists and anonymous callers are refused by every function', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const w = await createWorker(s);
      const veh = await createVehicle(s, c.profileId);
      const svc = await sid(s, 'car-body-wash');
      const day = await istDate(s, 5);
      const calls = [
        `select public.admin_update_customer_profile('${c.profileId}','Hacker','h@x.test')`,
        `select public.admin_set_profile_archived('${c.profileId}', true)`,
        `select public.admin_save_vehicle(null,'${c.profileId}','car','x','Model','MH12ZZ9999')`,
        `select public.admin_set_vehicle_active('${veh}', false)`,
        `select public.admin_save_address(null,'${c.profileId}','Home','Soc','B','1','P1')`,
        `select public.admin_create_booking('${c.profileId}','${veh}','${svc}','${day}','morning')`,
        `select public.admin_save_service(null,'sneaky','Sneaky','car')`,
        `select public.admin_set_service_active('${svc}', false)`,
        `select public.admin_set_service_price('${svc}','car', 100)`,
        `select public.admin_set_discount('frequency', 3, 5000, 'Free money')`,
        `select public.admin_remove_discount('frequency', 3)`,
        `select public.admin_set_pricing_setting('max_total_discount_bp', 5000)`,
        `select public.admin_begin_password_reset('${w.profileId}')`,
      ];
      for (const who of [{ role: 'authenticated', id: c.authId }, { role: 'authenticated', id: w.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        for (const sql of calls) expect(await s.err(sql), sql).toMatch(NOT_ADMIN);
      }
    }));
});

describe('customers', () => {
  it('edits name and email, never the phone', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const c = await createCustomer(s);
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_update_customer_profile($1, '  Meera Joshi ', 'Meera@Example.COM')`, [c.profileId]);
      await s.as('postgres');
      expect((await s.q('select full_name, email, phone from public.profiles where id=$1', [c.profileId]))[0]).toEqual({ full_name: 'Meera Joshi', email: 'meera@example.com', phone: c.phone });
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_update_customer_profile('${c.profileId}', 'M', null)`)).toMatch(/full name/);
      expect(await s.err(`select public.admin_update_customer_profile('${c.profileId}', 'Meera', 'not-an-email')`)).toMatch(/valid email/);
      expect(await s.err(`select public.admin_update_customer_profile('${admin.profileId}', 'Boss', null)`)).toMatch(/Customer not found/); // only customers
      await s.q(`select public.admin_update_customer_profile($1, 'Meera Joshi', '')`, [c.profileId]);
      await s.as('postgres');
      expect((await s.q('select email from public.profiles where id=$1', [c.profileId]))[0].email).toBeNull();
    }));

  it('archives a customer with no live work, and restores them', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const c = await createCustomer(s);
      await s.as('authenticated', admin.authId);
      const r = (await s.q('select public.admin_set_profile_archived($1, true, $2) r', [c.profileId, 'Moved away']))[0].r;
      expect(r).toMatchObject({ archived: true });
      await s.as('postgres');
      expect((await s.q('select archived_at is not null a from public.profiles where id=$1', [c.profileId]))[0].a).toBe(true);
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id=$1 and event_type='profile_archived'`, [c.profileId]))[0].n).toBe(1);
      await s.as('authenticated', admin.authId);
      expect((await s.q('select public.admin_set_profile_archived($1, false) r', [c.profileId]))[0].r).toMatchObject({ archived: false, auth_user_id: c.authId });
      await s.as('postgres');
      expect((await s.q('select archived_at from public.profiles where id=$1', [c.profileId]))[0].archived_at).toBeNull();
    }));

  it('refuses to archive a customer with a scheduled wash or an active membership', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const b = await confirmedBooking(s, { days: 3 });
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_profile_archived('${b.u.profileId}', true)`)).toMatch(/1 scheduled wash.*0 active membership/);
      const m = await paidMembership(s);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_profile_archived('${m.u.profileId}', true)`)).toMatch(/active membership/);
      await s.as('postgres');
      expect((await s.q('select archived_at from public.profiles where id=$1', [m.u.profileId]))[0].archived_at).toBeNull();
    }));

  it('cannot archive yourself, another admin, or someone who does not exist', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const other = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_profile_archived('${admin.profileId}', true)`)).toMatch(/own account/);
      expect(await s.err(`select public.admin_set_profile_archived('${other.profileId}', true)`)).toMatch(/Person not found/);
      expect(await s.err(`select public.admin_set_profile_archived('${uid()}', true)`)).toMatch(/Person not found/);
    }));
});

describe('specialists', () => {
  it('archiving returns their upcoming washes (and memberships) to the pool; they can no longer be given work', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s);
      const w = await createWorker(s);
      const single = await confirmedBooking(s, { days: 4 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      await s.q('select public.admin_assign_worker($1,$2)', [single.id, w.profileId]);
      const r = (await s.q('select public.admin_set_profile_archived($1, true, $2) r', [w.profileId, 'Left the company']))[0].r;
      expect(r).toMatchObject({ archived: true, released_memberships: 1, released_washes: 1 });
      await s.as('postgres');
      expect((await s.q('select assigned_worker_profile_id w from public.memberships where id=$1', [m.membership]))[0].w).toBeNull();
      expect((await s.q('select count(*)::int n from public.worker_assignments where worker_profile_id=$1 and is_active', [w.profileId]))[0].n).toBe(0);
      expect((await s.q('select status::text s from public.bookings where id=$1', [single.id]))[0].s).toBe('confirmed');
      // never assigned again while archived
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_assign_worker('${single.id}','${w.profileId}')`)).toMatch(/archived/);
      expect(await s.err(`select public.admin_assign_membership_worker('${m.membership}','${w.profileId}')`)).toMatch(/archived/);
      // restored: allowed again
      await s.q('select public.admin_set_profile_archived($1, false)', [w.profileId]);
      expect(await s.err(`select public.admin_assign_worker('${single.id}','${w.profileId}')`)).toBeNull();
    }));

  it('a password reset is allowed only for a live specialist, and leaves an audit trail', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const w = await createWorker(s);
      const c = await createCustomer(s);
      await s.as('authenticated', admin.authId);
      expect((await s.q('select public.admin_begin_password_reset($1) a', [w.profileId]))[0].a).toBe(w.authId);
      expect(await s.err(`select public.admin_begin_password_reset('${c.profileId}')`)).toMatch(/Specialist not found/);
      await s.q('select public.admin_set_profile_archived($1, true)', [w.profileId]);
      expect(await s.err(`select public.admin_begin_password_reset('${w.profileId}')`)).toMatch(/Specialist not found/);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id=$1 and event_type='worker_password_reset'`, [w.profileId]))[0].n).toBe(1);
    }));

  it('cannot be archived while a wash is in progress', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const w = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0, status: 'in_progress' });
      await s.as('postgres');
      await s.q('insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)', [b.id, w.profileId]);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_profile_archived('${w.profileId}', true)`)).toMatch(/in progress/);
    }));
});

describe("a customer's vehicles", () => {
  it('creates, edits, and refuses a duplicate registration', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const c = await createCustomer(s);
      await s.as('authenticated', admin.authId);
      const id = (await s.q(`select public.admin_save_vehicle(null,$1,'car','Hyundai','Creta',' mh12 ab 1234 ','White',null,'P1') id`, [c.profileId]))[0].id;
      await s.as('postgres');
      expect((await s.q('select registration_number, make, color, parking_location from public.vehicles where id=$1', [id]))[0]).toEqual({ registration_number: 'MH12 AB 1234', make: 'Hyundai', color: 'White', parking_location: 'P1' });
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_save_vehicle($1,$2,'car','Hyundai','Creta N Line','MH12AB1234','Black',null,null)`, [id, c.profileId]);
      expect(await s.err(`select public.admin_save_vehicle(null,'${c.profileId}','car','x','Swift','mh12ab1234')`)).toMatch(/already has a vehicle with that registration/);
      expect(await s.err(`select public.admin_save_vehicle(null,'${c.profileId}','car','x','','MH12ZZ0001')`)).toMatch(/model/);
      expect(await s.err(`select public.admin_save_vehicle('${id}','${(await createCustomer(s)).profileId}','car','x','Y','MH12ZZ0002')`)).toBeTruthy();
    }));

  it('will not change the type of a vehicle with wash history, and will not archive one that is booked', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const b = await confirmedBooking(s, { days: 3 });
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_save_vehicle('${b.veh}','${b.u.profileId}','suv','x','Model','MH12ZZ0003')`)).toMatch(/wash history/);
      expect(await s.err(`select public.admin_set_vehicle_active('${b.veh}', false)`)).toMatch(/scheduled washes/);
      await s.as('postgres');
      await s.q(`update public.bookings set status='completed' where id=$1`, [b.id]);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_vehicle_active('${b.veh}', false)`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select is_active from public.vehicles where id=$1', [b.veh]))[0].is_active).toBe(false);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_vehicle_active('${b.veh}', true)`)).toBeNull();
    }));
});

describe("a customer's addresses", () => {
  it('creates, edits, keeps one default, and archives (clearing it from their vehicles)', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const c = await createCustomer(s);
      await s.as('authenticated', admin.authId);
      const a1 = (await s.q(`select public.admin_save_address(null,$1,'Home','Yashwin','B','B-702','Basement P1') id`, [c.profileId]))[0].id;
      const a2 = (await s.q(`select public.admin_save_address(null,$1,'Office','Eon','A','A-1','Gate 2','Kharadi','Pune','411014',true) id`, [c.profileId]))[0].id;
      await s.as('postgres');
      expect((await s.q('select id, is_default from public.customer_addresses where customer_profile_id=$1 order by label', [c.profileId])).map((r: any) => [r.id === a1, r.is_default]))
        .toEqual([[true, false], [false, true]]); // Home (a1) no longer default, Office (a2) is
      const veh = await createVehicle(s, c.profileId);
      await s.q('update public.vehicles set address_id=$2 where id=$1', [veh, a2]);
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_save_address($1,$2,'Office','Eon Free Zone','A','A-2','Gate 3')`, [a2, c.profileId]);
      expect(await s.err(`select public.admin_save_address(null,'${c.profileId}','Home','Soc','B','1','P1','Kharadi','Pune','4110')`)).toMatch(/6-digit pincode/);
      expect(await s.err(`select public.admin_set_address_archived('${a2}', true)`)).toBeNull();
      await s.as('postgres');
      expect((await s.q('select archived_at is not null a, is_default from public.customer_addresses where id=$1', [a2]))[0]).toEqual({ a: true, is_default: false });
      expect((await s.q('select address_id from public.vehicles where id=$1', [veh]))[0].address_id).toBeNull();
      await s.as('authenticated', admin.authId);
      await s.q('select public.admin_set_address_archived($1, false)', [a2]);
    }));

  it('will not archive an address a scheduled wash is going to', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const b = await confirmedBooking(s, { days: 3 });
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_address_archived('${b.addr}', true)`)).toMatch(/scheduled wash uses this address/);
    }));
});

describe('washes booked by WASHO', () => {
  async function setup(s: any) {
    const admin = await createAdmin(s);
    const c = await createCustomer(s);
    const veh = await createVehicle(s, c.profileId, 'car');
    const addr = await createAddress(s, c.profileId);
    return { admin, c, veh, addr, svc: await sid(s, 'car-body-wash'), day: await istDate(s, 3) };
  }

  it('paid in cash: a confirmed wash at the rate-card price with an offline payment on record', async () =>
    inTx(async (s) => {
      const t = await setup(s);
      await s.as('authenticated', t.admin.authId);
      const r = (await s.q(`select public.admin_create_booking($1,$2,$3,$4::date,'morning',$5,'Gate 4','cash','Call at the gate') r`, [t.c.profileId, t.veh, t.svc, t.day, t.addr]))[0].r;
      expect(r.price_cents).toBe(15000);
      await s.as('postgres');
      expect((await s.q('select status::text s, source, price_cents, parking_location, notes from public.bookings where id=$1', [r.booking_id]))[0])
        .toEqual({ s: 'confirmed', source: 'admin', price_cents: 15000, parking_location: 'Gate 4', notes: 'Call at the gate' });
      expect((await s.q(`select provider, status::text s, amount_cents, booking_id from public.payments where id=$1`, [r.payment_id]))[0]).toEqual({ provider: 'offline', s: 'paid', amount_cents: 15000, booking_id: r.booking_id });
      expect((await s.q(`select event_type from public.booking_events where booking_id=$1 order by created_at, id`, [r.booking_id])).map((e: any) => e.event_type).sort()).toEqual(['booking_created', 'payment_received']);
      expect((await s.q(`select count(*)::int n from public.notifications where profile_id=$1 and reference_id=$2`, [t.c.profileId, r.booking_id]))[0].n).toBe(1);
      // it is an ordinary paid wash: the same vehicle cannot be booked again that day
      await s.as('authenticated', t.admin.authId);
      expect(await s.err(`select public.admin_create_booking('${t.c.profileId}','${t.veh}','${t.svc}','${t.day}','afternoon')`)).toMatch(/already has a wash booked that day/);
      // cancelling it raises a refund REQUEST; it was not paid through Razorpay, so it is refunded by hand
      await s.as('authenticated', t.admin.authId);
      await s.q(`select public.cancel_customer_booking($1,'Customer asked')`, [r.booking_id]);
      await s.as('postgres');
      const refund = (await s.q('select id, amount_cents, status::text s from public.refunds where booking_id=$1', [r.booking_id]))[0];
      expect(refund).toMatchObject({ amount_cents: 15000, s: 'requested' });
      await s.as('authenticated', t.admin.authId);
      expect(await s.err(`select public.admin_begin_refund('${refund.id}')`)).toMatch(/no captured Razorpay payment/);
      expect(await s.err(`select public.admin_resolve_refund('${refund.id}','processed','CASH-0001')`)).toBeNull();
    }));

  it('paid online: a Razorpay payment the website never heard about is recorded once, at the right amount, and can be refunded through Razorpay', async () =>
    inTx(async (s) => {
      const t = await setup(s);
      const laterDay = await istDate(s, 6);
      await s.as('authenticated', t.admin.authId);
      const book = (id: string | null, cents: number | null, day = t.day) =>
        s.err(`select public.admin_create_booking('${t.c.profileId}','${t.veh}','${t.svc}','${day}'::date,'morning',null,null,'online',null,${id ? `'${id}'` : 'null'},${cents ?? 'null'})`);
      expect(await book(null, 15000)).toMatch(/Razorpay payment id/);
      expect(await book('pay_ABC123456', 10000)).toMatch(/is for ₹100 but this wash costs ₹150/);
      expect(await book('pay_ABC123456', null)).toMatch(/is for ₹0 but this wash costs ₹150/);
      const r = (await s.q(`select public.admin_create_booking($1,$2,$3,$4::date,'morning',null,null,'online','Paid on Google Pay','pay_ABC123456',15000) r`, [t.c.profileId, t.veh, t.svc, t.day]))[0].r;
      expect(r.price_cents).toBe(15000);
      await s.as('postgres');
      expect((await s.q('select provider, provider_payment_id, status::text s, amount_cents from public.payments where id=$1', [r.payment_id]))[0]).toEqual({ provider: 'razorpay', provider_payment_id: 'pay_ABC123456', s: 'paid', amount_cents: 15000 });
      // the same Razorpay payment cannot pay for a second wash
      await s.as('authenticated', t.admin.authId);
      expect(await book('pay_ABC123456', 15000, laterDay)).toMatch(/already recorded against another booking/);
      // cancelling raises a refund request that CAN go through Razorpay (a real captured payment is on record)
      await s.q(`select public.cancel_customer_booking($1,'Plans changed')`, [r.booking_id]);
      await s.as('postgres');
      const refund = (await s.q('select id from public.refunds where booking_id=$1', [r.booking_id]))[0];
      await s.as('authenticated', t.admin.authId);
      expect((await s.q('select public.admin_begin_refund($1) r', [refund.id]))[0].r).toMatchObject({ provider_payment_id: 'pay_ABC123456', amount_cents: 15000 });
    }));

  it('complimentary: price 0, no payment, and cancelling it needs no refund', async () =>
    inTx(async (s) => {
      const t = await setup(s);
      await s.as('authenticated', t.admin.authId);
      const r = (await s.q(`select public.admin_create_booking($1,$2,$3,$4::date,'night',null,null,'free') r`, [t.c.profileId, t.veh, t.svc, t.day]))[0].r;
      expect(r).toMatchObject({ price_cents: 0, payment_id: null });
      await s.q(`select public.cancel_customer_booking($1,'Not needed')`, [r.booking_id]);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.refunds where booking_id=$1', [r.booking_id]))[0].n).toBe(0);
    }));

  it('checks the customer, vehicle, service, address, date and payment choice', async () =>
    inTx(async (s) => {
      const t = await setup(s);
      const other = await createCustomer(s);
      const otherVeh = await createVehicle(s, other.profileId);
      const bike = await sid(s, 'bike-body-wash');
      const otherAddr = await createAddress(s, other.profileId);
      const yesterday = await istDate(s, -1);
      await s.as('authenticated', t.admin.authId);
      const book = (o: Partial<Record<string, string>> = {}) =>
        s.err(`select public.admin_create_booking('${o.c ?? t.c.profileId}','${o.v ?? t.veh}','${o.s ?? t.svc}','${o.d ?? t.day}','morning',${o.a ? `'${o.a}'` : 'null'},null,'${o.p ?? 'cash'}')`);
      expect(await book({ p: 'credit' })).toMatch(/how this wash is paid/);
      expect(await book({ v: otherVeh })).toMatch(/Vehicle not found/);
      expect(await book({ s: bike })).toMatch(/not available for that vehicle/);
      expect(await book({ a: otherAddr })).toMatch(/Address not found/);
      expect(await book({ d: yesterday })).toMatch(/today or a later date/);
      expect(await book({ c: uid() })).toMatch(/Customer not found/);
      // an archived customer cannot be booked for
      await s.q('select public.admin_set_profile_archived($1, true)', [t.c.profileId]);
      expect(await book()).toMatch(/Customer not found/);
    }));

  it('edits the address, parking spot and note of a live wash only', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const b = await confirmedBooking(s, { days: 3 });
      await s.as('authenticated', admin.authId);
      const a2 = (await s.q(`select public.admin_save_address(null,$1,'Office','Eon','A','A-1','Gate 2') id`, [b.u.profileId]))[0].id;
      await s.q(`select public.admin_update_booking_details($1,$2,'Gate 2, level 1','Ring twice')`, [b.id, a2]);
      await s.as('postgres');
      expect((await s.q('select address_id, parking_location, notes from public.bookings where id=$1', [b.id]))[0]).toEqual({ address_id: a2, parking_location: 'Gate 2, level 1', notes: 'Ring twice' });
      await s.q(`update public.bookings set status='completed' where id=$1`, [b.id]);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_update_booking_details('${b.id}', null, 'x', null)`)).toMatch(/cannot be edited/);
    }));
});

describe('services and prices', () => {
  it('adds a service, edits it, and will not change its code or vehicle type', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      const id = (await s.q(`select public.admin_save_service(null,'Bike-Polish','Bike Polish','bike','Wax and shine','Gleam in 40 minutes',40,'["Wax","Tyre shine"]'::jsonb,50) id`))[0].id;
      await s.as('postgres');
      expect((await s.q('select code, name, is_active, duration_minutes, includes from public.services where id=$1', [id]))[0]).toEqual({ code: 'bike-polish', name: 'Bike Polish', is_active: true, duration_minutes: 40, includes: ['Wax', 'Tyre shine'] });
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_save_service($1,'bike-polish','Bike Polish Plus','bike','Wax, shine and chain lube','Gleam',45,'["Wax"]'::jsonb,60)`, [id]);
      expect(await s.err(`select public.admin_save_service('${id}','renamed','Bike Polish Plus','bike')`)).toMatch(/code cannot be changed/);
      expect(await s.err(`select public.admin_save_service('${id}','bike-polish','Bike Polish Plus','car')`)).toMatch(/vehicle type cannot be changed/);
      expect(await s.err(`select public.admin_save_service(null,'bike-polish','Another','bike')`)).toMatch(/already exists/);
      expect(await s.err(`select public.admin_save_service(null,'Bad Code!','Another','bike')`)).toMatch(/lowercase/);
      expect(await s.err(`select public.admin_save_service(null,'x-ok','A','bike')`)).toMatch(/service name/);
      expect(await s.err(`select public.admin_save_service(null,'x-ok','Okay','bike',null,null,3)`)).toMatch(/duration/);
      expect(await s.err(`select public.admin_save_service(null,'x-ok','Okay','bike',null,null,30,'"nope"'::jsonb)`)).toMatch(/list of up to 12/);
    }));

  it('retires and restores a service, but not one that memberships are built from', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const carBody = await sid(s, 'car-body-wash');
      await s.as('authenticated', admin.authId);
      const id = (await s.q(`select public.admin_save_service(null,'tyre-shine','Tyre Shine','car') id`))[0].id;
      await s.q('select public.admin_set_service_active($1,false)', [id]);
      await s.as('postgres');
      expect((await s.q('select is_active from public.services where id=$1', [id]))[0].is_active).toBe(false);
      await s.as('authenticated', admin.authId);
      await s.q('select public.admin_set_service_active($1,true)', [id]);
      expect(await s.err(`select public.admin_set_service_active('${carBody}', false)`)).toMatch(/memberships are built from/);
    }));

  it('a new price starts now and the old one is kept, closed', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const svc = await sid(s, 'car-body-wash');
      const c = await createCustomer(s);
      const veh = await createVehicle(s, c.profileId, 'car');
      const day = await istDate(s, 3);
      await s.as('authenticated', admin.authId);
      expect((await s.q(`select public.admin_set_service_price($1,'car',16000) r`, [svc]))[0].r).toEqual({ changed: true, price_cents: 16000 });
      expect((await s.q(`select public.admin_set_service_price($1,'car',16000) r`, [svc]))[0].r).toEqual({ changed: false, price_cents: 16000 });
      await s.as('postgres');
      const rules = await s.q(`select base_amount_cents c, active, rule_version v, valid_to is not null closed from public.pricing_rules where service_id=$1 and vehicle_type='car' and duration_months=1 and quantity_tier=1 order by rule_version`, [svc]);
      expect(rules.at(-2)).toMatchObject({ c: 15000, closed: true });
      expect(rules.at(-1)).toMatchObject({ c: 16000, active: true, closed: false });
      expect((await s.q(`select app_private.unit_price_cents($1,'car') p`, [svc]))[0].p).toBe(16000);
      // a customer is charged the new price
      await s.as('authenticated', c.authId);
      const intent = (await s.q(`select public.create_booking_payment_intent($1,$2,$3::date,'morning',null,'P1',null,'website') i`, [veh, svc, day]))[0].i;
      expect(intent.amount_cents).toBe(16000);
    }));

  it('checks the price and the vehicle type, and a brand-new price just sets it', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const svc = await sid(s, 'car-body-wash');
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_service_price('${svc}','car',50)`)).toMatch(/between ₹1 and ₹10,000/);
      expect(await s.err(`select public.admin_set_service_price('${svc}','car',2000000)`)).toMatch(/between ₹1 and ₹10,000/);
      expect(await s.err(`select public.admin_set_service_price('${svc}','bike',5000)`)).toMatch(/not offered for that vehicle type/);
      const fresh = (await s.q(`select public.admin_save_service(null,'quick-wipe','Quick Wipe','car') id`))[0].id;
      await s.q(`select public.admin_set_service_price($1,'car',9000)`, [fresh]);
      await s.q(`select public.admin_set_service_price($1,'car',9500)`, [fresh]); // started in this transaction: set in place
      await s.q(`select public.admin_set_service_price($1,'suv',9500)`, [fresh]); // SUVs use car services
      await s.as('postgres');
      expect((await s.q(`select app_private.unit_price_cents($1,'car') p`, [fresh]))[0].p).toBe(9500);
      expect((await s.q(`select app_private.unit_price_cents($1,'suv') p`, [fresh]))[0].p).toBe(9500);
    }));

  it('changing a discount or the cap changes what a membership costs, with the old rule kept', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      const c = await createCustomer(s);
      await s.as('authenticated', admin.authId);
      const price = async () => {
        const e = (await s.q(`select public.estimate_membership_price('car', $1::jsonb, 1) e`, [JSON.stringify([{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }])]))[0].e;
        return e.final_cents as number;
      };
      expect(await price()).toBe(187200); // 3 a week: 10% off 2080
      await s.q(`select public.admin_set_discount('frequency', 3, 2000, '3 a week')`);
      expect(await price()).toBe(176800); // 20% would be 1664, but the 15% cap still applies
      await s.q(`select public.admin_set_pricing_setting('max_total_discount_bp', 2500)`);
      expect(await price()).toBe(166400);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.membership_discount_rules where kind='frequency' and key_value=3`))[0].n).toBeGreaterThanOrEqual(2); // history kept
      expect((await s.q(`select count(*)::int n from public.membership_discount_rules where kind='frequency' and key_value=3 and active`))[0].n).toBe(1);
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_remove_discount('frequency', 3)`);
      expect(await price()).toBe(208000);
      expect(await s.err(`select public.admin_remove_discount('frequency', 3)`)).toMatch(/Discount not found/);
      void c;
    }));

  it('validates discounts and settings', async () =>
    inTx(async (s) => {
      const admin = await createAdmin(s);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_discount('loyalty', 3, 500, 'x y')`)).toMatch(/washes a week or for membership length/);
      expect(await s.err(`select public.admin_set_discount('frequency', 8, 500, 'Eight')`)).toMatch(/between 1 and 7/);
      expect(await s.err(`select public.admin_set_discount('duration', 2, 500, 'Two months')`)).toMatch(/1, 3, 6 or 12/);
      expect(await s.err(`select public.admin_set_discount('duration', 3, 6000, 'Huge')`)).toMatch(/between 0% and 50%/);
      expect(await s.err(`select public.admin_set_discount('duration', 3, 500, '')`)).toMatch(/short label/);
      expect(await s.err(`select public.admin_set_pricing_setting('max_total_discount_bp', 9000)`)).toMatch(/not allowed/);
      expect(await s.err(`select public.admin_set_pricing_setting('drop_table', 1)`)).toMatch(/not allowed/);
      expect(await s.err(`select public.admin_set_pricing_setting('weeks_per_month', 4)`)).toBeNull();
    }));
});
