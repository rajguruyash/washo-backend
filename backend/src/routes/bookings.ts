import crypto from 'crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { invokeFunction, photoStorage } from '../supabase';

export const bookingsRouter = Router();
bookingsRouter.use(['/bookings', '/payments'], requireSession);

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.');
const slot = z.enum(['morning', 'afternoon', 'night']);

const LIVE = `('pending','confirmed','worker_assigned','worker_called','call_not_picked_up','in_progress')`;

// What a customer reads about a wash. Joined for display only; every rule lives in the database.
export const BOOKING_SQL = `
  SELECT b.id, b.reference_code, b.status::text AS status, b.booking_type::text AS booking_type, b.scheduled_date, b.time_slot::text AS time_slot,
         b.membership_id, b.membership_schedule_occurrence_id AS occurrence_id, b.price_cents, b.parking_location, b.target_completion_time,
         b.customer_confirmed_at, b.created_at, b.completed_at, b.cancel_reason, s.name AS service_name, s.wash_kind,
         v.id AS vehicle_id, v.vehicle_type::text AS vehicle_type, v.make AS vehicle_make, v.model AS vehicle_model, v.registration_number
    FROM public.bookings b
    JOIN public.services s ON s.id = b.service_id
    JOIN public.vehicles v ON v.id = b.vehicle_id`;

// ───────────────────────── customer: list / detail ─────────────────────────
bookingsRouter.get(
  '/bookings',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const scope = parse(z.enum(['upcoming', 'past', 'all']).catch('all'), req.query.scope);
    const bookings = await req.db(async (c) => {
      const where =
        scope === 'upcoming'
          ? `WHERE b.status IN ${LIVE} ORDER BY b.scheduled_date, b.time_slot`
          : scope === 'past'
            ? `WHERE b.status NOT IN ${LIVE} ORDER BY b.scheduled_date DESC, b.created_at DESC`
            : `ORDER BY b.scheduled_date DESC, b.time_slot`;
      return (await c.query(`${BOOKING_SQL} ${where} LIMIT 200`)).rows;
    });
    res.json({ success: true, bookings });
  })
);

const TIMELINE = ['booking_created', 'worker_assigned', 'worker_called', 'customer_confirmed', 'call_not_picked_up', 'wash_started', 'wash_completed', 'rescheduled', 'cancelled', 'refund_requested', 'refunded'];

bookingsRouter.get(
  '/bookings/:id',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const out = await req.db(async (c) => {
      const booking = (await c.query(`${BOOKING_SQL} WHERE b.id = $1`, [id])).rows[0];
      if (!booking) return null;
      const events = (
        await c.query(
          `SELECT event_type, created_at, event_metadata - 'notes' - 'note' AS meta FROM public.booking_events
            WHERE booking_id = $1 AND event_type = ANY($2) ORDER BY created_at, id`,
          [id, TIMELINE]
        )
      ).rows;
      return { booking, events };
    });
    if (!out) throw new HttpError(404, 'not_found', 'Booking not found');
    res.json({ success: true, ...out });
  })
);

bookingsRouter.post(
  '/bookings/:id/cancel',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { reason } = parse(z.object({ reason: z.string().trim().max(200).optional() }), req.body);
    await req.db((c) => c.query('SELECT public.cancel_customer_booking($1, $2)', [id, reason || 'Customer requested cancellation']));
    res.json({ success: true });
  })
);

// Membership washes can be moved (never cancelled). The database enforces notice, term, vehicle-per-day and ownership.
bookingsRouter.post(
  '/bookings/:id/reschedule',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const body = parse(z.object({ date: isoDate, time_slot: slot }), req.body);
    await req.db(async (c) => {
      const row = (await c.query('SELECT membership_schedule_occurrence_id AS occ FROM public.bookings WHERE id = $1', [id])).rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'Booking not found');
      if (!row.occ) throw new HttpError(422, 'not_a_membership_wash', 'Only membership washes can be rescheduled. Cancel and rebook instead.');
      await c.query('SELECT public.reschedule_booking_occurrence($1, $2::date, $3::public.time_slot)', [row.occ, body.date, body.time_slot]);
    });
    res.json({ success: true });
  })
);

// ───────────────────────── photos (customer, the holding worker, admin) ─────────────────────────
bookingsRouter.get(
  '/bookings/:id/photos',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const rows = await req.db(async (c) => (await c.query('SELECT * FROM public.booking_photos_for_viewer($1)', [id])).rows);
    const photos = await Promise.all(
      rows.map(async (p) => ({ id: p.id, phase: p.phase, photo_type: p.photo_type, created_at: p.created_at, url: await photoStorage.signedUrl(p.storage_path) }))
    );
    res.json({ success: true, photos });
  })
);

const sniff = (b: Buffer): { mime: string; ext: string } | null => {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
};

// A worker adds a before/after photo. The database row is written FIRST, inside the worker's own transaction:
// save_booking_photo refuses unless they hold this wash and it is open, and pins the path to the wash's folder.
// Only then is the file stored, and the row is committed only if the file was.
bookingsRouter.post(
  '/bookings/:id/photos',
  requireRole('worker'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: config.photos.maxBytes }),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const q = parse(z.object({ phase: z.enum(['before', 'after']), type: z.enum(['front', 'rear', 'left', 'right', 'additional']) }), req.query);
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, 'no_photo', 'Choose a photo to upload.');
    const kind = sniff(bytes);
    if (!kind) throw new HttpError(415, 'bad_photo', 'Please upload a JPG, PNG or WebP photo.');

    const path = `${id}/${q.phase}-${q.type}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${kind.ext}`;
    const photoId = await req.db(async (c) => {
      const { rows } = await c.query('SELECT public.save_booking_photo($1, $2, $3, $4, $5::jsonb) AS id', [
        id, q.phase, q.type, path, JSON.stringify({ bytes: bytes.length, source: 'website' }),
      ]);
      await photoStorage.upload(path, bytes, kind.mime);
      return rows[0].id as string;
    });
    res.status(201).json({ success: true, id: photoId });
  })
);

// ───────────────────────── payments (the edge functions do the work; this relays as the customer) ─────────────────────────
const onDemandSchema = z.object({
  vehicle_id: z.string().uuid('Choose a vehicle.'),
  service_id: z.string().uuid('Choose a service.'),
  scheduled_date: isoDate,
  time_slot: slot,
  address_id: z.string().uuid().nullish(),
  parking_location: z.string().trim().max(160).optional(),
  target_completion_time: z.string().trim().max(40).optional(),
});

// The amount is decided by the database from the rate card. This route accepts no amount at all.
bookingsRouter.post(
  '/payments/on-demand',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const b = parse(onDemandSchema, req.body);
    const order = await invokeFunction('create-razorpay-order', { type: 'on_demand', ...b, source: 'website' }, req.session!.accessToken);
    res.json({ success: true, order });
  })
);

bookingsRouter.post(
  '/payments/verify',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({ razorpay_order_id: z.string().min(5).max(64), razorpay_payment_id: z.string().min(5).max(64), razorpay_signature: z.string().min(10).max(128) }),
      req.body
    );
    const result = await invokeFunction('verify-razorpay-payment', body, req.session!.accessToken);
    res.json({ success: true, result });
  })
);

bookingsRouter.get(
  '/payments/:id',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const status = await req.db(async (c) => (await c.query('SELECT public.my_payment_status($1) AS s', [id])).rows[0].s);
    if (!status) throw new HttpError(404, 'not_found', 'Payment not found');
    res.json({ success: true, payment: status });
  })
);
