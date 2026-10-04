-- READ-ONLY. Run in the Supabase SQL editor BEFORE applying the bundle. Changes nothing.
SELECT 'profiles.email exists' AS check, EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='email') AS value
UNION ALL SELECT 'record_signup_source() exists', to_regprocedure('public.record_signup_source(text)') IS NOT NULL
UNION ALL SELECT 'get_public_catalog() exists', to_regprocedure('public.get_public_catalog()') IS NOT NULL
UNION ALL SELECT 'create_membership_request() exists', to_regprocedure('public.create_membership_request(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text)') IS NOT NULL
UNION ALL SELECT 'worker_queue() exists', to_regprocedure('public.worker_queue(integer)') IS NOT NULL
UNION ALL SELECT 'estimate_membership_price() exists', to_regprocedure('public.estimate_membership_price(public.vehicle_type, jsonb, integer)') IS NOT NULL
UNION ALL SELECT 'washo_api role exists', EXISTS (SELECT 1 FROM pg_roles WHERE rolname='washo_api');

-- What the bundle will not touch, for your information (row counts of the data it leaves alone):
SELECT 'profiles' AS tbl, count(*) FROM public.profiles
UNION ALL SELECT 'vehicles', count(*) FROM public.vehicles
UNION ALL SELECT 'bookings', count(*) FROM public.bookings
UNION ALL SELECT 'memberships', count(*) FROM public.memberships
UNION ALL SELECT 'payments', count(*) FROM public.payments;
