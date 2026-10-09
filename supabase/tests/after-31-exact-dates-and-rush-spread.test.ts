/**
 * GREEN tests for 20261004000031_exact_dates_any_days_and_rush_aware_spread.sql: exact dates have one rule left (one wash a day, so days one after another are
 * fine), and the automatic spread of a monthly plan keeps to the customer's days and the even spread but moves a wash off a busy day to a quieter one of its own part
 * of the month.
 */
import { describe, expect, it } from 'vitest';
import { createAddress, createCustomer, createVehicle, inTx, istDate, serviceId, uid } from './helpers';

async function customer(s: any, vtype: 'bike' | 'car' | 'suv' = 'car') {
  const u = await createCustomer(s);
  const addr = await createAddress(s, u.profileId);
  const veh = await createVehicle(s, u.profileId, vtype);
  return { u, addr, veh };
}
const asCustomer = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);
const days = (d: number[]) => `ARRAY[${d.join(',')}]::integer[]`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

async function preview(s: any, c: { veh: string; u: { authId: string } }, o: { body: number; deep?: number; weekdays?: number[]; months?: number; startDays?: number }) {
  const start = await istDate(s, o.startDays ?? 4);
  await asCustomer(s, c.u);
  const r = (await s.q(`select public.preview_monthly_dates($1,$2,$3,${days(o.weekdays ?? [])},$4,'morning',$5::date) r`, [c.veh, o.body, o.deep ?? 0, o.months ?? 1, start]))[0].r;
  return { start, ...r } as { start: string; end_date: string; fits: boolean; dates: { date: string; kind: string; state: string }[] };
}
/** `n` washes held on a date by other vehicles: that is how busy the day is. */
async function load(s: any, date: string, n: number) {
  await s.as('postgres');
  const u = await createCustomer(s);
  const svc = await serviceId(s, 'car-body-wash');
  for (let i = 0; i < n; i++) {
    const v = await createVehicle(s, u.profileId, 'car');
    await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status) values ($1,$2,$3,'on_demand',$4::date,'morning','confirmed')`, [u.profileId, v, svc, date]);
  }
}
/** The plain even spread, as it always was: n washes over the c candidate days, at positions (i + 0.5) * c / n. */
const plainSpread = (start: string, end: string, weekdays: number[], n: number) => {
  const cand: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (!weekdays.length || weekdays.includes(dow(d))) cand.push(d);
  return Array.from({ length: n }, (_, i) => cand[Math.floor(((i + 0.5) * cand.length) / n)]);
};

describe('the automatic spread with no rush anywhere', () => {
  it('gives exactly the dates it always gave (the even spread over the customer\'s days)', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      for (const [body, deep, wd] of [[2, 2, [1, 4]], [5, 0, []], [4, 3, [0, 2, 5]], [6, 6, [1, 2, 3, 4, 5]]] as [number, number, number[]][]) {
        const r = await preview(s, c, { body, deep, weekdays: wd });
        expect(r.fits).toBe(true);
        expect(r.dates.map((d) => d.date), `${body}+${deep} on ${wd}`).toEqual(plainSpread(r.start, r.end_date, wd, body + deep));
      }
    }));

  it('every month of a longer term is still spread inside its own window', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const r = await preview(s, c, { body: 4, deep: 1, weekdays: [2, 5], months: 3 });
      expect(r.dates).toHaveLength(15);
      expect(r.dates.map((d) => d.date)).toEqual([...r.dates.map((d) => d.date)].sort());
      expect(new Set(r.dates.map((d) => d.date)).size).toBe(15);
      expect(r.dates.every((d) => [2, 5].includes(dow(d.date)))).toBe(true);
    }));
});

describe('with a rush', () => {
  it('a wash on a busy day moves to a quieter day next to it, on a day the customer picked, and nothing else moves', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const base = await preview(s, c, { body: 4, weekdays: [] });
      const target = base.dates[1].date;
      await load(s, target, 8);
      const after = await preview(s, c, { body: 4, weekdays: [] });
      expect(after.dates[0].date).toBe(base.dates[0].date);
      expect(after.dates[2].date).toBe(base.dates[2].date);
      expect(after.dates[3].date).toBe(base.dates[3].date);
      expect(after.dates[1].date).not.toBe(target);
      expect(Math.abs((Date.parse(after.dates[1].date) - Date.parse(target)) / 86_400_000)).toBe(1);   // the quietest day nearest the one it always got
      expect(after.dates[1].date > base.dates[0].date && after.dates[1].date < base.dates[2].date).toBe(true);
      expect(after.dates.map((d) => d.state)).not.toContain('busy');
    }));

  it('only the customer\'s own weekdays are used when it moves a wash', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const wd = [1, 2, 3, 4, 5];
      const base = await preview(s, c, { body: 4, weekdays: wd });
      await load(s, base.dates[2].date, 7);
      const after = await preview(s, c, { body: 4, weekdays: wd });
      expect(after.dates[2].date).not.toBe(base.dates[2].date);
      expect(after.dates.every((d) => wd.includes(dow(d.date)))).toBe(true);
      expect(new Set(after.dates.map((d) => d.date)).size).toBe(4);
    }));

  it('where the customer\'s days leave no choice, a busy day is still used (a rush is a warning, never a refusal)', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      // one weekday: 4 or 5 of them in the month, 4 washes: when the month has exactly four, every wash has its one day
      let start = await istDate(s, 4), found: { start: string; end_date: string } | null = null;
      for (let wd = 0; wd < 7 && !found; wd++) {
        const r = await preview(s, c, { body: 4, weekdays: [wd] });
        const n = r.dates.length;
        const count = plainSpread(r.start, r.end_date, [wd], 1).length ? (() => { let k = 0; for (let d = r.start; d <= r.end_date; d = addDays(d, 1)) if (dow(d) === wd) k++; return k; })() : 0;
        if (count === 4 && n === 4) { found = { start: r.start, end_date: r.end_date }; await load(s, r.dates[0].date, 16); start = r.dates[0].date; const again = await preview(s, c, { body: 4, weekdays: [wd] }); expect(again.fits).toBe(true); expect(again.dates.map((d) => d.date)).toEqual(r.dates.map((d) => d.date)); expect(again.dates[0].state).toBe('full'); }
      }
      expect(found, 'a weekday that comes round exactly four times in the month').not.toBeNull();
      expect(start).toBeTruthy();
    }));

  it('always one wash to a part of the month: strictly increasing, distinct days, the right number, whatever the plan and the rush', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const first = await preview(s, c, { body: 4, weekdays: [] });
      // some busy days scattered through the month
      for (const i of [1, 5, 9, 12, 20, 21, 27]) if (first.dates[0].date) await load(s, addDays(first.start, i), 1 + (i % 4) * 3);
      for (const n of [4, 5, 6, 7, 9, 11, 13, 17, 23, 28]) {
        for (const wd of [[], [1, 3, 5], [0, 1, 2, 3, 4, 5, 6]]) {
          if (wd.length && Math.ceil(n / 4) > wd.length) continue;
          const r = await preview(s, c, { body: n, weekdays: wd });
          const ds = r.dates.map((d) => d.date);
          expect(ds, `${n} on ${wd}`).toHaveLength(n);
          expect(ds, `${n} on ${wd}`).toEqual([...new Set(ds)].sort());
          expect(ds.every((d) => d >= r.start && d <= r.end_date)).toBe(true);
          if (wd.length) expect(ds.every((d) => wd.includes(dow(d)))).toBe(true);
        }
      }
    }));

  it('what is paid for is laid out with the same rule: the washes are the dates the preview showed', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const every = [0, 1, 2, 3, 4, 5, 6];
      const base = await preview(s, c, { body: 3, deep: 2, weekdays: every });
      await load(s, base.dates[3].date, 9);
      const shown = await preview(s, c, { body: 3, deep: 2, weekdays: every });
      expect(shown.dates[3].date).not.toBe(base.dates[3].date);
      await asCustomer(s, c.u);
      const intent = (await s.q(`select public.start_monthly_membership_checkout($1,3,2,${days([0, 1, 2, 3, 4, 5, 6])},1,'morning',$2::date,$3,'Basement P1',null,null,null) r`, [c.veh, shown.start, c.addr]))[0].r;
      await s.as('service_role');
      const order = `order_${uid().slice(0, 8)}`;
      await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
      const paid = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intent.amount_cents]))[0].r;
      await s.as('postgres');
      const washes = await s.q(`select to_char(b.scheduled_date,'YYYY-MM-DD') d, sv.wash_kind kind from public.bookings b join public.services sv on sv.id = b.service_id where b.membership_id = $1 order by b.scheduled_date`, [paid.membership_id]);
      expect(washes.map((w: any) => [w.d, w.kind])).toEqual(shown.dates.map((d) => [d.date, d.kind]));
    }));
});

describe('picking every date by hand: one wash a day is the only rule', () => {
  async function go(s: any, c: any, body: number, deep: number, dates: unknown[]) {
    const start = await istDate(s, 4);
    await asCustomer(s, c.u);
    return s.err(`select public.create_monthly_membership_request($1,$2,$3,ARRAY[]::integer[],1,'morning',$4::date,$5,null,null,null,$6::jsonb)`, [c.veh, body, deep, start, c.addr, JSON.stringify(dates)]);
  }

  it('every wash on days one after another is accepted, and is exactly what gets booked', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 6);
      const plan = [0, 1, 2, 3, 4, 5].map((i) => ({ date: addDays(start, i), kind: i % 3 === 2 ? 'deep' : 'body' }));   // 4 Body + 2 Deep, six days in a row
      expect(await go(s, c, 4, 2, plan)).toBeNull();
      const checkoutStart = await istDate(s, 4);
      await asCustomer(s, c.u);
      const intent = (await s.q(`select public.start_monthly_membership_checkout($1,4,2,ARRAY[]::integer[],1,'morning',$2::date,$3,'Basement P1',null,null,$4::jsonb) r`, [c.veh, checkoutStart, c.addr, JSON.stringify(plan)]))[0].r;
      await s.as('service_role');
      const order = `order_${uid().slice(0, 8)}`;
      await s.q('select app_private.attach_provider_order($1,$2)', [intent.payment_id, order]);
      const paid = (await s.q(`select app_private.settle_payment($1,$2,$3,'INR','captured') r`, [order, `pay_${uid().slice(0, 8)}`, intent.amount_cents]))[0].r;
      await s.as('postgres');
      const washes = await s.q(`select to_char(b.scheduled_date,'YYYY-MM-DD') d, sv.wash_kind kind from public.bookings b join public.services sv on sv.id = b.service_id where b.membership_id = $1 order by b.scheduled_date`, [paid.membership_id]);
      expect(washes.map((w: any) => [w.d, w.kind])).toEqual(plan.map((p) => [p.date, p.kind]));
    }));

  it('a whole month of washes in one week is fine too; two on one day, wrong counts and a day outside the term are still refused', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 6);
      const eight = Array.from({ length: 8 }, (_, i) => ({ date: addDays(start, i), kind: i < 5 ? 'body' : 'deep' }));
      expect(await go(s, c, 5, 3, eight)).toBeNull();
      expect(await go(s, c, 5, 3, [...eight.slice(0, 7), { date: eight[6].date, kind: 'deep' }])).toMatch(/same day/);
      expect(await go(s, c, 5, 3, eight.slice(0, 7))).toMatch(/Choose exactly 5 Body washes and 3 Deep cleans/);
      expect(await go(s, c, 5, 3, [...eight.slice(0, 7), { date: addDays(start, 90), kind: 'deep' }])).toMatch(/Every wash must be between/);
    }));

  it('a day this vehicle already has a wash is still refused', async () =>
    inTx(async (s) => {
      const c = await customer(s);
      const start = await istDate(s, 6);
      await s.as('postgres');
      await s.q(`insert into public.bookings (customer_profile_id,vehicle_id,service_id,booking_type,scheduled_date,time_slot,status,address_id,parking_location)
                 values ($1,$2,(select id from public.services where code='car-body-wash'),'on_demand',$3::date,'morning','confirmed',$4,'P1')`, [c.u.profileId, c.veh, addDays(start, 2), c.addr]);
      const plan = [0, 1, 2, 3].map((i) => ({ date: addDays(start, i), kind: 'body' }));
      expect(await go(s, c, 4, 0, plan)).toMatch(/already has a wash on/);
    }));
});
