import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { phoneSchema } from '../phone';
import { fetchGatewayPayment } from '../razorpay';
import { forgetProfile } from '../profile';
import { gotrueAdmin } from '../supabase';

/**
 * What the Admin page needs to create, edit and "delete" things: customers (and their vehicles and addresses), specialists,
 * washes, services, prices and discounts. Every rule lives in the database (migration 20261004000013); this is validation of what
 * the browser sent, plus the few things only Supabase Auth can do. "Delete" is ARCHIVE: nothing is ever removed.
 */
export const adminManageRouter = Router();
adminManageRouter.use('/admin', requireSession, requireRole('admin'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const slot = z.enum(['morning', 'afternoon', 'night']);
const vehicleType = z.enum(['bike', 'car', 'suv']);
const status3 = z.enum(['active', 'archived', 'all']).catch('active');
const text = (max: number) => z.string().trim().max(max);
const optText = (max: number) => text(max).optional();

const call = <T = unknown>(req: { db: <R>(fn: (c: import('pg').PoolClient) => Promise<R>) => Promise<R> }, sql: string, params: unknown[]) =>
  req.db(async (c) => (await c.query(sql, params)).rows[0] as T);

// ───────────────────────── customers ─────────────────────────
adminManageRouter.get(
  '/admin/customers',
  asyncHandler(async (req, res) => {
    const q = parse(z.string().trim().max(60).optional().catch(undefined), req.query.q);
    const which = parse(status3, req.query.status);
    const customers = await req.db(async (c) =>
      (
        await c.query(
          `SELECT p.id, p.full_name, p.phone, p.email, p.signup_source, p.created_at,
                  (to_jsonb(p) ->> 'archived_at') IS NOT NULL AS archived,
                  (SELECT count(*)::int FROM public.vehicles v WHERE v.customer_profile_id = p.id AND v.is_active) AS vehicles,
                  (SELECT count(*)::int FROM public.memberships m WHERE m.customer_profile_id = p.id AND m.status = 'active') AS active_memberships,
                  (SELECT count(*)::int FROM public.bookings b WHERE b.customer_profile_id = p.id) AS washes
             FROM public.profiles p
            WHERE p.role = 'customer'
              AND ($1::text IS NULL OR p.full_name ILIKE '%' || $1 || '%' OR p.phone ILIKE '%' || $1 || '%' OR p.email ILIKE '%' || $1 || '%')
              AND ($2 = 'all' OR (($2 = 'archived') = ((to_jsonb(p) ->> 'archived_at') IS NOT NULL)))
            ORDER BY p.created_at DESC LIMIT 200`,
          [q || null, which]
        )
      ).rows
    );
    res.json({ success: true, customers });
  })
);

adminManageRouter.get(
  '/admin/customers/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const out = await req.db(async (c) => {
      const customer = (
        await c.query(
          `SELECT p.id, p.full_name, p.phone, p.email, p.signup_source, p.created_at, (to_jsonb(p) ->> 'archived_at') IS NOT NULL AS archived
             FROM public.profiles p WHERE p.id = $1 AND p.role = 'customer'`,
          [id]
        )
      ).rows[0];
      if (!customer) return null;
      const vehicles = (
        await c.query(
          `SELECT id, vehicle_type::text AS vehicle_type, make, model, registration_number, color, address_id, parking_location, is_active
             FROM public.vehicles WHERE customer_profile_id = $1 ORDER BY is_active DESC, created_at`,
          [id]
        )
      ).rows;
      const addresses = (
        await c.query(
          `SELECT a.id, a.label, a.society_name, a.building_block, a.flat_number, a.parking_location, a.area_locality, a.city, a.pincode, a.is_default,
                  (to_jsonb(a) ->> 'archived_at') IS NOT NULL AS archived
             FROM public.customer_addresses a WHERE a.customer_profile_id = $1 ORDER BY (to_jsonb(a) ->> 'archived_at') IS NOT NULL, a.is_default DESC, a.created_at`,
          [id]
        )
      ).rows;
      const washes = (
        await c.query(
          `SELECT b.id, b.reference_code, b.scheduled_date, b.time_slot::text AS time_slot, b.status::text AS status, b.price_cents, s.name AS service_name
             FROM public.bookings b JOIN public.services s ON s.id = b.service_id
            WHERE b.customer_profile_id = $1 ORDER BY b.scheduled_date DESC, b.created_at DESC LIMIT 10`,
          [id]
        )
      ).rows;
      return { customer, vehicles, addresses, washes };
    });
    if (!out) throw new HttpError(404, 'not_found', 'Customer not found');
    res.json({ success: true, ...out });
  })
);

// Registers a customer by phone. They are not marked verified: they confirm the number with a code the first time they sign in,
// and everything the admin adds (vehicles, addresses, washes) is already waiting for them.
adminManageRouter.post(
  '/admin/customers',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ full_name: text(80).min(2, 'Enter their name.'), phone: phoneSchema, email: z.union([z.literal(''), z.email('Enter a valid email address.').max(160)]).optional() }), req.body);
    const created = await gotrueAdmin.createCustomer(b.phone, b.full_name);
    const profileId = await req.db(async (c) => {
      const row = (await c.query('SELECT id FROM public.profiles WHERE auth_user_id = $1 AND role = $2', [created.id, 'customer'])).rows[0];
      if (!row) return null;
      await c.query('SELECT public.admin_update_customer_profile($1, $2, $3)', [row.id, b.full_name, b.email || null]);
      return row.id as string;
    });
    if (!profileId) throw new HttpError(500, 'profile_missing', 'The login was created but the customer record was not. Please contact the developer.');
    res.status(201).json({ success: true, customer: { id: profileId, full_name: b.full_name, phone: b.phone } });
  })
);

adminManageRouter.put(
  '/admin/customers/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ full_name: text(80).min(2, 'Enter their name.'), email: z.union([z.literal(''), z.email('Enter a valid email address.').max(160)]).optional() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_update_customer_profile($1, $2, $3)', [id, b.full_name, b.email || null]));
    res.json({ success: true });
  })
);

/** Archive / restore a customer or a specialist. The login is locked at Supabase too, so an archived specialist is also kept out of the mobile app. */
async function setArchived(req: Parameters<Parameters<typeof asyncHandler>[0]>[0], id: string, archived: boolean, reason?: string) {
  const r = await call<{ r: { auth_user_id: string; released_washes?: number; released_memberships?: number } }>(req, 'SELECT public.admin_set_profile_archived($1, $2, $3) AS r', [id, archived, reason ?? null]);
  const auth = r.r.auth_user_id;
  forgetProfile(auth);
  const locked = await gotrueAdmin.setBanned(auth, archived);
  return { archived, released_washes: r.r.released_washes ?? 0, released_memberships: r.r.released_memberships ?? 0, login_locked: archived ? locked : false };
}
const archiveBody = z.object({ archived: z.boolean(), reason: optText(200) });

adminManageRouter.post(
  '/admin/customers/:id/archive',
  asyncHandler(async (req, res) => {
    const b = parse(archiveBody, req.body);
    res.json({ success: true, ...(await setArchived(req, parse(uuid, req.params.id), b.archived, b.reason)) });
  })
);

// ───────────────────────── a customer's vehicles and addresses ─────────────────────────
const vehicleBody = z.object({
  vehicle_type: vehicleType,
  make: optText(60),
  model: text(60).min(1, 'Enter the model.'),
  registration_number: text(20).min(4, 'Enter the registration number.'),
  color: optText(30),
  address_id: z.string().uuid().nullish(),
  parking_location: optText(160),
});
const vehicleArgs = (b: z.infer<typeof vehicleBody>) => [b.vehicle_type, b.make ?? '', b.model, b.registration_number, b.color ?? null, b.address_id ?? null, b.parking_location ?? null];

adminManageRouter.post(
  '/admin/customers/:id/vehicles',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(vehicleBody, req.body);
    const r = await call<{ id: string }>(req, 'SELECT public.admin_save_vehicle(NULL, $1, $2::public.vehicle_type, $3, $4, $5, $6, $7, $8) AS id', [id, ...vehicleArgs(b)]);
    res.status(201).json({ success: true, vehicle_id: r.id });
  })
);

adminManageRouter.put(
  '/admin/vehicles/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(vehicleBody, req.body);
    await req.db(async (c) => {
      const owner = (await c.query('SELECT customer_profile_id AS c FROM public.vehicles WHERE id = $1', [id])).rows[0]?.c;
      if (!owner) throw new HttpError(404, 'not_found', 'Vehicle not found');
      await c.query('SELECT public.admin_save_vehicle($1, $2, $3::public.vehicle_type, $4, $5, $6, $7, $8, $9)', [id, owner, ...vehicleArgs(b)]);
    });
    res.json({ success: true });
  })
);

adminManageRouter.post(
  '/admin/vehicles/:id/active',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_vehicle_active($1, $2)', [id, active]));
    res.json({ success: true });
  })
);

const addressBody = z.object({
  label: text(40).default('Home'),
  society_name: text(120).min(2, 'Enter the society or building.'),
  building_block: text(40).min(1, 'Enter the block or wing.'),
  flat_number: text(40).min(1, 'Enter the flat number.'),
  parking_location: text(160).min(2, 'Tell us where the vehicle is parked.'),
  area_locality: text(80).default('Kharadi'),
  city: text(60).default('Pune'),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode.').default('411014'),
  is_default: z.boolean().optional(),
});
const addressArgs = (a: z.infer<typeof addressBody>) => [a.label || 'Home', a.society_name, a.building_block, a.flat_number, a.parking_location, a.area_locality, a.city, a.pincode, a.is_default ?? false];

adminManageRouter.post(
  '/admin/customers/:id/addresses',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const a = parse(addressBody, req.body);
    const r = await call<{ id: string }>(req, 'SELECT public.admin_save_address(NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) AS id', [id, ...addressArgs(a)]);
    res.status(201).json({ success: true, address_id: r.id });
  })
);

adminManageRouter.put(
  '/admin/addresses/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const a = parse(addressBody, req.body);
    await req.db(async (c) => {
      const owner = (await c.query('SELECT customer_profile_id AS c FROM public.customer_addresses WHERE id = $1', [id])).rows[0]?.c;
      if (!owner) throw new HttpError(404, 'not_found', 'Address not found');
      await c.query('SELECT public.admin_save_address($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)', [id, owner, ...addressArgs(a)]);
    });
    res.json({ success: true });
  })
);

adminManageRouter.post(
  '/admin/addresses/:id/archived',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_address_archived($1, $2)', [id, archived]));
    res.json({ success: true });
  })
);

// ───────────────────────── specialists ─────────────────────────
adminManageRouter.get(
  '/admin/workers',
  asyncHandler(async (req, res) => {
    const which = parse(status3, req.query.status);
    const workers = await req.db(async (c) =>
      (
        await c.query(
          `SELECT p.id, p.full_name, p.phone, (to_jsonb(p) ->> 'archived_at') IS NOT NULL AS archived,
                  (SELECT count(*)::int FROM public.worker_assignments wa JOIN public.bookings b ON b.id = wa.booking_id
                    WHERE wa.worker_profile_id = p.id AND wa.is_active AND b.status NOT IN ('completed','cancelled')
                      AND b.scheduled_date BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date AND (now() AT TIME ZONE 'Asia/Kolkata')::date + 7) AS washes_next_7_days,
                  (SELECT count(*)::int FROM public.memberships m WHERE m.assigned_worker_profile_id = p.id AND m.status = 'active') AS memberships
             FROM public.profiles p
            WHERE p.role = 'worker' AND ($1 = 'all' OR (($1 = 'archived') = ((to_jsonb(p) ->> 'archived_at') IS NOT NULL)))
            ORDER BY p.full_name NULLS LAST`,
          [which]
        )
      ).rows
    );
    res.json({ success: true, workers });
  })
);

adminManageRouter.post(
  '/admin/workers/:id/archive',
  asyncHandler(async (req, res) => {
    const b = parse(archiveBody, req.body);
    res.json({ success: true, ...(await setArchived(req, parse(uuid, req.params.id), b.archived, b.reason)) });
  })
);

adminManageRouter.post(
  '/admin/workers/:id/reset-password',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { password } = parse(z.object({ password: z.string().min(8, 'Use at least 8 characters.').max(100) }), req.body);
    const auth = (await call<{ a: string }>(req, 'SELECT public.admin_begin_password_reset($1) AS a', [id])).a;
    await gotrueAdmin.setPassword(auth, password);
    res.json({ success: true });
  })
);

// ───────────────────────── washes ─────────────────────────
adminManageRouter.post(
  '/admin/bookings',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        customer_id: uuid,
        vehicle_id: uuid,
        service_id: uuid,
        date: isoDate,
        time_slot: slot,
        address_id: z.string().uuid().nullish(),
        parking_location: optText(160),
        payment: z.enum(['cash', 'free', 'online']),
        razorpay_payment_id: z.string().trim().regex(/^pay_[A-Za-z0-9]{6,40}$/, 'Paste the Razorpay payment id (it starts with pay_).').optional(),
        note: optText(300),
      }),
      req.body
    );
    // "Paid online": the admin checked the Razorpay dashboard; Razorpay is asked too, and the amount must match the rate card.
    let paymentId: string | null = null;
    let paidCents: number | null = null;
    if (b.payment === 'online') {
      if (!b.razorpay_payment_id) throw new HttpError(400, 'validation_error', 'Paste the Razorpay payment id (it starts with pay_).', { fields: { razorpay_payment_id: 'Paste the Razorpay payment id (it starts with pay_).' } });
      const rp = await fetchGatewayPayment(b.razorpay_payment_id).catch(() => null);
      if (!rp) throw new HttpError(422, 'rule', 'Razorpay does not know that payment id. Check it in the dashboard and try again.');
      if (rp.status !== 'captured') throw new HttpError(422, 'rule', `Razorpay shows that payment as "${rp.status}", not captured, so it cannot be recorded as paid.`);
      if (rp.currency !== 'INR') throw new HttpError(422, 'rule', 'That payment is not in rupees.');
      paymentId = rp.id;
      paidCents = rp.amount;
    }
    const r = await call<{ r: { booking_id: string; price_cents: number } }>(req, 'SELECT public.admin_create_booking($1, $2, $3, $4::date, $5::public.time_slot, $6, $7, $8, $9, $10, $11) AS r', [
      b.customer_id, b.vehicle_id, b.service_id, b.date, b.time_slot, b.address_id ?? null, b.parking_location ?? null, b.payment, b.note ?? null, paymentId, paidCents,
    ]);
    res.status(201).json({ success: true, booking_id: r.r.booking_id, price_cents: r.r.price_cents });
  })
);

adminManageRouter.put(
  '/admin/bookings/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ address_id: z.string().uuid().nullish(), parking_location: optText(160), note: optText(300) }), req.body);
    await req.db((c) => c.query('SELECT public.admin_update_booking_details($1, $2, $3, $4)', [id, b.address_id ?? null, b.parking_location ?? null, b.note ?? null]));
    res.json({ success: true });
  })
);

// ───────────────────────── services, prices, discounts ─────────────────────────
adminManageRouter.get(
  '/admin/services',
  asyncHandler(async (req, res) => {
    const services = await req.db(async (c) =>
      (
        await c.query(
          `SELECT s.id, s.code, s.name, s.vehicle_type::text AS vehicle_type, s.wash_kind, s.description, s.tagline, s.duration_minutes, s.includes, s.sort_order, s.is_active,
                  EXISTS (SELECT 1 FROM public.membership_service_options o WHERE o.service_id = s.id) AS used_by_memberships,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object('vehicle_type', r.vehicle_type, 'price_cents', r.base_amount_cents) ORDER BY r.vehicle_type)
                              FROM public.pricing_rules r
                             WHERE r.service_id = s.id AND r.duration_months = 1 AND r.quantity_tier = 1 AND r.active
                               AND r.valid_from <= now() AND (r.valid_to IS NULL OR r.valid_to > now())), '[]'::jsonb) AS prices
             FROM public.services s ORDER BY s.is_active DESC, s.sort_order, s.name`
        )
      ).rows
    );
    res.json({ success: true, services });
  })
);

const serviceBody = z.object({
  name: text(80).min(2, 'Enter the service name.'),
  description: optText(400),
  tagline: optText(120),
  duration_minutes: z.number().int().min(5, 'At least 5 minutes.').max(600, 'At most 10 hours.').nullish(),
  includes: z.array(text(80).min(1)).max(12).default([]),
  sort_order: z.number().int().min(0).max(10000).default(100),
});

adminManageRouter.post(
  '/admin/services',
  asyncHandler(async (req, res) => {
    const b = parse(serviceBody.extend({ code: text(40).min(2, 'Give it a short code like "bike-polish".'), vehicle_type: vehicleType }), req.body);
    const r = await call<{ id: string }>(req, 'SELECT public.admin_save_service(NULL, $1, $2, $3::public.vehicle_type, $4, $5, $6, $7::jsonb, $8) AS id', [
      b.code, b.name, b.vehicle_type, b.description ?? null, b.tagline ?? null, b.duration_minutes ?? null, JSON.stringify(b.includes), b.sort_order,
    ]);
    res.status(201).json({ success: true, service_id: r.id });
  })
);

adminManageRouter.put(
  '/admin/services/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(serviceBody, req.body);
    await req.db(async (c) => {
      const s = (await c.query('SELECT code, vehicle_type::text AS vt FROM public.services WHERE id = $1', [id])).rows[0];
      if (!s) throw new HttpError(404, 'not_found', 'Service not found');
      await c.query('SELECT public.admin_save_service($1, $2, $3, $4::public.vehicle_type, $5, $6, $7, $8::jsonb, $9)', [
        id, s.code, b.name, s.vt, b.description ?? null, b.tagline ?? null, b.duration_minutes ?? null, JSON.stringify(b.includes), b.sort_order,
      ]);
    });
    res.json({ success: true });
  })
);

adminManageRouter.post(
  '/admin/services/:id/active',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_service_active($1, $2)', [id, active]));
    res.json({ success: true });
  })
);

adminManageRouter.put(
  '/admin/services/:id/price',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ vehicle_type: vehicleType, price_cents: z.number().int().min(100, 'At least ₹1.').max(1_000_000, 'At most ₹10,000.') }), req.body);
    const r = await call<{ r: { changed: boolean; price_cents: number } }>(req, 'SELECT public.admin_set_service_price($1, $2::public.vehicle_type, $3) AS r', [id, b.vehicle_type, b.price_cents]);
    res.json({ success: true, ...r.r });
  })
);

adminManageRouter.get(
  '/admin/pricing',
  asyncHandler(async (req, res) => {
    const out = await req.db(async (c) => ({
      discounts: (await c.query(`SELECT kind, key_value AS key, discount_bp, label FROM public.membership_discount_rules WHERE active ORDER BY kind, key_value`)).rows,
      settings: (await c.query(`SELECT key, value_int AS value, description FROM public.pricing_settings ORDER BY key`)).rows,
    }));
    res.json({ success: true, ...out });
  })
);

adminManageRouter.put(
  '/admin/discounts',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ kind: z.enum(['frequency', 'duration']), key: z.number().int().min(1).max(12), discount_bp: z.number().int().min(0).max(5000), label: text(60).min(2, 'Give it a short label.') }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_discount($1, $2, $3, $4)', [b.kind, b.key, b.discount_bp, b.label]));
    res.json({ success: true });
  })
);

adminManageRouter.post(
  '/admin/discounts/remove',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ kind: z.enum(['frequency', 'duration']), key: z.number().int().min(1).max(12) }), req.body);
    await req.db((c) => c.query('SELECT public.admin_remove_discount($1, $2)', [b.kind, b.key]));
    res.json({ success: true });
  })
);

adminManageRouter.put(
  '/admin/pricing-settings',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ key: text(60).min(1), value: z.number().int() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_pricing_setting($1, $2)', [b.key, b.value]));
    res.json({ success: true });
  })
);
