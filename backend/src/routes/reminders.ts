import { isPhoneLoginEmail } from '../phone';
import crypto from 'crypto';
import { Router } from 'express';
import { config } from '../config';
import { HttpError } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { z } from 'zod';
import { parse } from '../errors';
import { mailConfigured } from '../notify';
import { loadRenewalSettings, runRenewalReminders, sendRenewal, stagesFor } from '../reminders';

export const remindersRouter = Router();

// Admin: "send the renewal reminders now" (or, with ?dry=1, "who would get one?"). The same job the site runs by itself every hour.
remindersRouter.post(
  '/admin/reminders/run',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, ...(await runRenewalReminders({ dryRun: req.query.dry === '1', manual: true })) });
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

// ───────────────────────── the renewal email controls (Admin -> Memberships) ─────────────────────────
// Who may do what is decided once, for every admin path (access.ts): reading is the Memberships area's "view", changing and sending is its "manage".
const uuid = z.string().uuid();
const stepSchema = z.object({ on: z.boolean(), days: z.number().int().min(0).max(14) });
const settingsSchema = z.object({ on: z.boolean(), week: stepSchema, last: stepSchema, ended: stepSchema, from_hour: z.number().int().min(0).max(23), to_hour: z.number().int().min(1).max(24) });

remindersRouter.get(
  '/admin/renewals',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const out = await req.db(async (c) => ({
      settings: (await c.query('SELECT public.admin_get_renewal_settings() AS s')).rows[0].s,
      ...((await c.query('SELECT public.admin_renewals_overview() AS o')).rows[0].o as { upcoming: unknown[]; recent: unknown[] }),
    }));
    res.json({ success: true, ...out, mail_ready: mailConfigured() });
  })
);

remindersRouter.put(
  '/admin/renewals/settings',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const b = parse(settingsSchema, req.body);
    const settings = await req.db(async (c) => (await c.query('SELECT public.admin_set_renewal_settings($1::jsonb) AS s', [JSON.stringify(b)])).rows[0].s);
    res.json({ success: true, settings });
  })
);

// "Send it now": one step of the renewal emails to one membership, whatever the dates (the database still refuses a second send of the same step).
remindersRouter.post(
  '/admin/renewals/:id/send',
  requireSession,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { step } = parse(z.object({ step: z.enum(['week', 'last', 'ended']) }), req.body);
    if (!mailConfigured()) throw new HttpError(503, 'mail_not_ready', 'Email is not set up on the server yet.');
    const cfg = await loadRenewalSettings();
    if (!stagesFor(cfg).some((s) => s.stage === step)) throw new HttpError(409, 'step_off', 'That email is switched off. Switch it on first.');
    const row = await req.db(async (c) => (await c.query('SELECT public.admin_renewal_row($1) AS r', [id])).rows[0].r as Record<string, unknown> & { email: string | null });
    if (!row.email || isPhoneLoginEmail(row.email)) throw new HttpError(422, 'no_email', 'This customer has no email address.');
    const result = await sendRenewal(step, row as never);
    if (result === 'already') throw new HttpError(409, 'already_sent', 'That email has already gone to this customer.');
    if (result === 'failed') throw new HttpError(502, 'send_failed', 'The email could not be sent. It is recorded, and the automatic job will try again.');
    res.json({ success: true });
  })
);
