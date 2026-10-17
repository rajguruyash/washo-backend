import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireSession } from '../middleware/http';

/**
 * The phone's push address. After sign-in the mobile app hands over the Firebase device token Android gave it, so WASHO can push a notification to the phone while the app is closed;
 * on sign-out it takes it back. Which messages are pushed is decided elsewhere (see push.ts and adminAnnouncements.ts); the rules are in the database (migration 20261004000047).
 */
export const devicesRouter = Router();
devicesRouter.use('/devices', requireSession);

const NOT_READY = new HttpError(503, 'backend_not_ready', "Push notifications aren't switched on yet. The database needs its latest update; please contact whoever looks after WASHO's website.");
const missingFunction = (err: unknown) => ['42883', '42P01'].includes((err as { code?: string }).code ?? '');

const register = z.object({
  token: z.string().trim().min(20, 'That is not a valid device token.').max(4096, 'That is not a valid device token.'),
  platform: z.enum(['android', 'ios']).default('android'),
  app_version: z.string().trim().max(40).optional(),
});

devicesRouter.put(
  '/devices',
  asyncHandler(async (req, res) => {
    const b = parse(register, req.body);
    try {
      await req.db((c) => c.query('SELECT public.register_device_token($1, $2, $3)', [b.token, b.platform, b.app_version ?? null]));
    } catch (err) {
      if (missingFunction(err)) throw NOT_READY;
      throw err;
    }
    res.json({ success: true });
  })
);

devicesRouter.post(
  '/devices/remove',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ token: z.string().trim().min(1).max(4096) }), req.body);
    try {
      await req.db((c) => c.query('SELECT public.unregister_device_token($1)', [b.token]));
    } catch (err) {
      if (missingFunction(err)) throw NOT_READY;
      throw err;
    }
    res.json({ success: true });
  })
);
