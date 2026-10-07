-- 20261004000019_capacity.sql
-- SAFE and re-runnable. How many vehicles WASHO can wash on a day, and in each time window, so that nobody is booked into a crowded day.
--
-- capacity_rules holds two rows, "weekday" (Mon-Fri) and "weekend" (Sat, Sun), each with
--   day_busy / day_full    washes on the whole day at which it is flagged busy (a warning) and full (closed)
--   slot_busy / slot_full  the same for one time window (morning, afternoon, night) of that day
-- Defaults: weekdays 10 busy / 15 full a day, weekends 15 busy / 20 full a day (per window: 6 / 9 and 9 / 12). Admin -> Capacity changes them.
--
-- A wash holds a place from the moment it is booked until it is cancelled, refunded or missed. The load of a day is the number of such washes on it, whoever
-- booked them (memberships, single washes, free washes, washes WASHO booked).
--
--   get_capacity(from, to)   what the booking pages show: for every day its load and state (ok / busy / full), and the same for each window.
--   require_capacity(d, s)   refuses a booking for a day or window that is full. Used by single-wash checkout and the free-wash claim here,
--                            and by the membership checkout in migration 20. A wash that is ALREADY paid for is never refused (money is never taken for
--                            something that then cannot be done): only the moment of choosing is checked. WASHO's own bookings (admin) are never refused.

CREATE TABLE IF NOT EXISTS public.capacity_rules (
  day_kind text PRIMARY KEY,
  day_busy integer NOT NULL,
  day_full integer NOT NULL,
  slot_busy integer NOT NULL,
  slot_full integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capacity_rules_kind_check CHECK (day_kind IN ('weekday', 'weekend')),
  CONSTRAINT capacity_rules_order_check CHECK (day_busy >= 1 AND day_full >= day_busy AND slot_busy >= 1 AND slot_full >= slot_busy AND day_full <= 500 AND slot_full <= 500)
);
INSERT INTO public.capacity_rules (day_kind, day_busy, day_full, slot_busy, slot_full) VALUES
  ('weekday', 10, 15, 6, 9),
  ('weekend', 15, 20, 9, 12)
ON CONFLICT (day_kind) DO NOTHING;

ALTER TABLE public.capacity_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capacity_rules_read ON public.capacity_rules;
CREATE POLICY capacity_rules_read ON public.capacity_rules FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.capacity_rules FROM anon, authenticated;
GRANT SELECT ON public.capacity_rules TO anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.capacity_kind(p_date date) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN extract(dow FROM p_date) IN (0, 6) THEN 'weekend' ELSE 'weekday' END; $$;

-- washes holding a place on a date (and, if given, in a time window)
CREATE OR REPLACE FUNCTION app_private.washes_on(p_date date, p_slot public.time_slot DEFAULT NULL) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::integer FROM public.bookings
   WHERE scheduled_date = p_date AND (p_slot IS NULL OR time_slot = p_slot)
     AND status NOT IN ('cancelled', 'refunded', 'refund_requested', 'no_show', 'rescheduled');
$$;

CREATE OR REPLACE FUNCTION app_private.level(p_n integer, p_busy integer, p_full integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN p_n >= p_full THEN 'full' WHEN p_n >= p_busy THEN 'busy' ELSE 'ok' END; $$;

-- ok / busy / full for a day and window (the window is also full when the whole day is)
CREATE OR REPLACE FUNCTION app_private.crowd_state(p_date date, p_slot public.time_slot) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.capacity_rules%ROWTYPE; v_day integer; v_slot integer;
BEGIN
  SELECT * INTO r FROM public.capacity_rules WHERE day_kind = app_private.capacity_kind(p_date);
  IF NOT FOUND THEN RETURN 'ok'; END IF;
  v_day := app_private.washes_on(p_date);
  v_slot := app_private.washes_on(p_date, p_slot);
  IF v_day >= r.day_full OR v_slot >= r.slot_full THEN RETURN 'full'; END IF;
  IF v_day >= r.day_busy OR v_slot >= r.slot_busy THEN RETURN 'busy'; END IF;
  RETURN 'ok';
END $$;

CREATE OR REPLACE FUNCTION app_private.require_capacity(p_date date, p_slot public.time_slot) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_private.crowd_state(p_date, p_slot) = 'full' THEN
    RAISE EXCEPTION '% is fully booked in the % window. Please choose another day or time.', to_char(p_date, 'FMDy, FMDD Mon'), p_slot;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_private.capacity_kind(date), app_private.washes_on(date, public.time_slot), app_private.level(integer, integer, integer),
  app_private.crowd_state(date, public.time_slot), app_private.require_capacity(date, public.time_slot) FROM PUBLIC, anon, authenticated;

-- what the booking pages need: every day from p_from to p_to with its load and state, and each window's
CREATE OR REPLACE FUNCTION public.get_capacity(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'Ask for 1 to 401 days at a time'; END IF;
  RETURN jsonb_build_object('days', COALESCE((
    WITH load AS (
      SELECT scheduled_date AS d, time_slot AS s, count(*)::integer AS n FROM public.bookings
       WHERE scheduled_date BETWEEN p_from AND p_to AND status NOT IN ('cancelled', 'refunded', 'refund_requested', 'no_show', 'rescheduled')
       GROUP BY 1, 2
    ), agg AS (
      SELECT g::date AS d, r.day_kind, r.day_busy, r.day_full, r.slot_busy, r.slot_full,
             COALESCE(sum(l.n), 0)::integer AS total,
             COALESCE(sum(l.n) FILTER (WHERE l.s = 'morning'), 0)::integer AS m,
             COALESCE(sum(l.n) FILTER (WHERE l.s = 'afternoon'), 0)::integer AS a,
             COALESCE(sum(l.n) FILTER (WHERE l.s = 'night'), 0)::integer AS nt
        FROM generate_series(p_from, p_to, interval '1 day') g
        JOIN public.capacity_rules r ON r.day_kind = app_private.capacity_kind(g::date)
        LEFT JOIN load l ON l.d = g::date
       GROUP BY g, r.day_kind, r.day_busy, r.day_full, r.slot_busy, r.slot_full
    ), w AS (   -- a window is closed when its own limit is reached or the whole day is
      SELECT agg.*,
             CASE WHEN total >= day_full OR m >= slot_full THEN 'full' WHEN total >= day_busy OR m >= slot_busy THEN 'busy' ELSE 'ok' END AS sm,
             CASE WHEN total >= day_full OR a >= slot_full THEN 'full' WHEN total >= day_busy OR a >= slot_busy THEN 'busy' ELSE 'ok' END AS sa,
             CASE WHEN total >= day_full OR nt >= slot_full THEN 'full' WHEN total >= day_busy OR nt >= slot_busy THEN 'busy' ELSE 'ok' END AS sn
        FROM agg
    )
    -- the day is red only when nothing can be booked on it; amber when it is getting crowded or one window is gone
    SELECT jsonb_agg(jsonb_build_object('date', d, 'kind', day_kind, 'total', total, 'limit', day_full,
             'state', CASE WHEN sm = 'full' AND sa = 'full' AND sn = 'full' THEN 'full' WHEN 'ok' = ALL (ARRAY[sm, sa, sn]) THEN 'ok' ELSE 'busy' END,
             'slots', jsonb_build_object(
               'morning', jsonb_build_object('n', m, 'limit', slot_full, 'state', sm),
               'afternoon', jsonb_build_object('n', a, 'limit', slot_full, 'state', sa),
               'night', jsonb_build_object('n', nt, 'limit', slot_full, 'state', sn))) ORDER BY d)
      FROM w), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.get_capacity(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_capacity(date, date) TO authenticated, service_role;

-- Admin: change the limits for weekdays or weekends
CREATE OR REPLACE FUNCTION public.admin_set_capacity(p_day_kind text, p_day_busy integer, p_day_full integer, p_slot_busy integer, p_slot_full integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid := app_private.require_admin();
BEGIN
  IF p_day_kind NOT IN ('weekday', 'weekend') THEN RAISE EXCEPTION 'Choose weekdays or weekends'; END IF;
  IF p_day_busy IS NULL OR p_day_full IS NULL OR p_slot_busy IS NULL OR p_slot_full IS NULL OR LEAST(p_day_busy, p_day_full, p_slot_busy, p_slot_full) < 1 THEN
    RAISE EXCEPTION 'Enter all four numbers (1 or more)';
  END IF;
  IF p_day_full < p_day_busy THEN RAISE EXCEPTION 'The "full" number for a day cannot be lower than its "busy" number'; END IF;
  IF p_slot_full < p_slot_busy THEN RAISE EXCEPTION 'The "full" number for a time window cannot be lower than its "busy" number'; END IF;
  IF GREATEST(p_day_full, p_slot_full) > 500 THEN RAISE EXCEPTION 'That is more than 500 vehicles'; END IF;
  INSERT INTO public.capacity_rules (day_kind, day_busy, day_full, slot_busy, slot_full) VALUES (p_day_kind, p_day_busy, p_day_full, p_slot_busy, p_slot_full)
  ON CONFLICT (day_kind) DO UPDATE SET day_busy = EXCLUDED.day_busy, day_full = EXCLUDED.day_full, slot_busy = EXCLUDED.slot_busy, slot_full = EXCLUDED.slot_full, updated_at = now();
  PERFORM app_private.audit('capacity', NULL, 'capacity_changed', jsonb_build_object('day_kind', p_day_kind, 'day_busy', p_day_busy, 'day_full', p_day_full, 'slot_busy', p_slot_busy, 'slot_full', p_slot_full));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_set_capacity(text, integer, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_capacity(text, integer, integer, integer, integer) TO authenticated; -- is_admin() inside

-- ───────────────────────── single washes and free washes honour it ─────────────────────────
-- (create_booking_payment_intent from migration 5 and claim_campaign_wash from migration 14, each with one extra line: PERFORM app_private.require_capacity(...))
CREATE OR REPLACE FUNCTION public.create_booking_payment_intent(
  p_vehicle_id uuid,
  p_service_id uuid,
  p_scheduled_date date,
  p_time_slot public.time_slot,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL,
  p_source text DEFAULT 'website'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_addr uuid := p_address_id;
  v_price integer;
  v_pay public.payments%ROWTYPE;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  IF p_source NOT IN ('mobile_app', 'website') THEN RAISE EXCEPTION 'Unknown booking source'; END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;

  SELECT * INTO v_service FROM public.services WHERE id = p_service_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service not found'; END IF;
  IF NOT (v_service.vehicle_type = v_vehicle.vehicle_type OR (v_vehicle.vehicle_type = 'suv' AND v_service.vehicle_type = 'car')) THEN
    RAISE EXCEPTION 'This service is not available for your vehicle';
  END IF;

  IF v_addr IS NULL THEN v_addr := v_vehicle.address_id; END IF;
  IF v_addr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = v_addr AND customer_profile_id = v_profile) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;

  IF p_scheduled_date IS NULL OR app_private.slot_start(p_scheduled_date, p_time_slot)
       < now() + make_interval(hours => app_private.setting('on_demand_min_lead_hours')) THEN
    RAISE EXCEPTION 'That slot starts too soon. Please choose a later one.';
  END IF;
  IF app_private.vehicle_has_live_booking(p_vehicle_id, p_scheduled_date) THEN
    RAISE EXCEPTION 'This vehicle already has a wash booked that day';
  END IF;
  PERFORM app_private.require_capacity(p_scheduled_date, p_time_slot); -- crowded days and times are closed (Admin -> Capacity)

  v_price := app_private.unit_price_cents(v_service.id, v_vehicle.vehicle_type);
  IF v_price IS NULL OR v_price < 100 THEN RAISE EXCEPTION 'No price is set for this service'; END IF;

  INSERT INTO public.payments (customer_profile_id, amount_cents, currency, provider, status, payment_kind, receipt, expires_at, fulfilment_status, intent)
  VALUES (v_profile, v_price, 'INR', 'razorpay', 'pending', 'on_demand', app_private.gen_ref('INT'),
          now() + make_interval(mins => app_private.setting('payment_intent_minutes')), 'pending',
          jsonb_build_object('kind', 'on_demand', 'vehicle_id', p_vehicle_id, 'service_id', p_service_id,
                             'scheduled_date', p_scheduled_date, 'time_slot', p_time_slot, 'address_id', v_addr,
                             'parking_location', COALESCE(NULLIF(trim(p_parking_location), ''), v_vehicle.parking_location),
                             'target_completion_time', p_target_completion_time, 'source', p_source, 'unit_price_cents', v_price))
  RETURNING * INTO v_pay;

  RETURN jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents, 'currency', 'INR',
                            'receipt', v_pay.receipt, 'expires_at', v_pay.expires_at);
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
  PERFORM app_private.require_capacity(p_scheduled_date, p_time_slot); -- crowded days and times are closed (Admin -> Capacity)

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
