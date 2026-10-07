import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requirePhone, requireRole, requireSession } from '../middleware/http';
import { campaignsNotInstalled } from '../campaigns';
import { notifyAdminOfRequest } from '../notify';
import { openOrder, reconcileOrder } from '../razorpay';

export const membershipsRouter = Router();
membershipsRouter.use(['/membership-requests', '/memberships'], requireSession, requireRole('customer'));

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a start date.');

const requestSchema = z.object({
  vehicle_id: z.string().uuid('Choose a vehicle.'),
  weekly_pattern: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), kind: z.enum(['body', 'deep']) }))
    .min(1, 'Choose your washes for the week.')
    .max(7),
  duration_months: z.number().int().refine((n) => [1, 3, 6, 12].includes(n), 'Choose 1, 3, 6 or 12 months.'),
  time_slot: z.enum(['morning', 'afternoon', 'night']),
  start_date: date,
  address_id: z.string().uuid().nullish(),
  parking_location: z.string().trim().max(160).optional(),
  customer_notes: z.string().trim().max(500).optional(),
});

// A request joined to its vehicle. The price columns are NULL until WASHO has approved a quote: the database function
// (my_membership_requests) hides them, so nothing here can leak an estimate.
const REQUESTS_SQL = `
  SELECT r.*, v.vehicle_type::text AS vehicle_type, v.make AS vehicle_make, v.model AS vehicle_model, v.registration_number
    FROM public.my_membership_requests() r JOIN public.vehicles v ON v.id = r.vehicle_id`;

// Plans the customer has cleared from their own pages (migration 21). Nothing is deleted: WASHO still sees everything. A database
// without migration 21 simply has nothing cleared, so the lists carry on as before.
const notCleared = (kind: 'membership' | 'membership_request', col: string) =>
  `NOT EXISTS (SELECT 1 FROM public.customer_hidden_plans h WHERE h.kind = '${kind}' AND h.ref_id = ${col})`;
async function listTolerant<T>(run: (hideCleared: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(true);
  } catch (err) {
    if (!campaignsNotInstalled(err)) throw err;
    return run(false);
  }
}

membershipsRouter.get(
  '/membership-requests',
  asyncHandler(async (req, res) => {
    const requests = await listTolerant((hide) =>
      req.db(async (c) => (await c.query(`${REQUESTS_SQL}${hide ? ` WHERE ${notCleared('membership_request', 'r.id')}` : ''} ORDER BY r.created_at DESC`)).rows)
    );
    res.json({ success: true, requests });
  })
);

membershipsRouter.get(
  '/membership-requests/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const request = await req.db(async (c) => (await c.query(`${REQUESTS_SQL} WHERE r.id = $1`, [id])).rows[0]);
    if (!request) throw new HttpError(404, 'not_found', 'Request not found');
    res.json({ success: true, request });
  })
);

membershipsRouter.post(
  '/membership-requests',
  asyncHandler(async (req, res) => {
    const r = parse(requestSchema, req.body);
    const { id, summary } = await req.db(async (c) => {
      const { rows } = await c.query(
        `SELECT public.create_membership_request($1, $2::jsonb, $3, $4::public.time_slot, $5::date, $6, $7, $8) AS id`,
        [r.vehicle_id, JSON.stringify(r.weekly_pattern), r.duration_months, r.time_slot, r.start_date, r.address_id ?? null, r.parking_location ?? null, r.customer_notes ?? null]
      );
      const reqId = rows[0].id as string;
      const s = (await c.query(`SELECT reference_code, frequency_per_week, duration_months, vehicle_type, vehicle_model, registration_number FROM (${REQUESTS_SQL}) x WHERE id = $1`, [reqId])).rows[0];
      return { id: reqId, summary: s };
    });
    void notifyAdminOfRequest({ ...summary, customer: req.session!.profile.full_name, phone: req.session!.profile.phone });
    res.status(201).json({ success: true, id, reference_code: summary.reference_code });
  })
);

// Pay for a quoted request (earlier requests WASHO has already priced): the database opens a PENDING payment for exactly the quoted
// amount as the customer, then the server opens the Razorpay order for that amount. No membership exists until payment is verified.
membershipsRouter.post(
  '/membership-requests/:id/accept',
  requirePhone,
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const intent = await req.db(async (c) => (await c.query('SELECT public.accept_membership_quote($1) AS r', [id])).rows[0].r);
    res.json({ success: true, order: await openOrder(req.session!.profile, intent) });
  })
);

membershipsRouter.post(
  '/membership-requests/:id/decline',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    await req.db((c) => c.query('SELECT public.decline_membership_quote($1)', [id]));
    res.json({ success: true });
  })
);

// Clear a plan from the customer's own pages: one they started but never paid for, or one that has ended. Nothing is deleted. An unpaid
// plan's checkout is stopped; an active membership, or a payment that has come in, is never touched (the database refuses).
membershipsRouter.post(
  '/membership-requests/:id/remove',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    // They may have paid in a UPI app without the browser reporting back: ask Razorpay first, so a real payment is recorded, not thrown away.
    try {
      const waiting = await req.db(async (c) => (await c.query(`SELECT provider_order_id FROM public.payments WHERE membership_request_id = $1 AND status = 'pending' AND provider_order_id IS NOT NULL`, [id])).rows as { provider_order_id: string }[]);
      for (const w of waiting) await reconcileOrder(w.provider_order_id, req.session!.profile.id, 'remove-plan');
    } catch (err) {
      console.warn('Re-checking a payment before removing a plan failed:', (err as Error).message);
    }
    const r = await req.db(async (c) => (await c.query(`SELECT public.remove_my_plan('membership_request', $1) AS r`, [id])).rows[0].r);
    res.json({ success: true, ...r });
  })
);

// ───────────────────────── active memberships ─────────────────────────
const MEMBERSHIP_SQL = `
  SELECT m.id, m.status, m.duration_months, m.start_at, m.end_at, m.base_amount_cents, m.discount_amount_cents, m.final_amount_cents,
         m.pricing_snapshot, r.reference_code, r.frequency_per_week, r.weekly_pattern, r.time_slot::text AS time_slot,
         v.id AS vehicle_id, v.vehicle_type::text AS vehicle_type, v.model AS vehicle_model, v.registration_number,
         (SELECT count(*)::int FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled') AS washes_total,
         (SELECT count(*)::int FROM public.bookings b WHERE b.membership_id = m.id AND b.status = 'completed') AS washes_completed,
         (SELECT to_jsonb(n) FROM (SELECT b.id, b.scheduled_date, b.time_slot::text AS time_slot, b.status::text AS status
                                     FROM public.bookings b WHERE b.membership_id = m.id AND b.status NOT IN ('completed', 'cancelled')
                                    ORDER BY b.scheduled_date, b.time_slot LIMIT 1) n) AS next_wash
    FROM public.memberships m
    LEFT JOIN public.my_membership_requests() r ON r.membership_id = m.id
    LEFT JOIN public.vehicles v ON v.id = COALESCE(r.vehicle_id, (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1))`;

membershipsRouter.get(
  '/memberships',
  asyncHandler(async (req, res) => {
    const memberships = await listTolerant((hide) =>
      req.db(async (c) => (await c.query(`${MEMBERSHIP_SQL}${hide ? ` WHERE ${notCleared('membership', 'm.id')}` : ''} ORDER BY m.created_at DESC`)).rows)
    );
    res.json({ success: true, memberships });
  })
);

// An ended membership, cleared from the customer's pages (never an active one).
membershipsRouter.post(
  '/memberships/:id/remove',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const r = await req.db(async (c) => (await c.query(`SELECT public.remove_my_plan('membership', $1) AS r`, [id])).rows[0].r);
    res.json({ success: true, ...r });
  })
);

membershipsRouter.get(
  '/memberships/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const out = await req.db(async (c) => {
      const membership = (await c.query(`${MEMBERSHIP_SQL} WHERE m.id = $1`, [id])).rows[0];
      if (!membership) return null;
      const washes = (
        await c.query(
          `SELECT b.id, b.reference_code, b.scheduled_date, b.time_slot::text AS time_slot, b.status::text AS status,
                  b.membership_schedule_occurrence_id AS occurrence_id, b.completed_at, s.name AS service_name, s.wash_kind
             FROM public.bookings b JOIN public.services s ON s.id = b.service_id
            WHERE b.membership_id = $1 ORDER BY b.scheduled_date, b.time_slot`,
          [id]
        )
      ).rows;
      return { membership, washes };
    });
    if (!out) throw new HttpError(404, 'not_found', 'Membership not found');
    res.json({ success: true, ...out });
  })
);
