-- 20261004000014_campaigns.sql
-- SAFE / additive and re-runnable. Free-wash campaigns (the Navratri offer) and the welcome offer on wash packs.
--
-- What a campaign is
--   * WASHO creates one in the Admin page: when claims open and close, the last day a free wash may be done, a cap on the total
--     and (optionally) on washes per day, how long the pack offer lasts, and the three pack rates. Nothing is seeded: no campaign
--     exists until an admin creates it, and it stays off until an admin switches it on.
--   * A customer claims ONE free body wash for their vehicle by picking a day and a time. claim_campaign_wash() checks every rule
--     and creates the booking in one step, so two people can never take the last free wash. The wash is an ordinary booking
--     (price 0, no payment, source 'website'), so specialists, the Washes tab and History treat it like any other.
--   * Rules, all enforced here: the campaign is on and open; the total and per-day caps; new customers only (no earlier wash and no
--     membership); one per verified phone (a profile), one per vehicle plate and one per flat (society + block + flat), so a second
--     number does not get a second wash; the date is inside the window; the usual lead time and one wash per vehicle per day.
--   * Cancelling the free wash gives the claim back (they can claim again while claims are open). A booking that ends as a no-show
--     keeps the claim used up. A completed wash starts the pack offer.
--
-- The pack offer
--   * After the free wash is COMPLETED, for pack_offer_days, the customer's wash-pack price uses the campaign's rates instead of the
--     normal frequency discount (never lower than the normal one): 1 a week, 2 a week, 3 or more a week. It still stacks with the
--     length discount and the usual combined cap. It is used once: the membership bought with it is recorded on the claim.
--   * It is applied inside compute_membership_quote() for the signed-in customer, so the estimate they see, the price stored on
--     the request and the amount charged all come from the same place. Anonymous visitors and everyone else get the normal price.
--
-- Nothing here changes existing rows. It adds two tables, one trigger on bookings (acts only on a booking that has a claim) and one
-- on memberships (acts only on a membership priced with the offer), and replaces compute_membership_quote() with the same logic
-- plus the offer.

-- ───────────────────────── tables ─────────────────────────
CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT false,
  claim_opens_on date NOT NULL,
  claim_closes_on date NOT NULL,
  use_by_date date NOT NULL,
  total_cap integer NOT NULL,
  daily_cap integer,
  new_customers_only boolean NOT NULL DEFAULT true,
  pack_offer_days integer NOT NULL DEFAULT 14,
  pack_offer_bp_1 integer NOT NULL DEFAULT 500,
  pack_offer_bp_2 integer NOT NULL DEFAULT 1000,
  pack_offer_bp_3plus integer NOT NULL DEFAULT 1500,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_code_check CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(code) BETWEEN 3 AND 40),
  CONSTRAINT campaigns_name_check CHECK (char_length(btrim(name)) BETWEEN 3 AND 80),
  CONSTRAINT campaigns_description_check CHECK (description IS NULL OR char_length(description) <= 400),
  CONSTRAINT campaigns_window_check CHECK (claim_closes_on >= claim_opens_on AND use_by_date >= claim_opens_on),
  CONSTRAINT campaigns_total_cap_check CHECK (total_cap BETWEEN 1 AND 100000),
  CONSTRAINT campaigns_daily_cap_check CHECK (daily_cap IS NULL OR daily_cap BETWEEN 1 AND 10000),
  CONSTRAINT campaigns_offer_days_check CHECK (pack_offer_days BETWEEN 1 AND 365),
  CONSTRAINT campaigns_offer_bp_check CHECK (pack_offer_bp_1 BETWEEN 0 AND 5000 AND pack_offer_bp_2 BETWEEN 0 AND 5000 AND pack_offer_bp_3plus BETWEEN 0 AND 5000)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaigns_code ON public.campaigns (code);

CREATE TABLE IF NOT EXISTS public.campaign_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  plate text NOT NULL,
  flat_key text,
  status text NOT NULL DEFAULT 'booked',
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  offer_expires_at timestamptz,
  offer_membership_id uuid REFERENCES public.memberships(id) ON DELETE SET NULL,
  offer_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaign_claims_status_check CHECK (status IN ('booked', 'completed', 'released', 'forfeited'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_claims_booking ON public.campaign_claims (booking_id);
-- One live claim per phone, per plate and per flat. A released claim (the wash was cancelled) frees all three again.
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_claims_customer ON public.campaign_claims (campaign_id, customer_profile_id) WHERE status <> 'released';
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_claims_plate ON public.campaign_claims (campaign_id, plate) WHERE status <> 'released';
CREATE UNIQUE INDEX IF NOT EXISTS ux_campaign_claims_flat ON public.campaign_claims (campaign_id, flat_key) WHERE status <> 'released' AND flat_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaign_claims_customer ON public.campaign_claims (customer_profile_id);

-- Read-only for people (admins see everything, a customer sees their own claim and its campaign). Every write goes through the functions below.
ALTER TABLE public.campaign_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaign_claims_read ON public.campaign_claims;
CREATE POLICY campaign_claims_read ON public.campaign_claims FOR SELECT TO authenticated
  USING (customer_profile_id = public.current_profile_id() OR public.is_admin());
REVOKE ALL ON public.campaign_claims FROM anon, authenticated;
GRANT SELECT ON public.campaign_claims TO authenticated;

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS campaigns_read ON public.campaigns;
CREATE POLICY campaigns_read ON public.campaigns FOR SELECT TO authenticated
  USING (public.is_admin() OR EXISTS (SELECT 1 FROM public.campaign_claims cl WHERE cl.campaign_id = campaigns.id AND cl.customer_profile_id = public.current_profile_id()));
REVOKE ALL ON public.campaigns FROM anon, authenticated;
GRANT SELECT ON public.campaigns TO authenticated;

-- ───────────────────────── helpers ─────────────────────────
-- "The same flat": society + block + flat number, ignoring case and spaces.
CREATE OR REPLACE FUNCTION app_private.flat_key(p_address_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT lower(regexp_replace(a.society_name || '|' || a.building_block || '|' || a.flat_number, '\s+', '', 'g'))
    FROM public.customer_addresses a WHERE a.id = p_address_id;
$$;
REVOKE ALL ON FUNCTION app_private.flat_key(uuid) FROM PUBLIC, anon, authenticated;

-- A new customer has never had a wash that was not cancelled, and has never held a membership.
CREATE OR REPLACE FUNCTION app_private.campaign_is_new_customer(p_profile_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.bookings WHERE customer_profile_id = p_profile_id AND status <> 'cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.memberships WHERE customer_profile_id = p_profile_id);
$$;
REVOKE ALL ON FUNCTION app_private.campaign_is_new_customer(uuid) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── claim a free wash ─────────────────────────
CREATE OR REPLACE FUNCTION public.claim_campaign_wash(
  p_campaign_id uuid,
  p_vehicle_id uuid,
  p_scheduled_date date,
  p_time_slot public.time_slot,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  c public.campaigns%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_addr uuid;
  v_flat text;
  v_parking text;
  v_claimed integer;
  v_day integer;
  v_booking uuid;
  v_claim uuid;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer' AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;

  -- Claims for one campaign go through one at a time, so the caps cannot be beaten by two people claiming together.
  SELECT * INTO c FROM public.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND OR NOT c.is_active THEN RAISE EXCEPTION 'This offer is not running right now'; END IF;
  IF v_today < c.claim_opens_on THEN RAISE EXCEPTION 'This offer opens on %', to_char(c.claim_opens_on, 'FMDD Mon'); END IF;
  IF v_today > c.claim_closes_on THEN RAISE EXCEPTION 'This offer has ended'; END IF;

  SELECT count(*) INTO v_claimed FROM public.campaign_claims WHERE campaign_id = c.id AND status <> 'released';
  IF v_claimed >= c.total_cap THEN RAISE EXCEPTION 'All the free washes have been claimed. Thank you for your interest!'; END IF;

  IF EXISTS (SELECT 1 FROM public.campaign_claims WHERE campaign_id = c.id AND customer_profile_id = v_profile AND status <> 'released') THEN
    RAISE EXCEPTION 'You have already claimed your free wash';
  END IF;
  IF c.new_customers_only AND NOT app_private.campaign_is_new_customer(v_profile) THEN
    RAISE EXCEPTION 'This offer is for new WASHO customers';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.campaign_claims WHERE campaign_id = c.id AND plate = v_vehicle.registration_normalized AND status <> 'released') THEN
    RAISE EXCEPTION 'A free wash has already been claimed for this vehicle';
  END IF;
  IF c.new_customers_only AND EXISTS (
       SELECT 1 FROM public.bookings b JOIN public.vehicles v ON v.id = b.vehicle_id
        WHERE v.registration_normalized = v_vehicle.registration_normalized AND b.status <> 'cancelled') THEN
    RAISE EXCEPTION 'This vehicle has already been washed by WASHO, so it is not eligible for the free wash';
  END IF;

  -- The free wash is the body wash for the vehicle (an SUV uses the car body wash, as everywhere else).
  SELECT s.* INTO v_service
    FROM public.membership_service_options o JOIN public.services s ON s.id = o.service_id AND s.is_active
   WHERE o.vehicle_type = v_vehicle.vehicle_type AND o.wash_kind = 'body';
  IF NOT FOUND THEN RAISE EXCEPTION 'The free body wash is not available for this vehicle'; END IF;

  v_addr := COALESCE(p_address_id, v_vehicle.address_id);
  IF v_addr IS NULL THEN
    SELECT id INTO v_addr FROM public.customer_addresses WHERE customer_profile_id = v_profile AND archived_at IS NULL ORDER BY is_default DESC, created_at LIMIT 1;
  END IF;
  IF v_addr IS NULL THEN RAISE EXCEPTION 'Add your address first, so our specialist knows where to come'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = v_addr AND customer_profile_id = v_profile AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;
  v_flat := app_private.flat_key(v_addr);
  IF v_flat IS NOT NULL AND EXISTS (SELECT 1 FROM public.campaign_claims WHERE campaign_id = c.id AND flat_key = v_flat AND status <> 'released') THEN
    RAISE EXCEPTION 'A free wash has already been claimed for this address';
  END IF;

  IF p_scheduled_date IS NULL OR p_scheduled_date < v_today THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  IF p_scheduled_date > c.use_by_date THEN RAISE EXCEPTION 'The free wash must be on or before %', to_char(c.use_by_date, 'FMDD Mon'); END IF;
  IF app_private.slot_start(p_scheduled_date, p_time_slot) < now() + make_interval(hours => app_private.setting('on_demand_min_lead_hours')) THEN
    RAISE EXCEPTION 'That slot starts too soon. Please choose a later one.';
  END IF;
  IF app_private.vehicle_has_live_booking(v_vehicle.id, p_scheduled_date) THEN
    RAISE EXCEPTION 'This vehicle already has a wash booked that day';
  END IF;
  IF c.daily_cap IS NOT NULL THEN
    SELECT count(*) INTO v_day FROM public.campaign_claims cl JOIN public.bookings b ON b.id = cl.booking_id
     WHERE cl.campaign_id = c.id AND cl.status <> 'released' AND b.scheduled_date = p_scheduled_date;
    IF v_day >= c.daily_cap THEN RAISE EXCEPTION 'That day is fully booked for free washes. Please choose another day.'; END IF;
  END IF;

  v_parking := COALESCE(NULLIF(trim(COALESCE(p_parking_location, '')), ''), v_vehicle.parking_location,
                        (SELECT parking_location FROM public.customer_addresses WHERE id = v_addr));
  BEGIN
    INSERT INTO public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status,
                                 notes, address_id, parking_location, target_completion_time, source, price_cents)
    VALUES (v_profile, v_vehicle.id, v_service.id, 'on_demand', p_scheduled_date, p_time_slot, 'confirmed',
            c.name || ' (free wash)' || COALESCE(E'\n' || v_parking, ''), v_addr, v_parking, NULLIF(p_target_completion_time, ''), 'website', 0)
    RETURNING id INTO v_booking;
    INSERT INTO public.campaign_claims (campaign_id, customer_profile_id, booking_id, plate, flat_key)
    VALUES (c.id, v_profile, v_booking, v_vehicle.registration_normalized, v_flat)
    RETURNING id INTO v_claim;
  EXCEPTION WHEN unique_violation THEN
    -- the unique indexes are the last line of defence when two requests slip past the checks above
    IF SQLERRM LIKE '%ux_campaign_claims_plate%' THEN RAISE EXCEPTION 'A free wash has already been claimed for this vehicle'; END IF;
    IF SQLERRM LIKE '%ux_campaign_claims_flat%' THEN RAISE EXCEPTION 'A free wash has already been claimed for this address'; END IF;
    IF SQLERRM LIKE '%ux_campaign_claims_customer%' THEN RAISE EXCEPTION 'You have already claimed your free wash'; END IF;
    IF SQLERRM LIKE '%ux_bookings_vehicle_day_live%' THEN RAISE EXCEPTION 'This vehicle already has a wash booked that day'; END IF;
    RAISE;
  END;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (v_booking, 'booking_created', v_profile, jsonb_build_object('booking_type', 'on_demand', 'source', 'website', 'payment', 'free', 'campaign', c.code));
  INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
  VALUES (v_profile, 'booking_confirmed', 'Your free wash is booked',
          v_service.name || ' on ' || to_char(p_scheduled_date, 'Dy DD Mon') || ' (' || p_time_slot || ')', v_booking);
  PERFORM app_private.audit('booking', v_booking, 'campaign_wash_claimed', jsonb_build_object('campaign', c.code, 'claim_id', v_claim, 'scheduled_date', p_scheduled_date));

  RETURN jsonb_build_object('booking_id', v_booking, 'claim_id', v_claim, 'campaign_name', c.name, 'service_name', v_service.name);
END $$;
REVOKE ALL ON FUNCTION public.claim_campaign_wash(uuid, uuid, date, public.time_slot, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_campaign_wash(uuid, uuid, date, public.time_slot, uuid, text, text) TO authenticated;

-- ───────────────────────── keep the claim in step with its wash ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.sync_campaign_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cl public.campaign_claims%ROWTYPE;
  c public.campaigns%ROWTYPE;
  v_last_day date;
BEGIN
  SELECT * INTO cl FROM public.campaign_claims WHERE booking_id = NEW.id FOR UPDATE;
  IF NOT FOUND OR cl.status <> 'booked' THEN RETURN NEW; END IF;
  SELECT * INTO c FROM public.campaigns WHERE id = cl.campaign_id;

  IF NEW.status = 'completed' THEN
    -- the offer lasts through the end of its last day (Pune time)
    v_last_day := (now() AT TIME ZONE 'Asia/Kolkata')::date + c.pack_offer_days;
    UPDATE public.campaign_claims
       SET status = 'completed', completed_at = now(), updated_at = now(),
           offer_expires_at = ((v_last_day::timestamp + interval '23 hours 59 minutes 59 seconds') AT TIME ZONE 'Asia/Kolkata')
     WHERE id = cl.id;
    INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
    VALUES (cl.customer_profile_id, 'wash_completed', 'Your free wash is done',
            'Start a wash pack by ' || to_char(v_last_day, 'FMDD Mon') || ' and save ' || trim_scale(c.pack_offer_bp_1 / 100.0)::text || '% to ' || trim_scale(GREATEST(c.pack_offer_bp_1, c.pack_offer_bp_2, c.pack_offer_bp_3plus) / 100.0)::text || '%.',
            cl.booking_id);
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE public.campaign_claims SET status = 'released', updated_at = now() WHERE id = cl.id;
  ELSIF NEW.status = 'no_show' THEN
    UPDATE public.campaign_claims SET status = 'forfeited', updated_at = now() WHERE id = cl.id;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.sync_campaign_claim() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS bookings_sync_campaign_claim ON public.bookings;
CREATE TRIGGER bookings_sync_campaign_claim AFTER UPDATE OF status ON public.bookings
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION app_private.sync_campaign_claim();

-- A membership priced with the welcome offer uses it up (the first membership to be created with it).
CREATE OR REPLACE FUNCTION app_private.consume_campaign_offer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_claim uuid := NULLIF(NEW.pricing_snapshot #>> '{campaign_offer,claim_id}', '')::uuid;
BEGIN
  IF v_claim IS NOT NULL THEN
    UPDATE public.campaign_claims SET offer_membership_id = NEW.id, offer_used_at = now(), updated_at = now()
     WHERE id = v_claim AND customer_profile_id = NEW.customer_profile_id AND offer_membership_id IS NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.consume_campaign_offer() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS memberships_consume_campaign_offer ON public.memberships;
CREATE TRIGGER memberships_consume_campaign_offer AFTER INSERT ON public.memberships
  FOR EACH ROW WHEN (NEW.pricing_snapshot ? 'campaign_offer') EXECUTE FUNCTION app_private.consume_campaign_offer();

-- ───────────────────────── what the website shows ─────────────────────────
-- The campaign people can claim now (or that opens soon), how many are left, what THIS visitor can do about it, and their pack offer
-- if they have one (which outlives the campaign). Anonymous visitors get the campaign only.
CREATE OR REPLACE FUNCTION public.get_campaign_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_profile uuid := public.current_profile_id();
  v_customer boolean := v_profile IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer');
  c public.campaigns%ROWTYPE;
  cl public.campaign_claims%ROWTYPE;
  v_claimed integer;
  v_state text;
  v_full jsonb;
  v_campaign jsonb := NULL;
  v_me jsonb := NULL;
  v_offer jsonb := NULL;
BEGIN
  SELECT * INTO c FROM public.campaigns WHERE is_active AND claim_closes_on >= v_today
   ORDER BY (claim_opens_on > v_today), claim_opens_on DESC LIMIT 1;
  IF FOUND THEN
    SELECT count(*) INTO v_claimed FROM public.campaign_claims WHERE campaign_id = c.id AND status <> 'released';
    v_state := CASE WHEN v_today < c.claim_opens_on THEN 'upcoming' WHEN v_claimed >= c.total_cap THEN 'full' ELSE 'open' END;
    SELECT COALESCE(jsonb_agg(d.day ORDER BY d.day), '[]'::jsonb) INTO v_full
      FROM (SELECT b.scheduled_date AS day FROM public.campaign_claims x JOIN public.bookings b ON b.id = x.booking_id
             WHERE c.daily_cap IS NOT NULL AND x.campaign_id = c.id AND x.status <> 'released' AND b.scheduled_date >= v_today
             GROUP BY b.scheduled_date HAVING count(*) >= c.daily_cap) d;
    v_campaign := jsonb_build_object(
      'id', c.id, 'code', c.code, 'name', c.name, 'description', c.description, 'state', v_state,
      'claim_opens_on', c.claim_opens_on, 'claim_closes_on', c.claim_closes_on, 'use_by_date', c.use_by_date,
      'total_cap', c.total_cap, 'spots_left', GREATEST(c.total_cap - v_claimed, 0), 'full_dates', v_full,
      'new_customers_only', c.new_customers_only,
      'pack_offer', jsonb_build_object('days', c.pack_offer_days, 'bp_1', c.pack_offer_bp_1, 'bp_2', c.pack_offer_bp_2, 'bp_3plus', c.pack_offer_bp_3plus));

    IF v_customer THEN
      SELECT * INTO cl FROM public.campaign_claims WHERE campaign_id = c.id AND customer_profile_id = v_profile AND status <> 'released' ORDER BY claimed_at DESC LIMIT 1;
      IF FOUND THEN
        v_me := jsonb_build_object('state', cl.status, 'booking_id', cl.booking_id,
          'scheduled_date', (SELECT b.scheduled_date FROM public.bookings b WHERE b.id = cl.booking_id),
          'time_slot', (SELECT b.time_slot FROM public.bookings b WHERE b.id = cl.booking_id));
      ELSIF c.new_customers_only AND NOT app_private.campaign_is_new_customer(v_profile) THEN
        v_me := jsonb_build_object('state', 'ineligible', 'reason', 'existing_customer');
      ELSE
        v_me := jsonb_build_object('state', 'eligible');
      END IF;
    END IF;
  END IF;

  IF v_customer THEN
    SELECT jsonb_build_object('claim_id', x.id, 'campaign_name', k.name, 'expires_at', x.offer_expires_at,
                              'bp_1', k.pack_offer_bp_1, 'bp_2', k.pack_offer_bp_2, 'bp_3plus', k.pack_offer_bp_3plus)
      INTO v_offer
      FROM public.campaign_claims x JOIN public.campaigns k ON k.id = x.campaign_id
     WHERE x.customer_profile_id = v_profile AND x.status = 'completed' AND x.offer_membership_id IS NULL AND x.offer_expires_at > now()
     ORDER BY x.offer_expires_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object('campaign', v_campaign, 'me', v_me, 'offer', v_offer);
END $$;
REVOKE ALL ON FUNCTION public.get_campaign_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_campaign_status() TO anon, authenticated, service_role;

-- ───────────────────────── the pack price, with the welcome offer ─────────────────────────
-- Same calculator as before (migration 10). The one addition: a signed-in customer whose free wash is done, inside their offer window
-- and not yet used, gets the campaign's rate for this many washes a week in place of the normal frequency discount (never lower).
CREATE OR REPLACE FUNCTION app_private.compute_membership_quote(p_vehicle_type public.vehicle_type, p_weekly_pattern jsonb, p_duration_months integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_freq integer;
  v_weeks integer := app_private.setting('weeks_per_month');
  v_cap_bp integer := app_private.setting('max_total_discount_bp');
  v_bodies integer;
  v_deeps integer;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal bigint := 0;
  v_freq_bp integer;
  v_freq_label text;
  v_dur_bp integer;
  v_freq_cents bigint;
  v_dur_cents bigint;
  v_combined bigint;
  v_cap_cents bigint;
  v_cap_adj bigint := 0;
  v_total_discount bigint;
  v_offer jsonb;
  rec record;
BEGIN
  IF p_weekly_pattern IS NULL OR jsonb_typeof(p_weekly_pattern) <> 'array' THEN
    RAISE EXCEPTION 'Choose your washes for the week';
  END IF;
  v_freq := jsonb_array_length(p_weekly_pattern);
  IF v_freq NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'A membership has 1 to 7 washes a week';
  END IF;

  IF (SELECT count(DISTINCT (e->>'weekday')) FROM jsonb_array_elements(p_weekly_pattern) e) <> v_freq THEN
    RAISE EXCEPTION 'Choose a different day for each wash';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_weekly_pattern) e
              WHERE (e->>'weekday') IS NULL OR (e->>'weekday') !~ '^[0-6]$' OR (e->>'kind') NOT IN ('body', 'deep') OR (e->>'kind') IS NULL) THEN
    RAISE EXCEPTION 'Each wash needs a weekday (0-6) and a kind (body or deep)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.membership_discount_rules WHERE active AND kind = 'duration' AND key_value = p_duration_months) THEN
    RAISE EXCEPTION 'Membership length must be 1, 3, 6 or 12 months';
  END IF;

  SELECT count(*) FILTER (WHERE e->>'kind' = 'body'), count(*) FILTER (WHERE e->>'kind' = 'deep')
    INTO v_bodies, v_deeps FROM jsonb_array_elements(p_weekly_pattern) e;

  -- Composition rules
  IF p_vehicle_type = 'bike' THEN
    IF v_deeps > 0 THEN RAISE EXCEPTION 'Bikes have one wash type'; END IF;
  ELSIF v_freq = 2 AND NOT (v_bodies = 1 AND v_deeps = 1) THEN
    RAISE EXCEPTION '2 washes a week is 1 body wash + 1 deep cleaning';
  ELSIF v_freq >= 3 AND (v_bodies < 1 OR v_deeps < 1) THEN
    RAISE EXCEPTION '% washes a week mixes body washes and deep cleanings', v_freq;
  END IF;

  -- Lines: one per service
  FOR rec IN
    SELECT o.service_id, s.code, s.name, k.kind, k.n AS per_week
      FROM (SELECT e->>'kind' AS kind, count(*)::int AS n FROM jsonb_array_elements(p_weekly_pattern) e GROUP BY 1) k
      LEFT JOIN public.membership_service_options o ON o.vehicle_type = p_vehicle_type AND o.wash_kind = k.kind
      LEFT JOIN public.services s ON s.id = o.service_id
     ORDER BY k.kind
  LOOP
    IF rec.service_id IS NULL THEN
      RAISE EXCEPTION 'No % wash is offered for this vehicle', rec.kind;
    END IF;
    DECLARE
      v_unit integer := app_private.unit_price_cents(rec.service_id, p_vehicle_type);
      v_qty integer := rec.per_week * v_weeks * p_duration_months;
    BEGIN
      IF v_unit IS NULL THEN RAISE EXCEPTION 'No price is set for % on this vehicle', rec.name; END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'service_id', rec.service_id, 'code', rec.code, 'name', rec.name, 'kind', rec.kind,
        'per_week', rec.per_week, 'quantity', v_qty, 'unit_cents', v_unit, 'line_cents', v_unit::bigint * v_qty));
      v_subtotal := v_subtotal + v_unit::bigint * v_qty;
    END;
  END LOOP;

  SELECT discount_bp, label INTO v_freq_bp, v_freq_label FROM public.membership_discount_rules WHERE active AND kind = 'frequency' AND key_value = v_freq;
  SELECT discount_bp INTO v_dur_bp  FROM public.membership_discount_rules WHERE active AND kind = 'duration'  AND key_value = p_duration_months;
  v_freq_bp := COALESCE(v_freq_bp, 0);
  v_dur_bp := COALESCE(v_dur_bp, 0);

  -- The welcome offer for a customer whose free-wash campaign wash is done (their own rate for this many washes a week).
  SELECT jsonb_build_object('claim_id', cl.id, 'campaign_id', k.id, 'name', k.name, 'bp', r.bp)
    INTO v_offer
    FROM public.campaign_claims cl
    JOIN public.campaigns k ON k.id = cl.campaign_id
    CROSS JOIN LATERAL (SELECT CASE WHEN v_freq = 1 THEN k.pack_offer_bp_1 WHEN v_freq = 2 THEN k.pack_offer_bp_2 ELSE k.pack_offer_bp_3plus END AS bp) r
   WHERE cl.customer_profile_id = public.current_profile_id()
     AND cl.status = 'completed' AND cl.offer_membership_id IS NULL AND cl.offer_expires_at > now()
   ORDER BY r.bp DESC LIMIT 1;
  IF v_offer IS NOT NULL AND (v_offer->>'bp')::int > v_freq_bp THEN
    v_freq_bp := (v_offer->>'bp')::int;
    v_freq_label := 'Welcome offer · ' || v_freq || CASE WHEN v_freq = 1 THEN ' wash per week' ELSE ' washes per week' END;
  ELSE
    v_offer := NULL;
  END IF;

  -- Sequential: frequency off the subtotal, then duration off what remains. Half-up rounding to the paisa.
  v_freq_cents := round(v_subtotal::numeric * v_freq_bp / 10000);
  v_dur_cents  := round((v_subtotal - v_freq_cents)::numeric * v_dur_bp / 10000);
  v_combined   := v_freq_cents + v_dur_cents;
  v_cap_cents  := round(v_subtotal::numeric * v_cap_bp / 10000);

  IF v_combined > v_cap_cents THEN
    v_cap_adj := v_combined - v_cap_cents;   -- the part of the discount the cap takes back
    v_total_discount := v_cap_cents;
  ELSE
    v_total_discount := v_combined;
  END IF;

  RETURN jsonb_build_object(
    'vehicle_type', p_vehicle_type,
    'frequency_per_week', v_freq,
    'duration_months', p_duration_months,
    'weeks_per_month', v_weeks,
    'washes_total', v_freq * v_weeks * p_duration_months,
    'lines', v_lines,
    'subtotal_cents', v_subtotal,
    'frequency_discount', jsonb_build_object('bp', v_freq_bp, 'cents', v_freq_cents, 'label', v_freq_label),
    'duration_discount',  jsonb_build_object('bp', v_dur_bp,  'cents', v_dur_cents,  'label', (SELECT label FROM public.membership_discount_rules WHERE active AND kind='duration'  AND key_value=p_duration_months)),
    'cap', jsonb_build_object('max_bp', v_cap_bp, 'applied', v_cap_adj > 0, 'adjustment_cents', v_cap_adj),
    'total_discount_cents', v_total_discount,
    'final_cents', v_subtotal - v_total_discount,
    'rounding', 'half_up_to_paisa'
  ) || CASE WHEN v_offer IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('campaign_offer', v_offer) END;
END;
$$;
REVOKE ALL ON FUNCTION app_private.compute_membership_quote(public.vehicle_type, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.compute_membership_quote(public.vehicle_type, jsonb, integer) TO service_role;

-- ───────────────────────── admin: create, edit, switch on and off ─────────────────────────
-- p_id NULL creates (the code is fixed once created: it can be in links and on posters). Returns the campaign id.
CREATE OR REPLACE FUNCTION public.admin_save_campaign(
  p_id uuid, p_code text, p_name text, p_description text,
  p_claim_opens_on date, p_claim_closes_on date, p_use_by_date date,
  p_total_cap integer, p_daily_cap integer, p_pack_offer_days integer,
  p_bp_1 integer, p_bp_2 integer, p_bp_3plus integer, p_active boolean DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_cap integer := app_private.setting('max_total_discount_bp');
  v_name text := btrim(COALESCE(p_name, ''));
  v_desc text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_code text := lower(btrim(COALESCE(p_code, '')));
  v_claimed integer;
  v_id uuid := p_id;
BEGIN
  IF char_length(v_name) NOT BETWEEN 3 AND 80 THEN RAISE EXCEPTION 'Give the campaign a name (3 to 80 characters)'; END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 400 THEN RAISE EXCEPTION 'Keep the description under 400 characters'; END IF;
  IF p_claim_opens_on IS NULL OR p_claim_closes_on IS NULL OR p_use_by_date IS NULL THEN RAISE EXCEPTION 'Set when claims open and close, and the last day to use the wash'; END IF;
  IF p_claim_closes_on < p_claim_opens_on THEN RAISE EXCEPTION 'Claims cannot close before they open'; END IF;
  IF p_use_by_date < p_claim_opens_on THEN RAISE EXCEPTION 'The last day to use the wash cannot be before claims open'; END IF;
  IF p_total_cap IS NULL OR p_total_cap < 1 OR p_total_cap > 100000 THEN RAISE EXCEPTION 'Set how many free washes there are (1 or more)'; END IF;
  IF p_daily_cap IS NOT NULL AND (p_daily_cap < 1 OR p_daily_cap > 10000) THEN RAISE EXCEPTION 'The daily limit must be 1 or more, or empty for no daily limit'; END IF;
  IF p_pack_offer_days IS NULL OR p_pack_offer_days < 1 OR p_pack_offer_days > 365 THEN RAISE EXCEPTION 'The pack offer lasts 1 to 365 days'; END IF;
  IF p_bp_1 IS NULL OR p_bp_2 IS NULL OR p_bp_3plus IS NULL OR LEAST(p_bp_1, p_bp_2, p_bp_3plus) < 0 THEN RAISE EXCEPTION 'Enter the three pack discounts'; END IF;
  IF GREATEST(p_bp_1, p_bp_2, p_bp_3plus) > v_cap THEN
    RAISE EXCEPTION 'A pack discount cannot be more than the % percent combined discount cap', trim_scale(v_cap / 100.0);
  END IF;

  IF v_id IS NULL THEN
    IF v_code !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_code) NOT BETWEEN 3 AND 40 THEN
      RAISE EXCEPTION 'The short name is 3 to 40 letters, numbers and dashes, for example navratri-2026';
    END IF;
    IF EXISTS (SELECT 1 FROM public.campaigns WHERE code = v_code) THEN RAISE EXCEPTION 'There is already a campaign called %', v_code; END IF;
    INSERT INTO public.campaigns (code, name, description, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, daily_cap,
                                  pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, created_by)
    VALUES (v_code, v_name, v_desc, COALESCE(p_active, false), p_claim_opens_on, p_claim_closes_on, p_use_by_date, p_total_cap, p_daily_cap,
            p_pack_offer_days, p_bp_1, p_bp_2, p_bp_3plus, v_admin)
    RETURNING id INTO v_id;
    PERFORM app_private.audit('campaign', v_id, 'campaign_created', jsonb_build_object('code', v_code, 'total_cap', p_total_cap, 'daily_cap', p_daily_cap));
  ELSE
    PERFORM 1 FROM public.campaigns WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
    SELECT count(*) INTO v_claimed FROM public.campaign_claims WHERE campaign_id = v_id AND status <> 'released';
    IF p_total_cap < v_claimed THEN RAISE EXCEPTION '% free washes are already claimed, so the total cannot go below that', v_claimed; END IF;
    UPDATE public.campaigns
       SET name = v_name, description = v_desc, claim_opens_on = p_claim_opens_on, claim_closes_on = p_claim_closes_on, use_by_date = p_use_by_date,
           total_cap = p_total_cap, daily_cap = p_daily_cap, pack_offer_days = p_pack_offer_days,
           pack_offer_bp_1 = p_bp_1, pack_offer_bp_2 = p_bp_2, pack_offer_bp_3plus = p_bp_3plus,
           is_active = COALESCE(p_active, is_active), updated_at = now()
     WHERE id = v_id;
    PERFORM app_private.audit('campaign', v_id, 'campaign_updated', jsonb_build_object('total_cap', p_total_cap, 'daily_cap', p_daily_cap));
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean) TO authenticated; -- is_admin() inside

CREATE OR REPLACE FUNCTION public.admin_set_campaign_active(p_id uuid, p_active boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid := app_private.require_admin();
BEGIN
  UPDATE public.campaigns SET is_active = COALESCE(p_active, false), updated_at = now() WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
  PERFORM app_private.audit('campaign', p_id, CASE WHEN p_active THEN 'campaign_switched_on' ELSE 'campaign_switched_off' END, '{}'::jsonb);
  RETURN COALESCE(p_active, false);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_campaign_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_campaign_active(uuid, boolean) TO authenticated; -- is_admin() inside
