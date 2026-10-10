-- 20261004000036_campaign_times.sql
-- SAFE / additive. A free-wash campaign's claims can open and close at an exact TIME (Pune time), not only on a date: "claims open 10 September at 10:00 am, close 12 September at 8:00 pm".
--
--   campaigns.claim_opens_at / claim_closes_at     two new optional columns (both set or both empty). A campaign made before this, or saved without times, has neither and keeps
--                                                  working exactly as before: it opens at the start of its "claims open" day and closes at the end of its "claims close" day.
--   app_private.campaign_opens_at / campaign_closes_at   the one place that says WHEN a campaign opens and closes (the exact time when there is one, the day boundaries when not)
--   get_campaign_status (replaced)                 the campaign people can claim now or that opens soon, decided by the clock rather than the date; it also returns the two times
--   claim_campaign_wash (replaced)                 refuses before the opening time ("This offer opens on 10 Sep, 10:00 am") and from the closing time ("This offer has ended")
--   admin_save_campaign (replaced)                 takes the two times as a last, optional pair; the date columns are derived from them so nothing that reads the dates changes
-- Nothing else about a campaign changes: the caps, who may claim, one per phone, plate and flat, WASHO placing the wash, the pack offer. The old 15-argument call still works.

ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS claim_opens_at timestamptz;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS claim_closes_at timestamptz;
ALTER TABLE public.campaigns DROP CONSTRAINT IF EXISTS campaigns_claim_times_check;
ALTER TABLE public.campaigns ADD CONSTRAINT campaigns_claim_times_check CHECK ((claim_opens_at IS NULL) = (claim_closes_at IS NULL) AND (claim_opens_at IS NULL OR claim_closes_at > claim_opens_at));

CREATE OR REPLACE FUNCTION app_private.campaign_opens_at(k public.campaigns) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(k.claim_opens_at, k.claim_opens_on::timestamp AT TIME ZONE 'Asia/Kolkata') $$;
CREATE OR REPLACE FUNCTION app_private.campaign_closes_at(k public.campaigns) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$ SELECT COALESCE(k.claim_closes_at, (k.claim_closes_on + 1)::timestamp AT TIME ZONE 'Asia/Kolkata') $$;
REVOKE ALL ON FUNCTION app_private.campaign_opens_at(public.campaigns), app_private.campaign_closes_at(public.campaigns) FROM PUBLIC, anon, authenticated;
-- (they are called from SECURITY DEFINER functions, which run as their owner)

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
  SELECT k.* INTO c FROM public.campaigns k WHERE k.is_active AND app_private.campaign_closes_at(k) > now()
   ORDER BY (app_private.campaign_opens_at(k) > now()), app_private.campaign_opens_at(k) DESC LIMIT 1;
  IF FOUND THEN
    SELECT count(*) INTO v_claimed FROM public.campaign_claims WHERE campaign_id = c.id AND status <> 'released';
    v_state := CASE WHEN now() < app_private.campaign_opens_at(c) THEN 'upcoming' WHEN v_claimed >= c.total_cap THEN 'full' ELSE 'open' END;
    SELECT COALESCE(jsonb_agg(d.day ORDER BY d.day), '[]'::jsonb) INTO v_full
      FROM (SELECT b.scheduled_date AS day FROM public.campaign_claims x JOIN public.bookings b ON b.id = x.booking_id
             WHERE c.daily_cap IS NOT NULL AND x.campaign_id = c.id AND x.status <> 'released' AND b.scheduled_date >= v_today
             GROUP BY b.scheduled_date HAVING count(*) >= c.daily_cap) d;
    v_campaign := jsonb_build_object(
      'id', c.id, 'code', c.code, 'name', c.name, 'description', c.description, 'state', v_state,
      'claim_opens_on', c.claim_opens_on, 'claim_closes_on', c.claim_closes_on, 'claim_opens_at', c.claim_opens_at, 'claim_closes_at', c.claim_closes_at, 'use_by_date', c.use_by_date,
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
  v_date date;
  v_slot public.time_slot;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer' AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;

  -- Claims for one campaign go through one at a time, so the caps cannot be beaten by two people claiming together.
  SELECT * INTO c FROM public.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND OR NOT c.is_active THEN RAISE EXCEPTION 'This offer is not running right now'; END IF;
  IF now() < app_private.campaign_opens_at(c) THEN
    RAISE EXCEPTION 'This offer opens on %', to_char(app_private.campaign_opens_at(c) AT TIME ZONE 'Asia/Kolkata', CASE WHEN c.claim_opens_at IS NULL THEN 'FMDD Mon' ELSE 'FMDD Mon, FMHH12:MI am' END);
  END IF;
  IF now() >= app_private.campaign_closes_at(c) THEN RAISE EXCEPTION 'This offer has ended'; END IF;

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

  -- WASHO picks the day and the time window; the customer is not asked (the date and slot a caller may send are ignored).
  SELECT p.o_date, p.o_slot INTO v_date, v_slot FROM app_private.pick_campaign_slot(c, v_vehicle.id) p;
  IF v_date IS NULL THEN RAISE EXCEPTION 'There is no day left for a free wash. Please contact WASHO'; END IF;

  v_parking := COALESCE(NULLIF(trim(COALESCE(p_parking_location, '')), ''), v_vehicle.parking_location,
                        (SELECT parking_location FROM public.customer_addresses WHERE id = v_addr));
  BEGIN
    INSERT INTO public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status,
                                 notes, address_id, parking_location, target_completion_time, source, price_cents)
    VALUES (v_profile, v_vehicle.id, v_service.id, 'on_demand', v_date, v_slot, 'confirmed',
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
          v_service.name || ' on ' || to_char(v_date, 'Dy DD Mon') || ' (' || v_slot || ')', v_booking);
  PERFORM app_private.audit('booking', v_booking, 'campaign_wash_claimed', jsonb_build_object('campaign', c.code, 'claim_id', v_claim, 'scheduled_date', v_date, 'time_slot', v_slot));

  RETURN jsonb_build_object('booking_id', v_booking, 'claim_id', v_claim, 'campaign_name', c.name, 'service_name', v_service.name, 'scheduled_date', v_date, 'time_slot', v_slot);
END $$;

DROP FUNCTION IF EXISTS public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean, boolean);
CREATE OR REPLACE FUNCTION public.admin_save_campaign(
  p_id uuid, p_code text, p_name text, p_description text,
  p_claim_opens_on date, p_claim_closes_on date, p_use_by_date date,
  p_total_cap integer, p_daily_cap integer, p_pack_offer_days integer,
  p_bp_1 integer, p_bp_2 integer, p_bp_3plus integer, p_active boolean DEFAULT NULL, p_new_customers_only boolean DEFAULT NULL,
  p_claim_opens_at timestamptz DEFAULT NULL, p_claim_closes_at timestamptz DEFAULT NULL
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
  -- Claims can open and close at an exact time (Pune time). Both or neither; the date columns follow, so everything that reads them keeps working.
  IF (p_claim_opens_at IS NULL) <> (p_claim_closes_at IS NULL) THEN RAISE EXCEPTION 'Set both the time claims open and the time they close'; END IF;
  IF p_claim_opens_at IS NOT NULL THEN
    IF p_claim_closes_at <= p_claim_opens_at THEN RAISE EXCEPTION 'Claims must close after they open'; END IF;
    p_claim_opens_on := (p_claim_opens_at AT TIME ZONE 'Asia/Kolkata')::date;
    p_claim_closes_on := (p_claim_closes_at AT TIME ZONE 'Asia/Kolkata')::date;
  END IF;
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
    INSERT INTO public.campaigns (code, name, description, is_active, claim_opens_on, claim_closes_on, claim_opens_at, claim_closes_at, use_by_date, total_cap, daily_cap,
                                  pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only, created_by)
    VALUES (v_code, v_name, v_desc, COALESCE(p_active, false), p_claim_opens_on, p_claim_closes_on, p_claim_opens_at, p_claim_closes_at, p_use_by_date, p_total_cap, p_daily_cap,
            p_pack_offer_days, p_bp_1, p_bp_2, p_bp_3plus, COALESCE(p_new_customers_only, true), v_admin)
    RETURNING id INTO v_id;
    PERFORM app_private.audit('campaign', v_id, 'campaign_created', jsonb_build_object('code', v_code, 'total_cap', p_total_cap, 'daily_cap', p_daily_cap, 'new_customers_only', COALESCE(p_new_customers_only, true), 'claim_opens_at', p_claim_opens_at, 'claim_closes_at', p_claim_closes_at));
  ELSE
    PERFORM 1 FROM public.campaigns WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
    SELECT count(*) INTO v_claimed FROM public.campaign_claims WHERE campaign_id = v_id AND status <> 'released';
    IF p_total_cap < v_claimed THEN RAISE EXCEPTION '% free washes are already claimed, so the total cannot go below that', v_claimed; END IF;
    UPDATE public.campaigns
       SET name = v_name, description = v_desc, claim_opens_on = p_claim_opens_on, claim_closes_on = p_claim_closes_on, claim_opens_at = p_claim_opens_at, claim_closes_at = p_claim_closes_at, use_by_date = p_use_by_date,
           total_cap = p_total_cap, daily_cap = p_daily_cap, pack_offer_days = p_pack_offer_days,
           pack_offer_bp_1 = p_bp_1, pack_offer_bp_2 = p_bp_2, pack_offer_bp_3plus = p_bp_3plus,
           is_active = COALESCE(p_active, is_active), new_customers_only = COALESCE(p_new_customers_only, new_customers_only), updated_at = now()
     WHERE id = v_id;
    PERFORM app_private.audit('campaign', v_id, 'campaign_updated', jsonb_build_object('total_cap', p_total_cap, 'daily_cap', p_daily_cap, 'new_customers_only', p_new_customers_only, 'claim_opens_at', p_claim_opens_at, 'claim_closes_at', p_claim_closes_at));
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean, boolean, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean, boolean, timestamptz, timestamptz) TO authenticated; -- is_admin() inside
