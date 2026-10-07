/** GREEN tests for 20261004000019_capacity.sql: how many vehicles a day and a time window can take, and what that closes. */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, serviceId, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;

/** The next date (at least `from` days away) that falls on this weekday: 0 = Sunday ... 6 = Saturday. */
async function nextDow(s: any, dow: number, from = 8): Promise<string> {
  await s.as('postgres');
  return (await s.q(`select d::text from generate_series((now() at time zone 'Asia/Kolkata')::date + $1::int, (now() at time zone 'Asia/Kolkata')::date + $1::int + 6, '1 day') d where extract(dow from d) = $2 limit 1`, [from, dow]))[0].d;
}
/** `n` washes held on a date in a window: n vehicles (a vehicle can only have one wash a day) each with a confirmed wash. */
async function load(s: any, date: string, slot: 'morning' | 'afternoon' | 'night', n: number, status = 'confirmed') {
  const u = await createCustomer(s);
  const svc = await serviceId(s, 'car-body-wash');
  for (let i = 0; i < n; i++) {
    const v = await createVehicle(s, u.profileId, 'car');
    await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,$5,$6)`, [u.profileId, v, svc, date, slot, status]);
  }
}
const cap = async (s: any, from: string, to = from) => { await s.as('service_role'); return (await s.q('select public.get_capacity($1::date,$2::date) r', [from, to]))[0].r.days; };
const one = async (s: any, date: string) => (await cap(s, date))[0];

describe('the limits', () => {
  it('start at 10 busy / 15 full a day on weekdays and 15 / 20 on weekends (per time window 6 / 9 and 9 / 12)', async () =>
    inTx(async (s) => {
      await s.as('postgres');
      const rows = await s.q('select day_kind, day_busy, day_full, slot_busy, slot_full from public.capacity_rules order by day_kind');
      expect(rows).toEqual([
        { day_kind: 'weekday', day_busy: 10, day_full: 15, slot_busy: 6, slot_full: 9 },
        { day_kind: 'weekend', day_busy: 15, day_full: 20, slot_busy: 9, slot_full: 12 },
      ]);
    }));
});

describe('how crowded a day is', () => {
  it('an empty day is ok; a window turns busy, then full, at its own limits, and the day follows', async () =>
    inTx(async (s) => {
      const wed = await nextDow(s, 3);
      expect(await one(s, wed)).toMatchObject({ kind: 'weekday', total: 0, state: 'ok', slots: { morning: { n: 0, state: 'ok' } } });
      await load(s, wed, 'morning', 6);
      expect(await one(s, wed)).toMatchObject({ total: 6, state: 'busy', slots: { morning: { n: 6, state: 'busy' }, afternoon: { n: 0, state: 'ok' }, night: { state: 'ok' } } });
      await load(s, wed, 'morning', 3);
      // the morning is closed (9 of 9), the rest of the day still takes washes: amber, not red
      expect(await one(s, wed)).toMatchObject({ total: 9, state: 'busy', slots: { morning: { n: 9, state: 'full' }, afternoon: { state: 'ok' }, night: { state: 'ok' } } });
    }));

  it('the whole day closes at 15 on a weekday, whichever windows they are in', async () =>
    inTx(async (s) => {
      const tue = await nextDow(s, 2);
      await load(s, tue, 'morning', 5);
      await load(s, tue, 'afternoon', 5);
      await load(s, tue, 'night', 4);
      expect(await one(s, tue)).toMatchObject({ total: 14, state: 'busy', slots: { morning: { state: 'busy' }, afternoon: { state: 'busy' }, night: { state: 'busy' } } });
      await load(s, tue, 'night', 1);
      expect(await one(s, tue)).toMatchObject({ total: 15, state: 'full', slots: { morning: { state: 'full' }, afternoon: { state: 'full' }, night: { state: 'full' } } });
    }));

  it('weekends have bigger limits: 12 washes is a quiet Saturday, 15 is busy, 20 is full', async () =>
    inTx(async (s) => {
      const sat = await nextDow(s, 6);
      await load(s, sat, 'morning', 4);
      await load(s, sat, 'afternoon', 4);
      await load(s, sat, 'night', 4);
      expect(await one(s, sat)).toMatchObject({ kind: 'weekend', total: 12, state: 'ok', limit: 20 });
      await load(s, sat, 'night', 3);
      expect(await one(s, sat)).toMatchObject({ total: 15, state: 'busy' });
      await load(s, sat, 'afternoon', 5);
      expect(await one(s, sat)).toMatchObject({ total: 20, state: 'full' });
      const sun = await nextDow(s, 0);
      expect((await one(s, sun)).kind).toBe('weekend');
    }));

  it('a cancelled, refunded or missed wash does not hold a place', async () =>
    inTx(async (s) => {
      const thu = await nextDow(s, 4);
      await load(s, thu, 'morning', 3, 'cancelled');
      await load(s, thu, 'morning', 2, 'refunded');
      await load(s, thu, 'morning', 1, 'no_show');
      await load(s, thu, 'morning', 2, 'confirmed');
      await load(s, thu, 'morning', 1, 'completed'); // a finished wash did use the day
      expect((await one(s, thu)).total).toBe(3);
    }));

  it('only signed-in people can look, and only for up to 401 days', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const d = await istDate(s, 2);
      await s.as('anon');
      expect(await s.err(`select public.get_capacity('${d}','${d}')`)).toMatch(/permission denied/);
      await s.as('authenticated', c.authId);
      expect(await s.err(`select public.get_capacity('${d}','${d}')`)).toBeNull();
      expect(await s.err(`select public.get_capacity('${d}', '${d}'::date + 500)`)).toMatch(/1 to 401 days/);
      expect(await s.err(`select public.get_capacity('${d}'::date + 3, '${d}')`)).toMatch(/1 to 401 days/);
    }));
});

describe('a rush day or window is shown red but is never closed', () => {
  const setup = async (s: any) => {
    const u = await createCustomer(s);
    const addr = await createAddress(s, u.profileId);
    const veh = await createVehicle(s, u.profileId, 'car');
    const svc = await serviceId(s, 'car-body-wash');
    return { u, addr, veh, svc };
  };
  const intent = async (s: any, c: any, date: string, slot: string) => {
    await s.as('authenticated', c.u.authId);
    return s.err(`select public.create_booking_payment_intent('${c.veh}','${c.svc}','${date}'::date,'${slot}'::public.time_slot,'${c.addr}')`);
  };

  it('a single wash can still be started for a window past the red number (it is only reported red)', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const wed = await nextDow(s, 3);
      await load(s, wed, 'morning', 9);
      expect((await one(s, wed)).slots.morning.state).toBe('full'); // red
      expect(await intent(s, c, wed, 'morning')).toBeNull();        // and still bookable
      expect(await intent(s, c, wed, 'afternoon')).toBeNull();
    }));

  it('a day past the red number in total is red for every window, and every window can still be booked', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const fri = await nextDow(s, 5);
      await load(s, fri, 'morning', 5);
      await load(s, fri, 'afternoon', 5);
      await load(s, fri, 'night', 5);
      expect((await one(s, fri)).state).toBe('full');
      for (const slot of ['morning', 'afternoon', 'night']) expect(await intent(s, c, fri, slot), slot).toBeNull();
    }));

  it('there is no upper limit: far past the red number it still books', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const wed = await nextDow(s, 3);
      await load(s, wed, 'morning', 40);
      expect((await one(s, wed)).state).toBe('full');
      expect(await intent(s, c, wed, 'morning')).toBeNull();
    }));

  it('a free-wash claim is placed by WASHO on the earliest day that is not red, and is never refused for a crowd', async () =>
    inTx(async (s) => {
      const people = [await setup(s), await setup(s), await setup(s)];
      const days = [] as string[];
      for (let i = 0; i <= 20; i++) days.push(await istDate(s, i));
      await s.as('postgres');
      for (const [i, c] of people.entries()) await s.q(`update public.customer_addresses set flat_number = $2 where id = $1`, [c.addr, `Z-${i}-${uid().slice(0, 4)}`]); // one free wash per flat
      const camp = (await s.q(
        `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, new_customers_only)
         values ($1,'Free wash',true,current_date,current_date + 3,current_date + 20,50,false) returning id`, [`t-${uid().slice(0, 8)}`]))[0].id;
      const claim = async (c: any) => { await s.as('authenticated', c.u.authId); return (await s.q(`select public.claim_campaign_wash($1::uuid,$2::uuid,null,null,$3::uuid,'P1') r`, [camp, c.veh, c.addr]))[0].r; };
      const r1 = await claim(people[0]);
      // from now on one wash is enough to turn a day red: the next claim goes to a day that is not
      await s.as('postgres');
      await s.q(`update public.capacity_rules set day_busy = 1, day_full = 1, slot_busy = 1, slot_full = 1`);
      const r2 = await claim(people[1]);
      expect(r2.scheduled_date > r1.scheduled_date).toBe(true);
      // and when EVERY day is red, it is still booked, on the earliest day, not refused
      for (const d of days) await load(s, d, 'morning', 1);
      const r3 = await claim(people[2]);
      expect(r3.booking_id).toBeTruthy();
      expect(r3.scheduled_date <= r2.scheduled_date).toBe(true);
    }));

  it('WASHO can still book a wash on a full day (the admin booking is not blocked)', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const admin = await createAdmin(s);
      const wed = await nextDow(s, 3);
      await load(s, wed, 'morning', 9);
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_create_booking('${c.u.profileId}','${c.veh}','${c.svc}','${wed}'::date,'morning'::public.time_slot,'${c.addr}',null,'free')`)).toBeNull();
    }));
});

describe('the admin changes the limits', () => {
  it('only an admin, with sensible numbers, and it takes effect at once', async () =>
    inTx(async (s) => {
      const c = await createCustomer(s);
      const w = await createWorker(s);
      const admin = await createAdmin(s);
      for (const who of [{ role: 'authenticated', id: c.authId }, { role: 'authenticated', id: w.authId }, { role: 'anon', id: null }] as const) {
        await s.as(who.role, who.id);
        expect(await s.err(`select public.admin_set_capacity('weekday', 1, 2, 1, 2)`)).toMatch(NOT_ADMIN);
      }
      await s.as('authenticated', admin.authId);
      expect(await s.err(`select public.admin_set_capacity('monday', 5, 10, 3, 6)`)).toMatch(/weekdays or weekends/);
      expect(await s.err(`select public.admin_set_capacity('weekday', 0, 10, 3, 6)`)).toMatch(/1 or more/);
      expect(await s.err(`select public.admin_set_capacity('weekday', 12, 10, 3, 6)`)).toMatch(/red number for a day cannot be lower than its amber number/);
      expect(await s.err(`select public.admin_set_capacity('weekday', 5, 10, 8, 6)`)).toMatch(/red number for a time window cannot be lower/);
      expect(await s.err(`select public.admin_set_capacity('weekend', 5, 900, 3, 6)`)).toMatch(/more than 500/);

      const wed = await nextDow(s, 3);
      await load(s, wed, 'morning', 3);
      expect((await one(s, wed)).state).toBe('ok');
      await s.as('authenticated', admin.authId);
      await s.q(`select public.admin_set_capacity('weekday', 2, 4, 2, 3)`);
      expect(await one(s, wed)).toMatchObject({ total: 3, limit: 4, state: 'busy', slots: { morning: { state: 'full', limit: 3 } } });
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.audit_events where event_type='capacity_changed'`))[0].n).toBe(1);
      expect((await s.q(`select day_full from public.capacity_rules where day_kind='weekend'`))[0].day_full).toBe(20); // weekends untouched
    }));
});
