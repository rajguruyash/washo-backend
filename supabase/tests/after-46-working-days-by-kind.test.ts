/**
 * GREEN tests for 20261004000046_working_days_by_kind.sql: Working Days are kept separately for single washes and for memberships. Memberships can be weekends only while single washes
 * stay open every day (or the other way round); each kind has its own weekdays and its own specific dates; the free-wash claim follows the single-wash days; moving a membership wash
 * follows the membership days. The old admin calls (no kind) still set both, an older booking page that does not say which kind it is booking is never offered a day that would be
 * refused, and nothing changes until an admin changes a kind.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, inTx, istDate, paidMembership, serviceId, uid } from './helpers';

const closedMsg = /^WASHO is currently unavailable on [A-Z][a-z]+, \d{1,2} [A-Z][a-z]{2}( \(.+\))?\. The next day you can book is [A-Z][a-z]+, \d{1,2} [A-Z][a-z]{2}\.$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const days = (d: number[]) => `ARRAY[${d.join(',')}]::integer[]`;
type Kind = 'single' | 'membership' | 'both';

const asAdmin = async (s: any, a: { authId: string }) => s.as('authenticated', a.authId);
const openOnly = async (s: any, a: any, open: number[], kind?: Kind) => {
  await asAdmin(s, a);
  return kind ? s.q(`select public.admin_set_working_weekdays(${days(open)}, $1)`, [kind]) : s.q(`select public.admin_set_working_weekdays(${days(open)})`);
};
const setDates = async (s: any, a: any, from: string, to: string, open: boolean, reason: string | null = null, kind?: Kind) => {
  await asAdmin(s, a);
  return kind
    ? (await s.q('select public.admin_set_working_dates($1::date,$2::date,$3,$4,$5) n', [from, to, open, reason, kind]))[0].n as number
    : (await s.q('select public.admin_set_working_dates($1::date,$2::date,$3,$4) n', [from, to, open, reason]))[0].n as number;
};
type Working = { kind: string; weekdays: { weekday: number; open: boolean }[]; closed: { date: string; reason: string | null }[]; next_open: string | null };
const working = async (s: any, from: string, to: string, kind?: Kind) => {
  await s.as('anon');
  return (kind ? (await s.q('select public.get_working_days($1::date,$2::date,$3) r', [from, to, kind])) : (await s.q('select public.get_working_days($1::date,$2::date) r', [from, to])))[0].r as Working;
};
const openWeekdays = (w: Working) => w.weekdays.filter((x) => x.open).map((x) => x.weekday);
const nextDow = async (s: any, d: number, from = 8) => { const t = await istDate(s, from); for (let i = 0; i < 7; i++) if (dow(addDays(t, i)) === d) return addDays(t, i); throw new Error('unreachable'); };

async function customer(s: any) {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, 'car');
  return { u, addr, veh };
}
const intent = async (s: any, c: any, date: string) => {
  const svc = await serviceId(s, 'car-body-wash');
  await s.as('authenticated', c.u.authId);
  return s.err(`select public.create_booking_payment_intent('${c.veh}','${svc}','${date}'::date,'morning'::public.time_slot,'${c.addr}')`);
};
const request = async (s: any, c: any, o: { weekdays?: number[]; start: string; dates?: unknown[]; body?: number }) => {
  await s.as('authenticated', c.u.authId);
  return s.err(`select public.create_monthly_membership_request($1,$2,0,${days(o.weekdays ?? [])},1,'morning',$3::date,$4,null,null,null,$5::jsonb,null)`, [c.veh, o.body ?? 4, o.start, c.addr, o.dates ? JSON.stringify(o.dates) : null]);
};

describe('nothing changes when it is applied, and the old calls still work', () => {
  it('both kinds start out the same as the one list was, and the old top-level fields are the single-wash ones', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      await asAdmin(s, a);
      const r = (await s.q('select public.admin_working_days() r'))[0].r;
      expect(r.single.weekdays).toHaveLength(7);
      expect(r.membership.weekdays).toHaveLength(7);
      expect(r.single.weekdays.every((w: any) => w.open) && r.membership.weekdays.every((w: any) => w.open)).toBe(true);
      expect(r.weekdays).toEqual(r.single.weekdays);
      expect(r.dates).toEqual(r.single.dates);
      await s.as('postgres');
      expect((await s.q(`select kind, count(*)::int n from public.working_weekdays group by kind order by kind`))).toEqual([{ kind: 'membership', n: 7 }, { kind: 'single', n: 7 }]);
    }));

  it('the calls without a kind change BOTH kinds (weekdays, dates, clearing a date)', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const from = await istDate(s, 0), to = await istDate(s, 30);
      await openOnly(s, a, [6, 0]);
      expect(openWeekdays(await working(s, from, to, 'single'))).toEqual([0, 6]);
      expect(openWeekdays(await working(s, from, to, 'membership'))).toEqual([0, 6]);
      const d = await istDate(s, 9);
      expect(await setDates(s, a, d, d, false, 'Rain')).toBe(1);
      expect((await working(s, from, to, 'single')).closed.find((c) => c.date === d)?.reason).toBe('Rain');
      expect((await working(s, from, to, 'membership')).closed.find((c) => c.date === d)?.reason).toBe('Rain');
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_date('${d}'::date)`)).toBeNull();
      expect((await working(s, from, to, 'single')).closed.some((c) => c.date === d)).toBe(dow(d) !== 0 && dow(d) !== 6);
      expect((await working(s, from, to, 'membership')).closed.some((c) => c.date === d)).toBe(dow(d) !== 0 && dow(d) !== 6);
    }));

  it('only an admin can change either kind; the question the booking pages ask is open to everyone', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const day = await istDate(s, 5);
      for (const who of [() => s.as('authenticated', c.u.authId), () => s.as('anon')]) {
        for (const sql of [
          `select public.admin_set_working_weekdays(ARRAY[6,0]::integer[], 'membership')`,
          `select public.admin_set_working_dates('${day}'::date,'${day}'::date,false,'x','single')`,
          `select public.admin_clear_working_date('${day}'::date, 'membership')`,
          `select public.admin_working_days()`,
        ]) { await who(); expect(await s.err(sql), sql).toMatch(/admin access required|permission denied/i); }
      }
      for (const kind of ['single', 'membership', null]) { await s.as('anon'); expect(await s.err(`select public.get_working_days(current_date, current_date + 3, ${kind ? `'${kind}'` : 'null'})`)).toBeNull(); }
      await s.as('anon');
      expect(await s.err(`select public.get_working_days(current_date, current_date + 3, 'bogus')`)).toMatch(/single, membership or both/);
    }));
});

describe('separate days of the week', () => {
  it('memberships weekends only, single washes every day: each page is told its own days, and an older page is told the days open for both', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const from = await istDate(s, 0), to = await istDate(s, 20);
      await openOnly(s, a, [6, 0], 'membership');
      const single = await working(s, from, to, 'single');
      const member = await working(s, from, to, 'membership');
      const both = await working(s, from, to);
      expect(single.kind).toBe('single');
      expect(single.closed).toEqual([]);
      expect(openWeekdays(single)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(openWeekdays(member)).toEqual([0, 6]);
      expect(member.closed.every((c) => ![0, 6].includes(dow(c.date)))).toBe(true);
      expect(member.closed.length).toBeGreaterThan(0);
      // no kind = 'both': a day is open only when it is open for both
      expect(both.kind).toBe('both');
      expect(openWeekdays(both)).toEqual([0, 6]);
      expect(both.closed.map((c) => c.date)).toEqual(member.closed.map((c) => c.date));
      expect([0, 6]).toContain(dow(member.next_open!));
      expect(single.next_open).toBe(from);
    }));

  it('a single wash can be booked on a weekday that is closed for memberships, and is refused where it is closed for single washes', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const tue = await nextDow(s, 2, 10);
      await openOnly(s, a, [6, 0], 'membership');
      expect(await intent(s, c, tue)).toBeNull();                       // single washes are open every day
      await openOnly(s, a, [6, 0], 'single');
      await openOnly(s, a, [0, 1, 2, 3, 4, 5, 6], 'membership');
      expect(await intent(s, c, tue)).toMatch(closedMsg);               // now it is the single wash that is closed on Tuesday
      expect(await intent(s, c, await nextDow(s, 6, 10))).toBeNull();
    }));

  it('a membership cannot use a weekday closed for memberships even though single washes are open then, and can use one that only single washes lost', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await openOnly(s, a, [6, 0], 'membership');
      expect(await request(s, c, { weekdays: [1, 3], start })).toBe('WASHO is currently unavailable on Mondays, Wednesdays. Choose from Saturdays, Sundays.');
      expect(await request(s, c, { weekdays: [6, 0], start })).toBeNull();
    }));

  it('a membership can use weekdays that only single washes have closed', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await openOnly(s, a, [6, 0], 'single');
      expect(await request(s, c, { weekdays: [1, 3, 5, 2], start })).toBeNull();
    }));

  it('the automatic spread of a membership follows the membership days only', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await openOnly(s, a, [6, 0], 'membership');
      await s.as('authenticated', c.u.authId);
      const r = (await s.q(`select public.preview_monthly_dates($1,4,0,${days([0, 1, 2, 3, 4, 5, 6])},1,'morning',$2::date) r`, [c.veh, start]))[0].r as { fits: boolean; dates: { date: string }[] };
      expect(r.fits).toBe(true);
      expect(r.dates.every((d) => [0, 6].includes(dow(d.date)))).toBe(true);
      // closing the weekends for SINGLE washes changes nothing for the spread
      await openOnly(s, a, [1, 2, 3, 4, 5], 'single');
      await openOnly(s, a, [0, 1, 2, 3, 4, 5, 6], 'membership');
      await s.as('authenticated', c.u.authId);
      const r2 = (await s.q(`select public.preview_monthly_dates($1,4,0,${days([6, 0])},1,'morning',$2::date) r`, [c.veh, start]))[0].r as { fits: boolean; dates: { date: string }[] };
      expect(r2.fits).toBe(true);
      expect(r2.dates.every((d) => [0, 6].includes(dow(d.date)))).toBe(true);
    }));
});

describe('separate dates', () => {
  it('a date closed for single washes leaves memberships alone, and the other way round; each page sees its own closed dates and reasons', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const from = await istDate(s, 0), to = await istDate(s, 30);
      const d1 = await istDate(s, 9), d2 = await istDate(s, 11);
      expect(await setDates(s, a, d1, d1, false, 'Diwali', 'single')).toBe(1);
      expect(await setDates(s, a, d2, d2, false, 'Team event', 'membership')).toBe(1);
      const single = await working(s, from, to, 'single'), member = await working(s, from, to, 'membership'), both = await working(s, from, to);
      expect(single.closed).toEqual([{ date: d1, reason: 'Diwali' }]);
      expect(member.closed).toEqual([{ date: d2, reason: 'Team event' }]);
      expect(both.closed.map((x) => x.date)).toEqual([d1, d2]);
      expect(await intent(s, c, d1)).toMatch(/\(Diwali\)/);
      expect(await intent(s, c, d2)).toBeNull();
    }));

  it('exact dates for a membership must be membership days, not single-wash days', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      const dates = [6, 9, 12, 15].map((n) => ({ date: '', kind: 'body', n }));
      const picked = await Promise.all(dates.map(async (d) => ({ date: await istDate(s, d.n), kind: 'body' })));
      await setDates(s, a, picked[1].date, picked[1].date, false, 'Single only', 'single');
      expect(await request(s, c, { start, dates: picked })).toBeNull();   // a single-wash closure does not touch a membership date
      await setDates(s, a, picked[1].date, picked[1].date, false, 'Membership closed', 'membership');
      expect(await request(s, c, { start, dates: picked })).toMatch(/Membership closed/);
    }));

  it('a set date can be cleared for one kind only', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const from = await istDate(s, 0), to = await istDate(s, 20);
      const d = await istDate(s, 7);
      await setDates(s, a, d, d, false, 'Rain');   // both
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_date('${d}'::date, 'single')`)).toBeNull();
      expect((await working(s, from, to, 'single')).closed.some((x) => x.date === d)).toBe(false);
      expect((await working(s, from, to, 'membership')).closed.some((x) => x.date === d)).toBe(true);
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_date('${d}'::date, 'single')`)).toMatch(/no setting to remove/);
      expect(await s.err(`select public.admin_clear_working_date('${d}'::date, 'bogus')`)).toMatch(/single washes, memberships or both/);
    }));
});

describe('moving a membership wash and the free-wash claim', () => {
  it('moving a membership wash follows the membership days: a day closed only for single washes is fine, a day closed for memberships is refused (an admin may still)', async () =>
    inTx(async (s) => {
      const m = await paidMembership(s, { startDays: 2 });
      const wash = m.washes[3];
      // two days after the wash on which this vehicle has no other wash
      const free = [1, 2, 3, 4, 5, 6].map((n) => addDays(wash.d, n)).filter((d) => !m.washes.some((w: any) => w.d === d));
      const target = free[0], target2 = free[1];
      await setDates(s, m.admin, target, target, false, 'Single only', 'single');
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target}'::date,'morning')`)).toBeNull();
      await setDates(s, m.admin, target2, target2, false, 'Rain', 'membership');
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target2}'::date,'morning')`)).toMatch(closedMsg);
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_reschedule_wash('${wash.booking_id}','${target2}'::date,'afternoon','Customer asked')`)).toBeNull();
    }));

  it('a free-wash claim is booked on the earliest day open for SINGLE washes, whatever memberships have closed', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const p = await customer(s);
      const opens = await istDate(s, 0), closes = await istDate(s, 5), useBy = await istDate(s, 9);
      await s.as('postgres');
      const camp = (await s.q(
        `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
         values ($1, 'Free wash', true, $2, $3, $4, 100, 14, 500, 1000, 1500, false) returning id`, [`wd-${uid().slice(0, 8)}`, opens, closes, useBy]
      ))[0].id as string;
      await setDates(s, a, await istDate(s, 0), await istDate(s, 12), false, 'Memberships closed', 'membership');   // nothing for single washes
      const openDay = await istDate(s, 3);
      await setDates(s, a, await istDate(s, 0), await istDate(s, 2), false, 'Single closed', 'single');
      await s.as('authenticated', p.u.authId);
      const r = (await s.q(`select public.claim_campaign_wash($1::uuid, $2::uuid, current_date, 'morning', $3::uuid, 'Basement P1') r`, [camp, p.veh, p.addr]))[0].r;
      expect(r.scheduled_date >= openDay).toBe(true);
    }));
});

describe('what the Working Days page shows, by kind', () => {
  it('each kind lists its own dates and the washes of that kind booked on days closed for it', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const svc = await serviceId(s, 'car-body-wash');
      const mon = await nextDow(s, 1, 5);
      await s.as('postgres');
      for (let i = 0; i < 2; i++) {
        const v = await createVehicle(s, c.u.profileId, 'car');
        await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'morning','confirmed')`, [c.u.profileId, v, svc, mon]);
      }
      await openOnly(s, a, [6, 0], 'single');   // Monday is now closed for single washes, still open for memberships
      await setDates(s, a, await istDate(s, 20), await istDate(s, 20), false, 'Festival', 'membership');
      await asAdmin(s, a);
      const r = (await s.q('select public.admin_working_days() r'))[0].r;
      expect(r.single.booked_on_closed.find((b: any) => b.date === mon)).toEqual({ date: mon, washes: 2 });
      expect(r.membership.booked_on_closed.find((b: any) => b.date === mon)).toBeUndefined();   // memberships are open on Monday
      expect(r.single.weekdays.filter((w: any) => w.open).map((w: any) => w.weekday)).toEqual([0, 6]);
      expect(r.membership.weekdays.filter((w: any) => w.open)).toHaveLength(7);
      expect(r.single.dates).toEqual([]);
      expect(r.membership.dates).toEqual([{ day: await istDate(s, 20), open: false, reason: 'Festival', washes: 0 }]);
    }));
});
