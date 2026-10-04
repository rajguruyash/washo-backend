/** GREEN tests for 20261004000006_reschedule_membership_wash.sql */
import { describe, expect, it } from 'vitest';
import { createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, uid } from './helpers';

const PATTERN = [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }];

/** A real, paid, active 1-month membership (so the test exercises the production creation path). */
async function activeMembership(s: any) {
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
  const washes = await s.q(`select b.id booking_id, o.id occ, to_char(b.scheduled_date,'YYYY-MM-DD') d, b.time_slot::text slot
                              from public.bookings b join public.membership_schedule_occurrences o on o.id=b.membership_schedule_occurrence_id
                             where b.membership_id=$1 order by b.scheduled_date`, [r.membership_id]);
  return { u, veh, washes, membership: r.membership_id as string };
}
const resched = (s: any, occ: string, date: string, slot: string) =>
  s.err(`select public.reschedule_booking_occurrence('${occ}','${date}'::date,'${slot}'::public.time_slot)`);
const wash = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select to_char(scheduled_date,'YYYY-MM-DD') d, time_slot::text slot, status::text st from public.bookings where id=$1`, [id]))[0]; };
const occRow = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select to_char("current_date",'YYYY-MM-DD') d, time_slot::text slot, status::text st from public.membership_schedule_occurrences where id=$1`, [id]))[0]; };

describe('rescheduling a membership wash', () => {
  it('moves the date, keeping the slot (and booking + occurrence stay in step)', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[0];
      const target = (await s.q(`select (d::date)::text d from generate_series($1::date + 20, $1::date + 26, '1 day') d where extract(dow from d)=2 limit 1`, [w.d]))[0].d;
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, w.occ, target, 'morning')).toBeNull();
      expect(await wash(s, w.booking_id)).toEqual({ d: target, slot: 'morning', st: 'confirmed' });
      expect(await occRow(s, w.occ)).toEqual({ d: target, slot: 'morning', st: 'rescheduled' });
    }));

  it('CHANGES THE SLOT (this failed in production before)', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[1];
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, w.occ, w.d, 'night')).toBeNull(); // same day, different slot
      expect(await wash(s, w.booking_id)).toEqual({ d: w.d, slot: 'night', st: 'confirmed' });
      expect(await occRow(s, w.occ)).toMatchObject({ d: w.d, slot: 'night' });
    }));

  it('changes date and slot together', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[2];
      const target = (await s.q(`select (d::date)::text d from generate_series($1::date + 15, $1::date + 21, '1 day') d where extract(dow from d)=6 limit 1`, [w.d]))[0].d;
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, w.occ, target, 'afternoon')).toBeNull();
      expect(await wash(s, w.booking_id)).toEqual({ d: target, slot: 'afternoon', st: 'confirmed' });
      expect(await occRow(s, w.occ)).toMatchObject({ d: target, slot: 'afternoon', st: 'rescheduled' });
    }));

  it('records who moved it, from where to where', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[1];
      await s.as('authenticated', m.u.authId);
      await resched(s, w.occ, w.d, 'night');
      await s.as('postgres');
      const ev = await s.q(`select event_metadata, actor_profile_id from public.booking_events where booking_id=$1 and event_type='rescheduled' order by created_at desc limit 1`, [w.booking_id]);
      expect(ev[0].actor_profile_id).toBe(m.u.profileId);
      expect(ev[0].event_metadata).toMatchObject({ old_slot: 'morning', new_slot: 'night' });
    }));

  it('a worker who had claimed the wash is released', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[1];
      const worker = await createWorker(s);
      await s.as('postgres');
      await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)`, [w.booking_id, worker.profileId]);
      await s.q(`update public.bookings set status='worker_assigned' where id=$1`, [w.booking_id]);
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, w.occ, w.d, 'afternoon')).toBeNull();
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.worker_assignments where booking_id=$1 and is_active', [w.booking_id]))[0].n).toBe(0);
      expect((await wash(s, w.booking_id)).st).toBe('confirmed');
    }));

  it('a wash the crew could not reach (call not picked up) can be rescheduled', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[0];
      await s.as('postgres');
      await s.q(`update public.bookings set status='call_not_picked_up' where id=$1`, [w.booking_id]);
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, w.occ, w.d, 'night')).toBeNull();
      expect((await wash(s, w.booking_id)).st).toBe('confirmed');
    }));
});

describe('rescheduling is restricted', () => {
  it('not to another customer\'s wash, not by anon', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const other = await createCustomer(s);
      await s.as('authenticated', other.authId);
      expect(await resched(s, m.washes[0].occ, m.washes[0].d, 'night')).toMatch(/Wash not found/);
      await s.as('anon');
      expect(await resched(s, m.washes[0].occ, m.washes[0].d, 'night')).toMatch(/permission denied/);
    }));

  it('not to a date that is too soon, or beyond the membership term', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      const w = m.washes[0];
      const tomorrow = await istDate(s, 1);
      const far = await istDate(s, 400);
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, w.occ, tomorrow, 'morning')).toMatch(/at least 1 day of preparation/);
      expect(await resched(s, w.occ, far, 'morning')).toMatch(/within your membership/);
    }));

  it('not onto a day the vehicle already has a wash, and not as a no-op', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, m.washes[0].occ, m.washes[1].d, 'morning')).toMatch(/already has a wash on that date/);
      expect(await resched(s, m.washes[0].occ, m.washes[0].d, m.washes[0].slot)).toMatch(/already the date and time/);
    }));

  it('not once the wash is in progress or done, or the membership has ended', async () =>
    inTx(async (s) => {
      const m = await activeMembership(s);
      await s.as('postgres');
      await s.q(`update public.bookings set status='in_progress' where id=$1`, [m.washes[0].booking_id]);
      await s.q(`update public.bookings set status='completed' where id=$1`, [m.washes[1].booking_id]);
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, m.washes[0].occ, m.washes[0].d, 'night')).toMatch(/in_progress and cannot be rescheduled/);
      expect(await resched(s, m.washes[1].occ, m.washes[1].d, 'night')).toMatch(/completed and cannot be rescheduled/);
      await s.as('postgres');
      await s.q(`update public.memberships set status='cancelled' where id=$1`, [m.membership]);
      await s.as('authenticated', m.u.authId);
      expect(await resched(s, m.washes[2].occ, m.washes[2].d, 'night')).toMatch(/not active/);
    }));
});
