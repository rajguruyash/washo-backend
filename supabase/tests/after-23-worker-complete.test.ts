/** GREEN tests for 20261004000023: a specialist can complete a membership wash (no credits), and the rest of completing a wash is unchanged. */
import { describe, expect, it } from 'vitest';
import { confirmedBooking, createWorker, inTx, paidMembership } from './helpers';

const photo = async (s: any, booking: string, worker: string, phase: 'before' | 'after') => {
  await s.as('postgres');
  await s.q(`insert into public.booking_photos (booking_id, worker_profile_id, phase, photo_type, storage_path) values ($1,$2,$3,'front',$4)`, [booking, worker, phase, `${booking}/${phase}-${Math.random().toString(36).slice(2)}.jpg`]);
};
const complete = (s: any, id: string) => s.err(`select public.worker_complete_wash('${id}')`);

describe('completing a membership wash', () => {
  it('works with no credits: in progress, with before and after photos -> completed, and the customer is told', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const wash = m.washes[0];
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_start_wash($1)', [wash.booking_id]);
      expect(await complete(s, wash.booking_id)).toMatch(/before photo is required/);
      await photo(s, wash.booking_id, w.profileId, 'before');
      await s.as('authenticated', w.authId);
      expect(await complete(s, wash.booking_id)).toMatch(/after photo is required/);
      await photo(s, wash.booking_id, w.profileId, 'after');
      await s.as('authenticated', w.authId);
      expect(await complete(s, wash.booking_id)).toBeNull();

      await s.as('postgres');
      expect((await s.q(`select status::text s, completed_at is not null done from public.bookings where id=$1`, [wash.booking_id]))[0]).toEqual({ s: 'completed', done: true });
      expect((await s.q(`select status::text s from public.membership_schedule_occurrences where id=$1`, [wash.occ]))[0].s).toBe('completed');
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='wash_completed' and actor_profile_id=$2`, [wash.booking_id, w.profileId]))[0].n).toBe(1);
      expect((await s.q(`select count(*)::int n from public.notifications where reference_id=$1 and category='wash_completed' and profile_id=$2`, [wash.booking_id, m.u.profileId]))[0].n).toBe(1);
      // nothing about credits was touched
      expect((await s.q(`select count(*)::int n from public.entitlement_transactions`))[0].n).toBe(0);
      // the membership's progress counts it, and the customer can read it
      expect((await s.q(`select count(*)::int n from public.bookings where membership_id=$1 and status='completed'`, [m.membership]))[0].n).toBe(1);
    }));

  it('completing twice does nothing the second time; another specialist, or a wash not started, is refused', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const other = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const wash = m.washes[0];
      await s.as('authenticated', w.authId);
      expect(await complete(s, wash.booking_id)).toMatch(/Start the wash before completing it/);
      await s.q('select public.worker_start_wash($1)', [wash.booking_id]);
      await photo(s, wash.booking_id, w.profileId, 'before');
      await photo(s, wash.booking_id, w.profileId, 'after');
      await s.as('authenticated', other.authId);
      expect(await complete(s, wash.booking_id)).toMatch(/Only the assigned worker/);
      await s.as('authenticated', w.authId);
      expect(await complete(s, wash.booking_id)).toBeNull();
      expect(await complete(s, wash.booking_id)).toBeNull(); // idempotent
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.booking_events where booking_id=$1 and event_type='wash_completed'`, [wash.booking_id]))[0].n).toBe(1);
      await s.as('anon');
      expect(await complete(s, wash.booking_id)).toMatch(/Only the assigned worker|permission denied/); // a visitor is not a specialist
    }));

  it('a single wash completes exactly as before', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const b = await confirmedBooking(s, { days: 0, status: 'worker_assigned' });
      await s.as('postgres');
      await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) values ($1,$2,true,now())`, [b.id, w.profileId]);
      await s.as('authenticated', w.authId);
      await s.q('select public.worker_start_wash($1)', [b.id]);
      await photo(s, b.id, w.profileId, 'before');
      await photo(s, b.id, w.profileId, 'after');
      await s.as('authenticated', w.authId);
      expect(await complete(s, b.id)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select status::text s from public.bookings where id=$1`, [b.id]))[0].s).toBe('completed');
    }));
});
