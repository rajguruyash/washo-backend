/**
 * GREEN tests for 20261004000039_working_days.sql: the days WASHO washes. An admin turns weekdays and single dates on or off; a closed day stops a single wash, a membership's
 * weekdays and exact dates, moving a membership wash (customers and specialists, not admins) and a free-wash claim, and tells the customer when they can book instead.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, paidMembership, serviceId, uid } from './helpers';

const NOT_ADMIN = /admin access required|permission denied/i;
const closedMsg = /^WASHO does not wash on [A-Z][a-z]+, \d{1,2} [A-Z][a-z]{2}( \(.+\))?\. The next day you can book is [A-Z][a-z]+, \d{1,2} [A-Z][a-z]{2}\.$/;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── helpers: each switches the session role itself (istDate resets it, so compute dates first) ───
const asAdmin = async (s: any, a: { authId: string }) => s.as('authenticated', a.authId);
const openOnly = async (s: any, a: any, open: number[]) => { await asAdmin(s, a); await s.q('select public.admin_set_working_weekdays($1::integer[])', [open]); };
const setDates = async (s: any, a: any, from: string, to: string, open: boolean, reason: string | null = null) => {
  await asAdmin(s, a);
  return (await s.q('select public.admin_set_working_dates($1::date,$2::date,$3,$4) n', [from, to, open, reason]))[0].n as number;
};
const working = async (s: any, from: string, to: string) => { await s.as('anon'); return (await s.q('select public.get_working_days($1::date,$2::date) r', [from, to]))[0].r as { weekdays: { weekday: number; open: boolean }[]; closed: { date: string; reason: string | null }[]; next_open: string | null }; };
/** The first date at least `from` days away that is on this weekday (0 = Sunday ... 6 = Saturday). */
const nextDow = async (s: any, d: number, from = 8) => { const t = await istDate(s, from); for (let i = 0; i < 7; i++) if (dow(addDays(t, i)) === d) return addDays(t, i); throw new Error('unreachable'); };

async function customer(s: any, vtype: 'bike' | 'car' | 'suv' = 'car') {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, vtype);
  return { u, addr, veh };
}
const intent = async (s: any, c: any, date: string, slot = 'morning') => {
  const svc = await serviceId(s, 'car-body-wash');
  await s.as('authenticated', c.u.authId);
  return s.err(`select public.create_booking_payment_intent('${c.veh}','${svc}','${date}'::date,'${slot}'::public.time_slot,'${c.addr}')`);
};
const days = (d: number[]) => `ARRAY[${d.join(',')}]::integer[]`;

describe('nothing changes until a day is turned off', () => {
  it('every weekday starts open, no day is closed, and the next open day is today', async () =>
    inTx(async (s) => {
      const from = await istDate(s, 0), to = await istDate(s, 60);
      const r = await working(s, from, to);
      expect(r.weekdays).toHaveLength(7);
      expect(r.weekdays.every((w) => w.open)).toBe(true);
      expect(r.closed).toEqual([]);
      expect(r.next_open).toBe(from);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.working_dates`))[0].n).toBe(0);
    }));

  it('a single wash on any day can still be started', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      expect(await intent(s, c, await istDate(s, 5))).toBeNull();
    }));
});

describe('only an admin can change it; anyone can ask which days are closed', () => {
  it('customers, specialists and anonymous callers are refused', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const w = await createWorker(s);
      const day = await istDate(s, 5);
      const calls = [
        `select public.admin_working_days()`,
        `select public.admin_set_working_weekdays(ARRAY[6,0]::integer[])`,
        `select public.admin_set_working_dates('${day}'::date,'${day}'::date,false,'x')`,
        `select public.admin_clear_working_date('${day}'::date)`,
      ];
      for (const who of [() => s.as('authenticated', c.u.authId), () => s.as('authenticated', w.authId), () => s.as('anon')]) {
        for (const sql of calls) { await who(); expect(await s.err(sql), sql).toMatch(NOT_ADMIN); }
      }
      // and they changed nothing
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.working_weekdays where not is_open`))[0].n).toBe(0);
      // the read the booking pages use is open to everyone signed in or not
      for (const who of [() => s.as('authenticated', c.u.authId), () => s.as('anon')]) { await who(); expect(await s.err(`select public.get_working_days(current_date, current_date + 3)`)).toBeNull(); }
    }));
});

describe('days of the week', () => {
  it('Monday to Friday off, Saturday and Sunday on: weekdays are closed, weekends are open, and the next open day is a weekend day', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const from = await istDate(s, 0), to = await istDate(s, 20);
      await openOnly(s, a, [6, 0]);
      const r = await working(s, from, to);
      expect(r.weekdays.filter((w) => w.open).map((w) => w.weekday)).toEqual([0, 6]);
      expect(r.closed.every((c) => ![0, 6].includes(dow(c.date)))).toBe(true);
      const expectedClosed = Array.from({ length: 21 }, (_, i) => addDays(from, i)).filter((d) => ![0, 6].includes(dow(d)));
      expect(r.closed.map((c) => c.date)).toEqual(expectedClosed);
      expect([0, 6]).toContain(dow(r.next_open!));
      expect(r.next_open! >= from).toBe(true);
      // switch it all back on
      await openOnly(s, a, [0, 1, 2, 3, 4, 5, 6]);
      expect((await working(s, from, to)).closed).toEqual([]);
    }));

  it('the choice is checked, and it is recorded in the activity log', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_set_working_weekdays(ARRAY[7]::integer[])`)).toMatch(/weekday \(0 to 6\)/);
      expect(await s.err(`select public.admin_set_working_weekdays(NULL)`)).toMatch(/weekday \(0 to 6\)/);
      expect(await s.err(`select public.admin_set_working_weekdays(ARRAY[6,0]::integer[])`)).toBeNull();
      await s.as('postgres');
      const ev = (await s.q(`select metadata m, actor_profile_id a from public.audit_events where event_type = 'working_weekdays_changed' order by created_at desc limit 1`))[0];
      expect(ev.m.open_days).toEqual([0, 6]);
      expect(ev.a).toBe(a.profileId);
    }));
});

describe('single dates', () => {
  it('a date can be closed with a reason, opened when its weekday is closed, and cleared', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const sat = await nextDow(s, 6), mon = await nextDow(s, 1);
      const from = await istDate(s, 0), to = await istDate(s, 30);
      await openOnly(s, a, [6, 0]);
      expect(await setDates(s, a, sat, sat, false, 'Diwali')).toBe(1);   // a closed weekend day
      expect(await setDates(s, a, mon, mon, true)).toBe(1);               // an open Monday
      let r = await working(s, from, to);
      expect(r.closed.find((c) => c.date === sat)).toEqual({ date: sat, reason: 'Diwali' });
      expect(r.closed.some((c) => c.date === mon)).toBe(false);
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_date('${sat}'::date)`)).toBeNull();
      expect(await s.err(`select public.admin_clear_working_date('${mon}'::date)`)).toBeNull();
      r = await working(s, from, to);
      expect(r.closed.some((c) => c.date === sat)).toBe(false);   // Saturday's weekday rule is back (open)
      expect(r.closed.some((c) => c.date === mon)).toBe(true);    // Monday's weekday rule is back (closed)
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_clear_working_date('${mon}'::date)`)).toMatch(/no setting to remove/);
    }));

  it('a run of dates is set at once (up to 92 days), and bad input is refused', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const d0 = await istDate(s, 3), d4 = await istDate(s, 7), past = await istDate(s, -1), d95 = await istDate(s, 95), d94 = await istDate(s, 94);
      expect(await setDates(s, a, d0, d4, false, 'Festival week')).toBe(5);
      const r = await working(s, d0, d4);
      expect(r.closed.map((c) => c.date)).toEqual(Array.from({ length: 5 }, (_, i) => addDays(d0, i)));
      expect(r.closed.every((c) => c.reason === 'Festival week')).toBe(true);
      await asAdmin(s, a);
      const set = (f: string, t: string, open: boolean | null, reason: string | null = null) => s.err(`select public.admin_set_working_dates('${f}'::date,'${t}'::date,${open},${reason ? `'${reason}'` : 'null'})`);
      expect(await set(past, d0, false)).toMatch(/today or a later date/);
      expect(await set(d4, d0, false)).toMatch(/cannot be before the first/);
      expect(await set(d0, d95, false)).toMatch(/up to 92 days/);
      expect(await set(d0, d94, false)).toBeNull();   // 92 days exactly is the most allowed
      expect(await set(d0, d0, null)).toMatch(/whether WASHO works/);
      expect(await set(d0, d0, false, 'x'.repeat(121))).toMatch(/under 120 characters/);
      expect(await set(d0, d0, false, '  ')).toBeNull();   // a blank reason is no reason
    }));

  it('setting a date again replaces its reason; each change is recorded', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const d = await istDate(s, 6), from = await istDate(s, 0), to = await istDate(s, 10);
      await setDates(s, a, d, d, false, 'Rain');
      await setDates(s, a, d, d, false, 'Heavy rain');
      expect((await working(s, from, to)).closed.find((c) => c.date === d)!.reason).toBe('Heavy rain');
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.audit_events where event_type = 'working_dates_set'`))[0].n).toBe(2);
      expect((await s.q(`select count(*)::int n from public.working_dates where day = $1`, [d]))[0].n).toBe(1);
    }));
});

describe('a single wash on a closed day', () => {
  it('is refused with the date, the reason, and the next day the customer can book', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const tue = await nextDow(s, 2, 10), sat = await nextDow(s, 6, 10);
      await openOnly(s, a, [6, 0]);
      const msg = await intent(s, c, tue);
      expect(msg).toMatch(closedMsg);
      expect(msg).toContain('Tuesday');
      // the next day offered is the first weekend day after the one asked for
      let n = addDays(tue, 1);
      while (![0, 6].includes(dow(n))) n = addDays(n, 1);
      expect(msg).toContain(`The next day you can book is ${DAYS[dow(n)]}, ${Number(n.slice(8))} ${MONTHS[Number(n.slice(5, 7)) - 1]}.`);
      expect(await intent(s, c, sat)).toBeNull();
    }));

  it('names the reason when the day was closed for one', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const d = await istDate(s, 6);
      await setDates(s, a, d, d, false, 'Diwali');
      expect(await intent(s, c, d)).toMatch(/\(Diwali\)/);
    }));

  it('a weekday that is turned on for one date can be booked; and no payment is opened for a refused day', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const mon = await nextDow(s, 1, 10), tue = addDays(mon, 1);
      await openOnly(s, a, [6, 0]);
      await setDates(s, a, mon, mon, true, 'Extra day');
      expect(await intent(s, c, mon)).toBeNull();
      expect(await intent(s, c, tue)).toMatch(closedMsg);
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.payments where customer_profile_id = $1 and status = 'pending'`, [c.u.profileId]))[0].n).toBe(1);
    }));

  it('when nothing is open at all, it says WASHO is not taking bookings', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      await openOnly(s, a, []);
      expect(await intent(s, c, await istDate(s, 6))).toMatch(/We are not taking bookings right now\.$/);
    }));
});

describe('a membership', () => {
  const request = async (s: any, c: any, o: { body?: number; deep?: number; weekdays?: number[]; start: string; dates?: unknown[] }) => {
    await s.as('authenticated', c.u.authId);
    return s.err(`select public.create_monthly_membership_request($1,$2,$3,${days(o.weekdays ?? [])},1,'morning',$4::date,$5,null,null,null,$6::jsonb,null)`, [c.veh, o.body ?? 4, o.deep ?? 0, o.start, c.addr, o.dates ? JSON.stringify(o.dates) : null]);
  };
  const preview = async (s: any, c: any, o: { body: number; deep?: number; weekdays: number[]; start: string }) => {
    await s.as('authenticated', c.u.authId);
    return (await s.q(`select public.preview_monthly_dates($1,$2,$3,${days(o.weekdays)},1,'morning',$4::date) r`, [c.veh, o.body, o.deep ?? 0, o.start]))[0].r as { fits: boolean; dates: { date: string; kind: string }[] };
  };

  it('cannot be built on weekdays WASHO is closed; the message says which and what to choose', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await openOnly(s, a, [6, 0]);
      expect(await request(s, c, { weekdays: [1, 3], start })).toBe('WASHO does not wash on Mondays, Wednesdays. Choose from Saturdays, Sundays.');
      expect(await request(s, c, { weekdays: [1, 6], start })).toBe('WASHO does not wash on Mondays. Choose from Saturdays, Sundays.');
      expect(await request(s, c, { weekdays: [6, 0], start })).toBeNull();
    }));

  it('says it is not taking memberships when every weekday is off', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      await openOnly(s, a, []);
      expect(await request(s, c, { weekdays: [2], start: await istDate(s, 4) })).toBe('WASHO does not wash on Tuesdays. We are not taking memberships right now.');
    }));

  it('lands every wash of the spread on a day WASHO works, and passes over a closed date', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      const every = [0, 1, 2, 3, 4, 5, 6];
      const before = await preview(s, c, { body: 4, weekdays: every, start });
      await openOnly(s, a, [6, 0]);
      let r = await preview(s, c, { body: 4, weekdays: every, start });
      expect(r.fits).toBe(true);
      expect(r.dates).toHaveLength(4);
      expect(r.dates.every((d) => [0, 6].includes(dow(d.date)))).toBe(true);
      // a holiday on one of the weekend days it chose: that wash moves to another open day
      const holiday = r.dates[1].date;
      await setDates(s, a, holiday, holiday, false, 'Holiday');
      r = await preview(s, c, { body: 4, weekdays: every, start });
      expect(r.dates).toHaveLength(4);
      expect(r.dates.map((d) => d.date)).not.toContain(holiday);
      expect(r.dates.every((d) => [0, 6].includes(dow(d.date)))).toBe(true);
      // with nothing turned off the plan was the plain spread over every day
      expect(before.dates.some((d) => ![0, 6].includes(dow(d.date)))).toBe(true);
    }));

  it('is shown as not fitting when the days the customer chose leave too few open days', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await openOnly(s, a, [6, 0]);
      // all four Saturdays of the month closed: Saturdays only cannot hold four washes any more
      const sats = Array.from({ length: 31 }, (_, i) => addDays(start, i)).filter((d) => dow(d) === 6);
      for (const d of sats) await setDates(s, a, d, d, false, 'Closed');
      const r = await preview(s, c, { body: 4, weekdays: [6], start });
      expect(r.fits).toBe(false);
      expect(await request(s, c, { weekdays: [6], start })).toMatch(/WASHO does not wash on Saturdays|cannot fit/);
    }));

  it('exact dates cannot include a closed day; open days are accepted', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await openOnly(s, a, [6, 0]);
      const wk = Array.from({ length: 20 }, (_, i) => addDays(start, i));
      const ok = wk.filter((d) => [0, 6].includes(dow(d))).slice(0, 4);
      const bad = wk.find((d) => dow(d) === 2)!;
      const plan = (dates: string[]) => dates.map((date) => ({ date, kind: 'body' }));
      expect(await request(s, c, { start, dates: plan(ok) })).toBeNull();
      expect(await request(s, c, { start, dates: plan([...ok.slice(0, 3), bad]) })).toMatch(closedMsg);
    }));

  it('is NEVER refused after payment: weekdays closed between checkout and payment fall back to open days', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const start = await istDate(s, 4);
      await s.as('authenticated', c.u.authId);
      const intentRow = (await s.q(`select public.start_monthly_membership_checkout($1,4,0,${days([6])},1,'morning',$2::date,$3,'Basement P1',null,null,null) r`, [c.veh, start, c.addr]))[0].r;
      await openOnly(s, a, [0]);   // Saturdays are now closed; only Sundays work
      await s.as('service_role');
      const order = `order_${uid().slice(0, 8)}`;
      await s.q('select app_private.attach_provider_order($1,$2)', [intentRow.payment_id, order]);
      const paid = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intentRow.amount_cents]))[0].r;
      expect(paid.membership_id).toBeTruthy();
      await s.as('postgres');
      const washes = await s.q(`select to_char(scheduled_date,'YYYY-MM-DD') d from public.bookings where membership_id = $1 order by scheduled_date`, [paid.membership_id]);
      expect(washes).toHaveLength(4);
      expect(washes.every((w: any) => dow(w.d) === 0)).toBe(true);   // open days first
    }));
});

describe('moving a membership wash', () => {
  it('a customer or a specialist cannot move it to a closed day; an admin can', async () =>
    inTx(async (s) => {
      const w = await createWorker(s);
      const m = await paidMembership(s, { startDays: 2 });
      await s.as('authenticated', m.admin.authId);
      await s.q('select public.admin_assign_membership_worker($1,$2)', [m.membership, w.profileId]);
      const wash = m.washes[3];                         // a later wash, so the customer's 2 days' notice is no issue
      const target = addDays(wash.d, 1);                // the day after: not one of this plan's own days
      const target2 = addDays(wash.d, 2);
      await setDates(s, m.admin, target, target, false, 'Rain');

      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target}'::date,'morning')`)).toMatch(closedMsg);
      await s.as('authenticated', w.authId);
      expect(await s.err(`select public.worker_reschedule_wash('${wash.booking_id}','${target}'::date,null,'x')`)).toMatch(closedMsg);
      // an open day still works for both
      await s.as('authenticated', m.u.authId);
      expect(await s.err(`select public.reschedule_booking_occurrence('${wash.occ}','${target2}'::date,'morning')`)).toBeNull();
      // an admin may make the exception
      await s.as('authenticated', m.admin.authId);
      expect(await s.err(`select public.admin_reschedule_wash('${wash.booking_id}','${target}'::date,'afternoon','Customer asked')`)).toBeNull();
      await s.as('postgres');
      expect((await s.q(`select to_char(scheduled_date,'YYYY-MM-DD') d from public.bookings where id = $1`, [wash.booking_id]))[0].d).toBe(target);
    }));

  it('an admin can move a single wash onto a closed day too', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const svc = await serviceId(s, 'car-body-wash');
      const day = await istDate(s, 6), closed = await istDate(s, 8);
      await s.as('postgres');
      const id = (await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'morning','confirmed') returning id`, [c.u.profileId, c.veh, svc, day]))[0].id;
      await setDates(s, a, closed, closed, false, 'Closed');
      await asAdmin(s, a);
      expect(await s.err(`select public.admin_reschedule_wash('${id}','${closed}'::date,'morning','Exception')`)).toBeNull();
    }));
});

describe('a free-wash campaign claim', () => {
  const campaign = async (s: any, useBy: string) => {
    const opens = await istDate(s, 0), closes = await istDate(s, 5);
    await s.as('postgres');
    return (await s.q(
      `insert into public.campaigns (code, name, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only)
       values ($1, 'Free wash', true, $2, $3, $4, 100, 14, 500, 1000, 1500, false) returning id`, [`wd-${uid().slice(0, 8)}`, opens, closes, useBy]
    ))[0].id as string;
  };
  const claim = async (s: any, c: any, camp: string) => {
    await s.as('authenticated', c.u.authId);
    return s.q(`select public.claim_campaign_wash($1::uuid, $2::uuid, current_date, 'morning', $3::uuid, 'Basement P1') r`, [camp, c.veh, c.addr]);
  };

  it('is booked on the earliest OPEN day', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const p = await customer(s);
      const camp = await campaign(s, await istDate(s, 9));
      const from = await istDate(s, 0), to = await istDate(s, 12);
      await setDates(s, a, from, to, false, 'Closed for a week');
      const openDay = await istDate(s, 6);
      await setDates(s, a, openDay, openDay, true);
      const r = (await claim(s, p, camp))[0].r;
      expect(r.scheduled_date).toBe(openDay);
    }));

  it('is refused, with the reason, when the offer has no open day left', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const p = await customer(s);
      const camp = await campaign(s, await istDate(s, 4));
      await setDates(s, a, await istDate(s, 0), await istDate(s, 12), false, 'Holiday');
      await s.as('authenticated', p.u.authId);
      const err = await s.err(`select public.claim_campaign_wash($1::uuid, $2::uuid, current_date, 'morning', $3::uuid, 'Basement P1')`, [camp, p.veh, p.addr]);
      expect(err).toMatch(/^WASHO has no working day left while this offer is open\. WASHO does not wash on .*\(Holiday\)\./);
    }));
});

describe('what the Working Days page shows', () => {
  it('lists the dates turned off or on, and the washes already booked on closed days (they stay booked)', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const svc = await serviceId(s, 'car-body-wash');
      const sat = await nextDow(s, 6, 5), sun = addDays(sat, 1), mon = addDays(sat, 2);
      await s.as('postgres');
      for (const d of [mon, mon]) {
        const v = await createVehicle(s, c.u.profileId, 'car');
        await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'morning','confirmed')`, [c.u.profileId, v, svc, d]);
      }
      await openOnly(s, a, [6, 0]);
      await setDates(s, a, sun, sun, false, 'Event');
      await asAdmin(s, a);
      const r = (await s.q('select public.admin_working_days() r'))[0].r;
      expect(r.weekdays.filter((w: any) => w.open).map((w: any) => w.weekday)).toEqual([0, 6]);
      expect(r.dates).toEqual([{ day: sun, open: false, reason: 'Event', washes: 0 }]);
      expect(r.booked_on_closed.find((b: any) => b.date === mon)).toEqual({ date: mon, washes: 2 });
      expect(r.next_open).toBeTruthy();
      // the bookings themselves were not touched
      await s.as('postgres');
      expect((await s.q(`select count(*)::int n from public.bookings where scheduled_date = $1 and status = 'confirmed'`, [mon]))[0].n).toBeGreaterThanOrEqual(2);
    }));

  it('a cancelled or finished wash on a closed day is not listed', async () =>
    inTx(async (s) => {
      const a = await createAdmin(s);
      const c = await customer(s);
      const svc = await serviceId(s, 'car-body-wash');
      const mon = await nextDow(s, 1, 5);
      await s.as('postgres');
      const v1 = await createVehicle(s, c.u.profileId, 'car'), v2 = await createVehicle(s, c.u.profileId, 'car');
      for (const [v, st] of [[v1, 'cancelled'], [v2, 'completed']] as const) {
        await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'morning',$5)`, [c.u.profileId, v, svc, mon, st]);
      }
      await openOnly(s, a, [6, 0]);
      await asAdmin(s, a);
      const r = (await s.q('select public.admin_working_days() r'))[0].r;
      expect(r.booked_on_closed.find((b: any) => b.date === mon)).toBeUndefined();
    }));
});
