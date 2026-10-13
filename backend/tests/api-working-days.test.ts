/**
 * Working Days over HTTP: an admin turns days of the week and single dates on or off; the booking pages learn which days are closed, a single wash or a membership on a
 * closed day is refused with the next day the customer can book, and only admins (with the capacity role) can change it. Razorpay is a local stand-in; the database is real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);
// Every test leaves all days open again (the whole API suite shares one database).
afterEach(async () => {
  await fake.admin.query('update public.working_weekdays set is_open = true');
  await fake.admin.query('delete from public.working_dates');
});

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The first date at least `from` days away that falls on this weekday (0 = Sunday). */
const next = (d: number, from = 9) => { let t = istDate(from); while (dow(t) !== d) t = addDays(t, 1); return t; };
const svc = async () => (await fake.admin.query(`select id from public.services where code = 'car-body-wash'`)).rows[0].id as string;
const weekendsOnly = (admin: { c: Client }) => admin.c.put('/api/admin/working-days/weekdays', { open_days: [6, 0] });
const singleWash = async (cust: Awaited<ReturnType<typeof customerWithVehicle>>, date: string) =>
  cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: await svc(), scheduled_date: date, time_slot: 'morning', address_id: cust.addr.id });

describe('the admin page', () => {
  it('starts with every day on, nothing set, and says what the next open day is', async () => {
    const admin = await staffClient('admin');
    const r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.installed).toBe(true);
    expect(r.weekdays).toHaveLength(7);
    expect(r.weekdays.every((w: any) => w.open)).toBe(true);
    expect(r.dates).toEqual([]);
    expect(r.booked_on_closed).toEqual([]);
    expect(r.next_open).toBe(istDate(0));
  });

  it('Monday to Friday off, Saturday and Sunday on', async () => {
    const admin = await staffClient('admin');
    expectOk(await weekendsOnly(admin));
    const r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.weekdays.filter((w: any) => w.open).map((w: any) => w.weekday)).toEqual([0, 6]);
    expect([0, 6]).toContain(dow(r.next_open));
  });

  it('turns single dates off and on, with a reason, and takes them away again', async () => {
    const admin = await staffClient('admin');
    const d = istDate(12), e = istDate(14);
    const one = expectOk(await admin.c.post('/api/admin/working-days/dates', { from: d, open: false, reason: 'Diwali' })).body;
    expect(one.days).toBe(1);
    const run = expectOk(await admin.c.post('/api/admin/working-days/dates', { from: istDate(20), to: istDate(22), open: false })).body;
    expect(run.days).toBe(3);
    let r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.dates.find((x: any) => x.day === d)).toMatchObject({ day: d, open: false, reason: 'Diwali' });   // (washes: how many are booked that day; other tests share the database)
    expect(typeof r.dates.find((x: any) => x.day === d).washes).toBe('number');
    expect(r.dates).toHaveLength(4);
    expectOk(await admin.c.post('/api/admin/working-days/dates', { from: e, open: true }));
    expectOk(await admin.c.req('DELETE', `/api/admin/working-days/dates/${d}`));
    r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.dates.some((x: any) => x.day === d)).toBe(false);
    const gone = await admin.c.req('DELETE', `/api/admin/working-days/dates/${d}`);
    expect(gone.status).toBeGreaterThanOrEqual(400);
    expect(gone.body.message).toMatch(/no setting to remove/);
  });

  it('refuses bad input in plain words', async () => {
    const admin = await staffClient('admin');
    const bad = (body: unknown) => admin.c.post('/api/admin/working-days/dates', body);
    expect((await bad({ from: istDate(-1), open: false })).body.message).toMatch(/today or a later date/);
    expect((await bad({ from: istDate(5), to: istDate(3), open: false })).body.message).toMatch(/cannot be before the first/);
    expect((await bad({ from: istDate(5), to: istDate(200), open: false })).body.message).toMatch(/up to 92 days/);
    expect((await bad({ from: istDate(5), open: false, reason: 'x'.repeat(130) })).status).toBe(400);
    expect((await bad({ open: false })).status).toBe(400);
    expect((await admin.c.put('/api/admin/working-days/weekdays', { open_days: [7] })).status).toBe(400);
    expect((await admin.c.put('/api/admin/working-days/weekdays', {})).status).toBe(400);
  });

  it('lists the washes already booked on closed days, and does not move them', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const order = expectOk(await singleWash(cust, next(1, 6))).body.order;     // a Monday, six or more days out
    expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id)));
    expectOk(await weekendsOnly(admin));
    const r = expectOk(await admin.c.get('/api/admin/working-days')).body;
    expect(r.booked_on_closed.some((b: any) => b.washes >= 1)).toBe(true);
    // still booked
    const list = expectOk(await admin.c.get(`/api/admin/bookings?from=${next(1, 6)}&to=${next(1, 6)}&q=${cust.reg}`)).body.bookings;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('confirmed');
  });
});

describe('who may change it', () => {
  it('customers, specialists and the signed-out are refused; an admin without the capacity role too', async () => {
    const cust = await customerWithVehicle('car');
    const worker = await staffClient('worker');
    const support = await staffClient('admin', { access: 'support' });
    for (const [who, label] of [[cust.c, 'customer'], [worker.c, 'worker'], [support.c, 'support admin'], [new Client(), 'nobody']] as const) {
      expect((await who.get('/api/admin/working-days')).status, label).toBeGreaterThanOrEqual(401);
      expect((await who.put('/api/admin/working-days/weekdays', { open_days: [6, 0] })).status, label).toBeGreaterThanOrEqual(401);
      expect((await who.post('/api/admin/working-days/dates', { from: istDate(5), open: false })).status, label).toBeGreaterThanOrEqual(401);
    }
    // nothing changed
    expect((await fake.admin.query('select count(*)::int n from public.working_weekdays where not is_open')).rows[0].n).toBe(0);
  });

  it('an operations admin may', async () => {
    const ops = await staffClient('admin', { access: 'operations' });
    expectOk(await weekendsOnly(ops));
    expectOk(await ops.c.get('/api/admin/working-days'));
  });
});

describe('what the booking pages are told', () => {
  it('/working-days: the weekdays, the closed days ahead (with the reason) and the next open day; /capacity marks the same days closed', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    const sat = next(6, 8);
    expectOk(await weekendsOnly(admin));
    expectOk(await admin.c.post('/api/admin/working-days/dates', { from: sat, open: false, reason: 'Festival' }));
    const w = expectOk(await cust.c.get('/api/working-days')).body;
    expect(w.weekdays.filter((x: any) => x.open).map((x: any) => x.weekday)).toEqual([0, 6]);
    expect(w.closed.find((c: any) => c.date === sat)).toEqual({ date: sat, reason: 'Festival' });
    expect(w.closed.every((c: any) => c.date === sat || ![0, 6].includes(dow(c.date)))).toBe(true);
    expect([0, 6]).toContain(dow(w.next_open));

    const from = istDate(0), to = istDate(21);
    const days = expectOk(await cust.c.get(`/api/capacity?from=${from}&to=${to}`)).body.days as { date: string; closed?: boolean; closed_reason?: string | null }[];
    expect(days).toHaveLength(22);
    for (const d of days) {
      const shouldClose = ![0, 6].includes(dow(d.date)) || d.date === sat;
      expect(Boolean(d.closed), d.date).toBe(shouldClose);
    }
    expect(days.find((d) => d.date === sat)!.closed_reason).toBe('Festival');
  });

  it('with nothing turned off no day is marked closed', async () => {
    const cust = await customerWithVehicle('car');
    const days = expectOk(await cust.c.get(`/api/capacity?from=${istDate(0)}&to=${istDate(10)}`)).body.days as { closed?: boolean }[];
    expect(days.some((d) => d.closed)).toBe(false);
    expect(expectOk(await cust.c.get('/api/working-days')).body.closed).toEqual([]);
  });
});

describe('booking on a closed day', () => {
  it('a single wash is refused with the day, the reason and the next day the customer can book; an open day works', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    expectOk(await weekendsOnly(admin));
    const tue = next(2, 9), sat = next(6, 9);
    expectOk(await admin.c.post('/api/admin/working-days/dates', { from: tue, open: false, reason: 'Diwali' }));
    const refused = await singleWash(cust, tue);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toMatch(/^WASHO is currently unavailable on Tuesday, \d{1,2} [A-Z][a-z]{2} \(Diwali\)\. The next day you can book is [A-Z][a-z]+, \d{1,2} [A-Z][a-z]{2}\.$/);
    expectOk(await singleWash(cust, sat));
  });

  it('a membership cannot be started on closed weekdays, or on exact dates that are closed', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    expectOk(await weekendsOnly(admin));
    const base = { vehicle_id: cust.vehicle.id, address_id: cust.addr.id, duration_months: 1, time_slot: 'morning', start_date: istDate(4) };
    const monday = await cust.c.post('/api/payments/membership-checkout', { ...base, monthly: { body: 4, deep: 0, weekdays: [1] } });
    expect(monday.status).toBeGreaterThanOrEqual(400);
    expect(monday.body.message).toBe('WASHO is currently unavailable on Mondays. Choose from Saturdays, Sundays.');
    const days = Array.from({ length: 24 }, (_, i) => addDays(istDate(4), i));
    const weekdayDates = days.filter((d) => ![0, 6].includes(dow(d))).slice(0, 4).map((date) => ({ date, kind: 'body' }));
    const exact = await cust.c.post('/api/payments/membership-checkout', { ...base, monthly: { body: 4, deep: 0, weekdays: [] }, custom_dates: weekdayDates });
    expect(exact.status).toBeGreaterThanOrEqual(400);
    expect(exact.body.message).toMatch(/^WASHO is currently unavailable on /);
    // weekends are fine
    const ok = await cust.c.post('/api/payments/membership-checkout', { ...base, monthly: { body: 4, deep: 0, weekdays: [6] } });
    expectOk(ok);
  });

  it('the preview lands every wash on an open day', async () => {
    const admin = await staffClient('admin');
    const cust = await customerWithVehicle('car');
    expectOk(await weekendsOnly(admin));
    const p = expectOk(await cust.c.post('/api/membership-preview', { vehicle_id: cust.vehicle.id, monthly: { body: 4, deep: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] }, duration_months: 1, time_slot: 'morning', start_date: istDate(4) })).body;
    expect(p.fits).toBe(true);
    expect(p.dates).toHaveLength(4);
    expect(p.dates.every((d: any) => [0, 6].includes(dow(d.date)))).toBe(true);
  });

  it('an existing membership keeps its washes, and its customer cannot move one onto a closed day', async () => {
    const admin = await staffClient('admin');
    const m = await activeMembership({ admin: admin.c });
    const washes = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes as { id: string; scheduled_date: string }[];
    const wash = washes[5];
    const target = addDays(wash.scheduled_date, 1);
    expectOk(await admin.c.post('/api/admin/working-days/dates', { from: target, open: false, reason: 'Rain' }));
    const refused = await m.c.post(`/api/bookings/${wash.id}/reschedule`, { date: target, time_slot: 'morning' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.message).toMatch(/^WASHO is currently unavailable on .*\(Rain\)\. The next day you can book is/);
    // the admin may make the exception
    expectOk(await admin.c.post(`/api/admin/bookings/${wash.id}/reschedule`, { date: target, time_slot: 'morning', reason: 'Customer asked' }));
    expect(expectOk(await admin.c.get(`/api/admin/bookings/${wash.id}`)).body.booking.scheduled_date).toBe(target);
  });
});
