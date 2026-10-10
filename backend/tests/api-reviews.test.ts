/**
 * Rating a wash over HTTP: a customer rates a completed wash (single or membership) with stars alone or with a review, sees it on their Washes tab and the wash's page, can
 * change it; the admin sees it on the wash and in the Reviews list. Razorpay is a local stand-in; the database rules are real.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, PATTERN_3, activeMembership, boot, customerWithVehicle, expectOk, fake, istDate, shutdown, staffClient } from './helpers';

beforeAll(boot);
afterAll(shutdown);

type Role = 'super_admin' | 'operations' | 'finance' | 'marketing' | 'support';
const staff = (access: Role) => staffClient('admin', { access });
const dbRows = async (sql: string, params: unknown[] = []) => (await fake.admin.query(sql, params)).rows;

/** A paid single wash, then done (the way the specialist's last step leaves it). */
async function doneSingleWash() {
  const cust = await customerWithVehicle('car');
  const svc = (await dbRows(`select id from public.services where code = 'car-body-wash'`))[0].id;
  const order = expectOk(await cust.c.post('/api/payments/on-demand', { vehicle_id: cust.vehicle.id, service_id: svc, scheduled_date: istDate(5), time_slot: 'morning', address_id: cust.addr.id })).body.order;
  const bookingId = expectOk(await cust.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result.booking_id as string;
  await fake.admin.query(`update public.bookings set status = 'completed', completed_at = now() where id = $1`, [bookingId]);
  return { ...cust, bookingId };
}

describe('rating a wash', () => {
  it('stars alone, no review: it shows on the Washes tab and on the wash itself', async () => {
    const w = await doneSingleWash();
    const before = expectOk(await w.c.get('/api/bookings?scope=past')).body.bookings.find((b: any) => b.id === w.bookingId);
    expect(before.review).toBeNull();
    const r = expectOk(await w.c.post(`/api/bookings/${w.bookingId}/review`, { rating: 5 })).body.review;
    expect(r).toMatchObject({ booking_id: w.bookingId, rating: 5, review: null });
    const list = expectOk(await w.c.get('/api/bookings?scope=past')).body.bookings.find((b: any) => b.id === w.bookingId);
    expect(list.review).toMatchObject({ rating: 5, review: null });
    expect(expectOk(await w.c.get(`/api/bookings/${w.bookingId}`)).body.booking.review).toMatchObject({ rating: 5, review: null });
  });

  it('with a review (trimmed), changed later, and a blank review clears the words', async () => {
    const w = await doneSingleWash();
    expectOk(await w.c.post(`/api/bookings/${w.bookingId}/review`, { rating: 3, review: '  Good, but the mirror was missed  ' }));
    expect(expectOk(await w.c.get(`/api/bookings/${w.bookingId}`)).body.booking.review).toMatchObject({ rating: 3, review: 'Good, but the mirror was missed' });
    expectOk(await w.c.post(`/api/bookings/${w.bookingId}/review`, { rating: 5, review: '' }));
    expect(expectOk(await w.c.get(`/api/bookings/${w.bookingId}`)).body.booking.review).toMatchObject({ rating: 5, review: null });
    expect((await dbRows('select count(*)::int n from public.wash_reviews where booking_id = $1', [w.bookingId]))[0].n).toBe(1);
  });

  it('says what is wrong in plain words', async () => {
    const w = await doneSingleWash();
    const url = `/api/bookings/${w.bookingId}/review`;
    for (const bad of [{}, { rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: 'five' }, { rating: null }]) {
      const r = await w.c.post(url, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(JSON.stringify((await w.c.post(url, { rating: 7 })).body)).toMatch(/1 to 5 stars/);
    const long = await w.c.post(url, { rating: 5, review: 'x'.repeat(1001) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(long.body)).toMatch(/under 1000 characters/);
    expectOk(await w.c.post(url, { rating: 5, review: 'x'.repeat(1000) }));
  });

  it('only once the wash is done, only by the customer who had it', async () => {
    const w = await doneSingleWash();
    const other = await customerWithVehicle('car');
    expect((await other.c.post(`/api/bookings/${w.bookingId}/review`, { rating: 5 })).status).toBe(404);
    expect((await new Client().post(`/api/bookings/${w.bookingId}/review`, { rating: 5 })).status).toBe(401);
    expect((await (await staffClient('worker')).c.post(`/api/bookings/${w.bookingId}/review`, { rating: 5 })).status).toBe(403);
    expect((await (await staff('super_admin')).c.post(`/api/bookings/${w.bookingId}/review`, { rating: 5 })).status).toBe(403);
    expect((await w.c.post('/api/bookings/not-an-id/review', { rating: 5 })).status).toBe(400);
    // a wash that has not been done
    const svc = (await dbRows(`select id from public.services where code = 'car-body-wash'`))[0].id;
    const order = expectOk(await other.c.post('/api/payments/on-demand', { vehicle_id: other.vehicle.id, service_id: svc, scheduled_date: istDate(6), time_slot: 'morning', address_id: other.addr.id })).body.order;
    const open = expectOk(await other.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result.booking_id as string;
    const early = await other.c.post(`/api/bookings/${open}/review`, { rating: 5 });
    expect(early.status).toBe(422);
    expect(early.body.message).toBe('You can rate a wash once it has been done');
    // someone else's rating is not shown to a stranger
    expectOk(await w.c.post(`/api/bookings/${w.bookingId}/review`, { rating: 4, review: 'private words' }));
    expect((await other.c.get(`/api/bookings/${w.bookingId}`)).status).toBe(404);
  });

  it('membership washes carry the rating too', async () => {
    const m = await activeMembership({ type: 'car', pattern: PATTERN_3, months: 1 });
    const washes = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes as { id: string; review: unknown }[];
    expect(washes.length).toBeGreaterThan(0);
    expect(washes.every((x) => x.review === null)).toBe(true);
    const first = washes[0].id;
    await fake.admin.query(`update public.bookings set status = 'completed', completed_at = now() where id = $1`, [first]);
    expectOk(await m.c.post(`/api/bookings/${first}/review`, { rating: 4, review: 'Prompt and neat' }));
    const again = expectOk(await m.c.get(`/api/memberships/${m.membershipId}`)).body.washes as { id: string; review: any }[];
    expect(again.find((x) => x.id === first)!.review).toMatchObject({ rating: 4, review: 'Prompt and neat' });
    expect(again.filter((x) => x.id !== first).every((x) => x.review === null)).toBe(true);
  });
});

describe('what the admin sees', () => {
  it('the wash sheet carries the review; the Reviews list has the average and a count per star, and can be narrowed to low ratings', async () => {
    const a = await doneSingleWash(), b = await doneSingleWash();
    expectOk(await a.c.post(`/api/bookings/${a.bookingId}/review`, { rating: 5, review: 'Spotless' }));
    expectOk(await b.c.post(`/api/bookings/${b.bookingId}/review`, { rating: 1, review: 'Late and rushed' }));
    const ops = await staff('operations');
    expect(expectOk(await ops.c.get(`/api/admin/bookings/${a.bookingId}`)).body.review).toMatchObject({ rating: 5, review: 'Spotless' });
    const fresh = await doneSingleWash();
    expect(expectOk(await ops.c.get(`/api/admin/bookings/${fresh.bookingId}`)).body.review).toBeNull();

    const all = expectOk(await ops.c.get('/api/admin/reviews')).body;
    expect(all.summary.count).toBeGreaterThanOrEqual(2);
    expect(all.summary.stars['5']).toBeGreaterThanOrEqual(1);
    expect(all.summary.stars['1']).toBeGreaterThanOrEqual(1);
    const mine = all.reviews.find((r: any) => r.booking_id === b.bookingId);
    expect(mine).toMatchObject({ rating: 1, review: 'Late and rushed', service_name: 'Car Body Wash' });
    const low = expectOk(await ops.c.get('/api/admin/reviews?max=2')).body.reviews as { rating: number }[];
    expect(low.length).toBeGreaterThanOrEqual(1);
    expect(low.every((r) => r.rating <= 2)).toBe(true);
    expect(expectOk(await ops.c.get('/api/admin/reviews?limit=1')).body.reviews).toHaveLength(1);
    expect((await ops.c.get('/api/admin/reviews?max=9')).status).toBe(400);
  });

  it('operations, finance, support and the super admin may read them; marketing, customers and visitors may not', async () => {
    for (const role of ['operations', 'finance', 'support', 'super_admin'] as Role[]) expectOk(await (await staff(role)).c.get('/api/admin/reviews'));
    expect((await (await staff('marketing')).c.get('/api/admin/reviews')).status).toBe(403);
    const cust = await customerWithVehicle('car');
    expect((await cust.c.get('/api/admin/reviews')).status).toBe(403);
    expect((await new Client().get('/api/admin/reviews')).status).toBe(401);
  });
});

describe('clearing a finished wash from the Washes tab', () => {
  it('leaves it out of the past list, brings it back on undo, and never touches a wash that is still coming up', async () => {
    const w = await doneSingleWash();
    const ids = async (c: Client) => (expectOk(await c.get('/api/bookings?scope=past')).body.bookings as { id: string }[]).map((b) => b.id);
    expect(await ids(w.c)).toContain(w.bookingId);
    expectOk(await w.c.post(`/api/bookings/${w.bookingId}/hide`, {}));
    expect(await ids(w.c)).not.toContain(w.bookingId);
    // still there for them to open, for the admin to see, and in the database
    expect(expectOk(await w.c.get(`/api/bookings/${w.bookingId}`)).body.booking.id).toBe(w.bookingId);
    expect(expectOk(await (await staff('operations')).c.get(`/api/admin/bookings/${w.bookingId}`)).body.booking.id).toBe(w.bookingId);
    expect(expectOk(await w.c.get('/api/bookings?scope=all')).body.bookings.some((b: any) => b.id === w.bookingId)).toBe(true);
    expectOk(await w.c.post(`/api/bookings/${w.bookingId}/unhide`, {}));
    expect(await ids(w.c)).toContain(w.bookingId);

    // a wash that is coming up cannot be cleared
    const svc = (await dbRows(`select id from public.services where code = 'car-body-wash'`))[0].id;
    const order = expectOk(await w.c.post('/api/payments/on-demand', { vehicle_id: w.vehicle.id, service_id: svc, scheduled_date: istDate(8), time_slot: 'morning', address_id: w.addr.id })).body.order;
    const open = expectOk(await w.c.post('/api/payments/verify', fake.checkout(order.order_id))).body.result.booking_id as string;
    const refused = await w.c.post(`/api/bookings/${open}/hide`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/finished/);
  });

  it('only the customer who had the wash; a visitor, a specialist and an admin cannot', async () => {
    const w = await doneSingleWash();
    const other = await customerWithVehicle('car');
    expect((await other.c.post(`/api/bookings/${w.bookingId}/hide`, {})).status).toBe(404);
    expect((await new Client().post(`/api/bookings/${w.bookingId}/hide`, {})).status).toBe(401);
    expect((await (await staffClient('worker')).c.post(`/api/bookings/${w.bookingId}/hide`, {})).status).toBe(403);
    expect((await w.c.post('/api/bookings/nope/hide', {})).status).toBe(400);
  });
});
