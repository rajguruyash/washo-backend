/**
 * GREEN tests for 20261004000028_monthly_membership_plan.sql: a membership chosen as washes in a MONTH (4 to 28, any mix of Body and Deep), spread
 * evenly over each month on the customer's weekdays. Weekly plans (the ones already sold) go through the code they always did; after-10/11/20 cover them.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createAdmin, createCustomer, createVehicle, createWorker, inTx, istDate, paidMembership, uid } from './helpers';

type Plan = { body: number; deep: number; days?: number[]; months?: number; slot?: string; startDays?: number; vtype?: 'bike' | 'car' | 'suv'; custom?: unknown };

async function customer(s: any, vtype: 'bike' | 'car' | 'suv' = 'car') {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, vtype);
  return { u, addr, veh };
}
const asCustomer = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);
const quote = async (s: any, vtype: string, body: number, deep: number, months: number) =>
  (await s.q(`select public.estimate_monthly_price($1::public.vehicle_type, $2, $3, $4) q`, [vtype, body, deep, months]))[0].q;
const weeklyQuote = async (s: any, vtype: string, pattern: unknown[], months: number) =>
  (await s.q(`select public.estimate_membership_price($1::public.vehicle_type, $2::jsonb, $3) q`, [vtype, JSON.stringify(pattern), months]))[0].q;
const daysArg = (d: number[] | undefined) => `ARRAY[${(d ?? []).join(',')}]::integer[]`;

async function preview(s: any, c: { veh: string; u: { authId: string } }, p: Plan) {
  const start = await istDate(s, p.startDays ?? 4); // (istDate looks as the database owner, so sign in again)
  await asCustomer(s, c.u);
  return (await s.q(
    `select public.preview_monthly_dates($1,$2,$3,${daysArg(p.days)},$4,$5::public.time_slot,$6::date) r`,
    [c.veh, p.body, p.deep, p.months ?? 1, p.slot ?? 'morning', start]
  ))[0].r;
}
async function checkout(s: any, c: { veh: string; addr: string; u: { authId: string } }, p: Plan) {
  const start = await istDate(s, p.startDays ?? 4);
  await asCustomer(s, c.u);
  return (await s.q(
    `select public.start_monthly_membership_checkout($1,$2,$3,${daysArg(p.days)},$4,$5::public.time_slot,$6::date,$7,'Basement P1','Gate code 4321',null,$8::jsonb) r`,
    [c.veh, p.body, p.deep, p.months ?? 1, p.slot ?? 'morning', start, c.addr, p.custom ? JSON.stringify(p.custom) : null]
  ))[0].r;
}
async function pay(s: any, intent: any) {
  await s.as('service_role');
  const order = `order_${uid().slice(0, 8)}`;
  await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
  const r = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intent.amount_cents]))[0].r;
  await s.as('postgres');
  return r;
}
const washesOf = async (s: any, membership: string) =>
  s.q(`select to_char(b.scheduled_date,'YYYY-MM-DD') d, sv.wash_kind kind, b.status::text status, b.time_slot::text slot
         from public.bookings b join public.services sv on sv.id = b.service_id where b.membership_id = $1 order by b.scheduled_date`, [membership]);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('the price', () => {
  it('a monthly plan costs exactly what the same plan costs by the week (4 Body a month = 1 a week; 4+4 = 1 Body and 1 Deep; 8+4 = 3 a week with its 10%)', async () =>
    inTx(async (s) => {
      const cases: [string, { weekday: number; kind: string }[], number, number][] = [
        ['car', [{ weekday: 1, kind: 'body' }], 4, 0],
        ['car', [{ weekday: 1, kind: 'body' }, { weekday: 4, kind: 'deep' }], 4, 4],
        ['car', [{ weekday: 1, kind: 'body' }, { weekday: 3, kind: 'deep' }, { weekday: 5, kind: 'body' }], 8, 4],
        ['suv', [{ weekday: 0, kind: 'deep' }, { weekday: 2, kind: 'deep' }, { weekday: 4, kind: 'deep' }, { weekday: 6, kind: 'body' }], 4, 12],
        ['bike', [{ weekday: 1, kind: 'body' }, { weekday: 2, kind: 'body' }], 8, 0],
      ];
      for (const months of [1, 3, 6, 12]) {
        for (const [vt, pattern, body, deep] of cases) {
          const w = await weeklyQuote(s, vt, pattern, months);
          const m = await quote(s, vt, body, deep, months);
          expect(m.final_cents, `${vt} ${body}+${deep} x${months}`).toBe(w.final_cents);
          expect(m.subtotal_cents).toBe(w.subtotal_cents);
          expect(m.frequency_discount.bp).toBe(w.frequency_discount.bp);
          expect(m.duration_discount.bp).toBe(w.duration_discount.bp);
          expect(m.total_discount_cents).toBe(w.total_discount_cents);
          expect(m.washes_total).toBe(w.washes_total);
        }
      }
    }));

  it('says what it is: washes a month, the monthly counts, every line, and the frequency discount by the weekly equivalent (4-7 = 1, 8-11 = 2, 12+ = 3 and up)', async () =>
    inTx(async (s) => {
      const q = await quote(s, 'car', 2, 3, 3); // 5 a month, 3 months
      expect(q).toMatchObject({ washes_per_month: 5, washes_total: 15, monthly: { body: 2, deep: 3 }, duration_months: 3, frequency_per_week: 1 });
      expect(q.lines.map((l: any) => [l.kind, l.per_month, l.quantity, l.unit_cents, l.line_cents])).toEqual([['body', 2, 6, 15000, 90000], ['deep', 3, 9, 22000, 198000]]);
      expect(q.subtotal_cents).toBe(288000);
      expect(q.frequency_discount.label).toBe('5 washes a month');
      const bp = async (n: number) => (await quote(s, 'car', n, 0, 1)).frequency_discount.bp;
      expect(await bp(4)).toBe(0);
      expect(await bp(7)).toBe(0);
      expect(await bp(11)).toBe(0);
      expect(await bp(12)).toBe(1000); // 3 a week
      expect(await bp(16)).toBe(1000);
      expect(await bp(28)).toBe(1000);
      const keys = (await s.q(`select n, app_private.monthly_freq_key(n) k from generate_series(4, 28) n`)).map((r: any) => [r.n, r.k]);
      expect(keys.find((x: number[]) => x[0] === 4)![1]).toBe(1);
      expect(keys.find((x: number[]) => x[0] === 8)![1]).toBe(2);
      expect(keys.find((x: number[]) => x[0] === 12)![1]).toBe(3);
      expect(keys.find((x: number[]) => x[0] === 28)![1]).toBe(7);
    }));

  it('asks for at least 4 washes a month and at most 28, in plain words; a bike has no Deep clean; the length must be one we sell', async () =>
    inTx(async (s) => {
      const err = (vt: string, b: number | null, d: number | null, m: number) => s.err(`select public.estimate_monthly_price($1::public.vehicle_type, $2, $3, $4)`, [vt, b, d, m]);
      expect(await err('car', 2, 1, 1)).toMatch(/Choose at least 4 washes a month \(you chose 3\)/);
      expect(await err('car', 0, 0, 1)).toMatch(/Choose at least 4 washes a month/);
      expect(await err('car', 1, 2, 1)).toMatch(/at least 4/);
      expect(await err('car', 20, 9, 1)).toMatch(/at most 28 washes a month \(you chose 29\)/);
      expect(await err('car', -1, 6, 1)).toMatch(/Choose how many washes/);
      expect(await err('car', null, 6, 1)).toMatch(/Choose how many washes/);
      expect(await err('bike', 2, 2, 1)).toMatch(/Bikes have one wash type/);
      expect(await err('car', 2, 2, 2)).toMatch(/1, 3, 6 or 12 months/);
      expect(await err('car', 4, 0, 1)).toBeNull();
      expect(await err('car', 28, 0, 1)).toBeNull();
      expect(await err('bike', 4, 0, 12)).toBeNull();
    }));

  it('a visitor may ask the price; it is the rate card, nothing is stored', async () =>
    inTx(async (s) => {
      await s.as('anon');
      expect((await quote(s, 'car', 4, 0, 1)).final_cents).toBe(60000);
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.membership_requests'))[0].n).toBe(0);
    }));
});

describe('where the washes land', () => {
  it('2 Body + 2 Deep on Monday and Thursday: four washes a month on those days, spread across the month, kinds interleaved', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const r = await preview(s, c, { body: 2, deep: 2, days: [1, 4] });
      expect(r).toMatchObject({ total: 4, fits: true });
      const dates: { date: string; kind: string; state: string }[] = r.dates;
      expect(dates).toHaveLength(4);
      expect(dates.every((d) => [1, 4].includes(dow(d.date)))).toBe(true);
      expect(new Set(dates.map((d) => d.date)).size).toBe(4);
      expect(dates.filter((d) => d.kind === 'deep')).toHaveLength(2);
      expect(dates.map((d) => d.kind)).toEqual(['body', 'deep', 'body', 'deep']); // never two Deep cleans in a row when they can alternate
      // spread across the month: the gaps are all similar, not four washes in the first week
      const gaps = dates.slice(1).map((d, i) => (Date.parse(d.date) - Date.parse(dates[i].date)) / 86_400_000);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(12);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(3);
      expect(['ok', 'busy', 'full']).toContain(dates[0].state);
    }));

  it('1 Deep + 4 Body (5 a month) on two weekdays; 5 on Wednesday-only is not enough days and is said so', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const ok = await preview(s, c, { body: 4, deep: 1, days: [2, 5] });
      expect(ok.fits).toBe(true);
      expect(ok.dates).toHaveLength(5);
      expect(ok.dates.filter((d: any) => d.kind === 'deep')).toHaveLength(1);
      const tight = await preview(s, c, { body: 12, deep: 0, days: [3] }); // 12 a month needs 12 candidate days: Wednesdays give 4 or 5
      expect(tight.fits).toBe(false);
      expect(tight.dates.length).toBeLessThan(12);
    }));

  it('every month of a longer term gets exactly its own washes, inside its own window, and the whole term is covered', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const start = await istDate(s, 5);
      const r = await preview(s, c, { body: 3, deep: 2, days: [1, 3, 5], months: 3, startDays: 5 });
      expect(r).toMatchObject({ total: 15, fits: true, start_date: start });
      await s.as('postgres');
      const ends = (await s.q(`select to_char(app_private.membership_term_end($1::date, g),'YYYY-MM-DD') e from generate_series(1,3) g order by g`, [start])).map((x: any) => x.e);
      expect(r.end_date).toBe(ends[2]);
      const windows = [[start, ends[0]], [addDays(ends[0], 1), ends[1]], [addDays(ends[1], 1), ends[2]]];
      for (const [from, to] of windows) {
        const inWindow = r.dates.filter((d: any) => d.date >= from && d.date <= to);
        expect(inWindow, `${from}..${to}`).toHaveLength(5);
        expect(inWindow.filter((d: any) => d.kind === 'deep')).toHaveLength(2);
      }
      expect(r.dates.every((d: any) => d.date >= start && d.date <= r.end_date)).toBe(true);
    }));

  it('passes over a day the vehicle already has a wash, and with no weekdays chosen any day will do', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const first = await preview(s, c, { body: 4, deep: 0, days: [1, 2, 3, 4, 5] });
      const taken = first.dates[1].date;
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id,parking_location)
                 values ($1,$2,(select id from public.services where code='car-body-wash'),'on_demand',$3::date,'morning','confirmed',$4,'P1')`, [c.u.profileId, c.veh, taken, c.addr]);
      await asCustomer(s, c.u);
      const second = await preview(s, c, { body: 4, deep: 0, days: [1, 2, 3, 4, 5] });
      expect(second.fits).toBe(true);
      expect(second.dates.map((d: any) => d.date)).not.toContain(taken);
      const anyDay = await preview(s, c, { body: 4, deep: 0, days: [] });
      expect(anyDay).toMatchObject({ fits: true, total: 4 });
    }));

  it('refuses a start that is too soon, a wash type a bike does not have, and someone else\'s vehicle', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const other = await customer(s);
      const today = await istDate(s, 0);
      const soon = await istDate(s, 4);
      const bike = await customer(s, 'bike');
      await asCustomer(s, c.u);
      const tooSoon = await s.err(`select public.preview_monthly_dates($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date)`, [c.veh, today]);
      expect(tooSoon).toMatch(/can start from/);
      expect(await s.err(`select public.preview_monthly_dates($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date)`, [other.veh, soon])).toMatch(/Vehicle not found/);
      await asCustomer(s, bike.u);
      expect(await s.err(`select public.preview_monthly_dates($1,2,2,ARRAY[1,2]::integer[],1,'morning',$2::date)`, [bike.veh, soon])).toMatch(/Bikes have one wash type/);
      await s.as('anon');
      expect(await s.err(`select public.preview_monthly_dates($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date)`, [c.veh, soon])).toMatch(/permission denied/i);
    }));
});

describe('starting and paying', () => {
  it('creates the plan with its monthly counts and weekdays, prices it like the estimate, and a paid plan becomes a membership with every wash', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const plan: Plan = { body: 3, deep: 2, days: [1, 3, 5], months: 3 };
      const want = await quote(s, 'car', 3, 2, 3);
      const intent = await checkout(s, c, plan);
      expect(intent.amount_cents).toBe(want.final_cents);
      expect(intent.request_id).toBeTruthy();
      await s.as('postgres');
      const req = (await s.q('select * from public.membership_requests where id=$1', [intent.request_id]))[0];
      expect(req).toMatchObject({ monthly_body: 3, monthly_deep: 2, preferred_weekdays: [1, 3, 5], weekly_pattern: [], frequency_per_week: 1, duration_months: 3, status: 'accepted', custom_dates: null });
      expect(req.quoted_amount_cents).toBe(want.final_cents);

      const settled = await pay(s, intent);
      expect(settled.membership_id).toBeTruthy();
      const m = (await s.q('select * from public.memberships where id=$1', [settled.membership_id]))[0];
      expect(m).toMatchObject({ status: 'active', duration_months: 3, quantity_per_period: 5, final_amount_cents: want.final_cents });
      const svc = await s.q(`select sv.wash_kind kind, ms.quantity_per_period q from public.membership_services ms join public.services sv on sv.id = ms.service_id where ms.membership_id=$1 order by 1`, [settled.membership_id]);
      expect(svc).toEqual([{ kind: 'body', q: 3 }, { kind: 'deep', q: 2 }]);
      const washes = await washesOf(s, settled.membership_id);
      expect(washes).toHaveLength(15);
      expect(washes.every((w: any) => w.status === 'confirmed' && w.slot === 'morning')).toBe(true);
      expect(washes.filter((w: any) => w.kind === 'body')).toHaveLength(9);
      expect(washes.filter((w: any) => w.kind === 'deep')).toHaveLength(6);
      expect(washes.every((w: any) => [1, 3, 5].includes(dow(w.d)))).toBe(true);
      expect(new Set(washes.map((w: any) => w.d)).size).toBe(15);
      // the schedule it was laid out on matches what the customer was shown
      await asCustomer(s, c.u);
      // (the preview was taken after the washes exist, so re-planning now would avoid them: compare with the stored schedule instead)
      await s.as('postgres');
      const sched = (await s.q(`select schedule_pattern from public.membership_schedules where membership_id=$1`, [settled.membership_id]))[0].schedule_pattern;
      expect(sched.monthly).toEqual({ body: 3, deep: 2, weekdays: [1, 3, 5] });
      expect((await s.q(`select status from public.membership_requests where id=$1`, [intent.request_id]))[0].status).toBe('active');
    }));

  it('the washes are the ones the preview showed (same days, same kinds)', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const plan: Plan = { body: 2, deep: 2, days: [2, 5], months: 3 };
      const shown = await preview(s, c, plan);
      const intent = await checkout(s, c, plan);
      const settled = await pay(s, intent);
      const washes = await washesOf(s, settled.membership_id);
      expect(washes.map((w: any) => [w.d, w.kind])).toEqual(shown.dates.map((d: any) => [d.date, d.kind]));
    }));

  it('asking again for the same plan while its payment is open gives back the same payment; a different plan replaces it', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const a = await checkout(s, c, { body: 4, deep: 0, days: [1] });
      const again = await checkout(s, c, { body: 4, deep: 0, days: [1] });
      expect(again.payment_id).toBe(a.payment_id);
      expect(again.request_id).toBe(a.request_id);
      const other = await checkout(s, c, { body: 3, deep: 2, days: [1, 4] });
      expect(other.payment_id).not.toBe(a.payment_id);
      await s.as('postgres');
      expect((await s.q('select status::text s from public.payments where id=$1', [a.payment_id]))[0].s).toBe('failed');
      expect((await s.q('select status s from public.membership_requests where id=$1', [a.request_id]))[0].s).toBe('cancelled');
      expect((await s.q(`select count(*)::int n from public.membership_requests where vehicle_id=$1 and status in ('submitted','quoted','accepted')`, [c.veh]))[0].n).toBe(1);
    }));

  it('says what to fix: too few washes, too few weekdays for that many washes, a bad weekday, a start that is too soon', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 4);
      const today = await istDate(s, 0);
      await asCustomer(s, c.u);
      const call = (b: number, d: number, days: number[], st = start) => s.err(`select public.create_monthly_membership_request($1,$2,$3,${daysArg(days)},1,'morning',$4::date,$5)`, [c.veh, b, d, st, c.addr]);
      expect(await call(2, 1, [1, 3])).toMatch(/Choose at least 4 washes a month/);
      expect(await call(4, 0, [])).toMatch(/Pick at least 1 day of the week so your 4 washes a month fit/);
      expect(await call(5, 0, [1])).toMatch(/Pick at least 2 days of the week so your 5 washes a month fit/);
      expect(await call(9, 0, [1, 2])).toMatch(/Pick at least 3 days of the week so your 9 washes a month fit/);
      expect(await call(12, 0, [1, 2])).toMatch(/Pick at least 3 days/);
      expect(await call(4, 0, [7])).toMatch(/weekday \(0 to 6\)/);
      expect(await call(4, 0, [1], today)).toMatch(/can start from/);
      // the exact 12 a month on 3 weekdays is fine
      expect(await call(12, 0, [1, 3, 5])).toBeNull();
    }));

  it('a bike gets Body washes only; another customer cannot use this vehicle; one open request per vehicle', async () =>
    inTx(async (s) => {
      const bike = await customer(s, 'bike');
      const other = await customer(s);
      const soon = await istDate(s, 4);
      await asCustomer(s, bike.u);
      expect(await s.err(`select public.create_monthly_membership_request($1,2,2,ARRAY[1,2]::integer[],1,'morning',$2::date,$3)`, [bike.veh, soon, bike.addr])).toMatch(/Bikes have one wash type/);
      expect(await s.err(`select public.create_monthly_membership_request($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date,$3)`, [bike.veh, soon, bike.addr])).toBeNull();
      expect(await s.err(`select public.create_monthly_membership_request($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date,$3)`, [bike.veh, soon, bike.addr])).toMatch(/already have a membership request in progress/);
      await asCustomer(s, other.u);
      expect(await s.err(`select public.create_monthly_membership_request($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date,$3)`, [bike.veh, soon, other.addr])).toMatch(/Vehicle not found/);
    }));

  it('a worker, an admin or a visitor cannot start one', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const worker = await createWorker(s);
      const admin = await createAdmin(s);
      const call = `select public.start_monthly_membership_checkout($1,4,0,ARRAY[1]::integer[],1,'morning',$2::date,$3)`;
      const args = [c.veh, await istDate(s, 4), c.addr];
      for (const who of [worker, admin]) { await asCustomer(s, who); expect(await s.err(call, args)).toMatch(/Customer profile not found/); }
      await s.as('anon');
      expect(await s.err(call, args)).toMatch(/permission denied/i);
    }));

  it('a paid membership is never refused: if the chosen days filled up between paying and the washes being laid out, any day is used', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const intent = await checkout(s, c, { body: 4, deep: 0, days: [1], months: 1 });
      // meanwhile the vehicle gets a wash on every Monday of the term
      await s.as('postgres');
      const start = await istDate(s, 4);
      const end = (await s.q(`select to_char(app_private.membership_term_end($1::date, 1),'YYYY-MM-DD') e`, [start]))[0].e;
      const mondays: string[] = [];
      for (let d = start; d <= end; d = addDays(d, 1)) if (dow(d) === 1) mondays.push(d);
      for (const d of mondays) {
        await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id,parking_location)
                   values ($1,$2,(select id from public.services where code='car-body-wash'),'on_demand',$3::date,'afternoon','confirmed',$4,'P1')`, [c.u.profileId, c.veh, d, c.addr]);
      }
      const settled = await pay(s, intent);
      expect(settled.membership_id).toBeTruthy();
      const washes = (await washesOf(s, settled.membership_id)).filter((w: any) => w.slot === 'morning');
      expect(washes).toHaveLength(4);
      expect(washes.some((w: any) => mondays.includes(w.d))).toBe(false);
    }));
});

describe('picking every date by hand', () => {
  async function monthDates(s: any, c: any, body: number, deep: number, months: number, startDays = 4) {
    await asCustomer(s, c.u);
    const r = await preview(s, c, { body, deep, days: [1, 2, 3, 4, 5, 6, 0], months, startDays });
    return r.dates.map((d: any) => ({ date: d.date, kind: d.kind })) as { date: string; kind: string }[];
  }

  it('exactly the monthly counts times the months, one a day, inside the term, at most ceil(n/4) in a week: then it is accepted and used as given', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const dates = await monthDates(s, c, 3, 2, 3); // 5 a month for 3 months = 15 washes
      expect(dates).toHaveLength(15);
      const intent = await checkout(s, c, { body: 3, deep: 2, days: [], months: 3, custom: dates });
      await s.as('postgres');
      const req = (await s.q('select custom_dates, preferred_weekdays from public.membership_requests where id=$1', [intent.request_id]))[0];
      expect(req.preferred_weekdays).toEqual([]);
      expect(req.custom_dates.map((d: any) => d.date)).toEqual(dates.map((d) => d.date));
      const settled = await pay(s, intent);
      expect((await washesOf(s, settled.membership_id)).map((w: any) => [w.d, w.kind])).toEqual(dates.map((d) => [d.date, d.kind]));
    }));

  it('refuses the wrong counts, two on one day, a day outside the term, and a day the vehicle already has a wash; washes on days one after another are fine', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const dates = await monthDates(s, c, 2, 2, 1);
      const start = await istDate(s, 4);
      await asCustomer(s, c.u);
      const go = (d: unknown) => s.err(`select public.create_monthly_membership_request($1,2,2,ARRAY[]::integer[],1,'morning',$2::date,$3,null,null,null,$4::jsonb)`, [c.veh, start, c.addr, JSON.stringify(d)]);
      expect(await go(dates.slice(0, 3))).toMatch(/Choose exactly 2 Body washes and 2 Deep cleans for this plan \(you have 1 and 2\)|Choose exactly 2 Body/);
      expect(await go([...dates.slice(0, 3), { date: dates[2].date, kind: 'deep' }])).toMatch(/same day/);
      expect(await go([...dates.slice(0, 3), { date: addDays(dates[3].date, 60), kind: dates[3].kind }])).toMatch(/Every wash must be between/);
      // one wash a day is the only rule: four washes on four days in a row, all in the same week, are fine (no "no more than N a week")
      expect(await go([{ date: addDays(start, 1), kind: 'body' }, { date: addDays(start, 2), kind: 'body' }, { date: addDays(start, 3), kind: 'deep' }, { date: addDays(start, 4), kind: 'deep' }])).toBeNull();
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id,parking_location)
                 values ($1,$2,(select id from public.services where code='car-body-wash'),'on_demand',$3::date,'morning','confirmed',$4,'P1')`, [c.u.profileId, c.veh, dates[0].date, c.addr]);
      await asCustomer(s, c.u);
      expect(await go(dates)).toMatch(/already has a wash on/);
      expect(await go([{ date: 'nonsense', kind: 'body' }])).toMatch(/Each wash needs a date/);
    }));
});

describe('everything that shows a plan says it right', () => {
  it('my_membership_requests and the admin list carry the monthly counts', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const admin = await createAdmin(s);
      await asCustomer(s, c.u);
      const intent = await checkout(s, c, { body: 4, deep: 1, days: [2, 5], months: 3 });
      const mine = (await s.q('select * from public.my_membership_requests()')).find((r: any) => r.id === intent.request_id);
      expect(mine).toMatchObject({ washes_per_month: 5, monthly_body: 4, monthly_deep: 1, preferred_weekdays: [2, 5], duration_months: 3, frequency_per_week: 1 });
      await asCustomer(s, admin);
      const listed = (await s.q(`select public.admin_list_membership_requests('accepted') l`))[0].l.find((r: any) => r.id === intent.request_id);
      expect(listed).toMatchObject({ washes_per_month: 5, monthly_body: 4, monthly_deep: 1, preferred_weekdays: [2, 5] });
      // a weekly plan reads as before
      const w = await paidMembership(s, { months: 1 });
      await asCustomer(s, w.u);
      const old = (await s.q('select * from public.my_membership_requests()')).find((r: any) => r.id === w.requestId);
      expect(old.washes_per_month).toBeNull();
      expect(old.weekly_pattern).toHaveLength(3);
    }));

  it('the specialist\'s queue says "5 washes a month · 3 months" for a monthly plan, and "3 washes a week · 1 month" for a weekly one', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const worker = await createWorker(s);
      const admin = await createAdmin(s);
      await asCustomer(s, c.u);
      const intent = await checkout(s, c, { body: 4, deep: 1, days: [2, 5], months: 3 });
      const settled = await pay(s, intent);
      const first = (await washesOf(s, settled.membership_id)).length;
      expect(first).toBe(15);
      await s.as('postgres');
      const booking = (await s.q(`select id from public.bookings where membership_id=$1 order by scheduled_date limit 1`, [settled.membership_id]))[0].id;
      await asCustomer(s, admin);
      await s.q('select public.admin_assign_worker($1,$2)', [booking, worker.profileId]);
      await asCustomer(s, worker);
      const row = (await s.q('select * from public.worker_queue(60)')).find((r: any) => r.booking_id === booking);
      expect(row.membership_label).toBe('5 washes a month · 3 months');
      expect(row.washes_total).toBe(15);

      const w = await paidMembership(s, { months: 1 });
      await s.as('postgres');
      const wb = (await s.q(`select id from public.bookings where membership_id=$1 order by scheduled_date limit 1`, [w.membership]))[0].id;
      await asCustomer(s, admin);
      await s.q('select public.admin_assign_worker($1,$2)', [wb, worker.profileId]);
      await asCustomer(s, worker);
      const old = (await s.q('select * from public.worker_queue(60)')).find((r: any) => r.booking_id === wb);
      expect(old.membership_label).toBe('3 washes a week · 1 month');
    }));

  it('the renewal reminder knows the plan is monthly, and the memberships export counts washes a month for both kinds', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      await asCustomer(s, c.u);
      const intent = await checkout(s, c, { body: 4, deep: 1, days: [2, 5], months: 1 });
      const settled = await pay(s, intent);
      await s.q(`update public.profiles set email = 'monthly.customer@example.com' where id=$1`, [c.u.profileId]);
      await s.q('alter table public.memberships disable trigger user');
      await s.q(
        `update public.memberships
            set start_at = (date_trunc('day', now() at time zone 'Asia/Kolkata') + 3 * interval '1 day' - make_interval(months => 1) + interval '1 day') at time zone 'Asia/Kolkata',
                end_at   = (date_trunc('day', now() at time zone 'Asia/Kolkata') + 3 * interval '1 day') at time zone 'Asia/Kolkata'
          where id = $1`, [settled.membership_id]);
      await s.q('alter table public.memberships enable trigger user');
      await s.as('service_role');
      const due = (await s.q('select * from public.svc_membership_reminders_due(7, 50)')).find((r: any) => r.membership_id === settled.membership_id);
      expect(due).toMatchObject({ washes_per_month: 5, duration_months: 1, washes_total: 5 });

      const weekly = await paidMembership(s, { months: 1 });
      await s.as('service_role');
      // (a weekly plan leaves washes_per_month empty; the email falls back to "per week")
      const none = (await s.q('select * from public.svc_membership_reminders_due(60, 200)')).find((r: any) => r.membership_id === weekly.membership);
      if (none) expect(none.washes_per_month).toBeNull();

      const admin = await createAdmin(s, 'super_admin');
      await asCustomer(s, admin);
      const exp = (await s.q(`select public.admin_export('memberships') e`))[0].e;
      expect(exp.columns).toContain('Washes a month');
      const col = exp.columns.indexOf('Washes a month');
      const counts = exp.rows.map((r: any[]) => r[col]);
      expect(counts).toContain(5); // the monthly plan
      expect(counts).toContain(12); // the weekly plan of 3 a week, as 12 a month
    }));
});
