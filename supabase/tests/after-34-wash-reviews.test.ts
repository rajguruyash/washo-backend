/**
 * GREEN tests for 20261004000034_wash_reviews.sql: a customer rates a completed wash (1 to 5 stars) with or without a written review, changes it later, and the admin reads it.
 */
import { describe, expect, it } from 'vitest';
import { confirmedBooking, createAdmin, createCustomer, createWorker, inTx, uid, type AdminAccess } from './helpers';

const as = async (s: any, u: { authId: string }) => s.as('authenticated', u.authId);
const denied = /your admin role cannot do this|admin access required|permission denied/i;

/** A confirmed wash, then marked completed the way the database does it at the end of a specialist's job. Returns who owns it. */
async function doneWash(s: any, o: { worker?: boolean } = {}) {
  const b = await confirmedBooking(s);
  await s.as('postgres');
  let worker: any = null;
  if (o.worker) {
    worker = await createWorker(s);
    await s.q(`insert into public.worker_assignments (booking_id, worker_profile_id, is_active) values ($1,$2,true)`, [b.id, worker.profileId]);
  }
  await s.q(`update public.bookings set status = 'completed', completed_at = now() where id = $1`, [b.id]);
  return { ...b, worker };
}
const rate = async (s: any, u: { authId: string }, id: string, rating: number | null, review: string | null = null) => {
  await as(s, u);
  return s.err('select public.rate_wash($1,$2,$3)', [id, rating, review]);
};
const rated = async (s: any, u: { authId: string }, id: string, rating: number, review: string | null = null) => {
  await as(s, u);
  return (await s.q('select public.rate_wash($1,$2,$3) r', [id, rating, review]))[0].r;
};

describe('rating a wash', () => {
  it('a completed wash can be rated with stars alone, no review', async () =>
    inTx(async (s) => {
      const w = await doneWash(s);
      const r = await rated(s, w.u, w.id, 5);
      expect(r).toMatchObject({ booking_id: w.id, rating: 5, review: null });
      await as(s, w.u);
      expect((await s.q('select * from public.my_wash_reviews($1)', [[w.id]]))).toEqual([expect.objectContaining({ booking_id: w.id, rating: 5, review: null })]);
    }));

  it('with a review, trimmed; a blank review is no review', async () =>
    inTx(async (s) => {
      const w = await doneWash(s);
      expect((await rated(s, w.u, w.id, 4, '  Spotless, thank you!  ')).review).toBe('Spotless, thank you!');
      expect((await rated(s, w.u, w.id, 4, '   ')).review).toBeNull();
    }));

  it('can be changed later (stars and words), and there is only ever one per wash', async () =>
    inTx(async (s) => {
      const w = await doneWash(s);
      await rated(s, w.u, w.id, 2);
      const next = await rated(s, w.u, w.id, 4, 'They came back and fixed the mirror');
      expect(next).toMatchObject({ rating: 4, review: 'They came back and fixed the mirror' });
      await s.as('postgres');
      expect((await s.q('select count(*)::int n from public.wash_reviews where booking_id = $1', [w.id]))[0].n).toBe(1);
      const ev = (await s.q(`select event_type from public.audit_events where entity_id = $1 and event_type in ('wash_rated','wash_rating_changed') order by event_type`, [w.id])).map((e: any) => e.event_type);
      expect(ev).toEqual(['wash_rated', 'wash_rating_changed']);
    }));

  it('stars are 1 to 5 whole numbers; the review is at most 1000 characters', async () =>
    inTx(async (s) => {
      const w = await doneWash(s);
      for (const bad of [0, 6, -1, null]) expect(await rate(s, w.u, w.id, bad as any), String(bad)).toMatch(/1 to 5 stars/);
      expect(await rate(s, w.u, w.id, 5, 'x'.repeat(1001))).toMatch(/under 1000 characters/);
      expect(await rate(s, w.u, w.id, 5, 'x'.repeat(1000))).toBeNull();
    }));

  it('only the customer who owns a wash, and only once it has been done', async () =>
    inTx(async (s) => {
      const w = await doneWash(s);
      const stranger = await createCustomer(s);
      expect(await rate(s, stranger, w.id, 5)).toMatch(/Booking not found/);
      expect(await rate(s, w.u, uid(), 5)).toMatch(/Booking not found/);
      const open = await confirmedBooking(s);
      expect(await rate(s, open.u, open.id, 5)).toMatch(/once it has been done/);
      await s.as('postgres');
      await s.q(`update public.bookings set status = 'cancelled' where id = $1`, [open.id]);
      expect(await rate(s, open.u, open.id, 5)).toMatch(/once it has been done/);
      // a stranger cannot read it either
      await rated(s, w.u, w.id, 3, 'ok');
      await as(s, stranger);
      expect(await s.q('select * from public.my_wash_reviews($1)', [[w.id]])).toEqual([]);
    }));

  it('a specialist, an admin and a visitor cannot rate; the table is closed', async () =>
    inTx(async (s) => {
      const w = await doneWash(s);
      const worker = await createWorker(s);
      const admin = await createAdmin(s, 'super_admin');
      for (const who of [worker, admin]) expect(await rate(s, who, w.id, 5)).toMatch(/Customer profile not found|permission denied/i);
      await s.as('anon');
      expect(await s.err('select public.rate_wash($1,5,null)', [w.id])).toMatch(/permission denied/i);
      await rated(s, w.u, w.id, 5);
      for (const role of ['authenticated', 'anon'] as const) {
        if (role === 'anon') await s.as('anon'); else await as(s, w.u);
        expect(await s.err('select * from public.wash_reviews')).toMatch(/permission denied/i);
      }
    }));

  it('remembers which specialist did the wash', async () =>
    inTx(async (s) => {
      const w = await doneWash(s, { worker: true });
      await rated(s, w.u, w.id, 5);
      await s.as('postgres');
      expect((await s.q('select worker_profile_id from public.wash_reviews where booking_id = $1', [w.id]))[0].worker_profile_id).toBe(w.worker.profileId);
    }));
});

describe('what the admin sees', () => {
  it('one wash\'s review, and a list with the average and a count per star, newest first; only roles that see washes', async () =>
    inTx(async (s) => {
      const a = await doneWash(s, { worker: true }), b = await doneWash(s), c = await doneWash(s);
      await rated(s, a.u, a.id, 5, 'Perfect');
      await rated(s, b.u, b.id, 2, 'Missed the wheels');
      await rated(s, c.u, c.id, 5);
      const admin = await createAdmin(s, 'operations');
      await as(s, admin);
      expect((await s.q('select public.admin_wash_review($1) r', [a.id]))[0].r).toMatchObject({ rating: 5, review: 'Perfect' });
      expect((await s.q('select public.admin_wash_review($1) r', [uid()]))[0].r).toBeNull();
      const all = (await s.q('select public.admin_list_reviews() r'))[0].r;
      expect(all.summary).toMatchObject({ count: 3, average: 4, with_text: 2 });
      expect(all.summary.stars).toEqual({ '1': 0, '2': 1, '3': 0, '4': 0, '5': 2 });
      expect(all.reviews).toHaveLength(3);
      const first = all.reviews.find((r: any) => r.booking_id === a.id);
      expect(first).toMatchObject({ rating: 5, review: 'Perfect', worker_name: expect.any(String), service_name: expect.any(String) });
      const low = (await s.q('select public.admin_list_reviews(3) r'))[0].r;
      expect(low.reviews.map((r: any) => r.rating)).toEqual([2]);
      expect(low.summary.count).toBe(3);
      expect((await s.q('select public.admin_list_reviews(null, 1) r'))[0].r.reviews).toHaveLength(1);

      for (const role of ['finance', 'support', 'super_admin'] as AdminAccess[]) {
        const x = await createAdmin(s, role);
        await as(s, x);
        expect(await s.err('select public.admin_list_reviews()'), role).toBeNull();
      }
      for (const role of ['marketing'] as AdminAccess[]) {
        const x = await createAdmin(s, role);
        await as(s, x);
        expect(await s.err('select public.admin_list_reviews()')).toMatch(denied);
        expect(await s.err('select public.admin_wash_review($1)', [a.id])).toMatch(denied);
      }
      await as(s, a.u);
      expect(await s.err('select public.admin_list_reviews()')).toMatch(denied);
      await s.as('anon');
      expect(await s.err('select public.admin_list_reviews()')).toMatch(/permission denied/i);
    }));
});
