import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../errors';
import { withAnon } from '../db';
import { asyncHandler } from '../middleware/http';

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

// "What would this plan cost?" The database runs the same calculator WASHO's quote starts from (rate card x washes, explicit
// discounts, the cap). It is only an estimate: nothing is stored, and WASHO still reviews the request and confirms the price.
catalogRouter.post(
  '/membership-estimate',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        vehicle_type: z.enum(['bike', 'car', 'suv']),
        weekly_pattern: z.array(z.object({ weekday: z.number().int().min(0).max(6), kind: z.enum(['body', 'deep']) })).min(1).max(7),
        duration_months: z.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Choose 1, 3, 6 or 12 months.'),
      }),
      req.body
    );
    const estimate = await withAnon(async (c) =>
      (await c.query('SELECT public.estimate_membership_price($1::public.vehicle_type, $2::jsonb, $3) AS q', [b.vehicle_type, JSON.stringify(b.weekly_pattern), b.duration_months])).rows[0].q
    );
    res.json({ success: true, estimate });
  })
);
