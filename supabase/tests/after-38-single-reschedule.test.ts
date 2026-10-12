/** GREEN tests for 20261004000038: an admin can move a single (on-demand) wash, paid or not; membership washes still go through the shared core. */
import { describe, expect, it } from 'vitest';
import { confirmedBooking, createAdmin, createCustomer, createWorker, inTx, istDate, serviceId } from './helpers';

/** Move a wash as `actor`. (istDate switches the session back to postgres, so work out dates BEFORE calling this.) */
const move = async (s: any, actor: { authId: string } | null, id: string, date: string, slot: string | null = 'afternoon', reason: string | null = 'Customer called') => {
  await s.as(actor ? 'authenticated' : 'anon', actor?.authId);
  return s.err(`select public.admin_reschedule_wash('${id}','${date}'::date,${slot ? `'${slot}'::public.time_slot` : 'null'},${reason ? `'${reason}'` : 'null'})`);
};

describe('an admin moves a single wash', () => {
  it('only an admin may', async () =>
    inTx(async (s) => {
      const t = await confirmedBooking(s, { days: 3 });
      const w = await createWorker(s);
      const target = await istDate(s, 5);
      expect(await move(s, t.u, t.id, target)).toMatch(/admin access required/);
      expect(await move(s, w, t.id, target)).toMatch(/admin access required/);
      expect(await move(s, null, t.id, target)).toMatch(/permission denied|admin access required/);
    }));

  it('moves date and window, sets it back to unassigned, releases the specialist, clears the phone confirmation, and logs it for the customer', async () =>
    inTx(async (s) => {
      const t = await confirmedBooking(s, { days: 3 });
      const a = await createAdmin(s);
      const w = await createWorker(s);
      const oldDate = await istDate(s, 3);
      const target = await istDate(s, 6);
      await s.as('authenticated', a.authId);
      await s.q('select public.admin_assign_worker($1,$2)', [t.id, w.profileId]);
      await s.as('postgres');
      await s.q(`update public.bookings set customer_confirmed_at = now(), status = 'worker_called' where id = $1`, [t.id]);

      expect(await move(s, a, t.id, target, 'night', 'Rain expected')).toBeNull();

      await s.as('postgres');
      const b = (await s.q(`select scheduled_date::text d, time_slot::text slot, status::text st, customer_confirmed_at c, notes from public.bookings where id = $1`, [t.id]))[0];
      expect(b).toMatchObject({ d: target, slot: 'night', st: 'confirmed', c: null });
      expect(b.notes).toContain(`Rescheduled from ${oldDate} to ${target}`);
      expect((await s.q(`select count(*)::int n from public.worker_assignments where booking_id = $1 and is_active`, [t.id]))[0].n).toBe(0);
      const ev = (await s.q(`select event_metadata em, actor_profile_id from public.booking_events where booking_id = $1 and event_type = 'rescheduled'`, [t.id]))[0];
      expect(ev.actor_profile_id).toBe(a.profileId);
      expect(ev.em).toMatchObject({ old_date: oldDate, old_slot: 'morning', new_date: target, new_slot: 'night', by: 'admin', reason: 'Rain expected' });
      const note = (await s.q(`select title, body from public.notifications where reference_id = $1 and profile_id = $2`, [t.id, t.u.profileId]))[0];
      expect(note.title).toBe('Your wash was moved');
      expect(note.body).toContain('night');
      expect((await s.q(`select count(*)::int n from public.audit_events where entity_id = $1 and event_type = 'admin_rescheduled_wash'`, [t.id]))[0].n).toBe(1);

      // the specialist no longer holds it: it shows as changed, with the customer's details hidden
      await s.as('authenticated', w.authId);
      const row = (await s.q('select * from public.worker_queue(60) where booking_id = $1', [t.id]))[0];
      expect(row).toMatchObject({ bucket: 'changed', customer_name: null, customer_phone: null });
      expect(row.change).toMatchObject({ kind: 'rescheduled', by: 'admin' });
    }));

  it('the same day in another window, or today, works; a reason is optional', async () =>
    inTx(async (s) => {
      const t = await confirmedBooking(s, { days: 3 });
      const a = await createAdmin(s);
      const day3 = await istDate(s, 3);
      const today = await istDate(s, 0);
      expect(await move(s, a, t.id, day3, 'night', null)).toBeNull();
      expect(await move(s, a, t.id, today, 'morning', '   ')).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select scheduled_date::text d from public.bookings where id = $1`, [t.id]))[0].d).toBe(today);
      expect((await s.q(`select event_metadata->>'reason' r from public.booking_events where booking_id = $1 and event_type = 'rescheduled' order by created_at desc limit 1`, [t.id]))[0].r).toBeNull();
    }));

  it('refuses a past date, no change, no window, an over-long reason, and a day when the vehicle already has a wash', async () =>
    inTx(async (s) => {
      const t = await confirmedBooking(s, { days: 3 });
      const a = await createAdmin(s);
      const [yesterday, day3, day4, day5] = [await istDate(s, -1), await istDate(s, 3), await istDate(s, 4), await istDate(s, 5)];
      expect(await move(s, a, t.id, yesterday)).toMatch(/today or a later date/);
      expect(await move(s, a, t.id, day3, 'morning')).toMatch(/already the date and time/);
      expect(await move(s, a, t.id, day4, null)).toMatch(/Choose the new date and time/);
      expect(await move(s, a, t.id, day4, 'night', 'x'.repeat(301))).toMatch(/under 300 characters/);

      // another live wash for the same vehicle on that day
      await s.as('postgres');
      await s.q(
        `insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id)
         values ($1,$2,$3,'on_demand',$4::date,'night','confirmed',$5)`,
        [t.u.profileId, t.veh, await serviceId(s, 'car-body-wash'), day5, t.addr]
      );
      expect(await move(s, a, t.id, day5)).toMatch(/already has a wash on that date/);
      // a cancelled wash on that day does not count
      await s.as('postgres');
      await s.q(`update public.bookings set status = 'cancelled' where vehicle_id = $1 and id <> $2`, [t.veh, t.id]);
      expect(await move(s, a, t.id, day5)).toBeNull();
    }));

  it('a wash that has started, finished, been cancelled or refunded, or does not exist, cannot be moved', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const target = await istDate(s, 6);
      for (const status of ['in_progress', 'completed', 'cancelled', 'refunded', 'no_show']) {
        const t = await confirmedBooking(s, { days: 3, status });
        expect(await move(s, a, t.id, target)).toMatch(new RegExp(`This wash is ${status} and cannot be rescheduled`));
      }
      expect(await move(s, a, '00000000-0000-4000-8000-000000000000', target)).toMatch(/Wash not found/);
    }));

  it('every status before the wash starts can be moved, and each lands on "confirmed"', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const target = await istDate(s, 6);
      for (const status of ['pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up']) {
        const t = await confirmedBooking(s, { days: 3, status });
        expect(await move(s, a, t.id, target)).toBeNull();
        await s.as('postgres');
        expect((await s.q(`select status::text st from public.bookings where id = $1`, [t.id]))[0].st).toBe('confirmed');
      }
    }));
});

describe('a customer does not lose anything', () => {
  it('nothing else about the wash changes: price, vehicle, address, parking spot, service; no one else is notified', async () =>
    inTx(async (s) => {
      const t = await confirmedBooking(s, { days: 3 });
      const a = await createAdmin(s);
      const other = await createCustomer(s);
      const target = await istDate(s, 8);
      const cols = `price_cents, vehicle_id, address_id, parking_location, service_id, customer_profile_id`;
      const before = (await s.q(`select ${cols} from public.bookings where id = $1`, [t.id]))[0];
      expect(await move(s, a, t.id, target)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select ${cols} from public.bookings where id = $1`, [t.id]))[0]).toEqual(before);
      expect((await s.q(`select count(*)::int n from public.notifications where profile_id = $1 and reference_id = $2`, [other.profileId, t.id]))[0].n).toBe(0);
    }));
});
