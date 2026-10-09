import { Router } from 'express';
import { z } from 'zod';
import { campaignsNotInstalled } from '../campaigns';
import { parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { monthlyNotInstalled, monthlyPlanSchema } from '../plan';

export const capacityRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({ from: isoDate, to: isoDate });
const limits = z.object({
  day_busy: z.number().int().min(1).max(500),
  day_full: z.number().int().min(1).max(500),
  slot_busy: z.number().int().min(1).max(500),
  slot_full: z.number().int().min(1).max(500),
});

/**
 * How crowded each day and time window is (migration 19). The booking pages use it to mark crowded days amber and full ones red. A database that
 * does not have it yet simply reports no days, and nothing is shaded.
 */
capacityRouter.get(
  '/capacity',
  requireSession,
  asyncHandler(async (req, res) => {
    const q = parse(range, req.query);
    let days: unknown[] = [];
    try {
      days = await req.db(async (c) => (await c.query('SELECT public.get_capacity($1::date, $2::date) AS r', [q.from, q.to])).rows[0].r.days);
    } catch (err) {
      if (!campaignsNotInstalled(err)) throw err;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, days });
  })
);

// Where a membership plan would land, day by day, and how busy each day is. Shown before paying; nothing is saved.
capacityRouter.post(
  '/membership-preview',
  requireSession,
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        vehicle_id: z.string().uuid(),
        weekly_pattern: z.array(z.object({ weekday: z.number().int().min(0).max(6), kind: z.enum(['body', 'deep']) })).min(1).max(7).optional(),
        monthly: monthlyPlanSchema.optional(),
        duration_months: z.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Choose 1, 3, 6 or 12 months.'),
        time_slot: z.enum(['morning', 'afternoon', 'night']),
        start_date: isoDate,
      }).refine((x) => Boolean(x.weekly_pattern) !== Boolean(x.monthly), 'Send either a weekly pattern or the washes in a month.'),
      req.body
    );
    const preview = await req.db(async (c) =>
      b.monthly
        ? (await c.query('SELECT public.preview_monthly_dates($1, $2, $3, $4::integer[], $5, $6::public.time_slot, $7::date) AS r', [b.vehicle_id, b.monthly.body, b.monthly.deep, b.monthly.weekdays, b.duration_months, b.time_slot, b.start_date])).rows[0].r
        : (await c.query('SELECT public.preview_membership_dates($1, $2::jsonb, $3, $4::public.time_slot, $5::date) AS r', [b.vehicle_id, JSON.stringify(b.weekly_pattern), b.duration_months, b.time_slot, b.start_date])).rows[0].r
    ).catch((err) => { throw monthlyNotInstalled(err) ?? err; });
    res.json({ success: true, ...preview });
  })
);

// Admin: the limits, and the load for the days ahead.
capacityRouter.get(
  '/admin/capacity',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const q = parse(range, req.query);
    const out = await req.db(async (c) => ({
      rules: (await c.query(`SELECT day_kind, day_busy, day_full, slot_busy, slot_full FROM public.capacity_rules ORDER BY day_kind`)).rows,
      days: (await c.query('SELECT public.get_capacity($1::date, $2::date) AS r', [q.from, q.to])).rows[0].r.days,
    }));
    res.json({ success: true, ...out });
  })
);

capacityRouter.put(
  '/admin/capacity',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ weekday: limits, weekend: limits }), req.body);
    await req.db(async (c) => {
      for (const kind of ['weekday', 'weekend'] as const) {
        const l = b[kind];
        await c.query('SELECT public.admin_set_capacity($1, $2, $3, $4, $5)', [kind, l.day_busy, l.day_full, l.slot_busy, l.slot_full]);
      }
    });
    res.json({ success: true });
  })
);

