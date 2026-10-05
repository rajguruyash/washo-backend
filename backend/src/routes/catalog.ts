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
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, ...catalog });
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
