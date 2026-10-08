import { RequestHandler, Router } from 'express';
import { withAnon } from '../db';
import { HttpError } from '../errors';
import { asyncHandler } from '../middleware/http';
import { cached } from '../publicCache';

export const settingsRouter = Router();

export interface PublicSettings {
  maintenance_mode: boolean;
  maintenance_message: string;
}

/** What any visitor may know: is the site paused. A few seconds of memory (an admin changing it empties that). A database without migration 27 means "not paused". */
export const publicSettings = (): Promise<PublicSettings> =>
  cached('public-settings', 10_000, async () => (await withAnon((c) => c.query('SELECT public.get_public_settings() AS s'))).rows[0].s as PublicSettings).catch(
    () => ({ maintenance_mode: false, maintenance_message: '' })
  );

settingsRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json({ success: true, ...(await publicSettings()) });
  })
);

// While maintenance mode is on, nothing that STARTS a booking or a payment is accepted. Everything already under way keeps working: a payment that was made
// can still be confirmed, a customer can still sign in and look at their washes, and specialists and admins carry on.
const PAUSED: [string, RegExp][] = [
  ['POST', /^\/payments\/(on-demand|membership-checkout)$/],
  ['POST', /^\/campaign\/claim$/],
  ['POST', /^\/membership-requests(\/[^/]+\/accept)?$/],
];

export const maintenanceGate: RequestHandler = asyncHandler(async (req, _res, next) => {
  if (!PAUSED.some(([method, re]) => method === req.method && re.test(req.path))) return next();
  const s = await publicSettings();
  if (s.maintenance_mode) throw new HttpError(503, 'maintenance', s.maintenance_message || 'WASHO is paused for a little while. Please check back soon.');
  next();
});
