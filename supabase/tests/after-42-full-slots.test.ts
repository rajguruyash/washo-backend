/**
 * GREEN tests for 20261004000042_full_slots_block.sql: a time window that is full cannot be picked by a customer or a specialist (exact dates of a membership, moving a membership
 * wash); an admin still can; the automatic spread of a plan, and a plan already paid, are never refused for a crowd.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, paidMembership, serviceId } from './helpers';

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const full = /is fully booked in the (morning|afternoon|night) window\. Please choose another day or time\./;

/** One wash by another vehicle in a window of a date: with every limit at 1, that fills it. */
async function fill(s: any, date: string, slot: 'morning' | 'afternoon' | 'night') {
  await s.as('postgres');
  const u = await createCustomer(s);
  const v = await createVehicle(s, u.profileId, 'car');
  const svc = await serviceId(s, 'car-body-wash');
  await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,$5,'confirmed')`, [u.profileId, v, svc, date, slot]);
}
const smallLimits = async (s: any) => { await s.as('postgres'); await s.q(`update public.capacity_rules set day_busy = 1, day_full = 3, slot_busy = 1, slot_full = 1`); };

async function customer(s: any) {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, 'car');
  return { u, addr, veh };
}

describe('a membership\'s exact dates', () => {
  const request = async (s: any, c: any, dates: { date: string; kind: string }[], slot = 'morning') => {
    const start = await istDate(s, 4);
    await s.as('authenticated', c.u.authId);
    return s.err(`select public.create_monthly_membership_request($1,4,0,ARRAY[]::integer[],1,$2::public.time_slot,$3::date,$4,null,null,null,$5::jsonb,null)`, [c.veh, slot, start, c.addr, JSON.stringify(dates)]);
  };

  it('cannot include a date whose time window is full; the same date in another window is fine', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 6);
      const dates = [0, 3, 6, 9].map((i) => ({ date: addDays(start, i), kind: 'body' }));
      await smallLimits(s);
      await fill(s, dates[2].date, 'morning');
      expect(await request(s, c, dates, 'morning')).toMatch(full);
      expect(await request(s, c, dates, 'afternoon')).toBeNull();
    }));

  it('an amber (busy) window is only a warning', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 6);
      const dates = [0, 3, 6, 9].map((i) => ({ date: addDays(start, i), kind: 'body' }));
      await s.as('postgres');
      await s.q(`update public.capacity_rules set day_busy = 1, day_full = 50, slot_busy = 1, slot_full = 50`);
      await fill(s, dates[1].date, 'morning');
      expect(await request(s, c, dates)).toBeNull();
    }));

  it('the automatic spread is never refused for a crowd: a plan on chosen weekdays still fits', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await smallLimits(s);
      const start = await istDate(s, 4);
      for (let i = 0; i < 31; i++) await fill(s, addDays(start, i), 'morning');   // every morning of the month is full
      await s.as('authenticated', c.u.authId);
      expect(await s.err(`select public.create_monthly_membership_request($1,4,0,ARRAY[1,3,5]::integer[],1,'morning',$2::date,$3,null,null,null,null,null)`, [c.veh, start, c.addr])).toBeNull();
    }));
});

describe('moving a membership wash', () => {
  it('a customer or a specialist cannot move it into a full window; the admin can; another window with room works', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const wash = m.washes[3];
      const target = addDays(wash.d, 1);
      await smallLimits(s);
      await fill(s, target, 'morning');

      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target}'::date,'morning')`)).toMatch(full);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_reschedule_wash('${wash.booking_id}','${target}'::date,'morning','x')`)).toMatch(full);
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target}'::date,'afternoon')`)).toBeNull();   // room in the afternoon
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_reschedule_wash('${wash.booking_id}','${target}'::date,'morning','Customer asked')`)).toBeNull();   // an admin may
    }));
});
