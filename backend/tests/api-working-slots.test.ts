/**
 * Working time windows (migration 49), over HTTP: the admin turns Morning, Afternoon or Night off by weekday or for a date, separately for single washes and for memberships; the booking
 * pages are told the closed windows (/capacity, /working-days); a single wash and a membership are refused in a window that is off, with the windows that are left.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);
afterEach(async () => {
  await fake.admin.query('update public.working_weekdays set is_open = true');
  await fake.admin.query('update public.working_slot_weekdays set is_open = true');
  await fake.admin.query('delete from public.working_dates');
  await fake.admin.query('delete from public.working_slot_dates');
});

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const next = (d: number, from = 9) => { let t = istDate(from); while (dow(t) !== d) t = addDays(t, 1); return t; };
const svc = async () => (await fake.admin.query(`select id from public.services where code = 'car-body-wash'`)).rows[0].id as string;
const singleWash = async (cust: Awaited<ReturnType<typeof customerWithVehicle>>, date: string, slot: string) =>
  cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: await svc(), scheduled_date: date, time_slot: slot, address_id: cust.addr.id });
const nightOffOnSundays = (admin: Awaited<ReturnType<typeof staffClient>>, kind?: string) =>
  admin.c.put('/api/admin/working-days/slots/weekdays', { slot: 'night', open_days: [1, 2, 3, 4, 5, 6], ...(kind ? { kind } : {}) });

describe('the admin page', () => {
  it('lists each window by weekday for each kind, and a change for one kind leaves the other alone', async () => {
    const admin = await staffClient('admin');
    let r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.slots_installed).toBe(true);
    expect(r.single.slot_weekdays).toHaveLength(21);
    expect(r.single.slot_weekdays.every((w: any) => w.open)).toBe(true);
    expectOk(await nightOffOnSundays(admin, 'single'));
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    const sundayNight = (part: any) => part.slot_weekdays.find((w: any) => w.slot === 'night' && w.weekday === 0).open;
    expect(sundayNight(r.single)).toBe(false);
    expect(sundayNight(r.membership)).toBe(true);
    expectOk(await nightOffOnSundays(admin));   // no kind: both
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(sundayNight(r.membership)).toBe(false);
  });

  it('sets a window for a date, lists it with the reason, and takes it away again', async () => {
    const admin = await staffClient('admin');
    const d = istDate(12);
    expect(expectOk(await admin.c.post('/api/admin/working-days/slots/dates', { slot: 'morning', from: d, open: false, reason: 'Diwali puja', kind: 'single' })).body.days).toBe(1);
    let r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    // `washes` counts the washes booked in that window, and other test files share this database: only its type is checked
    expect(r.single.slot_dates).toMatchObject([{ day: d, slot: 'morning', open: false, reason: 'Diwali puja' }]);
    expect(typeof r.single.slot_dates[0].washes).toBe('number');
    expect(r.membership.slot_dates).toEqual([]);
    expectOk(await admin.c.req('DELETE', `/api/admin/working-days/slots/dates/${d}?slot=morning&kind=single`));
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.single.slot_dates).toEqual([]);
    const again = await admin.c.req('DELETE', `/api/admin/working-days/slots/dates/${d}?slot=morning&kind=single`);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.body.message).toMatch(/no setting for this time window to remove/);
  });

  it('refuses an unknown window or kind, and anyone who is not an admin', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    expect((await admin.c.put('/api/admin/working-days/slots/weekdays', { slot: 'lunch', open_days: [1] })).status).toBe(400);
    expect((await admin.c.put('/api/admin/working-days/slots/weekdays', { slot: 'night', open_days: [1], kind: 'bogus' })).status).toBe(400);
    expect((await admin.c.post('/api/admin/working-days/slots/dates', { slot: 'night', from: 'tomorrow', open: false })).status).toBe(400);
    expect((await admin.c.post('/api/admin/working-days/slots/dates', { slot: 'night', from: istDate(-3), open: false })).status).toBeGreaterThanOrEqual(400);
    for (const who of [cust.c]) {
      expect((await who.put('/api/admin/working-days/slots/weekdays', { slot: 'night', open_days: [1] })).status).toBeGreaterThanOrEqual(401);
      expect((await who.post('/api/admin/working-days/slots/dates', { slot: 'night', from: istDate(5), open: false })).status).toBeGreaterThanOrEqual(401);
    }
  });
});

describe('what the booking pages are told', () => {
  it('/capacity and /working-days list the closed windows for the kind asked', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const sun = next(0, 6);
    expectOk(await nightOffOnSundays(admin, 'single'));
    expectOk(await admin.c.post('/api/admin/working-days/slots/dates', { slot: 'morning', from: sun, open: false, reason: 'Society event', kind: 'single' }));
    const from = istDate(0), to = istDate(20);
    const cap = async (kind?: string) => expectOk(await cust.c.get(`/api/capacity?from=${from}&to=${to}${kind ? `&kind=${kind}` : ''}`)).body.days as { date: string; closed?: boolean; closed_slots?: { slot: string; reason: string | null }[] }[];
    const single = await cap('single');
    const onSun = single.find((d) => d.date === sun)!;
    expect(onSun.closed).toBeUndefined();
    expect(onSun.closed_slots).toEqual([{ slot: 'morning', reason: 'Society event' }, { slot: 'night', reason: null }]);
    expect(single.filter((d) => dow(d.date) === 0 && d.date !== sun).every((d) => d.closed_slots?.length === 1 && d.closed_slots[0].slot === 'night')).toBe(true);
    expect(single.filter((d) => dow(d.date) !== 0).every((d) => !d.closed_slots)).toBe(true);
    expect((await cap('membership')).every((d) => !d.closed_slots)).toBe(true);
    expect((await cap()).find((d) => d.date === sun)?.closed_slots).toHaveLength(2);   // an older page: closed for either kind
    const w = expectOk(await cust.c.get(`/api/working-days?kind=single&from=${from}&to=${to}`)).body;
    expect(w.closed).toEqual([]);
    expect(w.closed_slots.find((c: any) => c.date === sun && c.slot === 'morning').reason).toBe('Society event');
    expect(expectOk(await cust.c.get(`/api/working-days?kind=membership&from=${from}&to=${to}`)).body.closed_slots).toEqual([]);
  });
});

describe('booking follows the windows', () => {
  it('a single wash is refused in a window that is off, with the windows that are left, and is fine in the others', async () => {
    const admin = await staffClient('admin');
    const sun = next(0, 9);
    expectOk(await nightOffOnSundays(admin, 'single'));
    const refused = await singleWash(await customerWithVehicle('car'), sun, 'night');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toMatch(/^WASHO is currently unavailable in the Night window on Sun, \d{1,2} [A-Z][a-z]{2}\. You can book the Morning or Afternoon window that day\.$/);
    expectOk(await singleWash(await customerWithVehicle('car'), sun, 'morning'));
    expectOk(await singleWash(await customerWithVehicle('car'), addDays(sun, 1), 'night'));
  });

  it('a membership cannot choose a window that is off on the weekdays it picked, and can on other days', async () => {
    const admin = await staffClient('admin');
    expectOk(await admin.c.put('/api/admin/working-days/slots/weekdays', { slot: 'morning', open_days: [1, 2, 3, 4, 5, 6], kind: 'membership' }));
    const cust = await customerWithVehicle('car');
    const base = { vehicle_id: cust.vehicle.id, address_id: cust.addr.id, duration_months: 1, time_slot: 'morning', start_date: istDate(4) };
    const refused = await cust.c.post('/api/payments/membership-checkout', { ...base, monthly: { body: 4, deep: 0, weekdays: [0] } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toBe('WASHO is currently unavailable in the Morning window on Sundays. Choose the Afternoon or Night window, or other days.');
    const ok = await cust.c.post('/api/payments/membership-checkout', { ...base, monthly: { body: 4, deep: 0, weekdays: [6] } });
    expectOk(ok);
  });
});
