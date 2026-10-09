import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { withAnon } from '../db';
import { asyncHandler, optionalSession } from '../middleware/http';
import { withCouponGuard } from '../couponGuard';
import { monthlyNotInstalled, monthlyPlanSchema } from '../plan';
import { cached } from '../publicCache';

export const catalogRouter = Router();

// The rate card, discount rules and membership options are DATA in Supabase (get_public_catalog). The website
// renders whatever the database says, so changing a price never needs a deploy.
catalogRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    const out = await cached('catalog', 30_000, async () => {
      // the two lookups are independent: ask the database for both at once
      const [catalog, rules] = await Promise.all([
        withAnon(async (c) => (await c.query('SELECT public.get_public_catalog() AS c')).rows[0].c),
        // How much notice a wash needs (set in Admin). The booking pages use it to grey out times that cannot be booked, instead of
        // letting a customer pick one and be refused at the end. The database still enforces it.
        withAnon(async (c) =>
          (await c.query(`SELECT key, value_int FROM public.pricing_settings WHERE key IN ('on_demand_min_lead_hours', 'membership_min_lead_days')`)).rows as { key: string; value_int: number }[]
        ).catch(() => [] as { key: string; value_int: number }[]),
      ]);
      const rule = (key: string, fallback: number) => rules.find((r) => r.key === key)?.value_int ?? fallback;
      return { ...catalog, booking_rules: { on_demand_min_lead_hours: rule('on_demand_min_lead_hours', 2), membership_min_lead_days: rule('membership_min_lead_days', 2) } };
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, ...out });
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
        // either a weekly pattern (the older way: a few washes a week) or washes in a month (4 to 28, any mix)
        weekly_pattern: z.array(z.object({ weekday: z.number().int().min(0).max(6), kind: z.enum(['body', 'deep']) })).min(1).max(7).optional(),
        monthly: monthlyPlanSchema.pick({ body: true, deep: true }).optional(),
        duration_months: z.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Choose 1, 3, 6 or 12 months.'),
        // A coupon the customer typed (only for a plan chosen as washes in a month, and only for a signed-in customer: it is checked against who is asking)
        coupon: z.string().trim().max(30).optional(),
      }).refine((x) => Boolean(x.weekly_pattern) !== Boolean(x.monthly), 'Send either a weekly pattern or the washes in a month.'),
      req.body
    );
    const coupon = b.coupon ? b.coupon : null;
    if (coupon) {
      if (!b.monthly) throw new HttpError(400, 'coupon_plan', 'A coupon is for a membership chosen as washes in a month.');
      if (!req.session) throw new HttpError(401, 'sign_in', 'Sign in to use a coupon.');
      const estimate = await withCouponGuard(req.session.claims.sub, () =>
        req.db(async (c) => (await c.query('SELECT public.estimate_monthly_price_with_coupon($1::public.vehicle_type, $2, $3, $4, $5) AS q', [b.vehicle_type, b.monthly!.body, b.monthly!.deep, b.duration_months, coupon])).rows[0].q)
      );
      return res.json({ success: true, estimate });
    }
    const ask = (run: typeof withAnon) =>
      run(async (c) =>
        b.monthly
          ? (await c.query('SELECT public.estimate_monthly_price($1::public.vehicle_type, $2, $3, $4) AS q', [b.vehicle_type, b.monthly.body, b.monthly.deep, b.duration_months])).rows[0].q
          : (await c.query('SELECT public.estimate_membership_price($1::public.vehicle_type, $2::jsonb, $3) AS q', [b.vehicle_type, JSON.stringify(b.weekly_pattern), b.duration_months])).rows[0].q
      ).catch((err) => { throw monthlyNotInstalled(err) ?? err; });
    // A visitor's price is the standard one, the same for everybody asking the same thing, so it is kept briefly. A signed-in customer's price
    // can include their own welcome offer, so theirs is always worked out fresh.
    const estimate = req.session
      ? await ask(req.db as unknown as typeof withAnon)
      : await cached(`estimate:${b.vehicle_type}:${JSON.stringify(b.weekly_pattern ?? b.monthly)}:${b.duration_months}`, 60_000, () => ask(withAnon));
    res.json({ success: true, estimate });
  })
);
