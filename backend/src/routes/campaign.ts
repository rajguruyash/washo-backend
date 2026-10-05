import { Router } from 'express';
import { z } from 'zod';
import { EMPTY_STATUS, campaignsNotInstalled } from '../campaigns';
import { parse } from '../errors';
import { withAnon } from '../db';
import { asyncHandler, optionalSession, requirePhone, requireRole, requireSession } from '../middleware/http';

export const campaignRouter = Router();

const uuid = z.string().uuid();

/**
 * The free-wash campaign: what is on offer, how many are left, what this visitor can do about it, and their pack offer if they
 * have one. Open to everyone (so the home page can show a banner), a little more for a signed-in customer. Every rule lives in the
 * database (migration 20261004000014); a database without it simply has no campaign.
 */
campaignRouter.get(
  '/campaign',
  optionalSession,
  asyncHandler(async (req, res) => {
    const run = req.session ? req.db : withAnon;
    let status: unknown = EMPTY_STATUS;
    try {
      status = await run(async (c) => (await c.query('SELECT public.get_campaign_status() AS s')).rows[0].s);
    } catch (err) {
      if (!campaignsNotInstalled(err)) throw err;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...(status as object) });
  })
);

// Claim the free wash: pick the vehicle, the day and the time. The database checks the offer is open, the caps, that this is a new
// customer, and one per phone / vehicle / flat, and books the wash in the same step. A verified phone is part of the claim.
campaignRouter.post(
  '/campaign/claim',
  requireSession,
  requireRole('customer'),
  requirePhone,
  asyncHandler(async (req, res) => {
    const b = parse(
      z.object({
        campaign_id: uuid,
        vehicle_id: uuid,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.'),
        time_slot: z.enum(['morning', 'afternoon', 'night']),
        address_id: uuid.nullish(),
        parking_location: z.string().trim().max(160).optional(),
      }),
      req.body
    );
    const r = await req.db(
      async (c) =>
        (
          await c.query('SELECT public.claim_campaign_wash($1, $2, $3::date, $4::public.time_slot, $5, $6) AS r', [
            b.campaign_id, b.vehicle_id, b.date, b.time_slot, b.address_id ?? null, b.parking_location ?? null,
          ])
        ).rows[0].r
    );
    res.status(201).json({ success: true, ...r });
  })
);
