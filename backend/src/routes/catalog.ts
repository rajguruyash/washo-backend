import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../errors';
import { withAnon } from '../db';
import { asyncHandler, optionalSession } from '../middleware/http';

export const catalogRouter = Router();

// The rate card, discount rules and membership options are DATA in Supabase (get_public_catalog). The website
// renders whatever the database says, so changing a price never needs a deploy.
catalogRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    const catalog = await withAnon(async (c) => (await c.query('SELECT public.get_public_catalog() AS c')).rows[0].c);
    // How much notice a wash needs (set in Admin). The booking pages use it to grey out times that cannot be booked, instead of
    // letting a customer pick one and be refused at the end. The database still enforces it.
    const rules = await withAnon(async (c) =>
      (await c.query(`SELECT key, value_int FROM public.pricing_settings WHERE key IN ('on_demand_min_lead_hours', 'membership_min_lead_days')`)).rows as { key: string; value_int: number }[]
    ).catch(() => []);
    const rule = (key: string, fallback: number) => rules.find((r) => r.key === key)?.value_int ?? fallback;
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, ...catalog, booking_rules: { on_demand_min_lead_hours: rule('on_demand_min_lead_hours', 2), membership_min_lead_days: rule('membership_min_lead_days', 2) } });
  })
);

// "What would this plan cost?" The database runs the same calculator the checkout uses (rate card x washes, explicit discounts, the
// cap). Nothing is stored. A signed-in customer gets THEIR price: the calculator knows who is asking, so a welcome offer from a free-wash
// campaign shows here exactly as it will be charged. A visitor gets the standard price.
catalogRouter.post(
  '/membership-estimate',
  optionalSession,
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        vehicle_type: z.enum(['bike', 'car', 'suv']),
        weekly_pattern: z.array(z.object({ weekday: z.number().int().min(0).max(6), kind: z.enum(['body', 'deep']) })).min(1).max(7),
        duration_months: z.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Choose 1, 3, 6 or 12 months.'),
      }),
      req.body
    );
    const run = req.session ? req.db : withAnon;
    const estimate = await run(async (c) =>
      (await c.query('SELECT public.estimate_membership_price($1::public.vehicle_type, $2::jsonb, $3) AS q', [b.vehicle_type, JSON.stringify(b.weekly_pattern), b.duration_months])).rows[0].q
    );
    res.json({ success: true, estimate });
  })
);
