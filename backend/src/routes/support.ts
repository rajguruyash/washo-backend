import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { notifyAdminOfComplaint } from '../notify';

/** A customer's complaints: raise one (optionally about a wash), follow the answers, write back. Everything about who may see what is in the database (migration 27). */
export const supportRouter = Router();
supportRouter.use('/support', requireSession, requireRole('customer'));

const uuid = z.string().uuid();
const message = z.string().trim().min(1, 'Write your message.').max(2000, 'Keep it under 2000 characters.');

supportRouter.get(
  '/support',
  asyncHandler(async (req, res) => {
    const tickets = await req.db(async (c) => (await c.query('SELECT public.my_support_tickets() AS t')).rows[0].t);
    res.json({ success: true, tickets });
  })
);

supportRouter.post(
  '/support',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        category: z.enum(['payment', 'booking', 'specialist', 'refund', 'membership', 'other'], 'Choose what this is about.'),
        subject: z.string().trim().min(3, 'Give it a short title.').max(120, 'Keep the title under 120 characters.'),
        message: z.string().trim().min(5, 'Tell us what happened.').max(2000, 'Keep it under 2000 characters.'),
        booking_id: z.string().uuid().nullish(),
      }),
      req.body
    );
    const ticket = await req.db(async (c) => (await c.query('SELECT public.create_support_ticket($1, $2, $3, $4) AS t', [b.category, b.subject, b.message, b.booking_id ?? null])).rows[0].t as { id: string; reference_code: string });
    // Tell WASHO. Best effort: the complaint is saved whether or not the email goes.
    void notifyAdminOfComplaint({ reference_code: ticket.reference_code, category: b.category, subject: b.subject, message: b.message, customer: req.session!.profile.full_name, phone: req.session!.profile.phone });
    res.status(201).json({ success: true, ticket });
  })
);

supportRouter.get(
  '/support/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const out = await req.db(async (c) => (await c.query('SELECT public.my_support_ticket($1) AS t', [id])).rows[0].t);
    if (!out) throw new HttpError(404, 'not_found', 'Complaint not found');
    res.json({ success: true, ...out });
  })
);

supportRouter.post(
  '/support/:id/reply',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ message }), req.body);
    await req.db((c) => c.query('SELECT public.reply_to_my_ticket($1, $2)', [id, b.message]));
    res.json({ success: true });
  })
);
