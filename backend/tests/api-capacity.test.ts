/** Crowd limits and exact dates over the website API: what the pages are shown (amber, red), what the admin can change, and that a rush never stops a booking. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const LIFTED = { day_busy: 400, day_full: 500, slot_busy: 400, slot_full: 500 };
const TIGHT = { day_busy: 1, day_full: 2, slot_busy: 1, slot_full: 1 };
const setLimits = async (admin: Awaited<ReturnType<typeof staffClient>>, weekday: typeof LIFTED, weekend: typeof LIFTED = weekday) =>
  expectOk(await admin.c.put('/api/admin/capacity', { weekday, weekend }));
beforeEach(async () => { await setLimits(await staffClient('admin'), LIFTED); });

/** A confirmed wash for somebody else on a date and window, so it holds a place. */
async function occupy(date: string, slot: 'morning' | 'afternoon' | 'night' = 'morning') {
  const o = await customerWithVehicle('car');
  await fake.admin.query(
    `insert into public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status)
     select v.customer_profile_id, v.id, (select id from public.services where code = 'car-body-wash'), 'on_demand', $2::date, $3, 'confirmed' from public.vehicles v where v.id = $1`,
    [o.vehicle.id, date, slot]
  );
}
const PLAN = [{ weekday: 3, kind: 'body' }, { weekday: 6, kind: 'deep' }];
const planBody = (c: Awaited<ReturnType<typeof customerWithVehicle>>, o: Record<string, unknown> = {}) => ({
  vehicle_id: c.vehicle.id, weekly_pattern: PLAN, duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: c.addr.id, ...o,
});

describe('what the booking pages are shown', () => {
  it('needs a signed-in person, a sensible range, and reports each day and window', async () => {
    expect((await new Client().get(`/api/capacity?from=${istDate(1)}&to=${istDate(3)}`)).status).toBe(401);
    const c = await customerWithVehicle('car');
    expect((await c.c.get('/api/capacity')).status).toBe(400);
    expect((await c.c.get(`/api/capacity?from=${istDate(3)}&to=${istDate(1)}`)).status).toBe(422);
    const day = istDate(380); // far enough ahead that no other test's membership has washes there
    const r = expectOk(await c.c.get(`/api/capacity?from=${day}&to=${istDate(382)}`)).body.days;
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ date: day, state: 'ok', total: 0, slots: { morning: { state: 'ok' }, afternoon: { state: 'ok' }, night: { state: 'ok' } } });
  });

  it('turns a window full and then the day, as washes are booked', async () => {
    const admin = await staffClient('admin');
    await setLimits(admin, TIGHT);
    const day = istDate(383);
    const c = await customerWithVehicle('car');
    await occupy(day, 'morning');
    let d = expectOk(await c.c.get(`/api/capacity?from=${day}&to=${day}`)).body.days[0];
    expect(d).toMatchObject({ state: 'busy', total: 1, slots: { morning: { state: 'full' }, afternoon: { state: 'busy' } } });
    await occupy(day, 'night');
    d = expectOk(await c.c.get(`/api/capacity?from=${day}&to=${day}`)).body.days[0];
    expect(d).toMatchObject({ total: 2, state: 'full', slots: { morning: { state: 'full' }, afternoon: { state: 'full' }, night: { state: 'full' } } });
  });
});

describe('the admin changes the limits', () => {
  it('only an admin; a customer sees the new limit at once', async () => {
    const admin = await staffClient('admin');
    const c = await customerWithVehicle('car');
    expect((await c.c.get('/api/admin/capacity?from=2026-01-01&to=2026-01-02')).status).toBe(403);
    expect((await c.c.put('/api/admin/capacity', { weekday: TIGHT, weekend: TIGHT })).status).toBe(403);
    expect((await new Client().put('/api/admin/capacity', { weekday: TIGHT, weekend: TIGHT })).status).toBe(401);
    const day = istDate(384);
    const before = expectOk(await admin.c.get(`/api/admin/capacity?from=${day}&to=${day}`)).body;
    expect(before.rules.map((r: any) => r.day_kind).sort()).toEqual(['weekday', 'weekend']);
    await setLimits(admin, { day_busy: 7, day_full: 9, slot_busy: 3, slot_full: 4 }, { day_busy: 11, day_full: 13, slot_busy: 5, slot_full: 6 });
    const after = expectOk(await admin.c.get(`/api/admin/capacity?from=${day}&to=${day}`)).body;
    expect(after.rules).toEqual([
      { day_kind: 'weekday', day_busy: 7, day_full: 9, slot_busy: 3, slot_full: 4 },
      { day_kind: 'weekend', day_busy: 11, day_full: 13, slot_busy: 5, slot_full: 6 },
    ]);
    const seen = expectOk(await c.c.get(`/api/capacity?from=${day}&to=${day}`)).body.days[0];
    expect(seen.limit).toBe(seen.kind === 'weekend' ? 13 : 9);
  });

  it('refuses numbers that do not make sense, in plain words', async () => {
    const admin = await staffClient('admin');
    const bad = await admin.c.put('/api/admin/capacity', { weekday: { ...LIFTED, day_busy: 20, day_full: 10 }, weekend: LIFTED });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/red number for a day cannot be lower than its amber number/);
    expect((await admin.c.put('/api/admin/capacity', { weekday: { ...LIFTED, day_busy: 0 }, weekend: LIFTED })).status).toBe(400);
    expect((await admin.c.put('/api/admin/capacity', { weekday: LIFTED })).status).toBe(400);
  });
});

describe('a rush never stops a booking, and exact dates follow the rules', () => {
  it('a single wash can still be started for a window that is red', async () => {
    const admin = await staffClient('admin');
    await setLimits(admin, TIGHT);
    const day = istDate(23);
    await occupy(day, 'afternoon');
    const c = await customerWithVehicle('car');
    const service = (await fake.admin.query(`select id from public.services where code='car-body-wash'`)).rows[0].id;
    // the page is told it is red ...
    expect(expectOk(await c.c.get(`/api/capacity?from=${day}&to=${day}`)).body.days[0].slots.afternoon.state).toBe('full');
    // ... and payment still opens
    const r = expectOk(await c.c.post('/api/payments/on-demand', { vehicle_id: c.vehicle.id, service_id: service, scheduled_date: day, time_slot: 'afternoon', address_id: c.addr.id }));
    expect(r.body.order.order_id).toBeTruthy();
  });

  it('the preview shows where a plan lands; it needs the customer\'s own vehicle', async () => {
    const c = await customerWithVehicle('car');
    const other = await customerWithVehicle('car');
    const p = expectOk(await c.c.post('/api/membership-preview', planBody(c))).body;
    expect(p).toMatchObject({ total: 8, fits: true, start_date: istDate(4) });
    expect(p.dates).toHaveLength(8);
    expect(p.dates[0]).toMatchObject({ state: 'ok' });
    expect((await c.c.post('/api/membership-preview', planBody(c, { vehicle_id: other.vehicle.id }))).status).toBe(404);
    expect((await c.c.post('/api/membership-preview', planBody(c, { start_date: istDate(0) }))).body.message).toMatch(/can start from/);
    expect((await new Client().post('/api/membership-preview', planBody(c))).status).toBe(401);
  });

  it('exact dates: a valid set is paid for and the washes land exactly there; a broken rule is explained and nothing is charged', async () => {
    const c = await customerWithVehicle('car');
    const preview = expectOk(await c.c.post('/api/membership-preview', planBody(c))).body;
    const dates = preview.dates.map((d: any) => ({ date: d.date, kind: d.kind }));
    // today and tomorrow are never allowed
    const tooSoon = await c.c.post('/api/payments/membership-checkout', planBody(c, { custom_dates: [{ date: istDate(1), kind: dates[0].kind }, ...dates.slice(1)] }));
    expect(tooSoon.status).toBe(422);
    expect(tooSoon.body.message).toMatch(/not today or tomorrow/);
    expect((await c.c.post('/api/payments/membership-checkout', planBody(c, { custom_dates: dates.slice(1) }))).body.message).toMatch(/Choose exactly 4 Body washes and 4 Deep cleans/);
    expect((await c.c.post('/api/payments/membership-checkout', planBody(c, { custom_dates: [{ date: 'soon', kind: 'body' }] }))).status).toBe(400);

    // move the first wash one day later and pay
    const moved = dates.map((d: any, i: number) => (i === 0 ? { ...d, date: new Date(Date.parse(`${d.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) } : d));
    const order = expectOk(await c.c.post('/api/payments/membership-checkout', planBody(c, { custom_dates: moved }))).body.order;
    const paid = expectOk(await c.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    const rows = (await fake.admin.query(`select scheduled_date::text d from public.bookings where membership_id = $1 order by 1`, [paid.membership_id])).rows.map((r: any) => r.d);
    expect(rows).toEqual(moved.map((m: any) => m.date).sort());
  });

  it('a weekday plan on days that are all red is still priced and paid for, on the days chosen', async () => {
    const admin = await staffClient('admin');
    await setLimits(admin, { ...TIGHT, day_full: 1 }, { ...TIGHT, day_full: 1 });
    const c = await customerWithVehicle('car');
    const all = expectOk(await c.c.post('/api/membership-preview', planBody(c))).body.dates as { date: string }[];
    for (const d of all) await occupy(d.date); // every Wednesday and Saturday of the first stretch is past the red number
    for (let i = 1; i <= 34; i++) { const day = istDate(4 + i); if ([3, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) await occupy(day).catch(() => undefined); }
    const p = expectOk(await c.c.post('/api/membership-preview', planBody(c))).body;
    expect(p.fits).toBe(true);
    expect(p.dates.every((d: any) => d.state === 'full')).toBe(true); // the page can colour them red
    const order = expectOk(await c.c.post('/api/payments/membership-checkout', planBody(c))).body.order;
    const paid = expectOk(await c.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result;
    const rows = (await fake.admin.query(`select scheduled_date::text d from public.bookings where membership_id = $1 order by 1`, [paid.membership_id])).rows.map((r: any) => r.d);
    expect(rows).toEqual(all.map((d) => d.date).sort());
  });
});
