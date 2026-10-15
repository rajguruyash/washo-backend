import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';

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

adminAnnouncementsRouter.post(
  '/admin/announcements',
  asyncHandler(async (req, res) => {
    const b = parse(sendBody, req.body);
    try {
      const sent = await req.db(async (c) => (await c.query('SELECT public.admin_send_announcement($1, $2, $3) AS sent', [b.title, b.body, b.audience])).rows[0].sent);
      res.status(201).json({ success: true, ...sent });
    } catch (err) {
      if (missingFunction(err)) throw NOT_READY;
      throw err;
    }
  })
);
