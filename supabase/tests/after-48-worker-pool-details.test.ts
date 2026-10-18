/** GREEN tests for 20261004000048: a specialist sees what an unclaimed wash IS (service, vehicle, building, parking spot) but not who the customer is. */
import { describe, expect, it } from 'vitest';
import { confirmedBooking, createWorker, inTx } from './helpers';

describe('the pool shows the job, not the customer', () => {
  it('service, vehicle, society, building, parking spot and finish-by time are there; name, number, flat, plate and notes are not', async () =>
    inTx(async (s) => {
      const c = await confirmedBooking(s, { days: 2 });
      await s.as('postgres');
      await s.q(`update public.bookings set target_completion_time = '10:30 AM', notes = 'Gate code 4321, dog on site' where id = $1`, [c.id]);
      await s.q(`update public.customer_addresses set building_block = 'B6', flat_number = 'B6-702', parking_location = 'Basement P2' where id = $1`, [c.addr]);
      await s.q(`update public.vehicles set make = 'Hyundai', model = 'Creta', color = 'White' where id = $1`, [c.veh]);
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      const pool = await s.q('select * from public.worker_pool(14)');
      expect(pool).toHaveLength(1);
      expect(pool[0]).toMatchObject({
        booking_id: c.id, service_name: 'Car Body Wash', vehicle_type: 'car', vehicle_make: 'Hyundai', vehicle_model: 'Creta', vehicle_color: 'White',
        society_name: 'Yashwin Orizzonte', building_block: 'B6', parking_location: 'Basement P2', target_completion_time: '10:30 AM', booking_type: 'on_demand',
      });
      expect(typeof pool[0].duration_minutes).toBe('number');
      expect(Array.isArray(pool[0].service_includes)).toBe(true);
      expect(pool[0].service_includes.length).toBeGreaterThan(0);
      expect(['body', 'deep']).toContain(pool[0].wash_kind);
      // nothing that says who the customer is
      const text = JSON.stringify(pool[0]);
      expect(text).not.toMatch(/B6-702|Gate code|dog on site/);
      await s.as('postgres');
      const person = (await s.q(`select p.full_name n, p.phone ph, v.registration_number r from public.profiles p join public.vehicles v on v.customer_profile_id = p.id where v.id = $1`, [c.veh]))[0];
      expect(text).not.toContain(person.r);
      expect(text).not.toContain(person.n);
      expect(text).not.toContain(String(person.ph).replace('+', ''));
    }));

  it('a wash with no parking spot or finish-by time says nothing for them (null, never a blank), and a claimed wash leaves the pool', async () =>
    inTx(async (s) => {
      const c = await confirmedBooking(s, { days: 1 });
      await s.as('postgres');
      await s.q(`update public.bookings set parking_location = null, target_completion_time = null where id = $1`, [c.id]);
      await s.q(`update public.vehicles set parking_location = null where id = $1`, [c.veh]);
      await s.q(`update public.customer_addresses set parking_location = '' where id = $1`, [c.addr]);   // an address always has the column; blank means none
      const w = await createWorker(s);
      await s.as('authenticated', w.authId);
      const row = (await s.q('select * from public.worker_pool(14)'))[0];
      expect(row.parking_location).toBeNull();
      expect(row.target_completion_time).toBeNull();
      await s.q('select public.worker_claim_booking($1)', [c.id]);
      expect(await s.q('select * from public.worker_pool(14)')).toHaveLength(0);
    }));

  it('only a specialist or an admin can look; a customer and a signed-out caller cannot', async () =>
    inTx(async (s) => {
      const c = await confirmedBooking(s, { days: 1 });
      await s.as('authenticated', c.u.authId);
      expect(await s.err('select * from public.worker_pool(14)')).toMatch(/Only workers/);
      await s.as('anon');
      expect(await s.err('select * from public.worker_pool(14)')).toMatch(/permission denied/);
    }));
});
