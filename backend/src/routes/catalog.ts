import { Router } from 'express';
import { withAnon } from '../db';
import { asyncHandler } from '../middleware/http';

export const catalogRouter = Router();

// The rate card, discount rules and membership options are DATA in Supabase (get_public_catalog). The website
// renders whatever the database says, so changing a price never needs a deploy.
catalogRouter.get(
  '/catalog',
  asyncHandler(async (_req, res) => {
    const catalog = await withAnon(async (c) => (await c.query('SELECT public.get_public_catalog() AS c')).rows[0].c);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, ...catalog });
  })
);
