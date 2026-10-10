import type { PoolClient } from 'pg';

type Db = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

export interface WashReview { rating: number; review: string | null; updated_at: string }

/** The database does not have wash reviews yet (migration 34 is not applied). */
export const reviewsNotInstalled = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === '42883' || code === '42703';
};

/**
 * This customer's own ratings for these washes. Wash lists and details must keep working on a database that has not had the review migration yet, so this is a separate,
 * tolerant lookup rather than a join in the main query.
 */
export async function reviewsFor(db: Db, bookingIds: string[]): Promise<Map<string, WashReview>> {
  const out = new Map<string, WashReview>();
  if (!bookingIds.length) return out;
  try {
    const rows = await db(async (c) => (await c.query('SELECT booking_id, rating, review, updated_at FROM public.my_wash_reviews($1::uuid[])', [bookingIds])).rows as (WashReview & { booking_id: string })[]);
    for (const r of rows) out.set(r.booking_id, { rating: r.rating, review: r.review, updated_at: r.updated_at });
  } catch (err) {
    if (!reviewsNotInstalled(err)) throw err;
  }
  return out;
}

/** Adds `review` (or null) to each wash row. */
export async function withReviews<T extends { id: string }>(db: Db, rows: T[]): Promise<(T & { review: WashReview | null })[]> {
  const found = await reviewsFor(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, review: found.get(r.id) ?? null }));
}
