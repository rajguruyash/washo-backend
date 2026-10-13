-- 20261004000040_working_days_wording.sql
-- SAFE / re-runnable. WORDING ONLY for Working Days (migration 39): what the server says when a day cannot be booked now reads "WASHO is currently unavailable on ..." instead of
-- "WASHO does not wash on ...", the same as the booking pages. No table, no row and no rule changes; the four functions below are migration 39's, word for word, except for their messages.
--
--   closed_day_message(date)        "WASHO is currently unavailable on Monday, 13 Oct (Diwali). The next day you can book is Saturday, 17 Oct."
--   require_open_weekdays(...)      "WASHO is currently unavailable on Mondays, Wednesdays. Choose from Saturdays, Sundays."
--   pick_campaign_slot(...)         "WASHO has no available day left while this offer is open. ..."
--   create_monthly_membership_request(...)   its "We cannot fit all N washes ..." message says "or WASHO is currently unavailable on them"

CREATE OR REPLACE FUNCTION app_private.closed_day_message(p_date date) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text;
  v_next date;
BEGIN
  SELECT d.reason INTO v_reason FROM public.working_dates d WHERE d.day = p_date AND NOT d.is_open;
  v_next := app_private.next_working_day(GREATEST(p_date, v_today) + 1);
  RETURN 'WASHO is currently unavailable on ' || to_char(p_date, 'FMDay, FMDD Mon') || CASE WHEN v_reason IS NOT NULL THEN ' (' || v_reason || ')' ELSE '' END || '. '
      || CASE WHEN v_next IS NULL THEN 'We are not taking bookings right now.' ELSE 'The next day you can book is ' || to_char(v_next, 'FMDay, FMDD Mon') || '.' END;
END $$;

CREATE OR REPLACE FUNCTION app_private.require_open_weekdays(p_days smallint[], p_start date, p_end date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bad smallint[]; v_open smallint[];
BEGIN
  IF p_days IS NULL OR cardinality(p_days) = 0 THEN RETURN; END IF;
  SELECT array_agg(d::smallint ORDER BY d) INTO v_bad FROM unnest(p_days) d
   WHERE NOT EXISTS (SELECT 1 FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
                      WHERE extract(dow FROM g)::integer = d AND app_private.is_working_day(g::date));
  IF v_bad IS NULL THEN RETURN; END IF;
  SELECT array_agg(d::smallint ORDER BY d) INTO v_open FROM generate_series(0, 6) d
   WHERE EXISTS (SELECT 1 FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
                  WHERE extract(dow FROM g)::integer = d AND app_private.is_working_day(g::date));
  RAISE EXCEPTION '%', 'WASHO is currently unavailable on ' || app_private.weekday_words(v_bad) || '. '
    || CASE WHEN v_open IS NULL THEN 'We are not taking memberships right now.' ELSE 'Choose from ' || app_private.weekday_words(v_open) || '.' END;
END $$;

CREATE OR REPLACE FUNCTION app_private.pick_campaign_slot(p_campaign public.campaigns, p_vehicle uuid, OUT o_date date, OUT o_slot public.time_slot)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_lead integer := app_private.setting('on_demand_min_lead_hours');
  d date; s public.time_slot; best public.time_slot; best_n integer; n integer; v_taken integer;
  fb_date date; fb_slot public.time_slot; v_skipped date;
BEGIN
  FOR i IN 0 .. GREATEST(p_campaign.use_by_date - v_today, -1) LOOP
    d := v_today + i;
    IF NOT app_private.is_working_day(d) THEN v_skipped := COALESCE(v_skipped, d); CONTINUE; END IF;
    IF app_private.vehicle_has_live_booking(p_vehicle, d) THEN CONTINUE; END IF;
    IF p_campaign.daily_cap IS NOT NULL THEN
      SELECT count(*) INTO v_taken FROM public.campaign_claims cl JOIN public.bookings b ON b.id = cl.booking_id
       WHERE cl.campaign_id = p_campaign.id AND cl.status <> 'released' AND b.scheduled_date = d;
      IF v_taken >= p_campaign.daily_cap THEN CONTINUE; END IF;
    END IF;
    best := NULL; best_n := NULL;
    FOREACH s IN ARRAY ARRAY['morning', 'afternoon', 'night']::public.time_slot[] LOOP
      IF app_private.slot_start(d, s) < now() + make_interval(hours => v_lead) THEN CONTINUE; END IF;
      n := app_private.washes_on(d, s);
      IF best IS NULL OR n < best_n THEN best := s; best_n := n; END IF;
    END LOOP;
    IF best IS NULL THEN CONTINUE; END IF;
    IF fb_date IS NULL THEN fb_date := d; fb_slot := best; END IF;
    IF app_private.crowd_state(d, best) <> 'full' THEN o_date := d; o_slot := best; RETURN; END IF;
  END LOOP;
  IF fb_date IS NULL AND v_skipped IS NOT NULL THEN
    RAISE EXCEPTION '%', 'WASHO has no available day left while this offer is open. ' || app_private.closed_day_message(v_skipped);
  END IF;
  o_date := fb_date; o_slot := fb_slot;
END $$;
REVOKE ALL ON FUNCTION app_private.pick_campaign_slot(public.campaigns, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_monthly_membership_request(
  p_vehicle_id uuid,
  p_body integer,
  p_deep integer,
  p_weekdays integer[],
  p_duration_months integer,
  p_time_slot public.time_slot,
  p_start_date date,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL,
  p_custom_dates jsonb DEFAULT NULL,
  p_coupon text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_addr uuid := p_address_id;
  v_quote jsonb;
  v_id uuid;
  v_total integer;
  v_end date;
  v_custom jsonb;
  v_days smallint[];
  v_n integer := COALESCE(p_body, 0) + COALESCE(p_deep, 0);
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  IF v_addr IS NULL THEN v_addr := v_vehicle.address_id; END IF;
  IF v_addr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = v_addr AND customer_profile_id = v_profile) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;
  IF p_start_date IS NULL OR p_start_date < v_today + app_private.setting('membership_min_lead_days') THEN
    RAISE EXCEPTION 'Your membership can start from % at the earliest', v_today + app_private.setting('membership_min_lead_days');
  END IF;

  -- Validates the counts (4 to 28 a month), the length and the vehicle; raises a message a customer can read.
  v_quote := app_private.compute_monthly_quote(v_vehicle.vehicle_type, p_body, p_deep, p_duration_months);
  -- A coupon the customer typed in: an extra percentage off the plan price, as its own line. Raises a message a customer can read if it cannot be used.
  v_quote := app_private.apply_coupon(v_quote, p_coupon, v_profile);
  v_days := app_private.clean_weekdays(p_weekdays);
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);

  IF p_custom_dates IS NULL THEN
    PERFORM app_private.require_open_weekdays(v_days, p_start_date, v_end);
    -- every month needs room for every wash: at least 4 days a month for each weekday chosen, so n washes need ceil(n / 4) weekdays
    IF cardinality(v_days) < CEIL(v_n / 4.0)::integer THEN
      RAISE EXCEPTION 'Pick at least % day% of the week so your % washes a month fit', CEIL(v_n / 4.0)::integer, CASE WHEN CEIL(v_n / 4.0) = 1 THEN '' ELSE 's' END, v_n;
    END IF;
    IF (SELECT count(*) FROM app_private.plan_monthly_washes(p_vehicle_id, p_start_date, p_duration_months, p_body, p_deep, v_days)) < v_total THEN
      RAISE EXCEPTION 'We cannot fit all % washes on those days: some days already have a wash for this vehicle, or WASHO is currently unavailable on them. Choose more days, or pick exact dates.', v_total;
    END IF;
  ELSE
    v_custom := app_private.check_custom_dates_counts(p_vehicle_id, p_start_date, v_end, p_body * p_duration_months, p_deep * p_duration_months, CEIL(v_n / 4.0)::integer, p_custom_dates);
  END IF;

  BEGIN
    INSERT INTO public.membership_requests (
      customer_profile_id, vehicle_id, address_id, parking_location, frequency_per_week, duration_months,
      weekly_pattern, time_slot, target_completion_time, start_date, customer_notes, system_quote, custom_dates,
      monthly_body, monthly_deep, preferred_weekdays
    ) VALUES (
      v_profile, p_vehicle_id, v_addr, COALESCE(NULLIF(trim(p_parking_location), ''), v_vehicle.parking_location),
      (v_quote->>'frequency_per_week')::integer, p_duration_months, '[]'::jsonb, p_time_slot, p_target_completion_time,
      p_start_date, NULLIF(trim(p_customer_notes), ''), v_quote, v_custom,
      p_body, p_deep, v_days
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a membership request in progress for this vehicle';
  END;

  PERFORM app_private.audit('membership_request', v_id, 'membership_requested',
    jsonb_build_object('washes_per_month', v_n, 'body', p_body, 'deep', p_deep, 'duration_months', p_duration_months));
  RETURN v_id;
END $$;
