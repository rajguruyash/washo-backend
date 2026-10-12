/**
 * The admin Washes tab says how each wash is paid for (Paid, Membership, Free, Refunded, Unpaid) and can be narrowed to one of them. Razorpay is a local stand-in; the
 * database is real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATTERN_3, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

const row = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows[0];

/** One of each: cash (booked by WASHO), complimentary, paid online by the customer, and a membership. Each on its own day so they can be told apart. */
async function oneOfEach() {
  const admin = await staffClient('admin');
  const svc = (await row(`select id from public.services where code = 'car-body-wash'`)).id as string;

  const cashCust = await customerWithVehicle('car');
  const cashMe = expectOk(await cashCust.c.get('/api/me')).body.user;
  const cash = expectOk(await admin.c.post('/api/admin/bookings', { customer_id: cashMe.id, vehicle_id: cashCust.vehicle.id, service_id: svc, date: istDate(11), time_slot: 'morning', payment: 'cash' })).body.booking_id as string;
  const free = expectOk(await admin.c.post('/api/admin/bookings', { customer_id: cashMe.id, vehicle_id: cashCust.vehicle.id, service_id: svc, date: istDate(12), time_slot: 'morning', payment: 'free' })).body.booking_id as string;

  const onlineCust = await customerWithVehicle('car');
  const order = expectOk(await onlineCust.c.post('/api/payments/on-demand', { vehicle_id: onlineCust.vehicle.id, service_id: svc, scheduled_date: istDate(13), time_slot: 'morning', address_id: onlineCust.addr.id })).body.order;
  const online = expectOk(await onlineCust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result.booking_id as string;

  const m = await activeMembership({ type: 'car', pattern: PATTERN_3, months: 1 });
  return { admin, cash, free, online, membershipId: m.membershipId };
}

const kinds = async (admin: { c: { get: (p: string) => Promise<any> } }, query: string) =>
  expectOk(await admin.c.get(`/api/admin/bookings?${query}`)).body.bookings as { id: string; payment_kind: string; payment_provider: string | null; booking_type: string }[];

describe('how each wash is paid for', () => {
  it('says Paid for a wash with a payment (online or cash), Free for a complimentary one, and Membership for a plan\'s washes', async () => {
    const t = await oneOfEach();
    const all = await kinds(t.admin, `from=${istDate(0)}&to=${istDate(40)}`);
    const by = (id: string) => all.find((b) => b.id === id)!;
    expect(by(t.cash)).toMatchObject({ payment_kind: 'paid', payment_provider: 'offline', booking_type: 'on_demand' });
    expect(by(t.online)).toMatchObject({ payment_kind: 'paid', payment_provider: 'razorpay' });
    expect(by(t.free)).toMatchObject({ payment_kind: 'free', payment_provider: null });
    const plan = await kinds(t.admin, `membership=${t.membershipId}`);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((b) => b.payment_kind === 'membership' && b.booking_type === 'membership')).toBe(true);
  });

  it('says Refunded once the payment is refunded, and Unpaid for a priced wash with no payment on record', async () => {
    const t = await oneOfEach();
    await fake.admin.query(`update public.payments set status = 'refunded' where booking_id = $1`, [t.online]);
    await fake.admin.query(`delete from public.payments where booking_id = $1`, [t.cash]);
    const all = await kinds(t.admin, `from=${istDate(0)}&to=${istDate(40)}`);
    expect(all.find((b) => b.id === t.online)!.payment_kind).toBe('refunded');
    expect(all.find((b) => b.id === t.cash)!.payment_kind).toBe('unpaid');
    // a part-refunded payment still counts as paid
    await fake.admin.query(`update public.payments set status = 'partially_refunded' where booking_id = $1`, [t.online]);
    expect((await kinds(t.admin, `from=${istDate(0)}&to=${istDate(40)}`)).find((b) => b.id === t.online)!.payment_kind).toBe('paid');
  });

  it('can be narrowed to one kind; anything else is ignored; the other filters still work with it', async () => {
    const t = await oneOfEach();
    const window = `from=${istDate(0)}&to=${istDate(40)}`;
    const ids = (rows: { id: string }[]) => new Set(rows.map((b) => b.id));
    const paid = await kinds(t.admin, `${window}&pay=paid`);
    expect(paid.every((b) => b.payment_kind === 'paid')).toBe(true);
    expect(ids(paid).has(t.cash) && ids(paid).has(t.online)).toBe(true);
    expect(ids(paid).has(t.free)).toBe(false);

    const free = await kinds(t.admin, `${window}&pay=free`);
    expect(free.every((b) => b.payment_kind === 'free')).toBe(true);
    expect(ids(free).has(t.free)).toBe(true);
    expect(ids(free).has(t.cash)).toBe(false);

    const plan = await kinds(t.admin, `${window}&pay=membership`);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((b) => b.payment_kind === 'membership')).toBe(true);

    expect((await kinds(t.admin, `${window}&pay=refunded`)).every((b) => b.payment_kind === 'refunded')).toBe(true);
    // not one of the kinds: no filter at all (the list is the same as without it)
    expect((await kinds(t.admin, `${window}&pay=banana`)).length).toBe((await kinds(t.admin, window)).length);
    // with a status filter as well
    const confirmedPaid = await kinds(t.admin, `${window}&pay=paid&status=confirmed`);
    expect(confirmedPaid.every((b) => b.payment_kind === 'paid')).toBe(true);
    expect(ids(confirmedPaid).has(t.cash)).toBe(true);
  });

  it('the wash\'s own page carries it too', async () => {
    const t = await oneOfEach();
    expect(expectOk(await t.admin.c.get(`/api/admin/bookings/${t.cash}`)).body.booking.payment_kind).toBe('paid');
    expect(expectOk(await t.admin.c.get(`/api/admin/bookings/${t.free}`)).body.booking.payment_kind).toBe('free');
  });
});

describe('searching the washes', () => {
  /** A customer with a name nobody else has, and two washes (3 and 40 days out) booked by WASHO. */
  async function distinct() {
    const admin = await staffClient('admin');
    const svc = (await row(`select id from public.services where code = 'car-body-wash'`)).id as string;
    const cust = await customerWithVehicle('car');
    const unique = `Quokka${Math.floor(Math.random() * 1e6)}`;
    expectOk(await cust.c.put('/api/me', { full_name: `Zed ${unique}`, email: 'asha@example.com' }));
    const me = expectOk(await cust.c.get('/api/me')).body.user;
    const book = async (days: number) => expectOk(await admin.c.post('/api/admin/bookings', { customer_id: me.id, vehicle_id: cust.vehicle.id, service_id: svc, date: istDate(days), time_slot: 'morning', payment: 'cash' })).body.booking_id as string;
    return { admin, cust, unique, near: await book(3), far: await book(40) };
  }
  const found = async (admin: { c: { get: (p: string) => Promise<any> } }, q: string, more = '') =>
    (expectOk(await admin.c.get(`/api/admin/bookings?q=${encodeURIComponent(q)}${more}`)).body.bookings as { id: string; scheduled_date: string; customer_name: string }[]);

  it('finds a customer by name (any case, part of it), by number plate, by phone however it is typed, by society, and by reference', async () => {
    const t = await distinct();
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    expect(ids(await found(t.admin, t.unique.toLowerCase()))).toEqual(expect.arrayContaining([t.near, t.far]));
    expect(ids(await found(t.admin, t.unique.slice(0, 7))).includes(t.near)).toBe(true);
    expect(ids(await found(t.admin, t.cust.reg.toLowerCase())).includes(t.near)).toBe(true);
    const digits = t.cust.phone as string; // 10 digits
    expect(ids(await found(t.admin, digits)).includes(t.near)).toBe(true);
    expect(ids(await found(t.admin, `${digits.slice(0, 5)} ${digits.slice(5)}`)).includes(t.near)).toBe(true);
    // a society is shared by many washes (and the list stops at 400), so narrow it to the one day
    expect(ids(await found(t.admin, 'yashwin', `&from=${istDate(3)}&to=${istDate(3)}`)).includes(t.near)).toBe(true);
    const ref = (await row(`select reference_code from public.bookings where id = $1`, [t.near])).reference_code as string;
    expect(ids(await found(t.admin, ref)).includes(t.near)).toBe(true);
  });

  it('looks at every date (the date range is for browsing), newest first, and narrows with the other filters', async () => {
    const t = await distinct();
    const rows = await found(t.admin, t.unique);
    expect(rows.map((r) => r.id)).toEqual([t.far, t.near]); // 40 days out comes before 3 days out
    // the same wash is not in the default week
    const week = expectOk(await t.admin.c.get(`/api/admin/bookings?from=${istDate(0)}&to=${istDate(7)}`)).body.bookings as { id: string }[];
    expect(week.some((b) => b.id === t.far)).toBe(false);
    // narrowed by payment and status
    expect((await found(t.admin, t.unique, '&pay=free')).length).toBe(0);
    expect((await found(t.admin, t.unique, '&pay=paid')).map((r) => r.id)).toEqual([t.far, t.near]);
    expect((await found(t.admin, t.unique, '&status=completed')).length).toBe(0);
  });

  it('% and _ are ordinary letters, nothing matches nothing, an empty or huge search is no search', async () => {
    const t = await distinct();
    expect((await found(t.admin, '%')).length).toBe(0);
    expect((await found(t.admin, '_')).length).toBe(0);
    expect((await found(t.admin, `${t.unique}%`)).length).toBe(0); // a name followed by a literal % is not a name
    expect((await found(t.admin, 'no-such-person-anywhere-xyz')).length).toBe(0);
    const everything = expectOk(await t.admin.c.get(`/api/admin/bookings?from=${istDate(0)}&to=${istDate(50)}`)).body.bookings.length as number;
    expect(expectOk(await t.admin.c.get(`/api/admin/bookings?q=&from=${istDate(0)}&to=${istDate(50)}`)).body.bookings.length).toBe(everything);
    expect(expectOk(await t.admin.c.get(`/api/admin/bookings?q=${'x'.repeat(200)}&from=${istDate(0)}&to=${istDate(50)}`)).body.bookings.length).toBe(everything);
  });
});

describe('the memberships list carries what the Paid tab shows', () => {
  it('where, when and how it was paid, and the slot and notes', async () => {
    const admin = await staffClient('admin');
    const m = await activeMembership({ type: 'car', pattern: PATTERN_3, months: 1 });
    const list = expectOk(await admin.c.get('/api/admin/memberships')).body.memberships as any[];
    const mine = list.find((x) => x.id === m.membershipId);
    expect(mine).toMatchObject({ status: 'active', society_name: 'Yashwin Orizzonte', time_slot: 'morning', payment_provider: 'razorpay', customer_notes: 'Gate code 4321' });
    expect(mine.paid_at).toBeTruthy();
    expect(mine.final_amount_cents).toBeGreaterThan(0);
    expect(mine.flat_number).toBe('B-702');
  });
});

describe('on-demand washes in the Paid tab: history, upcoming, live', () => {
  it('can be listed on their own (type), newest first (order), with when it was paid, completed and booked', async () => {
    const t = await oneOfEach();
    const window = `from=${istDate(0)}&to=${istDate(40)}`;
    const single = (await kinds(t.admin, `${window}&type=on_demand`)) as any[];
    expect(single.length).toBeGreaterThan(0);
    expect(single.every((b) => b.booking_type === 'on_demand')).toBe(true);
    expect(single.map((b) => b.id)).toEqual(expect.arrayContaining([t.cash, t.free, t.online]));
    const plan = (await kinds(t.admin, `${window}&type=membership`)) as any[];
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((b) => b.booking_type === 'membership')).toBe(true);
    // anything else is no filter at all
    expect((await kinds(t.admin, `${window}&type=banana`)).length).toBe((await kinds(t.admin, window)).length);

    // oldest first by default, newest first on request
    const up = single.map((b) => b.scheduled_date);
    expect(up).toEqual([...up].sort());
    const down = ((await kinds(t.admin, `${window}&type=on_demand&order=desc`)) as any[]).map((b) => b.scheduled_date);
    expect(down).toEqual([...down].sort().reverse());

    const online = single.find((b) => b.id === t.online);
    expect(online.paid_at).toBeTruthy();
    expect(online.booked_at).toBeTruthy();
    expect(online.completed_at).toBeNull();
    expect(single.find((b) => b.id === t.free).paid_at).toBeNull();
    // paid single washes only
    const paidOnly = (await kinds(t.admin, `${window}&type=on_demand&pay=paid`)) as any[];
    expect(paidOnly.every((b) => b.payment_kind === 'paid' && b.booking_type === 'on_demand')).toBe(true);
    expect(paidOnly.map((b) => b.id)).not.toContain(t.free);
  });
});

describe('an admin moves a paid single wash', () => {
  it('moves it to another day and window, shows it unassigned, tells the customer, and logs who did it', async () => {
    const t = await oneOfEach();
    const target = istDate(20);
    expectOk(await t.admin.c.post(`/api/admin/bookings/${t.online}/reschedule`, { date: target, time_slot: 'night', reason: 'Customer called' }));
    const after = expectOk(await t.admin.c.get(`/api/admin/bookings/${t.online}`)).body;
    expect(after.booking).toMatchObject({ scheduled_date: target, time_slot: 'night', status: 'confirmed', payment_kind: 'paid', worker_id: null });
    const moved = after.events.find((e: any) => e.event_type === 'rescheduled');
    expect(moved.meta).toMatchObject({ new_date: target, new_slot: 'night', by: 'admin', reason: 'Customer called' });
    // it keeps its payment and shows up in the new day's list
    expect(((await kinds(t.admin, `from=${target}&to=${target}&type=on_demand&pay=paid`)) as any[]).map((b) => b.id)).toContain(t.online);
    // cash-paid and free ones can be moved too
    expectOk(await t.admin.c.post(`/api/admin/bookings/${t.cash}/reschedule`, { date: istDate(21), time_slot: 'morning' }));
    expectOk(await t.admin.c.post(`/api/admin/bookings/${t.free}/reschedule`, { date: istDate(22), time_slot: 'afternoon' }));
  });

  it('is refused for a past date, for the same day and window, and for a cancelled wash', async () => {
    const t = await oneOfEach();
    const r1 = await t.admin.c.post(`/api/admin/bookings/${t.online}/reschedule`, { date: istDate(-1), time_slot: 'morning' });
    expect(r1.status).toBeGreaterThanOrEqual(400);
    expect(r1.body.message).toMatch(/today or a later date/);
    const r2 = await t.admin.c.post(`/api/admin/bookings/${t.online}/reschedule`, { date: istDate(13), time_slot: 'morning' });
    expect(r2.body.message).toMatch(/already the date and time/);
    expectOk(await t.admin.c.post(`/api/admin/bookings/${t.cash}/cancel`, { reason: 'Customer cancelled' }));
    const r3 = await t.admin.c.post(`/api/admin/bookings/${t.cash}/reschedule`, { date: istDate(25), time_slot: 'morning' });
    expect(r3.status).toBeGreaterThanOrEqual(400);
    expect(r3.body.message).toMatch(/cannot be rescheduled/);
  });

  it('only an admin may, and a customer cannot move their own paid single wash this way', async () => {
    const t = await oneOfEach();
    const w = await staffClient('worker');
    expect((await w.c.post(`/api/admin/bookings/${t.online}/reschedule`, { date: istDate(25), time_slot: 'morning' })).status).toBeGreaterThanOrEqual(401);
    const anon = (await customerWithVehicle('car')).c;
    expect((await anon.post(`/api/admin/bookings/${t.online}/reschedule`, { date: istDate(25), time_slot: 'morning' })).status).toBeGreaterThanOrEqual(401);
  });
});
