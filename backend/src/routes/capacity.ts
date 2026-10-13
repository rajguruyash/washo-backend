import { Router } from 'express';
import { z } from 'zod';
import { campaignsNotInstalled } from '../campaigns';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { monthlyNotInstalled, monthlyPlanSchema } from '../plan';

export const capacityRouter = Router();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({ from: isoDate, to: isoDate });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date.');
const limits = z.object({
  day_busy: z.number().int().min(1).max(500),
  day_full: z.number().int().min(1).max(500),
  slot_busy: z.number().int().min(1).max(500),
  slot_full: z.number().int().min(1).max(500),
});

/** The closed days in a range (migration 39), or null on a database that does not have Working Days yet: then every day is open. */
type WorkingDays = { weekdays: { weekday: number; open: boolean }[]; closed: { date: string; reason: string | null }[]; next_open: string | null };
async function workingDays(db: (fn: (c: any) => Promise<any>) => Promise<any>, from: string, to: string): Promise<WorkingDays | null> {
  try {
    return (await db(async (c) => (await c.query('SELECT public.get_working_days($1::date, $2::date) AS r', [from, to])).rows[0].r)) as WorkingDays;
  } catch (err) {
    if (!campaignsNotInstalled(err)) throw err;
    return null;
  }
}
const notSwitchedOn = (err: unknown): HttpError | null =>
  campaignsNotInstalled(err) ? new HttpError(409, 'working_days_not_installed', 'Working Days is not switched on yet. Ask whoever looks after the database to apply migration 39.') : null;

/**
 * How crowded each day and time window is (migration 19), and which days WASHO is closed (migration 39). The booking pages use it to mark crowded days amber and full ones red
 * and to grey out closed days. A database that does not have it yet simply reports no days, and nothing is shaded.
 */
capacityRouter.get(
  '/capacity',
  requireSession,
  asyncHandler(async (req, res) => {
    const q = parse(range, req.query);
    let days: { date: string }[] = [];
    try {
      days = await req.db(async (c) => (await c.query('SELECT public.get_capacity($1::date, $2::date) AS r', [q.from, q.to])).rows[0].r.days);
    } catch (err) {
      if (!campaignsNotInstalled(err)) throw err;
    }
    const wd = await workingDays(req.db, q.from, q.to);
    if (wd) {
      const closed = new Map(wd.closed.map((c) => [c.date, c.reason]));
      days = days.map((d) => (closed.has(d.date) ? { ...d, closed: true, closed_reason: closed.get(d.date) ?? null } : d));
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, days });
  })
);

// Which weekdays WASHO works and the closed days ahead, with the next day a customer can book. Public information for the signed-in booking pages.
capacityRouter.get(
  '/working-days',
  requireSession,
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const wd = await workingDays(req.db, q.from ?? today, q.to ?? plus(400));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, weekdays: wd?.weekdays ?? [], closed: wd?.closed ?? [], next_open: wd?.next_open ?? null });
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

// Admin: Working Days. What is open and closed, and the washes already booked on closed days (they stay booked until WASHO moves them).
capacityRouter.get(
  '/admin/working-days',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    try {
      const r = await req.db(async (c) => (await c.query('SELECT public.admin_working_days() AS r')).rows[0].r);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true, installed: true, ...r });
    } catch (err) {
      if (!campaignsNotInstalled(err)) throw err;
      res.json({ success: true, installed: false, weekdays: [], dates: [], booked_on_closed: [], next_open: null });
    }
  })
);

capacityRouter.put(
  '/admin/working-days/weekdays',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ open_days: z.array(z.number().int().min(0).max(6)).max(7) }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_working_weekdays($1::integer[])', [[...new Set(b.open_days)]])).catch((err) => { throw notSwitchedOn(err) ?? err; });
    res.json({ success: true });
  })
);

capacityRouter.post(
  '/admin/working-days/dates',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ from: day, to: day.optional(), open: z.boolean(), reason: z.string().trim().max(120, 'Keep the reason under 120 characters.').optional() }), req.body);
    const n = await req
      .db(async (c) => (await c.query('SELECT public.admin_set_working_dates($1::date, $2::date, $3, $4) AS n', [b.from, b.to ?? b.from, b.open, b.reason || null])).rows[0].n as number)
      .catch((err) => { throw notSwitchedOn(err) ?? err; });
    res.json({ success: true, days: n });
  })
);

capacityRouter.delete(
  '/admin/working-days/dates/:day',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const d = parse(day, req.params.day);
    await req.db((c) => c.query('SELECT public.admin_clear_working_date($1::date)', [d])).catch((err) => { throw notSwitchedOn(err) ?? err; });
    res.json({ success: true });
  })
);
