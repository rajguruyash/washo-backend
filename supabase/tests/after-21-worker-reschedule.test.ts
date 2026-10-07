/** GREEN tests for 20261004000021: a specialist moves a membership wash the vehicle could not be washed on; a customer clears a plan from their pages. */
import { describe, expect, it } from 'vitest';
import { createAddress, createCustomer, createVehicle, createWorker, inTx, istDate, paidMembership, uid } from './helpers';

const NOPE = /permission denied|Not authorized/i;
const PATTERN = [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }];

/** A paid membership whose washes are all held by one regular specialist. */
async function held(s: any, o: { startDays?: number } = {}) {
  const w = await createWorker(s);
  const m = await paidMembership(s, { startDays: o.startDays ?? 2 });
  await s.as('authenticated', m.admin.authId);
  await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
  return { w, m };
}
const move = (s: any, booking: string, date: string, slot: string | null = null, reason: string | null = null) =>
  s.err(`select public.worker_reschedule_wash('${booking}','${date}'::date,${slot ? `'${slot}'::public.time_slot` : 'null'},${reason ? `'${reason}'` : 'null'})`);
const row = async (s: any, id: string) => {
  await s.as('postgres');
  return (await s.q(`select to_char(scheduled_date,'YYYY-MM-DD') d, time_slot::text slot, status::text st, customer_confirmed_at is null unconfirmed from public.bookings where id=$1`, [id]))[0];
};
const holder = async (s: any, id: string) => {
  await s.as('postgres');
  return (await s.q(`select worker_profile_id w from public.worker_assignments where booking_id=$1 and is_active`, [id])).map((r: any) => r.w);
};
/** A day within the term that suits the weekday-1/3/5 pattern and is not one of the membership's own wash days. */
const freeDay = async (s: any, membership: string, after: string) => {
  await s.as('postgres');
  return (await s.q(
    `select to_char(d,'YYYY-MM-DD') d from generate_series($2::date + 1, $2::date + 20, '1 day') d
      where d <= (select (end_at at time zone 'Asia/Kolkata')::date from public.memberships where id = $1)
        and not exists (select 1 from public.bookings b where b.membership_id = $1 and b.scheduled_date = d::date and b.status <> 'cancelled')
      order by d limit 1`,
    [membership, after]
  ))[0].d as string;
};

describe('a specialist moves a membership wash', () => {
  it('to another day, keeping the wash with them; the customer sees who moved it and why', async () =>
    inTx(async (s) => {
      const { w, m } = await held(s);
      const wash = m.washes[1];
      const target = await freeDay(s, m.membership, wash.d);
      await s.as('authenticated', w.authId);
      expect(await move(s, wash.booking_id, target, null, 'Car was out of the society')).toBeNull();
      expect(await row(s, wash.booking_id)).toEqual({ d: target, slot: wash.slot, st: 'worker_assigned', unconfirmed: true });
      expect(await holder(s, wash.booking_id)).toEqual([w.profileId]);
      // the booking timeline names the specialist and the reason
      await s.as('postgres');
      const ev = (await s.q(`select event_metadata from public.booking_events where booking_id=$1 and event_type='rescheduled' and event_metadata ? 'by' order by created_at desc limit 1`, [wash.booking_id]))[0].event_metadata;
      expect(ev).toMatchObject({ by: 'worker', reason: 'Car was out of the society', new_date: target, old_date: wash.d });
      // and the customer's membership page shows the new date
      await s.as('authenticated', m.u.authId);
      const seen = await s.q(`select to_char(scheduled_date,'YYYY-MM-DD') d from public.bookings where id=$1`, [wash.booking_id]);
      expect(seen[0].d).toBe(target);
    }));

  it('the reason is optional; the day can be today or tomorrow, and the time window can change too', async () =>
    inTx(async (s) => {
      const { w, m } = await held(s, { startDays: 2 });
      const wash = m.washes[0];
      await s.as('authenticated', w.authId);
      // same day, another window
      expect(await move(s, wash.booking_id, wash.d, 'night')).toBeNull();
      expect(await row(s, wash.booking_id)).toMatchObject({ d: wash.d, slot: 'night' });
      await s.as('postgres');
      const ev = (await s.q(`select event_metadata->>'reason' r from public.booking_events where booking_id=$1 and event_type='rescheduled' and event_metadata ? 'by' order by created_at desc limit 1`, [wash.booking_id]))[0];
      expect(ev.r).toBe('Vehicle was not available');
    }));

  it('a wash the specialist claimed from the pool stays theirs on the new day', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const wash = m.washes[0];
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [wash.booking_id]);
      expect(await holder(s, wash.booking_id)).toEqual([w.profileId]);
      const target = await freeDay(s, m.membership, wash.d);
      await s.as('authenticated', w.authId);
      expect(await move(s, wash.booking_id, target)).toBeNull();
      expect(await holder(s, wash.booking_id)).toEqual([w.profileId]);
      expect((await row(s, wash.booking_id)).st).toBe('worker_assigned');
    }));

  it('only the specialist who holds it, and only a signed-in specialist', async () =>
    inTx(async (s) => {
      const { m } = await held(s);
      const other = await createWorker(s);
      const wash = m.washes[1];
      const target = await freeDay(s, m.membership, wash.d);
      await s.as('authenticated', other.authId);
      expect(await move(s, wash.booking_id, target)).toMatch(NOPE);
      await s.as('authenticated', m.u.authId); // the customer is not a specialist
      expect(await move(s, wash.booking_id, target)).toMatch(NOPE);
      await s.as('anon');
      expect(await move(s, wash.booking_id, target)).toMatch(/permission denied/);
      expect((await row(s, wash.booking_id)).d).toBe(wash.d);
    }));

  it('not into the past, not outside the membership, not onto a day the vehicle is already booked, not to the same slot', async () =>
    inTx(async (s) => {
      const { w, m } = await held(s);
      const wash = m.washes[1];
      const yesterday = await istDate(s, -1);
      await s.as('authenticated', w.authId);
      expect(await move(s, wash.booking_id, yesterday)).toMatch(/today or a later date/);
      await s.as('postgres');
      const end = (await s.q(`select to_char((end_at at time zone 'Asia/Kolkata')::date + 1,'YYYY-MM-DD') d from public.memberships where id=$1`, [m.membership]))[0].d;
      await s.as('authenticated', w.authId);
      expect(await move(s, wash.booking_id, end)).toMatch(/within your membership/);
      expect(await move(s, wash.booking_id, m.washes[2].d)).toMatch(/already has a wash on that date/);
      expect(await move(s, wash.booking_id, wash.d)).toMatch(/already the date and time/);
      expect(await move(s, wash.booking_id, wash.d, null, 'x'.repeat(301))).toMatch(/under 300 characters/);
    }));

  it('not once the wash has started, and not for a single wash', async () =>
    inTx(async (s) => {
      const { w, m } = await held(s);
      const wash = m.washes[1];
      const target = await freeDay(s, m.membership, wash.d);
      await s.as('postgres');
      await s.q(`update public.bookings set status='in_progress' where id=$1`, [wash.booking_id]);
      await s.as('authenticated', w.authId);
      expect(await move(s, wash.booking_id, target)).toMatch(/already started/);

      // a single (non-membership) wash held by the same specialist
      const c = await createCustomer(s);
      const addr = await createAddress(s, c.profileId);
      const veh = await createVehicle(s, c.profileId, 'car');
      await s.as('postgres');
      const svc = (await s.q(`select id from public.services where code='car-body-wash'`))[0].id;
      const single = (await s.q(
        `insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id,parking_location)
         values ($1,$2,$3,'on_demand',(now() at time zone 'Asia/Kolkata')::date + 3,'morning','confirmed',$4,'P2') returning id`,
        [c.profileId, veh, svc, addr]
      ))[0].id;
      await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) values ($1,$2,true,now())`, [single, w.profileId]);
      const later = await istDate(s, 6); // (the helper runs as postgres, so look the date up before signing in as the specialist)
      await s.as('authenticated', w.authId);
      expect(await move(s, single, later)).toMatch(/Only a membership wash/);
    }));

  it('not on a membership that is no longer active', async () =>
    inTx(async (s) => {
      const { w, m } = await held(s);
      const wash = m.washes[1];
      const target = await freeDay(s, m.membership, wash.d);
      await s.as('postgres');
      await s.q('alter table public.memberships disable trigger user');
      await s.q(`update public.memberships set status='cancelled' where id=$1`, [m.membership]);
      await s.q('alter table public.memberships enable trigger user');
      await s.as('authenticated', w.authId);
      expect(await move(s, wash.booking_id, target)).toMatch(/not active/);
    }));

  it('the customer and the admin still reschedule the same way (the core only names who moved it)', async () =>
    inTx(async (s) => {
      const { m } = await held(s);
      const wash = m.washes[3];
      const target = await freeDay(s, m.membership, wash.d);
      await s.as('authenticated', m.admin.authId);
      expect((await s.q(`select public.admin_reschedule_wash($1,$2::date,'morning','Customer called')`, [wash.booking_id, target]))[0]).toBeTruthy();
      await s.as('postgres');
      const by = (await s.q(`select event_metadata->>'by' b from public.booking_events where booking_id=$1 and event_type='rescheduled' and event_metadata ? 'by' order by created_at desc limit 1`, [wash.booking_id]))[0].b;
      expect(by).toBe('admin');
    }));
});

describe('a customer clears a plan from their pages', () => {
  const checkout = async (s: any, c: { u: any; addr: string; veh: string; start: string }) => {
    await s.as('authenticated', c.u.authId);
    return (await s.q(`select public.start_membership_checkout($1,$2::jsonb,1,'morning',$3::date,$4,'Basement P1','Gate 4321') r`, [c.veh, JSON.stringify(PATTERN), c.start, c.addr]))[0].r;
  };
  const setup = async (s: any) => {
    const u = await createCustomer(s);
    const addr = await createAddress(s, u.profileId);
    const veh = await createVehicle(s, u.profileId, 'car');
    return { u, addr, veh, start: await istDate(s, 4) };
  };
  const remove = (s: any, kind: string, id: string) => s.err(`select public.remove_my_plan('${kind}','${id}')`);
  const hiddenCount = async (s: any, id: string) => { await s.as('postgres'); return (await s.q('select count(*)::int n from public.customer_hidden_plans where ref_id=$1', [id]))[0].n; };

  it('an unpaid plan: its checkout is stopped (request cancelled, payment failed) and it is hidden, not deleted', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const r = await checkout(s, c);
      await s.as('authenticated', c.u.authId);
      const out = (await s.q(`select public.remove_my_plan('membership_request',$1) r`, [r.request_id]))[0].r;
      expect(out).toEqual({ removed: true, stopped_checkout: true });
      await s.as('postgres');
      expect((await s.q('select status::text s from public.membership_requests where id=$1', [r.request_id]))[0].s).toBe('cancelled');
      expect((await s.q('select status::text s from public.payments where id=$1', [r.payment_id]))[0].s).toBe('failed');
      expect(await hiddenCount(s, r.request_id)).toBe(1);
      // it is still in the table for WASHO's records
      expect((await s.q('select count(*)::int n from public.membership_requests where id=$1', [r.request_id]))[0].n).toBe(1);
      // the customer reads their own hidden list (RLS), and doing it twice is harmless
      await s.as('authenticated', c.u.authId);
      expect((await s.q('select ref_id from public.customer_hidden_plans'))[0].ref_id).toBe(r.request_id);
      expect(await remove(s, 'membership_request', r.request_id)).toBeNull();
      expect(await hiddenCount(s, r.request_id)).toBe(1);
    }));

  it('an earlier request that has ended is just hidden', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const r = await checkout(s, c);
      await s.as('postgres');
      await s.q(`update public.membership_requests set status='expired' where id=$1`, [r.request_id]);
      await s.as('authenticated', c.u.authId);
      expect((await s.q(`select public.remove_my_plan('membership_request',$1) r`, [r.request_id]))[0].r).toEqual({ removed: true, stopped_checkout: false });
    }));

  it('never an active membership or its request, and never a plan whose payment has come in', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s);
      await s.as('authenticated', m.u.authId);
      expect(await remove(s, 'membership', m.membership)).toMatch(/active membership cannot be removed/);
      expect(await remove(s, 'membership_request', m.requestId)).toMatch(/now a membership/);

      const c = await setup(s);
      const r = await checkout(s, c);
      await s.as('postgres');
      await s.q(`update public.payments set status='paid', fulfilment_status='unfulfilled' where id=$1`, [r.payment_id]);
      await s.as('authenticated', c.u.authId);
      expect(await remove(s, 'membership_request', r.request_id)).toMatch(/payment for this plan has been received/);
      await s.as('postgres');
      expect((await s.q('select status::text s from public.membership_requests where id=$1', [r.request_id]))[0].s).toBe('accepted');
    }));

  it('an ended membership can be cleared; someone else\'s plan, an unknown plan and a non-customer cannot', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s);
      await s.as('postgres');
      await s.q('alter table public.memberships disable trigger user');
      await s.q(`update public.memberships set status='expired' where id=$1`, [m.membership]);
      await s.q('alter table public.memberships enable trigger user');

      const stranger = await createCustomer(s);
      await s.as('authenticated', stranger.authId);
      expect(await remove(s, 'membership', m.membership)).toMatch(/Plan not found/);
      expect(await hiddenCount(s, m.membership)).toBe(0);

      await s.as('authenticated', m.u.authId);
      expect(await remove(s, 'membership', m.membership)).toBeNull();
      expect(await remove(s, 'membership', uid())).toMatch(/Plan not found/);
      expect(await remove(s, 'something_else', m.membership)).toMatch(/Unknown kind/);

      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      expect(await remove(s, 'membership', m.membership)).toMatch(/Customer profile not found/);
      await s.as('anon');
      expect(await remove(s, 'membership', m.membership)).toMatch(/permission denied/);
      await s.as('postgres');
      expect(await hiddenCount(s, m.membership)).toBe(1);
    }));
});
