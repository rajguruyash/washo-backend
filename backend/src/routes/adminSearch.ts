import { Router } from 'express';
import { z } from 'zod';
import { can } from '../access';
import { parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { ADMIN_BOOKING_SQL } from './admin';

/**
 * The master search at the top of the admin page: one box that looks for a customer (name, mobile number, email, number plate), a wash (reference, customer, plate, society,
 * flat, service, specialist), a membership and a complaint, and returns the few best matches of each. Each group is only searched when the admin's role may look at that part of
 * the console (the same areas the tabs use), so the search never shows more than the tabs would.
 */
export const adminSearchRouter = Router();
adminSearchRouter.use('/admin/search', requireSession, requireRole('admin'));

// % and _ typed in the box are letters, not wildcards. A phone number or plate matches however it was spaced.
const like = (t: string) => `%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
const LIMIT = 6;

adminSearchRouter.get(
  '/admin/search',
  asyncHandler(async (req, res) => {
    const q = parse(z.string().trim().max(60).catch(''), req.query.q);
    const out = { customers: [] as unknown[], washes: [] as unknown[], memberships: [] as unknown[], tickets: [] as unknown[] };
    if (q.length < 2) {
      res.json({ success: true, ...out });
      return;
    }
    const term = like(q);
    const flat = like(q.replace(/[\s-]/g, ''));
    const admin = req.admin;
    await req.db(async (c) => {
      if (can(admin, 'people')) {
        out.customers = (
          await c.query(
            `SELECT p.id, p.full_name, p.phone, p.email, (to_jsonb(p) ->> 'archived_at') IS NOT NULL AS archived,
                    (SELECT string_agg(v.registration_number, ', ' ORDER BY v.registration_number) FROM public.vehicles v WHERE v.customer_profile_id = p.id AND v.is_active) AS plates
               FROM public.profiles p
              WHERE p.role = 'customer'
                AND (p.full_name ILIKE $1 OR p.email ILIKE $1 OR p.phone ILIKE $2
                     OR EXISTS (SELECT 1 FROM public.vehicles v WHERE v.customer_profile_id = p.id AND v.registration_number ILIKE $2))
              ORDER BY ((to_jsonb(p) ->> 'archived_at') IS NOT NULL), p.created_at DESC LIMIT ${LIMIT}`,
            [term, flat]
          )
        ).rows;
      }
      if (can(admin, 'bookings')) {
        out.washes = (
          await c.query(
            `${ADMIN_BOOKING_SQL}
              WHERE b.reference_code ILIKE $1 OR p.full_name ILIKE $1 OR p.phone ILIKE $2 OR v.registration_number ILIKE $2 OR v.model ILIKE $1
                 OR a.society_name ILIKE $1 OR a.flat_number ILIKE $1 OR a.building_block ILIKE $1 OR s.name ILIKE $1 OR wp.full_name ILIKE $1
              ORDER BY b.scheduled_date DESC, b.time_slot DESC, b.created_at DESC LIMIT ${LIMIT}`,
            [term, flat]
          )
        ).rows.map((b) => ({
          id: b.id, reference_code: b.reference_code, scheduled_date: b.scheduled_date, time_slot: b.time_slot, status: b.status, service_name: b.service_name,
          registration_number: b.registration_number, customer_name: b.customer_name, customer_phone: b.customer_phone, payment_kind: b.payment_kind, payment_provider: b.payment_provider,
        }));
      }
      if (can(admin, 'memberships')) {
        out.memberships = (
          await c.query(
            `SELECT m.id, m.status, m.end_at, r.reference_code, p.full_name AS customer_name, p.phone AS customer_phone, v.model AS vehicle_model, v.registration_number
               FROM public.memberships m
               JOIN public.profiles p ON p.id = m.customer_profile_id
               LEFT JOIN public.membership_requests r ON r.id = m.membership_request_id
               LEFT JOIN public.vehicles v ON v.id = COALESCE(r.vehicle_id, (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1))
               LEFT JOIN public.profiles wp ON wp.id = m.assigned_worker_profile_id
              WHERE r.reference_code ILIKE $1 OR p.full_name ILIKE $1 OR p.phone ILIKE $2 OR v.registration_number ILIKE $2 OR wp.full_name ILIKE $1
              ORDER BY (m.status = 'active') DESC, m.created_at DESC LIMIT ${LIMIT}`,
            [term, flat]
          )
        ).rows;
      }
      if (can(admin, 'support')) {
        // Complaints are only readable through the database's own function (it checks the role), which returns the latest 200; the search looks inside those.
        const all = (await c.query(`SELECT public.admin_support_list('all') AS r`)).rows[0].r as { id: string; reference_code: string; subject: string; status: string; customer_name: string | null; customer_phone: string | null; updated_at: string }[];
        const needle = q.toLowerCase();
        const digits = q.replace(/[\s-]/g, '').toLowerCase();
        out.tickets = all
          .filter((t) => [t.reference_code, t.subject, t.customer_name].some((x) => x?.toLowerCase().includes(needle)) || (digits.length > 1 && (t.customer_phone ?? '').replace(/[\s-]/g, '').toLowerCase().includes(digits)))
          .slice(0, LIMIT)
          .map((t) => ({ id: t.id, reference_code: t.reference_code, subject: t.subject, status: t.status, customer_name: t.customer_name, customer_phone: t.customer_phone }));
      }
    });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...out });
  })
);
