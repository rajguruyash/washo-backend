import { Router } from 'express';
import { z } from 'zod';
import { reverseGeocode } from '../geocode';
import { parse } from '../errors';
import { asyncHandler, requireSession } from '../middleware/http';

export const geoRouter = Router();

// "Use my current location" on the address form: the browser's coordinates in, a best guess at the society and area out. The coordinates are
// looked up and forgotten (never written to the database). Signed-in people only, so the lookup cannot be used as a free service by anyone.
geoRouter.get(
  '/geo/reverse',
  requireSession,
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ lat: z.coerce.number().min(-90).max(90), lon: z.coerce.number().min(-180).max(180) }), req.query);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, place: await reverseGeocode(q.lat, q.lon) });
  })
);
