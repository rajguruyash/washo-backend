-- 20261004000003_schema_additions.sql
-- SAFE / additive: new columns, new tables, new indexes. No data is changed or removed, and nothing
-- here changes behaviour the mobile app relies on.
--
--   profiles            + email, signup_source (write-once)
--   vehicles            make becomes optional; normalised plate with a unique index
--   bookings            + reference_code, source, price_cents, cancel_reason; one live wash per vehicle per day
--   payments            + intent, payment_kind, membership_request_id, receipt, expires_at, fulfilment_status
--   memberships         + membership_request_id (a membership is only ever created from a PAID request)
--   membership_requests NEW: the customer -> WASHO review -> accept -> pay flow
--   website_leads       NEW: legacy marketing-site leads, preserved read-only
--   washo_api           NEW: the least-privilege role the Render web API connects as

-- ───────────────────────── helpers ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.gen_ref(p_prefix text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O/1/I: readable over a phone call
  out text := '';
  i int;
BEGIN
  FOR i IN 1..6 LOOP
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN p_prefix || '-' || out;
END $$;
REVOKE ALL ON FUNCTION app_private.gen_ref(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.gen_ref(text) TO service_role;

-- ───────────────────────── profiles ─────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS signup_source text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_signup_source_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_signup_source_check
  CHECK (signup_source IS NULL OR signup_source ~ '^[a-z0-9_-]{1,32}$');

-- signup_source records where a customer came from (?source=nfc|qr|whatsapp...). Set once, never rewritten.
CREATE OR REPLACE FUNCTION app_private.protect_signup_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.signup_source IS NOT NULL AND NEW.signup_source IS DISTINCT FROM OLD.signup_source AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Signup source cannot be changed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_protect_signup_source ON public.profiles;
CREATE TRIGGER profiles_protect_signup_source BEFORE UPDATE OF signup_source ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION app_private.protect_signup_source();

CREATE OR REPLACE FUNCTION public.record_signup_source(p_source text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  IF p_source IS NULL OR lower(p_source) !~ '^[a-z0-9_-]{1,32}$' THEN RETURN; END IF; -- ignore junk quietly
  UPDATE public.profiles SET signup_source = lower(p_source), updated_at = now()
   WHERE auth_user_id = auth.uid() AND signup_source IS NULL;
END $$;
REVOKE ALL ON FUNCTION public.record_signup_source(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_signup_source(text) TO authenticated, service_role;

-- ───────────────────────── vehicles ─────────────────────────
-- The website asks for model + registration only. (The mobile form keeps collecting make.)
ALTER TABLE public.vehicles ALTER COLUMN make DROP NOT NULL;

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS registration_normalized text
  GENERATED ALWAYS AS (upper(regexp_replace(registration_number, '[^A-Za-z0-9]', '', 'g'))) STORED;

-- "MH12AB1234" and "MH 12 AB 1234" are the same plate. Create the unique index only if existing data allows it;
-- otherwise warn and expose the duplicates for cleanup instead of failing the whole migration.
DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM public.vehicles WHERE is_active GROUP BY customer_profile_id, registration_normalized HAVING count(*) > 1
  ) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_vehicles_customer_plate_active
      ON public.vehicles (customer_profile_id, registration_normalized) WHERE is_active;
  ELSE
    RAISE WARNING 'Skipped ux_vehicles_customer_plate_active: % customer(s) have the same plate saved twice. See view public.v_duplicate_vehicle_plates.', dupes;
  END IF;
END $$;
CREATE OR REPLACE VIEW public.v_duplicate_vehicle_plates WITH (security_invoker = true) AS
  SELECT customer_profile_id, registration_normalized, count(*) AS copies, array_agg(id) AS vehicle_ids
    FROM public.vehicles WHERE is_active GROUP BY 1, 2 HAVING count(*) > 1;
REVOKE ALL ON public.v_duplicate_vehicle_plates FROM anon, authenticated;

-- ───────────────────────── bookings ─────────────────────────
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS reference_code text,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'mobile_app',
  ADD COLUMN IF NOT EXISTS price_cents integer,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  -- set when the worker has spoken to the customer; cleared when the wash is moved or the call is not picked up
  ADD COLUMN IF NOT EXISTS customer_confirmed_at timestamptz;

ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_source_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_source_check
  CHECK (source IN ('mobile_app', 'website', 'admin', 'membership_schedule'));
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS bookings_price_cents_check;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_price_cents_check CHECK (price_cents IS NULL OR price_cents >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_reference_code ON public.bookings (reference_code) WHERE reference_code IS NOT NULL;

CREATE OR REPLACE FUNCTION app_private.set_booking_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tries int := 0;
BEGIN
  IF NEW.reference_code IS NULL THEN
    LOOP
      NEW.reference_code := app_private.gen_ref('WSH');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.bookings WHERE reference_code = NEW.reference_code);
      tries := tries + 1;
      IF tries > 10 THEN RAISE EXCEPTION 'Could not allocate a booking reference'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.set_booking_reference() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bookings_set_reference ON public.bookings;
CREATE TRIGGER bookings_set_reference BEFORE INSERT ON public.bookings FOR EACH ROW EXECUTE FUNCTION app_private.set_booking_reference();

-- One live wash per vehicle per day (same rule the mobile app implicitly assumes). Skipped with a
-- warning if existing data already breaks it, so it can be cleaned up first.
DO $$
DECLARE dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT 1 FROM public.bookings
     WHERE status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress')
     GROUP BY vehicle_id, scheduled_date HAVING count(*) > 1
  ) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_vehicle_day_live ON public.bookings (vehicle_id, scheduled_date)
      WHERE status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress');
  ELSE
    RAISE WARNING 'Skipped ux_bookings_vehicle_day_live: % vehicle-day(s) already have more than one live booking. See view public.v_duplicate_live_bookings.', dupes;
  END IF;
END $$;
CREATE OR REPLACE VIEW public.v_duplicate_live_bookings WITH (security_invoker = true) AS
  SELECT vehicle_id, scheduled_date, count(*) AS bookings, array_agg(id) AS booking_ids
    FROM public.bookings
   WHERE status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress')
   GROUP BY 1, 2 HAVING count(*) > 1;
REVOKE ALL ON public.v_duplicate_live_bookings FROM anon, authenticated;

-- ───────────────────────── membership_requests ─────────────────────────
CREATE TABLE IF NOT EXISTS public.membership_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code text NOT NULL UNIQUE DEFAULT app_private.gen_ref('MR'),
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE RESTRICT,
  address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
  parking_location text,
  frequency_per_week smallint NOT NULL CHECK (frequency_per_week BETWEEN 1 AND 3),
  duration_months smallint NOT NULL CHECK (duration_months IN (1, 3, 6, 12)),
  weekly_pattern jsonb NOT NULL CHECK (jsonb_typeof(weekly_pattern) = 'array'),
  time_slot public.time_slot NOT NULL,
  target_completion_time text,
  start_date date NOT NULL,
  customer_notes text CHECK (customer_notes IS NULL OR char_length(customer_notes) <= 500),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'quoted', 'accepted', 'active', 'rejected', 'declined', 'expired', 'cancelled')),
  -- What the rate card says at request time. Admin-only: the customer is never shown a price before WASHO approves.
  system_quote jsonb,
  -- WASHO's decision.
  adjustment_cents integer NOT NULL DEFAULT 0,
  adjustment_reason text,
  quoted_amount_cents integer CHECK (quoted_amount_cents IS NULL OR quoted_amount_cents >= 100),
  quoted_breakdown jsonb,
  quote_expires_at timestamptz,
  reviewed_by_profile_id uuid REFERENCES public.profiles(id),
  reviewed_at timestamptz,
  rejection_reason text,
  accepted_at timestamptz,
  payment_id uuid,
  membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_membership_requests_customer ON public.membership_requests (customer_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_requests_status ON public.membership_requests (status, created_at);
-- One open request per vehicle keeps WASHO's review queue sane.
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_requests_open_per_vehicle
  ON public.membership_requests (vehicle_id) WHERE status IN ('submitted', 'quoted', 'accepted');

ALTER TABLE public.membership_requests ENABLE ROW LEVEL SECURITY;
-- Customers have NO direct table access: they read through functions that hide the price until it is approved.
DROP POLICY IF EXISTS membership_requests_admin_all ON public.membership_requests;
CREATE POLICY membership_requests_admin_all ON public.membership_requests FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE ALL ON public.membership_requests FROM anon, authenticated;
GRANT SELECT ON public.membership_requests TO authenticated; -- RLS: admins only

-- ───────────────────────── memberships ─────────────────────────
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS membership_request_id uuid REFERENCES public.membership_requests(id);
-- The specialist who normally serves this membership. Washes that are moved return to this worker's queue.
ALTER TABLE public.memberships ADD COLUMN IF NOT EXISTS assigned_worker_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_memberships_request ON public.memberships (membership_request_id) WHERE membership_request_id IS NOT NULL;

-- ───────────────────────── payments ─────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_kind text,
  ADD COLUMN IF NOT EXISTS intent jsonb,
  ADD COLUMN IF NOT EXISTS membership_request_id uuid REFERENCES public.membership_requests(id),
  ADD COLUMN IF NOT EXISTS receipt text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilment_status text;

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_payment_kind_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_payment_kind_check CHECK (payment_kind IS NULL OR payment_kind IN ('on_demand', 'membership'));
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_fulfilment_status_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_fulfilment_status_check
  CHECK (fulfilment_status IS NULL OR fulfilment_status IN ('pending', 'fulfilled', 'unfulfilled'));

-- A paid payment must point at exactly one thing it bought. Exceptions: money was taken but the
-- slot/dates were no longer available -> 'unfulfilled' (which always gets a refund request), and a
-- 'failed' (abandoned/superseded) payment, which never bought anything.
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_booking_id_membership_id_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_booking_id_membership_id_check CHECK (
     (status = 'pending' AND booking_id IS NULL AND membership_id IS NULL)
  OR (status <> 'pending' AND ((booking_id IS NOT NULL) <> (membership_id IS NOT NULL)))
  OR (status <> 'pending' AND fulfilment_status = 'unfulfilled' AND booking_id IS NULL AND membership_id IS NULL)
  OR (status = 'failed' AND booking_id IS NULL AND membership_id IS NULL)
);

-- Idempotency anchors: one payment row per Razorpay order, and one captured payment is never applied twice.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.payments WHERE provider_order_id IS NOT NULL GROUP BY provider_order_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_order ON public.payments (provider_order_id) WHERE provider_order_id IS NOT NULL;
  ELSE
    RAISE WARNING 'Skipped ux_payments_provider_order: duplicate provider_order_id values exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payments WHERE provider_payment_id IS NOT NULL GROUP BY provider_payment_id HAVING count(*) > 1) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_provider_payment ON public.payments (provider_payment_id) WHERE provider_payment_id IS NOT NULL;
  ELSE
    RAISE WARNING 'Skipped ux_payments_provider_payment: duplicate provider_payment_id values exist';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_payments_membership_request ON public.payments (membership_request_id) WHERE membership_request_id IS NOT NULL;

ALTER TABLE public.membership_requests DROP CONSTRAINT IF EXISTS membership_requests_payment_fk;
ALTER TABLE public.membership_requests ADD CONSTRAINT membership_requests_payment_fk FOREIGN KEY (payment_id) REFERENCES public.payments(id);
ALTER TABLE public.membership_requests DROP CONSTRAINT IF EXISTS membership_requests_membership_fk;
ALTER TABLE public.membership_requests ADD CONSTRAINT membership_requests_membership_fk FOREIGN KEY (membership_id) REFERENCES public.memberships(id);

-- ───────────────────────── website_leads (legacy, read-only) ─────────────────────────
-- The marketing site's old lead form captured these before the web app existed. Kept, not deleted.
CREATE TABLE IF NOT EXISTS public.website_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id integer UNIQUE,                       -- id in the old Render database, for idempotent import
  name text NOT NULL,
  email text,
  mobile text NOT NULL,
  vehicle_type text,
  vehicle_model text,
  vehicle_registration_number text,
  location text,
  flat_number text,
  preferred_service text,
  status text,
  source text,
  legacy_payment_image_url text,                  -- path on the old server; the image itself is NOT migrated
  legacy_created_at timestamptz,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_website_leads_mobile ON public.website_leads (mobile);
ALTER TABLE public.website_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS website_leads_admin_read ON public.website_leads;
CREATE POLICY website_leads_admin_read ON public.website_leads FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.website_leads FROM anon, authenticated;
GRANT SELECT ON public.website_leads TO authenticated; -- RLS: admins only
GRANT INSERT, SELECT ON public.website_leads TO service_role;

-- ───────────────────────── washo_api: the website server's database role ─────────────────────────
-- Not a superuser, not service_role. It can run the specific functions granted to it, and (inside one
-- transaction) act as a signed-in customer via SET LOCAL ROLE authenticated, so RLS and auth.uid()
-- behave exactly as they do for the mobile app. An operator must give it a password out of band:
--   ALTER ROLE washo_api WITH LOGIN PASSWORD '<random>';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'washo_api') THEN
    CREATE ROLE washo_api NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT authenticated TO washo_api;
GRANT anon TO washo_api;            -- the public catalogue is read as anon
GRANT USAGE ON SCHEMA public TO washo_api;
GRANT USAGE ON SCHEMA app_private TO washo_api;
