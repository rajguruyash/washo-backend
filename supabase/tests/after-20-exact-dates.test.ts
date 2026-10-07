/** GREEN tests for 20261004000020_membership_exact_dates.sql: the plan planner, exact dates and their rules, the crowd check before payment. */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, inTx, istDate, serviceId, uid } from './helpers';

const PLAN = [{ weekday: 3, kind: 'body' }, { weekday: 6, kind: 'deep' }]; // Wed body, Sat deep: 2 a week

async function setup(s: any, type: 'bike' | 'car' | 'suv' = 'car') {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, type);
  const start = await istDate(s, 4);
  return { u, addr, veh, start };
}
const termEnd = async (s: any, start: string, months = 1) => { await s.as('postgres'); return (await s.q('select app_private.membership_term_end($1::date,$2) d', [start, months]))[0].d.toISOString?.().slice(0, 10) ?? (await s.q('select app_private.membership_term_end($1::date,$2)::text d', [start, months]))[0].d; };
const planned = async (s: any, c: any, o: { pattern?: any[]; months?: number; slot?: string; respect?: boolean; total?: number } = {}) => {
  await s.as('postgres');
  const end = (await s.q('select app_private.membership_term_end($1::date,$2)::text d', [c.start, o.months ?? 1]))[0].d;
  return s.q(`select wash_date::text d, kind from app_private.plan_membership_washes($1,$2::date,$3::date,$4::jsonb,$5,$6::public.time_slot,$7) order by 1`,
    [c.veh, c.start, end, JSON.stringify(o.pattern ?? PLAN), o.total ?? 8, o.slot ?? 'morning', o.respect ?? true]);
};
/** Make a date "full": one place only on weekdays and weekends, then a wash on it. */
async function limitsToOne(s: any) {
  const admin = await createAdmin(s);
  await s.as('authenticated', admin.authId);
  await s.q(`select public.admin_set_capacity('weekday', 1, 1, 1, 1)`);
  await s.as('authenticated', admin.authId);
  await s.q(`select public.admin_set_capacity('weekend', 1, 1, 1, 1)`);
}
async function occupy(s: any, date: string, slot = 'morning') {
  const u = await createCustomer(s);
  const veh = await createVehicle(s, u.profileId, 'car');
  const svc = await serviceId(s, 'car-body-wash');
  await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,$5,'confirmed')`, [u.profileId, veh, svc, date, slot]);
}
const checkout = async (s: any, c: any, o: { pattern?: any[]; months?: number; slot?: string; custom?: any } = {}) => {
  await s.as('authenticated', c.u.authId);
  return s.q(`select public.start_membership_checkout($1,$2::jsonb,$3,$4::public.time_slot,$5::date,$6,'Basement P1',null,null,$7::jsonb) r`,
    [c.veh, JSON.stringify(o.pattern ?? PLAN), o.months ?? 1, o.slot ?? 'morning', c.start, c.addr, o.custom ? JSON.stringify(o.custom) : null]).then((r: any) => r[0].r);
};
const checkoutErr = async (s: any, c: any, custom: any, o: { pattern?: any[]; months?: number } = {}) => {
  await s.as('authenticated', c.u.authId);
  return s.err(`select public.start_membership_checkout($1,$2::jsonb,$3,'morning'::public.time_slot,$4::date,$5,'P1',null,null,$6::jsonb)`,
    [c.veh, JSON.stringify(o.pattern ?? PLAN), o.months ?? 1, c.start, c.addr, custom === null ? null : JSON.stringify(custom)]);
};
const settle = async (s: any, payment: any, profile: string) => {
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [payment.payment_id, order]);
  return (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured',$4) r`, [order, `pay_${uid().slice(0, 8)}`, payment.amount_cents, profile]))[0].r;
};
const bookedDates = async (s: any, membership: string) => { await s.as('postgres'); return s.q(`select scheduled_date::text d, sv.wash_kind kind from public.bookings b join public.services sv on sv.id = b.service_id where b.membership_id=$1 order by 1`, [membership]); };

describe('the planner', () => {
  it('lays a weekday plan on its weekdays from the start date: 4 weeks of Wed (body) and Sat (deep)', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const rows = await planned(s, c);
      expect(rows).toHaveLength(8);
      expect(rows.filter((r: any) => r.kind === 'body')).toHaveLength(4);
      for (const r of rows) {
        const dow = new Date(`${r.d}T00:00:00Z`).getUTCDay();
        expect(dow, r.d).toBe(r.kind === 'body' ? 3 : 6);
        expect(r.d >= c.start).toBe(true);
      }
    }));

  it('passes over a day that is full (and carries on to the next chosen day), when asked to respect the limits', async () =>
    inTx(async (s) => {
      // three months: room for the washes to slip a day or two, whatever weekday the term starts on
      const c = await setup(s);
      const three = { months: 3, total: 24 };
      const before = await planned(s, c, three);
      await limitsToOne(s);
      await s.as('postgres');
      await occupy(s, before[0].d); // the first wash day is now full
      const after = await planned(s, c, three);
      expect(after.map((r: any) => r.d)).not.toContain(before[0].d);
      expect(after).toHaveLength(24); // every wash still has a day, a little later
      const ignoring = await planned(s, c, { ...three, respect: false });
      expect(ignoring.map((r: any) => r.d)).toContain(before[0].d); // without the limits it would use it
    }));

  it('says so when the crowded days leave no room: fewer days than washes', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      await limitsToOne(s);
      await s.as('postgres');
      const all = await planned(s, c, { respect: false, total: 20 }); // every Wed and Sat in the term
      for (const r of all) await occupy(s, r.d);
      expect(await planned(s, c, { total: 8 })).toHaveLength(0);
    }));
});

describe('the preview', () => {
  const preview = async (s: any, c: any, start = c.start, pattern = PLAN) => { await s.as('authenticated', c.u.authId); return (await s.q(`select public.preview_membership_dates($1,$2::jsonb,1,'morning'::public.time_slot,$3::date) r`, [c.veh, JSON.stringify(pattern), start]))[0].r; };

  it('lists the dates and how busy each is', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const p = await preview(s, c);
      expect(p).toMatchObject({ total: 8, fits: true, start_date: c.start });
      expect(p.dates).toHaveLength(8);
      expect(p.dates[0]).toMatchObject({ state: 'ok' });
      expect(p.end_date >= p.dates[7].date).toBe(true);
    }));

  it('says it does not fit, and still shows where it would land', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      await limitsToOne(s);
      await s.as('postgres');
      const all = await planned(s, c, { respect: false, total: 20 });
      for (const r of all) await occupy(s, r.d);
      const p = await preview(s, c);
      expect(p.fits).toBe(false);
      expect(p.dates.length).toBeGreaterThan(0);
      expect(p.dates.every((d: any) => d.state === 'full')).toBe(true);
    }));

  it('refuses a start that is too soon, someone else\'s vehicle and a bad plan', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const other = await setup(s);
      const today = await istDate(s, 0);
      await s.as('authenticated', c.u.authId);
      const q = (veh: string, start: string, pattern: any) => s.err(`select public.preview_membership_dates('${veh}','${JSON.stringify(pattern)}'::jsonb,1,'morning'::public.time_slot,'${start}'::date)`);
      expect(await q(c.veh, today, PLAN)).toMatch(/can start from/);
      expect(await q(other.veh, c.start, PLAN)).toMatch(/Vehicle not found/);
      expect(await q(c.veh, c.start, [{ weekday: 1, kind: 'body' }, { weekday: 1, kind: 'deep' }])).toMatch(/different day/);
    }));

  it('a request on weekdays that cannot be laid out is refused before any payment exists', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      await limitsToOne(s);
      await s.as('postgres');
      for (const r of await planned(s, c, { respect: false, total: 20 })) await occupy(s, r.d);
      expect(await checkoutErr(s, c, null)).toMatch(/cannot fit all 8 washes/);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.payments'))[0].n).toBe(0);
    }));
});

describe('exact dates', () => {
  /** A valid set of dates for PLAN over one month: the planner's own answer. */
  const good = async (s: any, c: any) => (await planned(s, c, { respect: false })).map((r: any) => ({ date: r.d, kind: r.kind }));
  const swap = (arr: any[], i: number, patch: any) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x));

  it('accepts a valid set, stores it, and the payment lays the washes on exactly those dates', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const dates = await good(s, c);
      // move the first wash a day later (a Thursday instead of Wednesday), keep everything else: still valid
      const moved = swap(dates, 0, { date: new Date(Date.parse(`${dates[0].date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) });
      const pay = await checkout(s, c, { custom: moved });
      expect(pay.amount_cents).toBeGreaterThan(0);
      await s.as('postgres');
      expect((await s.q('select jsonb_array_length(custom_dates) n from public.membership_requests where id=$1', [pay.request_id]))[0].n).toBe(8);
      const res = await settle(s, pay, c.u.profileId);
      expect(res.status).toBe('fulfilled');
      const rows = await bookedDates(s, res.membership_id);
      expect(rows.map((r: any) => r.d)).toEqual(moved.map((m: any) => m.date).sort());
      expect(rows.filter((r: any) => r.kind === 'body')).toHaveLength(4);
      expect(rows.filter((r: any) => r.kind === 'deep')).toHaveLength(4);
    }));

  it('repeating the same exact dates returns the same open payment; different dates make a new one', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const dates = await good(s, c);
      const a = await checkout(s, c, { custom: dates });
      const again = await checkout(s, c, { custom: [...dates].reverse() }); // order does not matter
      expect(again.payment_id).toBe(a.payment_id);
      const moved = swap(dates, 1, { date: new Date(Date.parse(`${dates[1].date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) });
      expect((await checkout(s, c, { custom: moved })).payment_id).not.toBe(a.payment_id);
    }));

  it('refuses the wrong number of washes of each kind', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const dates = await good(s, c);
      expect(await checkoutErr(s, c, dates.slice(1))).toMatch(/Choose exactly 4 Body washes and 4 Deep cleans for this plan \(you have 3 and 4\)/);
      expect(await checkoutErr(s, c, swap(dates, 0, { kind: 'deep' }))).toMatch(/you have 3 and 5/);
    }));

  it('refuses two washes on one day, a day before the earliest start, a day after the term, and too many in a week', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const dates = await good(s, c);
      expect(await checkoutErr(s, c, swap(dates, 1, { date: dates[0].date }))).toMatch(/same day/);
      expect(await checkoutErr(s, c, swap(dates, 0, { date: await istDate(s, 1) }))).toMatch(/Every wash must be between .* \(not today or tomorrow\)/);
      expect(await checkoutErr(s, c, swap(dates, 0, { date: await istDate(s, 0) }))).toMatch(/not today or tomorrow/);
      expect(await checkoutErr(s, c, swap(dates, 7, { date: await istDate(s, 200) }))).toMatch(/Every wash must be between/);
      // three washes in one week for a 2-a-week plan: take a week that has two and move the last wash of the term into it, on a day in between
      const day = (d: string) => new Date(`${d}T00:00:00Z`);
      const monday = (d: string) => { const x = day(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.getTime(); };
      const week = dates.find((d: any) => dates.filter((o: any) => monday(o.date) === monday(d.date)).length === 2);
      const free = [1, 2, 3, 4, 5, 6, 0].map((n) => new Date(monday(week.date) + n * 86_400_000).toISOString().slice(0, 10)).find((x) => !dates.some((d: any) => d.date === x) && x >= c.start);
      const crowded = swap(dates, dates.length - 1, { date: free });
      expect(await checkoutErr(s, c, crowded)).toMatch(/No more than 2 washes in one week: the week of .* has 3/);
    }));

  it('refuses a day the vehicle already has a wash, and a day that is full', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const dates = await good(s, c);
      await s.as('postgres');
      const svc = await serviceId(s, 'car-body-wash');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'night','confirmed')`, [c.u.profileId, c.veh, svc, dates[2].date]);
      expect(await checkoutErr(s, c, dates)).toMatch(/This vehicle already has a wash on/);
      await s.as('postgres');
      await s.q(`delete from public.bookings where vehicle_id=$1`, [c.veh]);
      await limitsToOne(s);
      await s.as('postgres');
      await occupy(s, dates[3].date);
      expect(await checkoutErr(s, c, dates)).toMatch(/These days are fully booked in the morning window/);
    }));

  it('a bike has only Body washes, and malformed input is refused plainly', async () =>
    inTx(async (s) => {
      const c = await setup(s, 'bike');
      const bikePlan = [{ weekday: 2, kind: 'body' }];
      const dates = (await planned(s, c, { pattern: bikePlan, total: 4, respect: false })).map((r: any) => ({ date: r.d, kind: r.kind }));
      expect(await checkoutErr(s, c, dates, { pattern: bikePlan })).toBeNull();
      expect(await checkoutErr(s, c, [{ date: 'tomorrow', kind: 'body' }], { pattern: bikePlan })).toMatch(/Each wash needs a date and a kind/);
      expect(await checkoutErr(s, c, [{ date: dates[0].date, kind: 'premium' }], { pattern: bikePlan })).toMatch(/Each wash needs a date and a kind/);
    }));
});

describe('paying', () => {
  it('a weekday plan skips a day that has filled up since it was chosen, and the customer still gets every wash', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const pay = await checkout(s, c, { months: 3 });
      await limitsToOne(s);
      await s.as('postgres');
      const first = (await planned(s, c, { months: 3, total: 24, respect: false }))[0].d;
      await occupy(s, first); // someone else took that day between choosing and paying
      const res = await settle(s, pay, c.u.profileId);
      expect(res.status).toBe('fulfilled');
      const rows = await bookedDates(s, res.membership_id);
      expect(rows).toHaveLength(24);
      expect(rows.map((r: any) => r.d)).not.toContain(first);
    }));

  it('and when the crowd leaves no room at all, the limit gives way: a paid membership is never refused for it', async () =>
    inTx(async (s) => {
      const c = await setup(s);
      const pay = await checkout(s, c);
      await limitsToOne(s);
      await s.as('postgres');
      for (const r of await planned(s, c, { respect: false, total: 20 })) await occupy(s, r.d);
      const res = await settle(s, pay, c.u.profileId);
      expect(res.status).toBe('fulfilled');
      expect(await bookedDates(s, res.membership_id)).toHaveLength(8);
    }));
});
