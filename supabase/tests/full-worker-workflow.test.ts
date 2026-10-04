/** The complete membership-wash lifecycle on the FULLY migrated schema (migrations + cutover). */
import { describe, expect, it } from 'vitest';
import { createCustomer, createWorker, inTx, paidMembership } from './helpers';

const rowOf = async (s: any, w: any, id: string) => { await s.as('authenticated', w.authId); return (await s.q('select * from public.worker_queue(60) where booking_id=$1', [id]))[0]; };

describe('membership wash, start to finish', () => {
  it('paid -> assigned -> call -> confirm -> start -> before -> after -> complete; the next wash is already queued', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const [x, next] = m.washes;
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);

      await s.as('authenticated', w.authId);
      await s.q('select public.worker_call_customer($1)', [x.booking_id]);
      await s.q('select public.worker_confirm_customer($1)', [x.booking_id]);
      await s.q('select public.worker_start_wash($1)', [x.booking_id]);
      expect((await rowOf(s, w, x.booking_id)).bucket).toBe('in_progress');

      // completion is refused until there is a before AND an after photo
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${x.booking_id}')`)).toMatch(/before photo is required/);
      await s.q(`select public.save_booking_photo($1,'before','front',$2)`, [x.booking_id, `${x.booking_id}/before-front.jpg`]);
      expect(await s.err(`select public.worker_complete_wash('${x.booking_id}')`)).toMatch(/after photo is required/);
      await s.q(`select public.save_booking_photo($1,'after','front',$2)`, [x.booking_id, `${x.booking_id}/after-front.jpg`]);
      expect((await rowOf(s, w, x.booking_id))).toMatchObject({ photos_before: 1, photos_after: 1 });

      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_complete_wash('${x.booking_id}')`)).toBeNull();
      expect(await s.err(`select public.worker_complete_wash('${x.booking_id}')`)).toBeNull(); // idempotent

      const done = await rowOf(s, w, x.booking_id);
      expect(done).toMatchObject({ status: 'completed', bucket: 'completed', customer_phone: null }); // phone is for live washes only
      expect(done.completed_at).not.toBeNull();
      expect(done.customer_name).toBeTruthy();

      await s.as('postgres');
      expect((await s.q(`select status::text s from public.membership_schedule_occurrences where id=$1`, [x.occ]))[0].s).toBe('completed');
      expect((await s.q(`select count(*)::int n from public.notifications where reference_id=$1 and category='wash_completed'`, [x.booking_id]))[0].n).toBe(1);
      // photos can't be added to a finished wash
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.save_booking_photo('${x.booking_id}','after','additional','${x.booking_id}/late.jpg')`)).toMatch(/only be added while the wash is open/);

      // the next wash needed no action: it is already in this worker's queue, scheduled
      const n = await rowOf(s, w, next.booking_id);
      expect(n).toMatchObject({ status: 'worker_assigned', wash_number: 2, washes_total: 12 });
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.bookings where membership_id=$1 and status='completed'`, [m.membership]))[0].n).toBe(1);
      expect((await s.q(`select count(*)::int n from public.bookings where membership_id=$1 and status='worker_assigned'`, [m.membership]))[0].n).toBe(11);
    }));

  it('the customer can see their before and after photos; a stranger cannot', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const stranger = await createCustomer(s);
      const m = await paidMembership(s, { startDays: 2 });
      const x = m.washes[0];
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_worker($1,$2)', [x.booking_id, w.profileId]);
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_start_wash($1)', [x.booking_id]);
      await s.q(`select public.save_booking_photo($1,'before','front',$2)`, [x.booking_id, `${x.booking_id}/b.jpg`]);
      await s.as('authenticated', m.u.authId);
      expect(await s.q('select phase from public.booking_photos_for_viewer($1)', [x.booking_id])).toEqual([{ phase: 'before' }]);
      await s.as('authenticated', stranger.authId);
      expect(await s.err(`select * from public.booking_photos_for_viewer('${x.booking_id}')`)).toMatch(/Not found/);
    }));

  it('only the holder can complete', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const other = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const x = m.washes[0];
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_worker($1,$2)', [x.booking_id, w.profileId]);
      await s.as('authenticated', other.authId);
      expect(await s.err(`select public.worker_complete_wash('${x.booking_id}')`)).toMatch(/Only the assigned worker/);
    }));
});

describe('cancellation and the worker queue', () => {
  it('WASHO cancelling a membership wash drops it from the worker\'s live queue (no customer details) and needs no credit tables', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const x = m.washes[0];
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);

      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.cancel_customer_booking('${x.booking_id}','Society water shutdown')`)).toBeNull();

      const row = await rowOf(s, w, x.booking_id);
      expect(row).toMatchObject({ status: 'cancelled', bucket: 'changed', customer_name: null, customer_phone: null, society_name: null });
      expect(row.change).toMatchObject({ kind: 'cancelled', reason: 'Society water shutdown' });
      // the other washes are untouched
      await s.as('authenticated', w.authId);
      expect((await s.q(`select count(*)::int n from public.worker_queue(60) where bucket='upcoming'`))[0].n).toBe(11);
    }));

  it('a customer cannot cancel a membership wash (they can reschedule it)', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.cancel_customer_booking('${m.washes[0].booking_id}','nope')`)).toMatch(/rescheduled but not cancelled/);
    }));

  it('admin_update_booking works without the credit tables (cancel + assign)', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const [a, b] = m.washes;
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_update_booking('${a.booking_id}', null, '${w.profileId}')`)).toBeNull();
      expect(await s.err(`select public.admin_update_booking('${b.booking_id}', 'cancelled', null, 'Customer asked')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select status::text s from public.membership_schedule_occurrences where id=$1`, [b.occ]))[0].s).toBe('cancelled');
      expect((await s.q(`select status::text s from public.bookings where id=$1`, [a.booking_id]))[0].s).toBe('worker_assigned');
    }));
});

describe('worker privacy after the cutover', () => {
  it('direct table reads show a worker nothing about customers they do not hold; the queue shows what they do', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', w.authId);
      expect(await s.q('select id from public.profiles where id <> public.current_profile_id()')).toHaveLength(0);
      expect(await s.q('select id from public.vehicles')).toHaveLength(0);
      expect(await s.q('select id from public.customer_addresses')).toHaveLength(0);
      expect(await s.q('select id from public.bookings')).toHaveLength(0);

      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_worker($1,$2)', [m.washes[0].booking_id, w.profileId]);
      await s.as('authenticated', w.authId);
      expect((await s.q('select id from public.bookings')).map((r: any) => r.id)).toEqual([m.washes[0].booking_id]);
      expect(await s.q('select id from public.profiles where id = $1', [m.u.profileId])).toHaveLength(1); // only the customer of a held wash
    }));
});
