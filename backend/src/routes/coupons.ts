import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';

/**
 * The Admin page's coupons: a code (for example EXTRA5) worth an extra percentage off a membership, that people are told about by word of mouth and type in on the last step.
 * Who may do what is decided once, for every /api/admin path (access.ts: the Campaigns area, view to look, manage to change); the database checks again (migration 32).
 * A coupon is never deleted: it is switched off, and every use stays on record.
 */
export const couponsRouter = Router();
couponsRouter.use('/admin', requireSession, requireRole('admin'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');
const body = z.object({
  code: z.string().trim().max(30).optional(),
  // basis points (500 = 5%): the page works in percent and sends whole hundredths of a percent
  discount_bp: z.number().int('Enter the percentage.').min(1, 'A coupon takes between 0.01% and 50% off.').max(5000, 'A coupon takes between 0.01% and 50% off.'),
  label: z.string().trim().max(60, 'Keep the note to 60 characters.').nullish(),
  expires_on: isoDate.nullish(),
  max_uses: z.number().int().min(1, 'The most uses must be 1 or more.').max(1_000_000).nullish(),
  once_per_customer: z.boolean().default(true),
});

const one = async <T>(req: { db: <R>(fn: (c: import('pg').PoolClient) => Promise<R>) => Promise<R> }, sql: string, params: unknown[] = []) =>
  req.db(async (c) => (await c.query(sql, params)).rows[0].r as T);

couponsRouter.get(
  '/admin/coupons',
  asyncHandler(async (req, res) => {
    res.json({ success: true, coupons: await one(req, 'SELECT public.admin_list_coupons() AS r') });
  })
);

couponsRouter.post(
  '/admin/coupons',
  asyncHandler(async (req, res) => {
    const b = parse(body, req.body);
    const coupon = await one(req, 'SELECT public.admin_save_coupon(NULL, $1, $2, $3, $4::date, $5, $6) AS r', [b.code ?? '', b.discount_bp, b.label ?? null, b.expires_on ?? null, b.max_uses ?? null, b.once_per_customer]);
    res.status(201).json({ success: true, coupon });
  })
);

couponsRouter.put(
  '/admin/coupons/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(body, req.body);
    const coupon = await one(req, 'SELECT public.admin_save_coupon($1, $2, $3, $4, $5::date, $6, $7) AS r', [id, b.code ?? null, b.discount_bp, b.label ?? null, b.expires_on ?? null, b.max_uses ?? null, b.once_per_customer]);
    res.json({ success: true, coupon });
  })
);

couponsRouter.post(
  '/admin/coupons/:id/active',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    res.json({ success: true, coupon: await one(req, 'SELECT public.admin_set_coupon_active($1, $2) AS r', [id, active]) });
  })
);

couponsRouter.get(
  '/admin/coupons/:id/uses',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    res.json({ success: true, uses: await one(req, 'SELECT public.admin_coupon_uses($1) AS r', [id]) });
  })
);
