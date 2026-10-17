import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { withAnon } from '../db';
import { cached } from '../publicCache';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';

/**
 * The offer on the home screen: a short notice (a discount, or a complimentary wash) that an admin switches on in Admin -> Campaigns, and that the website and the mobile app then show
 * to everyone. Who may change it is the Campaigns area (access.ts); the rules are in the database (migration 20261004000045). This only checks what was typed and passes it on.
 * It never sets a price: a discount's real percentage is a coupon or an automatic discount, a complimentary wash is the campaign's claim.
 */
export const offersRouter = Router();
offersRouter.use('/admin/offers', requireSession, requireRole('admin'));

const NOT_READY = new HttpError(503, 'backend_not_ready', "Offers aren't switched on yet. The database needs its latest update; please contact whoever looks after WASHO's website.");
const missing = (err: unknown) => ['42883', '42P01'].includes((err as { code?: string }).code ?? '');
const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date.');

const body = z.object({
  kind: z.enum(['discount', 'complimentary_wash'], 'Choose a discount or a complimentary wash.'),
  headline: z.string().trim().min(3, 'Write the offer in 3 to 60 characters.').max(60, 'Keep the offer to 60 characters.'),
  details: z.string().trim().max(140, 'Keep the extra line to 140 characters.').nullish(),
  code: z.string().trim().max(20, 'A coupon code is at most 20 letters and numbers.').nullish(),
  starts_on: day.nullish(),
  ends_on: day.nullish(),
  active: z.boolean().default(false),
});

type Db = <R>(fn: (c: import('pg').PoolClient) => Promise<R>) => Promise<R>;
const run = async <T>(req: { db: Db }, sql: string, params: unknown[] = []): Promise<T> => {
  try {
    return await req.db(async (c) => (await c.query(sql, params)).rows[0].r as T);
  } catch (err) {
    if (missing(err)) throw NOT_READY;
    throw err;
  }
};
const save = (req: { db: Db }, id: string | null, b: z.infer<typeof body>) =>
  run(req, 'SELECT public.admin_save_offer($1, $2, $3, $4, $5, $6::date, $7::date, $8) AS r', [id, b.kind, b.headline, b.details ?? null, b.code ?? null, b.starts_on ?? null, b.ends_on ?? null, b.active]);

/** What to show right now. Open to everyone (the home page and the app show it before anyone signs in); a few seconds of memory, emptied when an admin changes anything. */
offersRouter.get(
  '/offers',
  asyncHandler(async (_req, res) => {
    const offers = await cached('offers', 10_000, () =>
      withAnon(async (c) => (await c.query('SELECT public.get_live_offers() AS r')).rows[0].r as unknown[]).catch((err) => {
        if (missing(err)) return [] as unknown[]; // a database without offers simply has none
        throw err;
      })
    );
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, offers });
  })
);

offersRouter.get('/admin/offers', asyncHandler(async (req, res) => res.json({ success: true, offers: await run(req, 'SELECT public.admin_list_offers() AS r') })));

offersRouter.post('/admin/offers', asyncHandler(async (req, res) => res.status(201).json({ success: true, offer: await save(req, null, parse(body, req.body)) })));

offersRouter.put('/admin/offers/:id', asyncHandler(async (req, res) => res.json({ success: true, offer: await save(req, parse(uuid, req.params.id), parse(body, req.body)) })));

offersRouter.post(
  '/admin/offers/:id/active',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    res.json({ success: true, offer: await run(req, 'SELECT public.admin_set_offer_active($1, $2) AS r', [id, active]) });
  })
);

offersRouter.post(
  '/admin/offers/:id/delete',
  asyncHandler(async (req, res) => {
    await run(req, 'SELECT public.admin_delete_offer($1) AS r', [parse(uuid, req.params.id)]);
    res.json({ success: true });
  })
);
