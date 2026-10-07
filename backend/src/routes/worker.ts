import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';

export const workerRouter = Router();
workerRouter.use('/worker', requireSession, requireRole('worker'));

const uuid = z.string().uuid();

// worker_queue() returns only the washes this specialist holds (full details) plus recent changes (no customer details).
workerRouter.get(
  '/worker/queue',
  asyncHandler(async (req, res) => {
    const days = parse(z.coerce.number().int().min(1).max(60).catch(7), req.query.days);
    const queue = await req.db(async (c) => (await c.query('SELECT * FROM public.worker_queue($1)', [days])).rows);
    res.json({ success: true, queue });
  })
);

// Unclaimed, paid washes: date, slot, service, vehicle type and society only. No names, numbers or flats.
workerRouter.get(
  '/worker/pool',
  asyncHandler(async (req, res) => {
    const pool = await req.db(async (c) => (await c.query('SELECT * FROM public.worker_pool(14)')).rows);
    res.json({ success: true, pool });
  })
);

const freshRow = async (req: Express.Request & { db: any }, id: string) =>
  req.db(async (c: any) => (await c.query('SELECT * FROM public.worker_queue(60) WHERE booking_id = $1', [id])).rows[0] ?? null);

type Step = (c: any, id: string, body: any) => Promise<unknown>;
const STEPS: Record<string, { sql: Step; schema?: z.ZodType }> = {
  claim: { sql: (c, id) => c.query('SELECT public.worker_claim_booking($1)', [id]) },
  call: { sql: (c, id) => c.query('SELECT public.worker_call_customer($1)', [id]) },
  confirm: { sql: (c, id) => c.query('SELECT public.worker_confirm_customer($1)', [id]) },
  'not-picked-up': {
    schema: z.object({ notes: z.string().trim().max(300).optional() }),
    sql: (c, id, b) => c.query('SELECT public.worker_customer_unavailable($1, $2)', [id, b.notes || 'Customer did not pick up / unavailable']),
  },
  // The customer's vehicle is not available that day: the specialist moves this membership wash to another day (and window, if they like).
  // The database applies the membership's own rules (inside the term, not on a day the vehicle already has a wash) and keeps the wash with them.
  reschedule: {
    schema: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the new date.'),
      time_slot: z.enum(['morning', 'afternoon', 'night']).optional(),
      reason: z.string().trim().max(300).optional(),
    }),
    sql: (c, id, b) => c.query('SELECT public.worker_reschedule_wash($1, $2::date, $3::public.time_slot, $4)', [id, b.date, b.time_slot ?? null, b.reason || null]),
  },
  start: { sql: (c, id) => c.query('SELECT public.worker_start_wash($1)', [id]) },
  complete: { sql: (c, id) => c.query('SELECT public.worker_complete_wash($1)', [id]) },
  issue: {
    schema: z.object({
      kind: z.enum(['customer_unavailable', 'vehicle_not_accessible', 'no_water_or_power', 'damage_noticed', 'safety_concern', 'other']),
      notes: z.string().trim().max(1000).optional(),
    }),
    sql: (c, id, b) => c.query('SELECT public.worker_report_issue($1, $2, $3)', [id, b.kind, b.notes ?? null]),
  },
  note: {
    schema: z.object({ note: z.string().trim().min(2, 'Write a short note first.').max(1000) }),
    sql: (c, id, b) => c.query('SELECT public.worker_add_note($1, $2)', [id, b.note]),
  },
};

// Every step is one database function. The database decides whether this worker may take it (they must hold the wash,
// it must be in the right state, completion needs before + after photos) and writes the booking event.
workerRouter.post(
  '/worker/washes/:id/:step',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const step = STEPS[String(req.params.step)];
    if (!step) throw new HttpError(404, 'not_found', 'Unknown step');
    const body = step.schema ? parse(step.schema, req.body ?? {}) : {};
    await req.db((c) => step.sql(c, id, body));
    res.json({ success: true, wash: await freshRow(req as any, id) });
  })
);
