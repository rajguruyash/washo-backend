/** GREEN tests for 20261004000009_worker_workflow.sql (safe set; completion is covered by full-worker-workflow). */
import { describe, expect, it } from 'vitest';
import { PATTERN_3, confirmedBooking, createAdmin, createCustomer, createWorker, inTx, istDate, paidMembership } from './helpers';

const queue = async (s: any, w: { authId: string }, days = 7) => {
  await s.as('authenticated', w.authId);
  return s.q('select * from public.worker_queue($1)', [days]);
};
const st = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select status::text s, customer_confirmed_at c from public.bookings where id=$1`, [id]))[0]; };
const events = async (s: any, id: string) => { await s.as('postgres'); return (await s.q(`select event_type, event_metadata m from public.booking_events where booking_id=$1 order by ctid`, [id])).map((e: any) => e.event_type); };

describe('worker_queue: who sees what', () => {
  it('is for workers only', async () =>
    inTx(async (s) => {
      const u = await createCustomer(s);
      const a = await createAdmin(s);
      for (const who of [u, a]) {
        await s.as('authenticated', who.authId);
        expect(await s.err('select * from public.worker_queue(7)')).toMatch(/Only workers/);
      }
      await s.as('anon');
      expect(await s.err('select * from public.worker_queue(7)')).toMatch(/permission denied/);
    }));

  it('a new worker has an empty queue; assigned washes appear with every detail the worker needs', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      expect(await queue(s, w)).toHaveLength(0);

      const m = await paidMembership(s, { startDays: 2, notes: 'Gate code 4321, dog on site' });
      await s.as('authenticated', m.admin.authId);
      const r = (await s.q('select public.admin_assign_membership_worker($1,$2) r', [m.membership, w.profileId]))[0].r;
      expect(r.washes_updated).toBe(12);

      const rows = await queue(s, w, 60);
      expect(rows).toHaveLength(12);
      const first = rows[0];
      expect(first).toMatchObject({
        status: 'worker_assigned', bucket: 'upcoming', booking_type: 'membership', time_slot: 'morning',
        vehicle_type: 'car', vehicle_make: 'Test', vehicle_model: 'Model', society_name: 'Yashwin Orizzonte', building_block: 'B', flat_number: 'B-702',
        parking_location: 'Basement P1', instructions: 'Gate code 4321, dog on site',
        membership_id: m.membership, membership_label: '3 washes a week · 1 month', wash_number: 1, washes_total: 12,
        customer_confirmed_at: null, photos_before: 0, photos_after: 0, calls_made: 0, change: null,
      });
      expect(first.customer_phone).toMatch(/^\+91/);
      expect(first.customer_name).toBeTruthy();
      expect(first.registration_number).toMatch(/^MH12AB/);
      expect(first.membership_reference).toMatch(/^MR-/);
      expect(first.reference_code).toMatch(/^WSH-/);
      expect(['Car Body Wash', 'Car Deep Cleaning']).toContain(first.service_name);
      expect(rows.map((x: any) => x.wash_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }));

  it('limits the upcoming window to the requested days', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const week = await queue(s, w, 7);
      expect(week.length).toBeGreaterThan(0);
      expect(week.length).toBeLessThan(12);
      for (const r of week) expect(r.scheduled_date <= new Date(Date.now() + 8 * 864e5)).toBe(true);
    }));

  it('puts today / in progress / upcoming / completed in the right bucket', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const today = await confirmedBooking(s, { days: 0 });
      const later = await confirmedBooking(s, { days: 3 });
      const late = await confirmedBooking(s, { days: -1 });
      await s.as('authenticated', w.authId);
      for (const b of [today, later, late]) await s.q('select public.worker_claim_booking($1)', [b.id]);
      let rows = await s.q('select booking_id, bucket, is_overdue from public.worker_queue(7)');
      const by = (id: string) => rows.find((r: any) => r.booking_id === id);
      expect(by(today.id)).toMatchObject({ bucket: 'today', is_overdue: false });
      expect(by(late.id)).toMatchObject({ bucket: 'today', is_overdue: true });
      expect(by(later.id)).toMatchObject({ bucket: 'upcoming' });

      await s.q('select public.worker_start_wash($1)', [today.id]);
      rows = await s.q('select booking_id, bucket from public.worker_queue(7)');
      expect(rows.find((r: any) => r.booking_id === today.id).bucket).toBe('in_progress');
    }));

  it('a worker never sees another worker\'s washes or any customer details from the pool', async () =>
    inTx(async (s) => {
      const w1 = await createWorker(s);
      const w2 = await createWorker(s);
      const b = await confirmedBooking(s, { days: 1 });
      await s.as('authenticated', w1.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      expect(await queue(s, w2)).toHaveLength(0);

      const c = await confirmedBooking(s, { days: 1 });
      await s.as('authenticated', w2.authId);
      const pool = await s.q('select * from public.worker_pool(14)');
      expect(pool.map((p: any) => p.booking_id)).toEqual([c.id]); // w1's claimed wash is not in the pool
      expect(Object.keys(pool[0]).sort()).toEqual(['area_locality', 'booking_id', 'booking_type', 'city', 'scheduled_date', 'service_name', 'society_name', 'time_slot', 'vehicle_type']);
    }));
});

describe('claiming', () => {
  it('only a confirmed, unclaimed wash can be claimed (never an unpaid one)', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const w2 = await createWorker(s);
      const unpaid = await confirmedBooking(s, { days: 2, status: 'pending' });
      const done = await confirmedBooking(s, { days: 2, status: 'completed' });
      const ok = await confirmedBooking(s, { days: 2 });
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_claim_booking('${unpaid.id}')`)).toMatch(/not available to claim/);
      expect(await s.err(`select public.worker_claim_booking('${done.id}')`)).toMatch(/not available to claim/);
      expect(await s.err(`select public.worker_claim_booking('${ok.id}')`)).toBeNull();
      expect(await s.err(`select public.worker_claim_booking('${ok.id}')`)).toBeNull(); // idempotent
      await s.as('authenticated', w2.authId);
      expect(await s.err(`select public.worker_claim_booking('${ok.id}')`)).toMatch(/already assigned/);
    }));
});

describe('the call: confirmed, or not picked up (and the wash stays scheduled)', () => {
  it('call -> customer confirmed -> start; every step is an event', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      expect(await s.err(`select public.worker_call_customer('${b.id}')`)).toBeNull();
      expect((await st(s, b.id)).s).toBe('worker_called');
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_confirm_customer('${b.id}')`)).toBeNull();
      const row = await st(s, b.id);
      expect(row.s).toBe('worker_called');
      expect(row.c).not.toBeNull();
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_start_wash('${b.id}')`)).toBeNull();
      expect((await st(s, b.id)).s).toBe('in_progress');
      expect((await events(s, b.id)).sort()).toEqual(['customer_confirmed', 'wash_started', 'worker_assigned', 'worker_called']);
    }));

  it('not picked up: stays scheduled, is never completed or charged, and the worker can try again', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const { booking_id, occ } = m.washes[0];
      await s.as('postgres');
      const paymentsBefore = (await s.q('select count(*)::int n, sum(amount_cents)::int a from public.payments'))[0];

      await s.as('authenticated', w.authId);
      await s.q('select public.worker_call_customer($1)', [booking_id]);
      expect(await s.err(`select public.worker_customer_unavailable('${booking_id}','Rang 3 times')`)).toBeNull();

      const after = await st(s, booking_id);
      expect(after.s).toBe('call_not_picked_up');
      expect(after.c).toBeNull();
      await s.as('postgres');
      expect((await s.q('select status::text s from public.membership_schedule_occurrences where id=$1', [occ]))[0].s).toBe('call_not_picked_up');
      expect((await s.q('select completed_at from public.bookings where id=$1', [booking_id]))[0].completed_at).toBeNull();
      expect((await s.q('select count(*)::int n, sum(amount_cents)::int a from public.payments'))[0]).toEqual(paymentsBefore);
      expect((await s.q('select count(*)::int n from public.refunds'))[0].n).toBe(0);
      const ev = (await s.q(`select event_metadata m from public.booking_events where booking_id=$1 and event_type='call_not_picked_up'`, [booking_id]))[0].m;
      expect(ev).toMatchObject({ notes: 'Rang 3 times', wash_completed: false, charged: false });

      // still in the worker's queue, still scheduled, and the worker calls again and gets through
      const rows = await queue(s, w, 60);
      expect(rows.find((r: any) => r.booking_id === booking_id)).toMatchObject({ status: 'call_not_picked_up' });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_call_customer($1)', [booking_id]);
      await s.q('select public.worker_confirm_customer($1)', [booking_id]);
      expect((await st(s, booking_id)).s).toBe('worker_called');
      await s.as('postgres');
      expect((await s.q('select status::text s from public.membership_schedule_occurrences where id=$1', [occ]))[0].s).toBe('scheduled');
      await s.as('authenticated', w.authId);
      expect((await s.q('select calls_made from public.worker_queue(60) where booking_id=$1', [booking_id]))[0].calls_made).toBe(2);
    }));

  it('only the holder can confirm or report, and not once the wash is finished', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const other = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      await s.as('authenticated', other.authId);
      expect(await s.err(`select public.worker_confirm_customer('${b.id}')`)).toMatch(/already assigned/);
      expect(await s.err(`select public.worker_customer_unavailable('${b.id}')`)).toMatch(/Not authorized/);
      expect(await s.err(`select public.worker_report_issue('${b.id}','other','hello there')`)).toMatch(/Not authorized/);
      expect(await s.err(`select public.worker_add_note('${b.id}','hello there')`)).toMatch(/Not authorized/);

      const done = await confirmedBooking(s, { days: 0, status: 'completed' });
      await s.as('postgres');
      await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)`, [done.id, w.profileId]);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_customer_unavailable('${done.id}')`)).toMatch(/cannot be updated now/);
      expect(await s.err(`select public.worker_confirm_customer('${done.id}')`)).toMatch(/cannot be confirmed now/);
    }));
});

describe('issues and notes', () => {
  it('records issues and notes as events without changing the wash', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      await s.q('select public.worker_start_wash($1)', [b.id]);
      expect(await s.err(`select public.worker_report_issue('${b.id}','no_water_or_power','Society water is off until 11')`)).toBeNull();
      expect(await s.err(`select public.worker_report_issue('${b.id}','customer_unavailable')`)).toBeNull(); // mid-wash: logged, no status change
      expect(await s.err(`select public.worker_add_note('${b.id}','Scratch on rear bumper, already there')`)).toBeNull();
      expect((await st(s, b.id)).s).toBe('in_progress');
      await s.as('postgres');
      const ev = await s.q(`select event_type, event_metadata m from public.booking_events where booking_id=$1 and event_type in ('worker_issue','worker_note')`, [b.id]);
      expect(ev.map((e: any) => e.event_type).sort()).toEqual(['worker_issue', 'worker_issue', 'worker_note']);
      expect(ev.find((e: any) => e.m.kind === 'no_water_or_power').m).toMatchObject({ notes: 'Society water is off until 11' });
      expect(ev.find((e: any) => e.event_type === 'worker_note').m).toMatchObject({ note: 'Scratch on rear bumper, already there' });
    }));

  it('customer-unavailable before the start behaves exactly like "not picked up"', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      expect(await s.err(`select public.worker_report_issue('${b.id}','customer_unavailable','Not home')`)).toBeNull();
      expect((await st(s, b.id)).s).toBe('call_not_picked_up');
    }));

  it('validates input', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      expect(await s.err(`select public.worker_report_issue('${b.id}','bogus','x y z')`)).toMatch(/Unknown issue type/);
      expect(await s.err(`select public.worker_report_issue('${b.id}','other','')`)).toMatch(/describe the problem/);
      expect(await s.err(`select public.worker_add_note('${b.id}',' ')`)).toMatch(/short note/);
      expect(await s.err(`select public.worker_add_note('${b.id}','${'x'.repeat(1001)}')`)).toMatch(/under 1000/);
    }));
});

describe('photos', () => {
  it('saves into the booking folder only, only while the wash is open, only for the holder', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const other = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0 });
      const c = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      await s.q('select public.worker_start_wash($1)', [b.id]);
      const save = (id: string, path: string, phase = 'before') => s.err(`select public.save_booking_photo('${id}','${phase}','front','${path}')`);
      expect(await save(b.id, `${b.id}/before-front.jpg`)).toBeNull();
      expect(await save(b.id, `${c.id}/before-front.jpg`)).toMatch(/inside this booking/);
      expect(await save(b.id, `${b.id}/../${c.id}/x.jpg`)).toMatch(/inside this booking/);
      expect(await save(b.id, `elsewhere.jpg`)).toMatch(/inside this booking/);
      await s.as('authenticated', other.authId);
      expect(await save(b.id, `${b.id}/x.jpg`)).toMatch(/Not authorized/);
      const done = await confirmedBooking(s, { days: 0, status: 'completed' });
      await s.as('postgres');
      await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id) values ($1,$2)`, [done.id, other.profileId]);
      await s.as('authenticated', other.authId);
      expect(await save(done.id, `${done.id}/x.jpg`)).toMatch(/only be added while the wash is open/);
    }));

  it('booking_photos_for_viewer: customer, holder and admin only', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const w2 = await createWorker(s);
      const stranger = await createCustomer(s);
      const admin = await createAdmin(s);
      const b = await confirmedBooking(s, { days: 0 });
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_claim_booking($1)', [b.id]);
      await s.q('select public.worker_start_wash($1)', [b.id]);
      await s.q(`select public.save_booking_photo($1,'before','front',$2)`, [b.id, `${b.id}/a.jpg`]);
      for (const who of [w, b.u, admin]) {
        await s.as('authenticated', who.authId);
        expect((await s.q('select * from public.booking_photos_for_viewer($1)', [b.id])).map((r: any) => r.storage_path)).toEqual([`${b.id}/a.jpg`]);
      }
      for (const who of [w2, stranger]) {
        await s.as('authenticated', who.authId);
        expect(await s.err(`select * from public.booking_photos_for_viewer('${b.id}')`)).toMatch(/Not found/);
      }
    }));
});

describe('rescheduling and the worker queue', () => {
  const targetDate = async (s: any, d: string) => (await s.q(`select (d::date)::text d from generate_series($1::date + 20, $1::date + 26, '1 day') d where extract(dow from d)=2 limit 1`, [d]))[0].d;

  it('regular specialist: a moved wash goes back into THAT worker\'s queue on the new date', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const x = m.washes[0];
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_call_customer($1)', [x.booking_id]);
      await s.q('select public.worker_confirm_customer($1)', [x.booking_id]);

      const target = await targetDate(s, x.d);
      await s.as('authenticated', m.u.authId);
      await s.q(`select public.reschedule_booking_occurrence($1,$2::date,'afternoon')`, [x.occ, target]);

      const row = (await queue(s, w, 60)).find((r: any) => r.booking_id === x.booking_id);
      expect(row).toMatchObject({ status: 'worker_assigned', time_slot: 'afternoon', customer_confirmed_at: null });
      expect(row.customer_name).toBeTruthy(); // still theirs
      expect(row.change).toMatchObject({ kind: 'rescheduled', from_date: x.d, from_slot: 'morning', by: 'customer' });
      expect((await queue(s, w, 60)).filter((r: any) => r.booking_id === x.booking_id)).toHaveLength(1);
    }));

  it('no regular specialist: the moved wash leaves the queue as a customer-detail-free "changed" row and returns to the pool', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const w2 = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const x = m.washes[0];
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_worker($1,$2)', [x.booking_id, w.profileId]);
      expect((await queue(s, w, 60)).find((r: any) => r.booking_id === x.booking_id)).toMatchObject({ bucket: 'upcoming' });

      const target = await targetDate(s, x.d);
      await s.as('authenticated', m.u.authId);
      await s.q(`select public.reschedule_booking_occurrence($1,$2::date,'morning')`, [x.occ, target]);

      const row = (await queue(s, w, 60)).find((r: any) => r.booking_id === x.booking_id);
      expect(row).toMatchObject({ bucket: 'changed', customer_name: null, customer_phone: null, society_name: null, flat_number: null, registration_number: null, parking_location: null, instructions: null });
      expect(row.change).toMatchObject({ kind: 'rescheduled', from_date: x.d });
      expect(row.scheduled_date).toBeTruthy();
      await s.as('authenticated', w2.authId);
      expect((await s.q('select booking_id from public.worker_pool(60)')).map((p: any) => p.booking_id)).toContain(x.booking_id);
    }));

  it('admin can move a wash too, with a reason; non-admins cannot', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      const x = m.washes[0];
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const target = await targetDate(s, x.d);
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.admin_reschedule_wash('${x.booking_id}','${target}','morning','x')`)).toMatch(/admin access required/);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.admin_assign_worker('${x.booking_id}','${w.profileId}')`)).toMatch(/admin access required/);
      expect(await s.err(`select public.admin_assign_membership_worker('${m.membership}','${w.profileId}')`)).toMatch(/admin access required/);

      await s.as('authenticated', m.admin.authId);
      // admins are not held to the customer's 2-day notice: the wash is 2+ days out here, so use the same day, later slot
      expect(await s.err(`select public.admin_reschedule_wash('${x.booking_id}','${x.d}','night','Rain')`)).toBeNull();
      const earlier = await istDate(s, 0);
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_reschedule_wash('${x.booking_id}','${earlier}','night','x')`)).toMatch(/earlier than its original date/);
      await s.as('authenticated', w.authId);
      const row = (await s.q('select * from public.worker_queue(60) where booking_id=$1', [x.booking_id]))[0];
      expect(row).toMatchObject({ time_slot: 'night', status: 'worker_assigned' });
      expect(row.change).toMatchObject({ kind: 'rescheduled', by: 'admin' });
    }));
});

describe('admin assignment', () => {
  it('assigning a membership covers every remaining wash, replaces the old worker, and NULL releases them', async () =>
    inTx(async (s) => {
      const a = await createWorker(s);
      const b = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, a.profileId]);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, b.profileId]);
      // the previous worker is told the washes are no longer theirs, and sees no customer details
      const gone = await queue(s, a, 60);
      expect(gone).toHaveLength(12);
      for (const r of gone) expect(r).toMatchObject({ bucket: 'changed', customer_name: null, customer_phone: null, change: expect.objectContaining({ kind: 'reassigned' }) });
      expect((await queue(s, b, 60)).filter((r: any) => r.bucket === 'upcoming')).toHaveLength(12);

      await s.as('authenticated', m.admin.authId);
      const r = (await s.q('select public.admin_assign_membership_worker($1,null) r', [m.membership]))[0].r;
      expect(r.washes_updated).toBe(12);
      expect((await queue(s, b, 60)).filter((r: any) => r.bucket !== 'changed')).toHaveLength(0);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.bookings where membership_id=$1 and status='confirmed'`, [m.membership]))[0].n).toBe(12);
      expect((await s.q(`select assigned_worker_profile_id w from public.memberships where id=$1`, [m.membership]))[0].w).toBeNull();
    }));

  it('refuses to assign non-workers or finished washes', async () =>
    inTx(async (s) => {
      const cust = await createCustomer(s);
      const w = await createWorker(s);
      const admin = await createAdmin(s);
      const done = await confirmedBooking(s, { days: 0, status: 'completed' });
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_assign_worker('${done.id}','${cust.profileId}')`)).toMatch(/Specialist not found/);
      expect(await s.err(`select public.admin_assign_worker('${done.id}','${w.profileId}')`)).toMatch(/cannot be assigned/);
    }));
});
