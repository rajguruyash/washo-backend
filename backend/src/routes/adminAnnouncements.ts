import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { pushConfigured, sendPush } from '../push';

/**
 * Announcements from the Admin page: a short message that lands in customers' Notifications in the app. Who may send it is the Campaigns area
 * (access.ts), the rules and the delivery are in the database (migration 20261004000043); this validates what the admin typed and reads the history.
 */
export const adminAnnouncementsRouter = Router();
adminAnnouncementsRouter.use('/admin/announcements', requireSession, requireRole('admin'));

const NOT_READY = new HttpError(503, 'backend_not_ready', "Sending notifications isn't switched on yet. The database needs its latest update; please contact whoever looks after WASHO's website.");
const missingFunction = (err: unknown) => ['42883', '42P01'].includes((err as { code?: string }).code ?? '');

const sendBody = z.object({
  title: z.string().trim().min(1, 'Give the notification a title.').max(80, 'Keep the title to 80 characters.'),
  body: z.string().trim().min(1, 'Write the message.').max(500, 'Keep the message to 500 characters.'),
  audience: z.enum(['all', 'members']).default('all'),
});

adminAnnouncementsRouter.get(
  '/admin/announcements',
  asyncHandler(async (req, res) => {
    try {
      const announcements = await req.db(async (c) => (await c.query('SELECT public.admin_announcements_list() AS list')).rows[0].list);
      res.json({ success: true, announcements });
    } catch (err) {
      if (missingFunction(err)) throw NOT_READY;
      throw err;
    }
  })
);

/** How the push to phones went: `configured` is false when the server has no Firebase key (nothing was pushed; the notification is still in every customer's list). */
export interface PushSummary { configured: boolean; devices: number; sent: number; failed: number; removed: number }

/**
 * After an announcement is saved, push it to the phones of the customers who received it. Best effort and never an error for the admin: the notification is already in every
 * customer's list; this only makes it arrive at once on a phone whose app is closed. Phones Firebase says are gone are forgotten.
 */
async function pushAnnouncement(req: import('express').Request, id: string): Promise<PushSummary> {
  const none: PushSummary = { configured: pushConfigured(), devices: 0, sent: 0, failed: 0, removed: 0 };
  if (!none.configured) return none;
  try {
    const t = await req.db(async (c) => (await c.query('SELECT public.admin_announcement_push_targets($1) AS t', [id])).rows[0].t as { title: string; body: string; devices: { token: string; notification_id: string }[] });
    if (!t.devices.length) return none;
    const results = await sendPush(t.devices.map((d) => ({ token: d.token, title: t.title, body: t.body, data: { notification_id: d.notification_id, category: 'announcement', announcement_id: id } })));
    const dead = t.devices.filter((_, i) => results[i] === 'dead').map((d) => d.token);
    let removed = 0;
    if (dead.length) removed = await req.db(async (c) => (await c.query('SELECT public.admin_forget_device_tokens($1::text[]) AS n', [dead])).rows[0].n as number).catch(() => 0);
    return { configured: true, devices: t.devices.length, sent: results.filter((r) => r === 'sent').length, failed: results.filter((r) => r === 'failed').length, removed };
  } catch (err) {
    // the database without migration 47 has no phones to push to; anything else is logged, never shown as a failure of the send
    if (!missingFunction(err)) console.error('Announcement push failed:', err instanceof Error ? err.message : err);
    return none;
  }
}

adminAnnouncementsRouter.post(
  '/admin/announcements',
  asyncHandler(async (req, res) => {
    const b = parse(sendBody, req.body);
    try {
      const sent = await req.db(async (c) => (await c.query('SELECT public.admin_send_announcement($1, $2, $3) AS sent', [b.title, b.body, b.audience])).rows[0].sent);
      const push = await pushAnnouncement(req, sent.id);
      res.status(201).json({ success: true, ...sent, push });
    } catch (err) {
      if (missingFunction(err)) throw NOT_READY;
      throw err;
    }
  })
);
