import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../errors';
import { asyncHandler, requireRole, requireSession } from '../middleware/http';
import { loadProfile } from '../profile';

export const accountRouter = Router();
accountRouter.use(['/me', '/addresses', '/vehicles', '/notifications'], requireSession);

const uuid = z.string().uuid();

// ───────────────────────── profile ─────────────────────────
accountRouter.put(
  '/me',
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        full_name: z.string().trim().min(2, 'Enter your full name.').max(80),
        email: z.union([z.literal(''), z.email('Enter a valid email address.').max(160)]).optional(),
      }),
      req.body
    );
    const user = await req.db(async (c) => {
      await c.query('UPDATE public.profiles SET full_name = $1, updated_at = now() WHERE auth_user_id = auth.uid()', [body.full_name]);
      if (body.email) {
        // profiles.email comes with migration 20261004000003. Until a database has it, saving the name must still work.
        await c.query('SAVEPOINT em');
        try {
          await c.query('UPDATE public.profiles SET email = $1 WHERE auth_user_id = auth.uid()', [body.email]);
          await c.query('RELEASE SAVEPOINT em');
        } catch (err) {
          if ((err as { code?: string }).code !== '42703') throw err; // undefined_column
          await c.query('ROLLBACK TO SAVEPOINT em');
          console.warn('profiles.email is missing in this database: apply supabase/migrations/20261004000003_schema_additions.sql');
        }
      }
      return loadProfile(c, req.session!.claims);
    });
    res.json({ success: true, user: { ...user, needs_profile: false } });
  })
);

// ───────────────────────── addresses (RLS: a customer manages only their own) ─────────────────────────
const addressSchema = z.object({
  label: z.string().trim().min(1).max(40).default('Home'),
  society_name: z.string().trim().min(2, 'Enter your society or building.').max(120),
  building_block: z.string().trim().min(1, 'Enter your block or wing.').max(40),
  flat_number: z.string().trim().min(1, 'Enter your flat number.').max(40),
  parking_location: z.string().trim().min(2, 'Tell us where the vehicle is parked.').max(160),
  area_locality: z.string().trim().min(2).max(80).default('Kharadi'),
  city: z.string().trim().min(2).max(60).default('Pune'),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit pincode.').default('411014'),
  is_default: z.boolean().optional(),
});

accountRouter.get(
  '/addresses',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const addresses = await req.db(async (c) => (await c.query(`SELECT * FROM public.customer_addresses ORDER BY is_default DESC, created_at`)).rows);
    res.json({ success: true, addresses });
  })
);

accountRouter.post(
  '/addresses',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const a = parse(addressSchema, req.body);
    const address = await req.db(async (c) => {
      const first = (await c.query('SELECT 1 FROM public.customer_addresses LIMIT 1')).rowCount === 0;
      const makeDefault = a.is_default || first;
      if (makeDefault) await c.query('UPDATE public.customer_addresses SET is_default = false WHERE is_default');
      const { rows } = await c.query(
        `INSERT INTO public.customer_addresses (customer_profile_id, label, society_name, building_block, flat_number, parking_location, area_locality, city, pincode, is_default)
         VALUES (public.current_profile_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [a.label, a.society_name, a.building_block, a.flat_number, a.parking_location, a.area_locality, a.city, a.pincode, makeDefault]
      );
      return rows[0];
    });
    res.status(201).json({ success: true, address });
  })
);

accountRouter.put(
  '/addresses/:id',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const a = parse(addressSchema, req.body);
    const address = await req.db(async (c) => {
      if (a.is_default) await c.query('UPDATE public.customer_addresses SET is_default = false WHERE is_default AND id <> $1', [id]);
      const { rows } = await c.query(
        `UPDATE public.customer_addresses SET label=$2, society_name=$3, building_block=$4, flat_number=$5, parking_location=$6,
                area_locality=$7, city=$8, pincode=$9, is_default = COALESCE($10, is_default), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, a.label, a.society_name, a.building_block, a.flat_number, a.parking_location, a.area_locality, a.city, a.pincode, a.is_default ?? null]
      );
      return rows[0];
    });
    if (!address) throw new HttpError(404, 'not_found', 'Address not found');
    res.json({ success: true, address });
  })
);

// ───────────────────────── vehicles ─────────────────────────
const vehicleSchema = z.object({
  vehicle_type: z.enum(['bike', 'car', 'suv']),
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().min(1, 'Enter the model.').max(60),
  registration_number: z
    .string()
    .trim()
    .min(4, 'Enter the registration number.')
    .max(20)
    .transform((v) => v.toUpperCase().replace(/\s+/g, ' ')),
  color: z.string().trim().max(30).optional(),
  address_id: z.string().uuid().nullish(),
  parking_location: z.string().trim().max(160).optional(),
});

const VEHICLE_COLUMNS = `id, vehicle_type::text AS vehicle_type, make, model, registration_number, color, address_id, parking_location, created_at`;

accountRouter.get(
  '/vehicles',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const vehicles = await req.db(async (c) => (await c.query(`SELECT ${VEHICLE_COLUMNS} FROM public.vehicles WHERE is_active ORDER BY created_at`)).rows);
    res.json({ success: true, vehicles });
  })
);

accountRouter.post(
  '/vehicles',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const v = parse(vehicleSchema, req.body);
    try {
      const vehicle = await req.db(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO public.vehicles (customer_profile_id, vehicle_type, make, model, registration_number, color, address_id, parking_location)
           VALUES (public.current_profile_id(), $1, NULLIF($2, ''), $3, $4, NULLIF($5, ''), $6, NULLIF($7, '')) RETURNING ${VEHICLE_COLUMNS}`,
          [v.vehicle_type, v.make ?? '', v.model, v.registration_number, v.color ?? '', v.address_id ?? null, v.parking_location ?? '']
        );
        return rows[0];
      });
      res.status(201).json({ success: true, vehicle });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate_vehicle', 'You have already saved this registration number.');
      throw err;
    }
  })
);

accountRouter.put(
  '/vehicles/:id',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const v = parse(vehicleSchema, req.body);
    try {
      const vehicle = await req.db(async (c) => {
        const { rows } = await c.query(
          `UPDATE public.vehicles SET vehicle_type=$2, make=NULLIF($3,''), model=$4, registration_number=$5, color=NULLIF($6,''),
                  address_id=$7, parking_location=NULLIF($8,''), updated_at=now()
            WHERE id = $1 AND is_active RETURNING ${VEHICLE_COLUMNS}`,
          [id, v.vehicle_type, v.make ?? '', v.model, v.registration_number, v.color ?? '', v.address_id ?? null, v.parking_location ?? '']
        );
        return rows[0];
      });
      if (!vehicle) throw new HttpError(404, 'not_found', 'Vehicle not found');
      res.json({ success: true, vehicle });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'duplicate_vehicle', 'You have already saved this registration number.');
      throw err;
    }
  })
);

// Soft delete: washes already booked for the vehicle keep their record.
accountRouter.delete(
  '/vehicles/:id',
  requireRole('customer'),
  asyncHandler(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const done = await req.db(async (c) => {
      const open = await c.query(
        `SELECT 1 FROM public.bookings WHERE vehicle_id = $1 AND status IN ('pending','confirmed','worker_assigned','worker_called','call_not_picked_up','in_progress') LIMIT 1`,
        [id]
      );
      if (open.rowCount) throw new HttpError(409, 'vehicle_has_washes', 'This vehicle has upcoming washes. Reschedule or finish them first.');
      const live = await c.query(`SELECT 1 FROM public.membership_services ms JOIN public.memberships m ON m.id = ms.membership_id WHERE ms.vehicle_id = $1 AND m.status = 'active' LIMIT 1`, [id]);
      if (live.rowCount) throw new HttpError(409, 'vehicle_has_membership', 'This vehicle has an active membership.');
      return (await c.query('UPDATE public.vehicles SET is_active = false, updated_at = now() WHERE id = $1 AND is_active', [id])).rowCount;
    });
    if (!done) throw new HttpError(404, 'not_found', 'Vehicle not found');
    res.json({ success: true });
  })
);

// ───────────────────────── notifications ─────────────────────────
accountRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const notifications = await req.db(async (c) => (await c.query(`SELECT id, category, title, body, reference_id, read, created_at FROM public.notifications ORDER BY created_at DESC LIMIT 30`)).rows);
    res.json({ success: true, notifications });
  })
);

accountRouter.post(
  '/notifications/read',
  asyncHandler(async (req, res) => {
    await req.db((c) => c.query('UPDATE public.notifications SET read = true WHERE NOT read'));
    res.json({ success: true });
  })
);
