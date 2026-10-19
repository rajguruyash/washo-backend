/**
 * GREEN tests for 20261004000049_working_slots.sql: Admin -> Working Days can turn a TIME WINDOW (Morning, Afternoon, Night) off, by weekday or for a date, separately for single washes
 * and for memberships. A closed window stops a single wash, a free-wash claim, a membership request (weekdays or exact dates) and the moving of a membership wash, with a message that says
 * which windows are left; an admin is never blocked; a day with every window off is a closed day; the booking pages are told the closed windows; nothing changes until an admin turns one off.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, inTx, istDate, paidMembership, serviceId, uid } from './helpers';

const slotMsg = /^WASHO is currently unavailable in the (Morning|Afternoon|Night) window on [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}( \(.+\))?\. (You can book the .+ window that day|Please choose another day)\.$/;
const closedMsg = /^WASHO is currently unavailable on [A-Z][a-z]+, \d{1,2} [A-Z][a-z]{2}( \(.+\))?\. /;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const days = (d: number[]) => `ARRAY[${d.join(',')}]::integer[]`;
type Kind = 'single' | 'membership' | 'both';
type Slot = 'morning' | 'afternoon' | 'night';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const asAdmin = async (s: any, a: { authId: string }) => s.as('authenticated', a.authId);
/** The window is on only for these weekdays. */
const slotDays = async (s: any, a: any, slot: Slot, open: number[], kind?: Kind) => {
  await asAdmin(s, a);
  return kind ? s.q(`select public.admin_set_working_slot_weekdays($1::public.time_slot, ${days(open)}, $2)`, [slot, kind]) : s.q(`select public.admin_set_working_slot_weekdays($1::public.time_slot, ${days(open)})`, [slot]);
};
const slotDates = async (s: any, a: any, slot: Slot, from: string, to: string, open: boolean, reason: string | null = null, kind?: Kind) => {
  await asAdmin(s, a);
  return kind
    ? (await s.q('select public.admin_set_working_slot_dates($1::date,$2::date,$3::public.time_slot,$4,$5,$6) n', [from, to, slot, open, reason, kind]))[0].n as number
    : (await s.q('select public.admin_set_working_slot_dates($1::date,$2::date,$3::public.time_slot,$4,$5) n', [from, to, slot, open, reason]))[0].n as number;
};
const setDates = async (s: any, a: any, from: string, to: string, open: boolean, reason: string | null = null, kind: Kind = 'both') => {
  await asAdmin(s, a);
  return (await s.q('select public.admin_set_working_dates($1::date,$2::date,$3,$4,$5) n', [from, to, open, reason, kind]))[0].n as number;
};
type Working = { kind: string; closed: { date: string; reason: string | null }[]; closed_slots: { date: string; slot: Slot; reason: string | null }[]; next_open: string | null };
const working = async (s: any, from: string, to: string, kind?: Kind) => {
  await s.as('anon');
  return (kind ? (await s.q('select public.get_working_days($1::date,$2::date,$3) r', [from, to, kind])) : (await s.q('select public.get_working_days($1::date,$2::date) r', [from, to])))[0].r as Working;
};
const nextDow = async (s: any, d: number, from = 8) => { const t = await istDate(s, from); for (let i = 0; i < 7; i++) if (dow(addDays(t, i)) === d) return addDays(t, i); throw new Error('unreachable'); };

async function customer(s: any) {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, 'car');
  return { u, addr, veh };
}
const intent = async (s: any, c: any, date: string, slot: Slot = 'morning') => {
  const svc = await serviceId(s, 'car-body-wash');
  await s.as('authenticated', c.u.authId);
  return s.err(`select public.create_booking_payment_intent('${c.veh}','${svc}','${date}'::date,'${slot}'::public.time_slot,'${c.addr}')`);
};
const request = async (s: any, c: any, o: { weekdays?: number[]; start: string; dates?: unknown[]; slot?: Slot }) => {
  await s.as('authenticated', c.u.authId);
  return s.err(`select public.create_monthly_membership_request($1,4,0,${days(o.weekdays ?? [])},1,'${o.slot ?? 'morning'}',$2::date,$3,null,null,null,$4::jsonb,null)`, [c.veh, o.start, c.addr, o.dates ? JSON.stringify(o.dates) : null]);
};

describe('nothing changes when it is applied', () => {
  it('every window starts on, for both kinds, and no window is reported closed', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      await s.as('postgres');
      expect(await s.q(`select kind, count(*)::int n, count(*) filter (where is_open)::int open from public.working_slot_weekdays group by kind order by kind`)).toEqual([{ kind: 'membership', n: 21, open: 21 }, { kind: 'single', n: 21, open: 21 }]);
      const from = await istDate(s, 0), to = await istDate(s, 60);
      for (const kind of ['single', 'membership', undefined] as const) {
        const w = await working(s, from, to, kind);
        expect(w.closed_slots).toEqual([]);
        expect(w.closed).toEqual([]);
      }
      for (const slot of ['morning', 'afternoon', 'night'] as const) expect(await intent(s, c, await istDate(s, 9), slot)).toBeNull();
      await asAdmin(s, a);
      const r = (await s.q('select public.admin_working_days() r'))[0].r;
      for (const k of ['single', 'membership']) {
        expect(r[k].slot_weekdays).toHaveLength(21);
        expect(r[k].slot_weekdays.every((w: any) => w.open)).toBe(true);
        expect(r[k].slot_dates).toEqual([]);
        expect(r[k].booked_in_closed_slots).toEqual([]);
      }
    }));
});

describe('a window turned off for a day of the week', () => {
  it('Night off on Sundays for single washes: Sunday night is refused with the windows that are left, everything else is fine, and memberships are untouched', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const sun = await nextDow(s, 0, 10), mon = addDays(sun, 1);
      await slotDays(s, a, 'night', [1, 2, 3, 4, 5, 6], 'single');
      const msg = await intent(s, c, sun, 'night');
      expect(msg).toMatch(slotMsg);
      expect(msg).toContain('You can book the Morning or Afternoon window that day.');
      expect(msg).toContain('window on Sun');
      expect(await intent(s, c, sun, 'morning')).toBeNull();
      expect(await intent(s, c, sun, 'afternoon')).toBeNull();
      expect(await intent(s, c, mon, 'night')).toBeNull();
      // the page is told
      const from = await istDate(s, 0), to = await istDate(s, 30);
      const single = await working(s, from, to, 'single'), member = await working(s, from, to, 'membership'), both = await working(s, from, to);
      expect(single.closed_slots.length).toBeGreaterThan(0);
      expect(single.closed_slots.every((x) => x.slot === 'night' && dow(x.date) === 0 && x.reason === null)).toBe(true);
      expect(single.closed_slots.some((x) => x.date === sun)).toBe(true);
      expect(single.closed).toEqual([]);                        // the days themselves are open
      expect(member.closed_slots).toEqual([]);
      expect(both.closed_slots.map((x) => x.date)).toEqual(single.closed_slots.map((x) => x.date));   // an older page is never offered a window that would be refused
      // memberships can still use Sunday night
      const start = await istDate(s, 4);
      expect(await request(s, c, { weekdays: [0], start, slot: 'night' })).toBeNull();
    }));

  it('the calls without a kind change both kinds, and a window can be turned back on', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const sun = await nextDow(s, 0, 10);
      await slotDays(s, a, 'morning', [1, 2, 3, 4, 5, 6]);   // both kinds
      expect(await intent(s, c, sun, 'morning')).toMatch(slotMsg);
      const from = await istDate(s, 0), to = await istDate(s, 20);
      expect((await working(s, from, to, 'single')).closed_slots.length).toBeGreaterThan(0);
      expect((await working(s, from, to, 'membership')).closed_slots.length).toBeGreaterThan(0);
      await slotDays(s, a, 'morning', ALL_DAYS);
      expect(await intent(s, c, sun, 'morning')).toBeNull();
      expect((await working(s, from, to)).closed_slots).toEqual([]);
    }));

  it('the window of one weekday does not touch another window or another day', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const sat = await nextDow(s, 6, 10), sun = addDays(sat, 1);
      await slotDays(s, a, 'afternoon', [0, 1, 2, 3, 4, 5], 'single');   // off on Saturdays only
      expect(await intent(s, c, sat, 'afternoon')).toMatch(slotMsg);
      expect(await intent(s, c, sat, 'morning')).toBeNull();
      expect(await intent(s, c, sat, 'night')).toBeNull();
      expect(await intent(s, c, sun, 'afternoon')).toBeNull();
    }));
});

describe('a window turned off for a date', () => {
  it('the reason is in the message; a date row beats its weekday; clearing it puts the weekday back in charge', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const d = await istDate(s, 12), d2 = await istDate(s, 13);
      expect(await slotDates(s, a, 'morning', d, d, false, 'Diwali puja', 'single')).toBe(1);
      const msg = await intent(s, c, d, 'morning');
      expect(msg).toMatch(slotMsg);
      expect(msg).toContain('(Diwali puja)');
      expect(await intent(s, c, d, 'afternoon')).toBeNull();
      expect(await intent(s, c, d2, 'morning')).toBeNull();
      const from = await istDate(s, 0), to = await istDate(s, 30);
      expect((await working(s, from, to, 'single')).closed_slots).toEqual([{ date: d, slot: 'morning', reason: 'Diwali puja' }]);
      expect((await working(s, from, to, 'membership')).closed_slots).toEqual([]);
      // the weekday is off, but this one date is turned ON
      await slotDays(s, a, 'night', ALL_DAYS.filter((x) => x !== dow(d2)), 'single');
      expect(await intent(s, c, d2, 'night')).toMatch(slotMsg);
      await slotDates(s, a, 'night', d2, d2, true, null, 'single');
      expect(await intent(s, c, d2, 'night')).toBeNull();
      // clearing the morning date, and the night date, gives the weekdays back
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_slot_date('${d}'::date, 'morning', 'single')`)).toBeNull();
      expect(await intent(s, c, d, 'morning')).toBeNull();
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_slot_date('${d2}'::date, 'night', 'single')`)).toBeNull();
      expect(await intent(s, c, d2, 'night')).toMatch(slotMsg);
    }));

  it('a run of dates, and each kind keeps its own', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const from = await istDate(s, 10), to = await istDate(s, 14);
      expect(await slotDates(s, a, 'night', from, to, false, 'Rain', 'membership')).toBe(5);
      const w = await working(s, await istDate(s, 0), await istDate(s, 30), 'membership');
      expect(w.closed_slots.map((x) => x.date)).toEqual([10, 11, 12, 13, 14].map((n) => addDays(from, n - 10)));
      expect((await working(s, await istDate(s, 0), await istDate(s, 30), 'single')).closed_slots).toEqual([]);
      await slotDates(s, a, 'night', from, to, false, 'Rain', 'single');
      expect((await working(s, await istDate(s, 0), await istDate(s, 30))).closed_slots).toHaveLength(5);   // 'both': once per date, not once per kind
    }));
});

describe('every window off is a closed day', () => {
  it('the day counts as closed, and the message is the closed-day one with the next open day', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const d = await istDate(s, 10);
      for (const slot of ['morning', 'afternoon', 'night'] as const) await slotDates(s, a, slot, d, d, false, null, 'single');
      const w = await working(s, await istDate(s, 0), await istDate(s, 30), 'single');
      expect(w.closed.map((x) => x.date)).toEqual([d]);
      expect(w.closed_slots.filter((x) => x.date === d)).toEqual([]);   // reported as a closed day, not as three closed windows
      expect(await intent(s, c, d, 'afternoon')).toMatch(closedMsg);
      // a window off on every weekday, for all three windows: nobody can book anything
      for (const slot of ['morning', 'afternoon', 'night'] as const) await slotDays(s, a, slot, [], 'single');
      const none = await working(s, await istDate(s, 0), await istDate(s, 30), 'single');
      expect(none.closed).toHaveLength(31);
      expect(none.next_open).toBeNull();
    }));
});

describe('a membership and its windows', () => {
  it('the window chosen must be on for every weekday picked: the message names the days and the windows that would work', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await slotDays(s, a, 'morning', [1, 2, 3, 4, 5, 6], 'membership');   // no Sunday mornings
      expect(await request(s, c, { weekdays: [0], start, slot: 'morning' })).toBe('WASHO is currently unavailable in the Morning window on Sundays. Choose the Afternoon or Night window, or other days.');
      expect(await request(s, c, { weekdays: [0, 6], start, slot: 'morning' })).toMatch(/Morning window on Sundays\./);
      expect(await request(s, c, { weekdays: [6], start, slot: 'morning' })).toBeNull();
    }));

  it('the same Sundays in another window are fine', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      await slotDays(s, a, 'morning', [1, 2, 3, 4, 5, 6], 'membership');
      expect(await request(s, c, { weekdays: [0], start: await istDate(s, 4), slot: 'afternoon' })).toBeNull();
    }));

  it('says so when no other window works either', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await slotDays(s, a, 'morning', [1, 2, 3, 4, 5, 6], 'membership');
      await slotDays(s, a, 'afternoon', [1, 2, 3, 4, 5, 6], 'membership');
      expect(await request(s, c, { weekdays: [0], start, slot: 'morning' })).toBe('WASHO is currently unavailable in the Morning window on Sundays. Choose the Night window, or other days.');
      await slotDays(s, a, 'night', [1, 2, 3, 4, 5, 6], 'membership');
      expect(await request(s, c, { weekdays: [0], start, slot: 'morning' })).toMatch(/closed|unavailable/);   // every window off on Sundays: Sunday is a closed day
    }));

  it('a window that only single washes lost does not matter to a membership', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await slotDays(s, a, 'morning', [1, 2, 3, 4, 5, 6], 'single');
      expect(await request(s, c, { weekdays: [0], start, slot: 'morning' })).toBeNull();
    }));

  it('exact dates: a date whose window is off is refused with the reason; the same date in another window is fine', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      const picked = await Promise.all([6, 9, 12, 15].map(async (n) => ({ date: await istDate(s, n), kind: 'body' })));
      await slotDates(s, a, 'morning', picked[2].date, picked[2].date, false, 'Society event', 'membership');
      expect(await request(s, c, { start, dates: picked, slot: 'morning' })).toMatch(/Morning window on .*\(Society event\)/);
      expect(await request(s, c, { start, dates: picked, slot: 'afternoon' })).toBeNull();
    }));

  it('moving a membership wash into a window that is off is refused for the customer, allowed in another window, and an admin may still', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s, { startDays: 2 });
      const wash = m.washes[3];
      const free = [1, 2, 3, 4, 5, 6].map((n) => addDays(wash.d, n)).filter((d) => !m.washes.some((w: any) => w.d === d));
      const target = free[0];
      await slotDates(s, m.admin, 'morning', target, target, false, 'Rain', 'membership');
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target}'::date,'morning')`)).toMatch(/Morning window on .*\(Rain\)\. You can book the Afternoon or Night window that day\./);
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target}'::date,'afternoon')`)).toBeNull();
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_reschedule_wash('${wash.booking_id}','${target}'::date,'morning','Customer asked')`)).toBeNull();
    }));
});

describe('a free wash from a campaign', () => {
  it('is booked in a window that is on', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const p = await customer(s);
      const opens = await istDate(s, 0), closes = await istDate(s, 5), useBy = await istDate(s, 9);
      await s.as('postgres');
      const camp = (await s.q(
        `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
         values ($1, 'Free wash', true, $2, $3, $4, 100, 14, 500, 1000, 1500, false) returning id`, [`ws-${uid().slice(0, 8)}`, opens, closes, useBy]
      ))[0].id as string;
      await slotDays(s, a, 'morning', [], 'single');
      await slotDays(s, a, 'afternoon', [], 'single');
      await s.as('authenticated', p.u.authId);
      const r = (await s.q(`select public.claim_campaign_wash($1::uuid, $2::uuid, current_date, 'morning', $3::uuid, 'Basement P1') r`, [camp, p.veh, p.addr]))[0].r;
      expect(r.time_slot).toBe('night');
    }));
});

describe('what the Working Days page shows', () => {
  it('each kind lists its windows by weekday, the windows set for dates with the washes booked in them, and the washes booked in a window that is off', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const svc = await serviceId(s, 'car-body-wash');
      const mon = await nextDow(s, 1, 5);
      await s.as('postgres');
      for (let i = 0; i < 2; i++) {
        const v = await createVehicle(s, c.u.profileId, 'car');
        await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'night','confirmed')`, [c.u.profileId, v, svc, mon]);
      }
      await slotDays(s, a, 'night', [0, 2, 3, 4, 5, 6], 'single');            // Monday nights are off for single washes
      await slotDates(s, a, 'afternoon', await istDate(s, 20), await istDate(s, 20), false, 'Festival', 'membership');
      await asAdmin(s, a);
      const r = (await s.q('select public.admin_working_days() r'))[0].r;
      expect(r.single.booked_in_closed_slots.find((b: any) => b.date === mon)).toEqual({ date: mon, slot: 'night', washes: 2 });
      expect(r.single.booked_on_closed.find((b: any) => b.date === mon)).toBeUndefined();   // the day is open; only the window is off
      expect(r.membership.booked_in_closed_slots).toEqual([]);
      const night = r.single.slot_weekdays.filter((w: any) => w.slot === 'night');
      expect(night).toHaveLength(7);
      expect(night.find((w: any) => w.weekday === 1).open).toBe(false);
      expect(night.filter((w: any) => w.open)).toHaveLength(6);
      expect(r.membership.slot_weekdays.every((w: any) => w.open)).toBe(true);
      expect(r.single.slot_dates).toEqual([]);
      expect(r.membership.slot_dates).toEqual([{ day: await istDate(s, 20), slot: 'afternoon', open: false, reason: 'Festival', washes: 0 }]);
      // the old top-level fields are still the single-wash ones
      expect(r.weekdays).toEqual(r.single.weekdays);
    }));
});

describe('who can change it, and what is checked', () => {
  it('only an admin can change a window; the question the booking pages ask is open to everyone', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const day = await istDate(s, 5);
      for (const who of [() => s.as('authenticated', c.u.authId), () => s.as('anon')]) {
        for (const sql of [
          `select public.admin_set_working_slot_weekdays('night', ARRAY[6,0]::integer[], 'membership')`,
          `select public.admin_set_working_slot_dates('${day}'::date,'${day}'::date,'night',false,'x','single')`,
          `select public.admin_clear_working_slot_date('${day}'::date, 'night', 'membership')`,
        ]) { await who(); expect(await s.err(sql), sql).toMatch(/admin access required|permission denied/i); }
      }
      await s.as('anon');
      expect(await s.err(`select public.get_working_days(current_date, current_date + 3, 'single')`)).toBeNull();
    }));

  it('refuses bad input with a message an admin can read', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const d = await istDate(s, 5);
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_set_working_slot_weekdays('night', ARRAY[7]::integer[], 'single')`)).toMatch(/weekday \(0 to 6\)/);
      expect(await s.err(`select public.admin_set_working_slot_weekdays('night', ARRAY[1]::integer[], 'bogus')`)).toMatch(/single washes, memberships or both/);
      expect(await s.err(`select public.admin_set_working_slot_weekdays('lunch', ARRAY[1]::integer[], 'single')`)).toMatch(/lunch|time_slot/);
      expect(await s.err(`select public.admin_set_working_slot_dates('${addDays(d, -30)}'::date,'${d}'::date,'night',false,null,'single')`)).toMatch(/today or a later date/);
      expect(await s.err(`select public.admin_set_working_slot_dates('${d}'::date,'${addDays(d, -1)}'::date,'night',false,null,'single')`)).toMatch(/last date cannot be before the first/);
      expect(await s.err(`select public.admin_set_working_slot_dates('${d}'::date,'${addDays(d, 200)}'::date,'night',false,null,'single')`)).toMatch(/up to 92 days/);
      expect(await s.err(`select public.admin_set_working_slot_dates('${d}'::date,'${d}'::date,'night',false,'${'x'.repeat(121)}','single')`)).toMatch(/under 120 characters/);
      expect(await s.err(`select public.admin_clear_working_slot_date('${d}'::date, 'night', 'single')`)).toMatch(/no setting for this time window to remove/);
    }));

  it('a change is written to the audit log', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const d = await istDate(s, 6);
      await slotDays(s, a, 'night', [1, 2, 3], 'single');
      await slotDates(s, a, 'morning', d, d, false, 'Rain', 'single');
      await s.as('postgres');
      const rows = await s.q(`select event_type, metadata m, actor_profile_id a from public.audit_events where event_type in ('working_slot_weekdays_changed','working_slot_dates_set') order by created_at`);
      expect(rows.map((x: any) => x.event_type)).toEqual(['working_slot_weekdays_changed', 'working_slot_dates_set']);
      expect(rows[0].m).toMatchObject({ slot: 'night', kinds: ['single'], open_days: [1, 2, 3] });
      expect(rows[1].m).toMatchObject({ slot: 'morning', reason: 'Rain', open: false });
      expect(rows[0].a).toBe(a.profileId);
    }));
});
