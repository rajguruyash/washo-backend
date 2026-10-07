import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { HttpError } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { runRenewalReminders } from '../reminders';

export const remindersRouter = Router();

// Admin: "send the renewal reminders now" (or, with ?dry=1, "who would get one?"). The same job the site runs by itself every hour.
remindersRouter.post(
  '/admin/reminders/run',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await runRenewalReminders({ dryRun: req.query.dry === '1' })) });
  })
);

// An outside scheduler (Render Cron Job, cron-job.org, GitHub Actions) can trigger the same job with the CRON_SECRET from the server's environment.
// With no CRON_SECRET set this does not exist.
remindersRouter.post(
  '/cron/reminders',
  asyncHandler(async (req, res) => {
    const secret = config.cronSecret;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const ok = secret.length >= 16 && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!ok) throw new HttpError(404, 'not_found', 'Not found');
    res.json({ success: true, ...(await runRenewalReminders()) });
  })
);
