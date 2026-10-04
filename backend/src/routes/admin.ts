import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { refundPayment } from '../razorpay';
import { photoStorage } from '../supabase';

export const adminRouter = Router();
adminRouter.use('/admin', requireSession, requireRole('admin'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slot = z.enum(['morning', 'afternoon', 'night']);

// ───────────────────────── overview ─────────────────────────
adminRouter.get(
  '/admin/overview',
  asyncHandler(async (req, res) => {
    const overview = await req.db(async (c) => {
      const { rows } = await c.query(`
        WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d)
        SELECT
          (SELECT count(*)::int FROM public.membership_requests WHERE status = 'submitted') AS requests_to_quote,
          (SELECT count(*)::int FROM public.membership_requests WHERE status = 'quoted' AND quote_expires_at > now()) AS quotes_awaiting_customer,
          (SELECT count(*)::int FROM public.bookings b, today t WHERE b.scheduled_date = t.d AND b.status NOT IN ('cancelled','refunded','refund_requested')) AS washes_today,
          (SELECT count(*)::int FROM public.bookings b, today t WHERE b.scheduled_date = t.d AND b.status = 'completed') AS washes_done_today,
          (SELECT count(*)::int FROM public.bookings b, today t
            WHERE b.scheduled_date BETWEEN t.d AND t.d + 3 AND b.status = 'confirmed'
              AND NOT EXISTS (SELECT 1 FROM public.worker_assignments wa WHERE wa.booking_id = b.id AND wa.is_active)) AS unassigned_next_3_days,
          (SELECT count(*)::int FROM public.booking_events WHERE event_type = 'worker_issue' AND created_at > now() - interval '24 hours') AS issues_24h,
          (SELECT count(*)::int FROM public.payments WHERE fulfilment_status = 'unfulfilled') AS unfulfilled_payments,
          (SELECT count(*)::int FROM public.refunds WHERE status IN ('requested', 'approved')) AS refunds_requested,
          (SELECT count(*)::int FROM public.memberships WHERE status = 'active') AS active_memberships`);
      return rows[0];
    });
    res.json({ success: true, overview });
  })
);

// ───────────────────────── membership requests (approve / quote) ─────────────────────────
adminRouter.get(
  '/admin/membership-requests',
  asyncHandler(async (req, res) => {
    const status = parse(z.enum(['submitted', 'quoted', 'accepted', 'active', 'rejected', 'declined', 'expired', 'cancelled']).optional().catch(undefined), req.query.status);
    const requests = await req.db(async (c) => (await c.query('SELECT public.admin_list_membership_requests($1) AS r', [status ?? null])).rows[0].r);
    res.json({ success: true, requests });
  })
);

adminRouter.post(
  '/admin/membership-requests/:id/review',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(
      z.object({
        action: z.enum(['quote', 'reject']),
        adjustment_cents: z.number().int().min(-100_000_00).max(100_000_00).optional(),
        adjustment_reason: z.string().trim().max(200).optional(),
        rejection_reason: z.string().trim().max(300).optional(),
      }),
      req.body
    );
    const result = await req.db(async (c) =>
      (await c.query('SELECT public.admin_review_membership_request($1, $2, $3, $4, $5) AS r', [id, b.action, b.adjustment_cents ?? 0, b.adjustment_reason ?? null, b.rejection_reason ?? null])).rows[0].r
    );
    res.json({ success: true, result });
  })
);

// ───────────────────────── bookings ─────────────────────────
const ADMIN_BOOKING_SQL = `
  SELECT b.id, b.reference_code, b.status::text AS status, b.booking_type::text AS booking_type, b.scheduled_date, b.time_slot::text AS time_slot,
         b.membership_id, b.price_cents, b.customer_confirmed_at, b.parking_location, b.cancel_reason,
         s.name AS service_name, s.wash_kind,
         v.vehicle_type::text AS vehicle_type, v.model AS vehicle_model, v.registration_number, v.color AS vehicle_color,
         p.id AS customer_id, p.full_name AS customer_name, p.phone AS customer_phone,
         a.society_name, a.building_block, a.flat_number,
         wp.id AS worker_id, wp.full_name AS worker_name
    FROM public.bookings b
    JOIN public.services s ON s.id = b.service_id
    JOIN public.vehicles v ON v.id = b.vehicle_id
    JOIN public.profiles p ON p.id = b.customer_profile_id
    LEFT JOIN public.customer_addresses a ON a.id = COALESCE(b.address_id, v.address_id)
    LEFT JOIN public.worker_assignments wa ON wa.booking_id = b.id AND wa.is_active
    LEFT JOIN public.profiles wp ON wp.id = wa.worker_profile_id`;

adminRouter.get(
  '/admin/bookings',
  asyncHandler(async (req, res) => {
    const q = parse(
      z.object({
        from: isoDate.optional().catch(undefined),
        to: isoDate.optional().catch(undefined),
        status: z.string().regex(/^[a-z_]+$/).optional().catch(undefined),
        worker: z.string().uuid().optional().catch(undefined),
        unassigned: z.enum(['1']).optional().catch(undefined),
        membership: z.string().uuid().optional().catch(undefined),
      }),
      req.query
    );
    const bookings = await req.db(async (c) =>
      (
        await c.query(
          `${ADMIN_BOOKING_SQL}
            WHERE ($1::date IS NULL OR b.scheduled_date >= $1) AND ($2::date IS NULL OR b.scheduled_date <= $2)
              AND ($3::text IS NULL OR b.status::text = $3) AND ($4::uuid IS NULL OR wp.id = $4)
              AND ($5::text IS NULL OR wp.id IS NULL) AND ($6::uuid IS NULL OR b.membership_id = $6)
            ORDER BY b.scheduled_date, b.time_slot, b.created_at LIMIT 400`,
          [q.from ?? null, q.to ?? null, q.status ?? null, q.worker ?? null, q.unassigned ?? null, q.membership ?? null]
        )
      ).rows
    );
    res.json({ success: true, bookings });
  })
);

adminRouter.get(
  '/admin/bookings/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const out = await req.db(async (c) => {
      const booking = (await c.query(`${ADMIN_BOOKING_SQL} WHERE b.id = $1`, [id])).rows[0];
      if (!booking) return null;
      const events = (
        await c.query(
          `SELECT e.event_type, e.created_at, e.event_metadata AS meta, ap.full_name AS actor_name, ap.role::text AS actor_role
             FROM public.booking_events e LEFT JOIN public.profiles ap ON ap.id = e.actor_profile_id
            WHERE e.booking_id = $1 ORDER BY e.created_at, e.id`,
          [id]
        )
      ).rows;
      const photoRows = (await c.query('SELECT * FROM public.booking_photos_for_viewer($1)', [id])).rows;
      return { booking, events, photoRows };
    });
    if (!out) throw new HttpError(404, 'not_found', 'Booking not found');
    const photos = await Promise.all(out.photoRows.map(async (p: any) => ({ id: p.id, phase: p.phase, photo_type: p.photo_type, created_at: p.created_at, url: await photoStorage.signedUrl(p.storage_path) })));
    res.json({ success: true, booking: out.booking, events: out.events, photos });
  })
);

adminRouter.post(
  '/admin/bookings/:id/assign',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { worker_profile_id } = parse(z.object({ worker_profile_id: z.string().uuid('Choose a specialist.') }), req.body);
    await req.db((c) => c.query('SELECT public.admin_assign_worker($1, $2)', [id, worker_profile_id]));
    res.json({ success: true });
  })
);

adminRouter.post(
  '/admin/bookings/:id/reschedule',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ date: isoDate, time_slot: slot, reason: z.string().trim().max(200).optional() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_reschedule_wash($1, $2::date, $3::public.time_slot, $4)', [id, b.date, b.time_slot, b.reason ?? null]));
    res.json({ success: true });
  })
);

adminRouter.post(
  '/admin/bookings/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(200) }), req.body);
    await req.db((c) => c.query('SELECT public.cancel_customer_booking($1, $2)', [id, reason]));
    res.json({ success: true });
  })
);

// ───────────────────────── memberships ─────────────────────────
adminRouter.get(
  '/admin/memberships',
  asyncHandler(async (req, res) => {
    const memberships = await req.db(async (c) =>
      (
        await c.query(`
          SELECT m.id, m.status, m.duration_months, m.start_at, m.end_at, m.final_amount_cents, r.reference_code, r.frequency_per_week, r.weekly_pattern, r.time_slot::text AS time_slot,
                 p.id AS customer_id, p.full_name AS customer_name, p.phone AS customer_phone,
                 v.vehicle_type::text AS vehicle_type, v.model AS vehicle_model, v.registration_number,
                 wp.id AS worker_id, wp.full_name AS worker_name,
                 (SELECT count(*)::int FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled') AS washes_total,
                 (SELECT count(*)::int FROM public.bookings b WHERE b.membership_id = m.id AND b.status = 'completed') AS washes_completed,
                 (SELECT min(b.scheduled_date) FROM public.bookings b WHERE b.membership_id = m.id AND b.status NOT IN ('completed','cancelled')) AS next_wash_date
            FROM public.memberships m
            JOIN public.profiles p ON p.id = m.customer_profile_id
            LEFT JOIN public.membership_requests r ON r.id = m.membership_request_id
            LEFT JOIN public.vehicles v ON v.id = COALESCE(r.vehicle_id, (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1))
            LEFT JOIN public.profiles wp ON wp.id = m.assigned_worker_profile_id
           ORDER BY (m.status = 'active') DESC, m.created_at DESC LIMIT 300`)
      ).rows
    );
    res.json({ success: true, memberships });
  })
);

// One specialist for the rest of the membership; moved washes return to them. null releases the washes to the pool.
adminRouter.post(
  '/admin/memberships/:id/assign-worker',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { worker_profile_id } = parse(z.object({ worker_profile_id: z.string().uuid().nullable() }), req.body);
    const result = await req.db(async (c) => (await c.query('SELECT public.admin_assign_membership_worker($1, $2) AS r', [id, worker_profile_id])).rows[0].r);
    res.json({ success: true, result });
  })
);

// ───────────────────────── specialists, and things that need a human ─────────────────────────
adminRouter.get(
  '/admin/workers',
  asyncHandler(async (req, res) => {
    const workers = await req.db(async (c) =>
      (
        await c.query(`
          SELECT p.id, p.full_name, p.phone,
                 (SELECT count(*)::int FROM public.worker_assignments wa JOIN public.bookings b ON b.id = wa.booking_id
                   WHERE wa.worker_profile_id = p.id AND wa.is_active AND b.status NOT IN ('completed','cancelled')
                     AND b.scheduled_date BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date AND (now() AT TIME ZONE 'Asia/Kolkata')::date + 7) AS washes_next_7_days
            FROM public.profiles p WHERE p.role = 'worker' ORDER BY p.full_name NULLS LAST`)
      ).rows
    );
    res.json({ success: true, workers });
  })
);

// Money that arrived but could not be turned into a booking/membership, and the refund requests that follow.
// An admin approves a refund and the server asks Razorpay to pay it back (below); nothing is refunded without that approval.
// failure_reason arrives with migration 12; reading it as JSON keeps this list working on a database that does not have it yet.
adminRouter.get(
  '/admin/attention',
  asyncHandler(async (req, res) => {
    const out = await req.db(async (c) => ({
      unfulfilled: (
        await c.query(`SELECT pay.id, pay.amount_cents, pay.payment_kind, pay.provider_payment_id, pay.updated_at, p.full_name AS customer_name, p.phone AS customer_phone
                         FROM public.payments pay JOIN public.profiles p ON p.id = pay.customer_profile_id
                        WHERE pay.fulfilment_status = 'unfulfilled' ORDER BY pay.updated_at DESC LIMIT 50`)
      ).rows,
      refunds: (
        await c.query(`SELECT r.id, r.amount_cents, r.reason, r.status::text AS status, to_jsonb(r) ->> 'failure_reason' AS failure_reason, r.created_at, p.full_name AS customer_name, p.phone AS customer_phone
                         FROM public.refunds r JOIN public.profiles p ON p.id = r.customer_profile_id
                        WHERE r.status IN ('requested', 'approved', 'failed') ORDER BY r.created_at DESC LIMIT 50`)
      ).rows,
    }));
    res.json({ success: true, ...out });
  })
);

// Approve and pay: the database claims the refund (so two admins cannot pay it twice), Razorpay refunds the ORIGINAL payment
// for the full amount, and only then is it recorded as processed. If Razorpay says no, the reason is kept and it can be retried.
adminRouter.post(
  '/admin/refunds/:id/approve',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const claim = await req.db(async (c) => (await c.query('SELECT public.admin_begin_refund($1) AS r', [id])).rows[0].r as {
      amount_cents: number; provider_payment_id: string;
    });
    const outcome = await refundPayment({ refundId: id, providerPaymentId: claim.provider_payment_id, amountPaise: claim.amount_cents });
    if (!outcome.ok) {
      await req.db((c) => c.query('SELECT public.admin_fail_refund($1, $2)', [id, outcome.reason ?? null]));
      throw new HttpError(502, 'refund_failed', `Razorpay did not accept the refund: ${outcome.reason ?? 'unknown reason'}. Nothing was refunded; you can try again.`);
    }
    await req.db((c) => c.query('SELECT public.admin_finish_refund($1, $2)', [id, outcome.refundId]));
    res.json({ success: true, provider_refund_id: outcome.refundId });
  })
);

adminRouter.post(
  '/admin/refunds/:id/resolve',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ status: z.enum(['approved', 'processed', 'failed']), provider_refund_id: z.string().trim().max(64).optional() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_resolve_refund($1, $2::public.refund_status, $3)', [id, b.status, b.provider_refund_id ?? null]));
    res.json({ success: true });
  })
);

// ───────────────────────── customers and specialists ─────────────────────────
adminRouter.get(
  '/admin/customers',
  asyncHandler(async (req, res) => {
    const q = parse(z.string().trim().max(60).optional().catch(undefined), req.query.q);
    const customers = await req.db(async (c) =>
      (
        await c.query(
          `SELECT p.id, p.full_name, p.phone, p.email, p.signup_source, p.created_at,
                  (SELECT count(*)::int FROM public.vehicles v WHERE v.customer_profile_id = p.id AND v.is_active) AS vehicles,
                  (SELECT count(*)::int FROM public.memberships m WHERE m.customer_profile_id = p.id AND m.status = 'active') AS active_memberships,
                  (SELECT count(*)::int FROM public.bookings b WHERE b.customer_profile_id = p.id) AS washes
             FROM public.profiles p
            WHERE p.role = 'customer' AND ($1::text IS NULL OR p.full_name ILIKE '%' || $1 || '%' OR p.phone ILIKE '%' || $1 || '%')
            ORDER BY p.created_at DESC LIMIT 100`,
          [q || null]
        )
      ).rows
    );
    res.json({ success: true, customers });
  })
);

// Creates the email + password login for a new specialist (the database function creates the Auth user and the profile).
adminRouter.post(
  '/admin/workers',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        full_name: z.string().trim().min(2, 'Enter their name.').max(80),
        email: z.email('Enter a valid email address.'),
        phone: z.string().trim().regex(/^\+?[0-9 ]{10,15}$/, 'Enter a valid phone number.'),
        password: z.string().min(8, 'Use at least 8 characters.').max(100),
      }),
      req.body
    );
    const result = await req.db(async (c) => (await c.query('SELECT public.admin_create_worker($1, $2, $3, $4) AS r', [b.full_name, b.email, b.phone, b.password])).rows[0].r);
    res.status(201).json({ success: true, worker: { id: result.profile_id, full_name: result.full_name, email: result.email } });
  })
);

adminRouter.put(
  '/admin/workers/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ full_name: z.string().trim().min(2).max(80), phone: z.string().trim().regex(/^\+?[0-9 ]{10,15}$/, 'Enter a valid phone number.') }), req.body);
    await req.db((c) => c.query('SELECT public.admin_update_worker($1, $2, $3)', [id, b.full_name, b.phone]));
    res.json({ success: true });
  })
);
