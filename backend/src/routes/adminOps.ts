import { Router } from 'express';
import { z } from 'zod';
import { forgetAccess } from '../access';
import { config } from '../config';
import { toCsv } from '../csv';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { mailConfigured } from '../notify';
import { strongPassword } from '../password';
import { forgetProfile } from '../profile';
import { gotrueAdmin } from '../supabase';
import { secondStepAvailable } from '../adminSession';

/**
 * The back-office around the money: the dashboard numbers, the activity log, complaints, app settings, the team (admin accounts and their roles) and data
 * export. Who may use each of these is decided in ONE place (access.ts, mounted on every /api/admin path) and again by the database (migration 27).
 */
export const adminOpsRouter = Router();
adminOpsRouter.use('/admin', requireSession, requireRole('admin'));

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ticketStatus = z.enum(['open', 'in_progress', 'resolved', 'closed']);
const teamRole = z.enum(['operations', 'finance', 'marketing', 'support'], 'Choose a role.');

const one = async <T>(req: { db: <R>(fn: (c: import('pg').PoolClient) => Promise<R>) => Promise<R> }, sql: string, params: unknown[] = []) =>
  req.db(async (c) => (await c.query(sql, params)).rows[0].r as T);

// ───────────────────────── dashboard ─────────────────────────
adminOpsRouter.get(
  '/admin/dashboard',
  asyncHandler(async (req, res) => {
    res.json({ success: true, dashboard: await one(req, 'SELECT public.admin_dashboard() AS r') });
  })
);

// ───────────────────────── activity log ─────────────────────────
adminOpsRouter.get(
  '/admin/activity',
  asyncHandler(async (req, res) => {
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(500).catch(100),
        before: z.string().datetime({ offset: true }).optional().catch(undefined),
        q: z.string().trim().max(60).optional().catch(undefined),
      }),
      req.query
    );
    const events = await one(req, 'SELECT public.admin_activity($1, $2::timestamptz, $3) AS r', [q.limit, q.before ?? null, q.q || null]);
    res.json({ success: true, events });
  })
);

// ───────────────────────── complaints ─────────────────────────
adminOpsRouter.get(
  '/admin/support',
  asyncHandler(async (req, res) => {
    const status = parse(z.enum(['open', 'in_progress', 'resolved', 'closed', 'all']).catch('all'), req.query.status);
    res.json({ success: true, tickets: await one(req, 'SELECT public.admin_support_list($1) AS r', [status]) });
  })
);

adminOpsRouter.get(
  '/admin/support/:id',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    res.json({ success: true, ...(await one<Record<string, unknown>>(req, 'SELECT public.admin_support_get($1) AS r', [id])) });
  })
);

adminOpsRouter.post(
  '/admin/support/:id/reply',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ message: z.string().trim().min(1, 'Write your reply.').max(2000, 'Keep it under 2000 characters.'), status: ticketStatus.optional() }), req.body);
    await req.db((c) => c.query('SELECT public.admin_support_reply($1, $2, $3)', [id, b.message, b.status ?? null]));
    res.json({ success: true });
  })
);

adminOpsRouter.post(
  '/admin/support/:id/status',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ status: ticketStatus }), req.body);
    await req.db((c) => c.query('SELECT public.admin_support_set_status($1, $2)', [id, b.status]));
    res.json({ success: true });
  })
);

// ───────────────────────── settings ─────────────────────────
adminOpsRouter.get(
  '/admin/settings',
  asyncHandler(async (req, res) => {
    const settings = await one<Record<string, unknown>>(req, 'SELECT public.admin_get_settings() AS r');
    // Read-only facts about how sign-in is protected, so the page can show them
    res.json({
      success: true,
      settings,
      security: { two_step: true, two_step_ready: secondStepAvailable() && mailConfigured(), idle_minutes: config.admin.idleMinutes, super_admin_email: config.admin.superEmail },
    });
  })
);

adminOpsRouter.put(
  '/admin/settings',
  asyncHandler(async (req, res) => {
    const b = parse(z.object({ key: z.enum(['maintenance_mode', 'maintenance_message', 'big_refund_threshold_cents']), value: z.union([z.boolean(), z.string(), z.number()]) }), req.body);
    const out = await one(req, 'SELECT public.admin_set_setting($1, $2::jsonb) AS r', [b.key, JSON.stringify(b.value)]);
    res.json({ success: true, setting: out });
  })
);

// ───────────────────────── the team ─────────────────────────
adminOpsRouter.get(
  '/admin/team',
  asyncHandler(async (req, res) => {
    res.json({ success: true, team: await one(req, 'SELECT public.admin_team() AS r') });
  })
);

// Adds an admin: the login (email + strong password, confirmed at once) is made at Supabase, then the database turns that brand-new login into an admin with the chosen role.
// Their sign-in code is emailed to the address given here, so it must be one they can read.
adminOpsRouter.post(
  '/admin/team',
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({ full_name: z.string().trim().min(2, 'Enter their name.').max(80), email: z.email('Enter a valid email address.').max(254), password: strongPassword, access: teamRole }),
      req.body
    );
    const addr = b.email.trim().toLowerCase();
    let created;
    try {
      created = await gotrueAdmin.createEmailUser(addr, b.password, b.full_name);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'email_taken') throw new HttpError(409, 'email_taken', 'That email already has a WASHO account. Use a different email for the new admin.');
      throw err;
    }
    const out = await one<{ profile_id: string; access: string }>(req, 'SELECT public.admin_promote_to_admin($1, $2, $3) AS r', [created.id, b.full_name, b.access]);
    forgetProfile(created.id);
    forgetAccess();
    res.status(201).json({ success: true, admin: { id: out.profile_id, access: out.access, email: addr, full_name: b.full_name } });
  })
);

adminOpsRouter.put(
  '/admin/team/:id/access',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ access: teamRole }), req.body);
    await req.db((c) => c.query('SELECT public.admin_set_access($1, $2)', [id, b.access]));
    forgetAccess();
    res.json({ success: true });
  })
);

adminOpsRouter.post(
  '/admin/team/:id/active',
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(z.object({ active: z.boolean() }), req.body);
    const r = await one<{ auth_user_id: string }>(req, 'SELECT public.admin_set_admin_active($1, $2) AS r', [id, b.active]);
    forgetProfile(r.auth_user_id);
    forgetAccess();
    const locked = await gotrueAdmin.setBanned(r.auth_user_id, !b.active); // best effort: the website refuses a switched-off account anyway
    res.json({ success: true, login_locked: !b.active ? locked : false });
  })
);

// ───────────────────────── export ─────────────────────────
const KINDS = ['customers', 'washes', 'memberships', 'payments', 'refunds', 'support', 'activity'] as const;
const CAP = 50_000;

adminOpsRouter.get(
  '/admin/export/:kind',
  asyncHandler(async (req, res) => {
    const kind = parse(z.enum(KINDS, 'Unknown export.'), req.params.kind);
    const q = parse(z.object({ from: isoDate.optional().catch(undefined), to: isoDate.optional().catch(undefined) }), req.query);
    const out = await one<{ columns: string[]; rows: unknown[][]; truncated: boolean }>(req, 'SELECT public.admin_export($1, $2::date, $3::date) AS r', [kind, q.from ?? null, q.to ?? null]);
    const csv = toCsv(out.columns, out.rows, out.truncated ? `Only the first ${CAP} rows are included. Choose a shorter date range to get the rest.` : undefined);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="washo-${kind}-${q.from ?? 'start'}-to-${q.to ?? 'today'}.csv"`,
      'Cache-Control': 'no-store',
      ...(out.truncated ? { 'X-Export-Truncated': '1' } : {}),
    });
    res.send(csv);
  })
);
