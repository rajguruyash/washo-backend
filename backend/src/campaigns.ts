import type { PoolClient } from 'pg';

type Db = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

/** The database does not have the campaign tables or functions yet (migration 14 is not applied). */
export const campaignsNotInstalled = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === '42883' || code === '42703';
};

export const EMPTY_STATUS = { campaign: null, me: null, offer: null } as const;

/**
 * Which of these washes are campaign washes (and which campaign). Wash lists and details must keep working on a database that
 * has not had the campaign migration yet, so this is a separate, tolerant lookup rather than a join in the main query.
 */
export async function campaignNames(db: Db, bookingIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!bookingIds.length) return out;
  try {
    const rows = await db(async (c) =>
      (
        await c.query(
          `SELECT cl.booking_id, k.name FROM public.campaign_claims cl JOIN public.campaigns k ON k.id = cl.campaign_id WHERE cl.booking_id = ANY($1::uuid[])`,
          [bookingIds]
        )
      ).rows as { booking_id: string; name: string }[]
    );
    for (const r of rows) out.set(r.booking_id, r.name);
  } catch (err) {
    if (!campaignsNotInstalled(err)) throw err;
  }
  return out;
}

/** Adds `campaign_name` (or null) to each wash row. */
export async function withCampaignNames<T extends { id: string }>(db: Db, rows: T[]): Promise<(T & { campaign_name: string | null })[]> {
  const names = await campaignNames(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, campaign_name: names.get(r.id) ?? null }));
}
