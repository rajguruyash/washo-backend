import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';

/**
 * Free-wash campaigns in the Admin page: create and edit one, switch it on and off, watch the claims. The rules live in the
 * database (migration 20261004000014); this validates what the browser sent and reads the numbers.
 */
export const adminCampaignsRouter = Router();
adminCampaignsRouter.use('/admin/campaigns', requireSession, requireRole('admin'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.');
const text = (max: number) => z.string().trim().max(max);

const body = z.object({
  code: text(40).optional(),
  name: text(80).min(3, 'Give the campaign a name.'),
  description: text(400).optional(),
  claim_opens_on: isoDate,
  claim_closes_on: isoDate,
  use_by_date: isoDate,
  total_cap: z.number().int('Enter a whole number.').min(1, 'At least 1.').max(100000),
  daily_cap: z.number().int('Enter a whole number.').min(1, 'At least 1, or leave empty.').max(10000).nullish(),
  pack_offer_days: z.number().int().min(1, 'At least 1 day.').max(365),
  pack_bp_1: z.number().int().min(0).max(5000),
  pack_bp_2: z.number().int().min(0).max(5000),
  pack_bp_3plus: z.number().int().min(0).max(5000),
  active: z.boolean().optional(),
});

const SAVE = `SELECT public.admin_save_campaign($1, $2, $3, $4, $5::date, $6::date, $7::date, $8, $9, $10, $11, $12, $13, $14) AS id`;
const saveParams = (id: string | null, b: z.infer<typeof body>) => [
  id, b.code ?? '', b.name, b.description ?? null, b.claim_opens_on, b.claim_closes_on, b.use_by_date, b.total_cap, b.daily_cap ?? null,
  b.pack_offer_days, b.pack_bp_1, b.pack_bp_2, b.pack_bp_3plus, b.active ?? null,
];

const CAMPAIGN_SQL = `
  SELECT k.id, k.code, k.name, k.description, k.is_active, k.claim_opens_on, k.claim_closes_on, k.use_by_date, k.total_cap, k.daily_cap,
         k.new_customers_only, k.pack_offer_days, k.pack_offer_bp_1 AS pack_bp_1, k.pack_offer_bp_2 AS pack_bp_2, k.pack_offer_bp_3plus AS pack_bp_3plus, k.created_at,
         count(x.id) FILTER (WHERE x.status <> 'released')::int AS claimed,
         count(x.id) FILTER (WHERE x.status = 'booked')::int AS booked,
         count(x.id) FILTER (WHERE x.status = 'completed')::int AS completed,
         count(x.id) FILTER (WHERE x.status = 'forfeited')::int AS forfeited,
         count(x.id) FILTER (WHERE x.status = 'released')::int AS released,
         count(x.id) FILTER (WHERE x.status = 'completed' AND x.offer_membership_id IS NULL AND x.offer_expires_at > now())::int AS offers_open,
         count(x.offer_membership_id)::int AS packs_bought,
         COALESCE(sum(m.final_amount_cents), 0)::bigint AS packs_cents
    FROM public.campaigns k
    LEFT JOIN public.campaign_claims x ON x.campaign_id = k.id
    LEFT JOIN public.memberships m ON m.id = x.offer_membership_id`;

adminCampaignsRouter.get(
  '/admin/campaigns',
  asyncHandler(async (req, res) => {
    const campaigns = await req.db(async (c) => (await c.query(`${CAMPAIGN_SQL} GROUP BY k.id ORDER BY k.created_at DESC`)).rows);
    res.json({ success: true, campaigns });
  })
);

adminCampaignsRouter.get(
  '/admin/campaigns/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const out = await req.db(async (c) => {
      const campaign = (await c.query(`${CAMPAIGN_SQL} WHERE k.id = $1 GROUP BY k.id`, [id])).rows[0];
      if (!campaign) return null;
      // washes per day (only the claims still standing), so the daily limit can be watched
      const days = (
        await c.query(
          `SELECT b.scheduled_date AS date, count(*)::int AS washes
             FROM public.campaign_claims x JOIN public.bookings b ON b.id = x.booking_id
            WHERE x.campaign_id = $1 AND x.status <> 'released' GROUP BY b.scheduled_date ORDER BY b.scheduled_date`,
          [id]
        )
      ).rows;
      return { campaign, days };
    });
    if (!out) throw new HttpError(404, 'not_found', 'Campaign not found');
    res.json({ success: true, ...out });
  })
);

adminCampaignsRouter.get(
  '/admin/campaigns/:id/claims',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const q = parse(
      z.object({
        status: z.enum(['booked', 'completed', 'released', 'forfeited']).optional().catch(undefined),
        q: z.string().trim().max(60).optional().catch(undefined),
      }),
      req.query
    );
    const claims = await req.db(async (c) =>
      (
        await c.query(
          `SELECT x.id, x.status, x.claimed_at, x.completed_at, x.offer_expires_at, x.offer_membership_id,
                  p.id AS customer_id, p.full_name AS customer_name, p.phone AS customer_phone,
                  b.id AS booking_id, b.reference_code, b.scheduled_date, b.time_slot::text AS time_slot, b.status::text AS booking_status,
                  v.vehicle_type::text AS vehicle_type, v.model AS vehicle_model, v.registration_number,
                  m.final_amount_cents AS pack_cents
             FROM public.campaign_claims x
             JOIN public.profiles p ON p.id = x.customer_profile_id
             JOIN public.bookings b ON b.id = x.booking_id
             JOIN public.vehicles v ON v.id = b.vehicle_id
             LEFT JOIN public.memberships m ON m.id = x.offer_membership_id
            WHERE x.campaign_id = $1 AND ($2::text IS NULL OR x.status = $2)
              AND ($3::text IS NULL OR p.full_name ILIKE '%' || $3 || '%' OR p.phone ILIKE '%' || $3 || '%' OR v.registration_number ILIKE '%' || $3 || '%' OR b.reference_code ILIKE '%' || $3 || '%')
            ORDER BY x.claimed_at DESC LIMIT 300`,
          [id, q.status ?? null, q.q ?? null]
        )
      ).rows
    );
    res.json({ success: true, claims });
  })
);

adminCampaignsRouter.post(
  '/admin/campaigns',
  asyncHandler(async (req, res) => {
    const b = parse(body, req.body);
    const r = await req.db(async (c) => (await c.query(SAVE, saveParams(null, b))).rows[0] as { id: string });
    res.status(201).json({ success: true, campaign_id: r.id });
  })
);

adminCampaignsRouter.put(
  '/admin/campaigns/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(body, req.body);
    await req.db((c) => c.query(SAVE, saveParams(id, b)));
    res.json({ success: true });
  })
);

adminCampaignsRouter.post(
  '/admin/campaigns/:id/active',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_campaign_active($1, $2)', [id, active]));
    res.json({ success: true });
  })
);
