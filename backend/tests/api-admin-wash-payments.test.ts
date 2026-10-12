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
