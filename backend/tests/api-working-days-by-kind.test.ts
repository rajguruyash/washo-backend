/**
 * Working Days kept separately for single washes and for memberships (migration 46), over HTTP: the admin sets each kind on its own, the booking pages ask for their kind, a single
 * wash follows the single-wash days and a membership follows the membership days, and the calls that do not name a kind still change both.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);
afterEach(async () => {
  await fake.admin.query('update public.working_weekdays set is_open = true');
  await fake.admin.query('delete from public.working_dates');
});

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const next = (d: number, from = 9) => { let t = istDate(from); while (dow(t) !== d) t = addDays(t, 1); return t; };
const svc = async () => (await fake.admin.query(`select id from public.services where code = 'car-body-wash'`)).rows[0].id as string;
const singleWash = async (cust: Awaited<ReturnType<typeof customerWithVehicle>>, date: string) =>
  cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: await svc(), scheduled_date: date, time_slot: 'morning', address_id: cust.addr.id });
const weekends = (admin: { c: Client }, kind?: 'single' | 'membership' | 'both') => admin.c.put('/api/admin/working-days/weekdays', { open_days: [6, 0], ...(kind ? { kind } : {}) });
const open = (w: { weekdays: { weekday: number; open: boolean }[] }) => w.weekdays.filter((x) => x.open).map((x) => x.weekday);

describe('the admin page keeps two lists', () => {
  it('weekends only for memberships leaves single washes open every day, and the page shows each kind', async () => {
    const admin = await staffClient('admin');
    expectOk(await weekends(admin, 'membership'));
    const r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.by_kind).toBe(true);
    expect(open(r.single)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(open(r.membership)).toEqual([0, 6]);
    expect(r.weekdays).toEqual(r.single.weekdays);   // the old top-level fields are the single-wash ones
    expect([0, 6]).toContain(dow(r.membership.next_open));
    expect(r.single.next_open).toBe(istDate(0));
  });

  it('a call without a kind (an older page) still changes both; a call for "both" does too', async () => {
    const admin = await staffClient('admin');
    expectOk(await weekends(admin));
    let r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(open(r.single)).toEqual([0, 6]);
    expect(open(r.membership)).toEqual([0, 6]);
    expectOk(await admin.c.put('/api/admin/working-days/weekdays', { open_days: [0, 1, 2, 3, 4, 5, 6], kind: 'both' }));
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(open(r.single).length + open(r.membership).length).toBe(14);
  });

  it('dates are set and cleared for one kind, or for both', async () => {
    const admin = await staffClient('admin');
    const d = istDate(12), e = istDate(14);
    expect(expectOk(await admin.c.post('/api/admin/working-days/dates', { from: d, open: false, reason: 'Diwali', kind: 'single' })).body.days).toBe(1);
    expect(expectOk(await admin.c.post('/api/admin/working-days/dates', { from: e, open: false, reason: 'Event' })).body.days).toBe(1);   // both
    let r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.single.dates.map((x: any) => x.day)).toEqual([d, e]);
    expect(r.membership.dates.map((x: any) => x.day)).toEqual([e]);
    expectOk(await admin.c.req('DELETE', `/api/admin/working-days/dates/${e}?kind=membership`));
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.single.dates.map((x: any) => x.day)).toEqual([d, e]);
    expect(r.membership.dates).toEqual([]);
    expectOk(await admin.c.req('DELETE', `/api/admin/working-days/dates/${e}`));   // both: removes the single-wash one that is left
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.single.dates.map((x: any) => x.day)).toEqual([d]);
  });

  it('an unknown kind is refused, and only an admin with the right role may change a kind', async () => {
    const admin = await staffClient('admin');
    expect((await admin.c.put('/api/admin/working-days/weekdays', { open_days: [6, 0], kind: 'bogus' })).status).toBe(400);
    const cust = await customerWithVehicle('car');
    const support = await staffClient('admin', { access: 'support' });
    for (const who of [cust.c, support.c, new Client()]) {
      expect((await who.put('/api/admin/working-days/weekdays', { open_days: [6, 0], kind: 'membership' })).status).toBeGreaterThanOrEqual(401);
    }
    expect((await fake.admin.query('select count(*)::int n from public.working_weekdays where not is_open')).rows[0].n).toBe(0);
  });
});

describe('what each booking page is told', () => {
  it('/working-days and /capacity answer for the kind asked, and for both when no kind is given', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    expectOk(await weekends(admin, 'membership'));
    const w = (q = '') => expectOk(cust.c.get(`/api/working-days${q}`) as never);
    void w;
    const single = expectOk(await cust.c.get('/api/working-days?kind=single')).body;
    const member = expectOk(await cust.c.get('/api/working-days?kind=membership')).body;
    const both = expectOk(await cust.c.get('/api/working-days')).body;
    expect(single.closed).toEqual([]);
    expect(open(member)).toEqual([0, 6]);
    expect(member.closed.length).toBeGreaterThan(0);
    expect(open(both)).toEqual([0, 6]);
    expect(both.closed.map((c: any) => c.date)).toEqual(member.closed.map((c: any) => c.date));

    const from = istDate(0), to = istDate(14);
    const cap = async (kind?: string) => (expectOk(await cust.c.get(`/api/capacity?from=${from}&to=${to}${kind ? `&kind=${kind}` : ''}`)).body.days as { date: string; closed?: boolean }[]);
    expect((await cap('single')).some((d) => d.closed)).toBe(false);
    expect((await cap('membership')).filter((d) => d.closed).every((d) => ![0, 6].includes(dow(d.date)))).toBe(true);
    expect((await cap('membership')).some((d) => d.closed)).toBe(true);
    expect((await cap()).filter((d) => d.closed).length).toBe((await cap('membership')).filter((d) => d.closed).length);
    expect((await cust.c.get('/api/working-days?kind=bogus')).status).toBe(400);
  });
});

describe('booking follows the right list', () => {
  it('a single wash is allowed on a weekday that only memberships have closed, and refused where single washes are closed', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const tue = next(2, 9);
    expectOk(await weekends(admin, 'membership'));
    expectOk(await singleWash(cust, tue));
    const cust2 = await customerWithVehicle('car');
    expectOk(await admin.c.put('/api/admin/working-days/weekdays', { open_days: [0, 1, 2, 3, 4, 5, 6], kind: 'membership' }));
    expectOk(await weekends(admin, 'single'));
    const refused = await singleWash(cust2, tue);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toMatch(/^WASHO is currently unavailable on Tuesday, /);
  });

  it('a membership follows the membership days, whatever single washes have closed', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const base = { vehicle_id: cust.vehicle.id, address_id: cust.addr.id, duration_months: 1, time_slot: 'morning', start_date: istDate(4) };
    expectOk(await weekends(admin, 'membership'));
    const monday = await cust.c.post('/api/payments/membership-checkout', { ...base, monthly: { body: 4, deep: 0, weekdays: [1] } });
    expect(monday.status).toBeGreaterThanOrEqual(400);
    expect(monday.body.message).toBe('WASHO is currently unavailable on Mondays. Choose from Saturdays, Sundays.');
    const cust2 = await customerWithVehicle('car');
    expectOk(await admin.c.put('/api/admin/working-days/weekdays', { open_days: [0, 1, 2, 3, 4, 5, 6], kind: 'membership' }));
    expectOk(await weekends(admin, 'single'));
    expectOk(await cust2.c.post('/api/payments/membership-checkout', { ...base, vehicle_id: cust2.vehicle.id, address_id: cust2.addr.id, monthly: { body: 4, deep: 0, weekdays: [1, 2, 3, 4] } }));
  });
});
