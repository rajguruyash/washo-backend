import { Router, type Request } from 'express';
import { z } from 'zod';
import { EMPTY_STATUS, campaignsNotInstalled } from '../campaigns';
import { freeWashEmail, sendTracked } from '../emails';
import { mailConfigured } from '../notify';
import { HttpError, parse } from '../errors';
import { withAnon } from '../db';
import { cached, forgetPublic } from '../publicCache';
import { asyncHandler, optionalSession, requirePhone, requireRole, requireSession } from '../middleware/http';

export const campaignRouter = Router();

/** Emails the confirmation for a free wash that has just been booked (best effort: it never affects the booking, and goes out once). */
async function emailConfirmation(req: Request, bookingId: string): Promise<void> {
  const to = req.session?.profile.email;
  if (!to || !mailConfigured()) return;
  const d = await req.db(
    async (c) =>
      (
        await c.query(
          `SELECT b.reference_code, b.scheduled_date, b.time_slot::text AS time_slot, s.name AS service, v.model AS vehicle, v.registration_number AS plate,
                  a.society_name, a.building_block, a.flat_number, COALESCE(b.parking_location, v.parking_location, a.parking_location) AS parking,
                  k.name AS campaign, k.claim_closes_on, k.pack_offer_days, k.pack_offer_bp_1, k.pack_offer_bp_2, k.pack_offer_bp_3plus
             FROM public.bookings b
             JOIN public.services s ON s.id = b.service_id
             JOIN public.vehicles v ON v.id = b.vehicle_id
             JOIN public.campaign_claims cl ON cl.booking_id = b.id
             JOIN public.campaigns k ON k.id = cl.campaign_id
             LEFT JOIN public.customer_addresses a ON a.id = b.address_id
            WHERE b.id = $1`,
          [bookingId]
        )
      ).rows[0]
  );
  if (!d) return;
  await sendTracked('free_wash_confirmation', bookingId, to, () =>
    freeWashEmail({
      name: req.session!.profile.full_name, bookingId, reference: d.reference_code, date: d.scheduled_date, slot: d.time_slot, service: d.service, vehicle: d.vehicle, plate: d.plate,
      society: d.society_name, block: d.building_block, flat: d.flat_number, parking: d.parking, campaign: d.campaign, claimsCloseOn: d.claim_closes_on,
      offer: { days: d.pack_offer_days, bp1: d.pack_offer_bp_1, bp2: d.pack_offer_bp_2, bp3: d.pack_offer_bp_3plus },
    })
  );
}

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
    const load = (run: typeof withAnon) => run(async (c) => (await c.query('SELECT public.get_campaign_status() AS s')).rows[0].s);
    let status: unknown = EMPTY_STATUS;
    try {
      // A visitor's view is the same for everyone (kept a few seconds); a signed-in customer also sees their own claim and offer, so theirs is fresh.
      status = req.session ? await load(req.db as unknown as typeof withAnon) : await cached('campaign:visitor', 5_000, () => load(withAnon));
    } catch (err) {
      if (!campaignsNotInstalled(err)) throw err;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...(status as object) });
  })
);

// Claim the free wash: pick the vehicle. The database checks the offer is open, the caps, that this is a new customer, and one per phone /
// vehicle / flat, picks the day and the time window itself (the customer is not asked: any date or window sent is ignored) and books the wash
// in the same step, then says when it is. A verified phone is part of the claim.
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
        date: z.string().optional(), // older pages still send these; the database ignores them
        time_slot: z.string().optional(),
        address_id: uuid.nullish(),
        parking_location: z.string().trim().max(160).optional(),
      }),
      req.body
    );
    const r = await req
      .db(
        async (c) =>
          (
            await c.query('SELECT public.claim_campaign_wash($1, $2, NULL::date, NULL::public.time_slot, $3, $4) AS r', [
              b.campaign_id, b.vehicle_id, b.address_id ?? null, b.parking_location ?? null,
            ])
          ).rows[0].r
      )
      .catch((err) => {
        // The website never shows the time of day a campaign opens at: "This offer opens on 10 Sep, 10:00 am" is told as "This offer opens on 10 Sep".
        const m = (err as { code?: string; message?: string }).message ?? '';
        if ((err as { code?: string }).code === 'P0001' && /^This offer opens on .+, \d{1,2}:\d{2} (am|pm)$/i.test(m)) {
          throw new HttpError(422, 'rule', m.replace(/, \d{1,2}:\d{2} (am|pm)$/i, ''));
        }
        throw err;
      });
    forgetPublic(); // the number of free washes left has just changed
    res.status(201).json({ success: true, ...r });
    void emailConfirmation(req, r.booking_id).catch((err) => console.error('Free wash confirmation email failed:', (err as Error).message));
  })
);
