/** A specialist moves a membership wash the vehicle was not available for; a customer clears plans from their own pages. Over HTTP, real database rules. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

let admin: Client;
beforeAll(async () => {
  admin = (await staffClient('admin')).c;
});

const db = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows;
const reschedule = (c: Client, id: string, body: unknown) => c.post(`/api/worker/washes/${id}/reschedule`, body);

async function held() {
  const w = await staffClient('worker', { name: 'Ravi Patil', phone: '9876500002' });
  const m = await activeMembership({ admin });
  expectOk(await admin.post(`/api/admin/memberships/${m.membershipId}/assign-worker`, { worker_profile_id: w.profileId }));
  const washes = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes as { id: string; scheduled_date: string; time_slot: string }[];
  return { w, m, washes };
}
/** A day after `from` with no wash of this membership on it. */
const freeDay = (washes: { scheduled_date: string }[], from: string) => {
  const taken = new Set(washes.map((x) => x.scheduled_date));
  for (let i = 1; i < 20; i++) {
    const d = new Date(new Date(`${from}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10);
    if (!taken.has(d)) return d;
  }
  throw new Error('no free day');
};

describe('a specialist moves a membership wash', () => {
  it('moves it, keeps it in their queue, and the customer sees who moved it and why', async () => {
    const { w, m, washes } = await held();
    const wash = washes[1];
    const target = freeDay(washes, wash.scheduled_date);
    const res = expectOk(await reschedule(w.c, wash.id, { date: target, reason: 'Car was not available: out of the society' }));
    expect(res.body.wash).toMatchObject({ booking_id: wash.id, scheduled_date: target, status: 'worker_assigned', change: { kind: 'rescheduled', by: 'worker', from_date: wash.scheduled_date } });

    // still theirs
    const queue = expectOk(await w.c.get('/api/worker/queue?days=60')).body.queue as any[];
    expect(queue.find((q) => q.booking_id === wash.id)).toMatchObject({ scheduled_date: target });

    // the customer's booking page: new date, and the timeline says the specialist moved it, with the reason
    const detail = expectOk(await m.c.get(`/api/bookings/${wash.id}`)).body;
    expect(detail.booking.scheduled_date).toBe(target);
    const ev = detail.events.filter((e: any) => e.event_type === 'rescheduled' && e.meta.by);
    expect(ev).toHaveLength(1);
    expect(ev[0].meta).toMatchObject({ by: 'worker', reason: 'Car was not available: out of the society', new_date: target });
    const list = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes as any[];
    expect(list.find((x) => x.id === wash.id).scheduled_date).toBe(target);
  });

  it('can change the time window too, and the reason is optional', async () => {
    const { w, washes } = await held();
    const wash = washes[2];
    const res = expectOk(await reschedule(w.c, wash.id, { date: wash.scheduled_date, time_slot: 'night' }));
    expect(res.body.wash).toMatchObject({ scheduled_date: wash.scheduled_date, time_slot: 'night' });
  });

  it('refuses another specialist, a customer, the past, a day outside the membership, and bad input', async () => {
    const { w, m, washes } = await held();
    const wash = washes[1];
    const target = freeDay(washes, wash.scheduled_date);
    const other = await staffClient('worker');
    expect((await reschedule(other.c, wash.id, { date: target })).status).toBe(403);
    expect((await reschedule(m.c, wash.id, { date: target })).status).toBe(403);
    expect((await reschedule(new Client(), wash.id, { date: target })).status).toBe(401);

    const past = await reschedule(w.c, wash.id, { date: istDate(-1) });
    expect(past.status).toBe(422);
    expect(past.body.message).toMatch(/today or a later date/);
    const beyond = await reschedule(w.c, wash.id, { date: istDate(200) });
    expect(beyond.status).toBe(422);
    expect(beyond.body.message).toMatch(/within your membership/);
    expect((await reschedule(w.c, wash.id, { date: '8 Oct' })).status).toBe(400);
    expect((await reschedule(w.c, wash.id, { date: target, time_slot: 'dawn' })).status).toBe(400);
    expect((await reschedule(w.c, wash.id, { date: target, reason: 'x'.repeat(301) })).status).toBe(400);
    expect(expectOk(await m.c.get(`/api/bookings/${wash.id}`)).body.booking.scheduled_date).toBe(wash.scheduled_date);
  });
});

describe('a customer clears plans from their pages', () => {
  const startCheckout = async (cust: Awaited<ReturnType<typeof customerWithVehicle>>) =>
    expectOk(
      await cust.c.post('/api/payments/membership-checkout', {
        vehicle_id: cust.vehicle.id, weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: cust.addr.id,
      })
    ).body;

  it('a plan started but not paid: the checkout is stopped and it leaves their lists, but is not deleted', async () => {
    const cust = await customerWithVehicle('car');
    const out = await startCheckout(cust);
    const request_id = (await db(`select membership_request_id from public.payments where provider_order_id = $1`, [out.order.order_id]))[0].membership_request_id;
    expect(request_id).toBeTruthy();

    const before = expectOk(await cust.c.get('/api/membership-requests')).body.requests as any[];
    expect(before.map((r) => r.id)).toContain(request_id);

    const res = expectOk(await cust.c.post(`/api/membership-requests/${request_id}/remove`, {}));
    expect(res.body).toMatchObject({ removed: true, stopped_checkout: true });

    const after = expectOk(await cust.c.get('/api/membership-requests')).body.requests as any[];
    expect(after.map((r) => r.id)).not.toContain(request_id);
    // WASHO still has it, cancelled, and its payment will never be taken
    const row = (await db(`select r.status::text rs, p.status::text ps from public.membership_requests r join public.payments p on p.membership_request_id = r.id where r.id = $1`, [request_id]))[0];
    expect(row).toEqual({ rs: 'cancelled', ps: 'failed' });
    // the same plan can be started afresh
    expectOk(await cust.c.post('/api/payments/membership-checkout', {
      vehicle_id: cust.vehicle.id, weekly_pattern: PATTERN_3, duration_months: 1, time_slot: 'morning', start_date: istDate(4), address_id: cust.addr.id,
    }));
  });

  it('never an active membership or the request behind it; never someone else\'s plan', async () => {
    const m = await activeMembership({ admin });
    const refused = await m.c.post(`/api/memberships/${m.membershipId}/remove`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/active membership cannot be removed/);
    const reqId = (await db(`select id from public.membership_requests where membership_id = $1`, [m.membershipId]))[0].id;
    expect((await m.c.post(`/api/membership-requests/${reqId}/remove`, {})).status).toBe(422);

    const stranger = await customerWithVehicle('car');
    expect((await stranger.c.post(`/api/memberships/${m.membershipId}/remove`, {})).status).toBe(404);
    expect((await stranger.c.post(`/api/membership-requests/${reqId}/remove`, {})).status).toBe(404);
    expect((await new Client().post(`/api/memberships/${m.membershipId}/remove`, {})).status).toBe(401);
    expect(expectOk(await m.c.get('/api/memberships')).body.memberships.map((x: any) => x.id)).toContain(m.membershipId);
  });

  it('an ended membership leaves their lists; its details stay for WASHO', async () => {
    const m = await activeMembership({ admin });
    await db('alter table public.memberships disable trigger user');
    await db(`update public.memberships set status = 'expired' where id = $1`, [m.membershipId]);
    await db('alter table public.memberships enable trigger user');
    expectOk(await m.c.post(`/api/memberships/${m.membershipId}/remove`, {}));
    expect(expectOk(await m.c.get('/api/memberships')).body.memberships.map((x: any) => x.id)).not.toContain(m.membershipId);
    expect((await db(`select count(*)::int n from public.memberships where id = $1`, [m.membershipId]))[0].n).toBe(1);
    // and it is not listed twice or brought back by the admin's view
    expect(expectOk(await admin.get('/api/admin/memberships')).body.memberships.map((x: any) => x.id)).toContain(m.membershipId);
  });
});
