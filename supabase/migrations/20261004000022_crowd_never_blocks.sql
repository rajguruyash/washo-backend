-- 20261004000022_crowd_never_blocks.sql
-- SAFE / re-runnable. The crowd limits (Admin -> Capacity) no longer close a day or a time window. Nobody is ever stopped from booking a busy day:
--   * a day or window past the AMBER number is shown amber, past the RED number it is shown red, with a note that there may be a slight delay
--     because of the rush. It can still be chosen and booked. There is no upper limit.
--   * get_capacity() is unchanged (it still reports ok / busy / full per day and per window; "full" is what the website shows as red).
--   * require_capacity() (single-wash checkout, free-wash claim) now never refuses. It is kept so the callers did not have to change.
--   * plan_membership_washes() no longer passes over a crowded day, and check_custom_dates() no longer refuses one. Days where the SAME vehicle
--     already has a wash are still passed over / refused, and so are the term, notice and per-week rules.
--   * Wording only: create_membership_request's "cannot fit" message and admin_set_capacity's messages say red and amber, not full and busy.
-- No data is touched.

-- A crowded day or window can always be booked.
CREATE OR REPLACE FUNCTION app_private.require_capacity(p_date date, p_slot public.time_slot) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN; -- the rush is shown to the customer (amber / red), never enforced
END $$;

CREATE OR REPLACE FUNCTION app_private.plan_membership_washes(
  p_vehicle_id uuid, p_start date, p_end date, p_pattern jsonb, p_total integer, p_slot public.time_slot, p_respect_capacity boolean
) RETURNS TABLE (wash_date date, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := p_start; n integer := 0; k text;
BEGIN
  WHILE n < p_total AND d <= p_end LOOP
    SELECT e->>'kind' INTO k FROM jsonb_array_elements(p_pattern) e WHERE (e->>'weekday')::integer = extract(dow FROM d)::integer;
    IF k IS NOT NULL
       AND NOT app_private.vehicle_has_live_booking(p_vehicle_id, d) THEN  -- (p_respect_capacity is kept for the callers, but a crowded day no longer matters)
      wash_date := d; kind := k; n := n + 1;
      RETURN NEXT;
    END IF;
    d := d + 1;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_private.check_custom_dates(
  p_vehicle_id uuid, p_start date, p_end date, p_pattern jsonb, p_total integer, p_slot public.time_slot, p_dates jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_min date := GREATEST(p_start, (now() AT TIME ZONE 'Asia/Kolkata')::date + app_private.setting('membership_min_lead_days'));
  v_per_week integer := jsonb_array_length(p_pattern);
  v_terms integer := p_total / jsonb_array_length(p_pattern);   -- how many weeks' worth of washes the term holds
  v_norm jsonb; v_n integer; v_body integer; v_deep integer; v_want_body integer; v_want_deep integer;
  r record;
BEGIN
  IF jsonb_typeof(p_dates) <> 'array' THEN RAISE EXCEPTION 'Choose the date of each wash'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_dates) e
              WHERE jsonb_typeof(e) <> 'object' OR (e->>'date') IS NULL OR (e->>'date') !~ '^\d{4}-\d{2}-\d{2}$' OR (e->>'kind') IS NULL OR (e->>'kind') NOT IN ('body', 'deep')) THEN
    RAISE EXCEPTION 'Each wash needs a date and a kind (body or deep)';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('date', (e->>'date')::date, 'kind', e->>'kind') ORDER BY (e->>'date')::date), count(*),
         count(*) FILTER (WHERE e->>'kind' = 'body'), count(*) FILTER (WHERE e->>'kind' = 'deep')
    INTO v_norm, v_n, v_body, v_deep FROM jsonb_array_elements(p_dates) e;
  SELECT count(*) FILTER (WHERE x->>'kind' = 'body') * v_terms, count(*) FILTER (WHERE x->>'kind' = 'deep') * v_terms INTO v_want_body, v_want_deep FROM jsonb_array_elements(p_pattern) x;

  IF v_body <> v_want_body OR v_deep <> v_want_deep THEN
    RAISE EXCEPTION 'Choose exactly % Body wash% and % Deep clean% for this plan (you have % and %)', v_want_body, CASE WHEN v_want_body = 1 THEN '' ELSE 'es' END, v_want_deep, CASE WHEN v_want_deep = 1 THEN '' ELSE 's' END, v_body, v_deep;
  END IF;
  IF (SELECT count(DISTINCT e->>'date') FROM jsonb_array_elements(v_norm) e) < v_n THEN RAISE EXCEPTION 'Two washes are on the same day: a vehicle is washed once a day'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_norm) e WHERE (e->>'date')::date < v_min OR (e->>'date')::date > p_end) THEN
    RAISE EXCEPTION 'Every wash must be between % and % (not today or tomorrow)', to_char(v_min, 'FMDy, FMDD Mon YYYY'), to_char(p_end, 'FMDy, FMDD Mon YYYY');
  END IF;
  FOR r IN SELECT date_trunc('week', (e->>'date')::date)::date AS wk, count(*)::integer AS n FROM jsonb_array_elements(v_norm) e GROUP BY 1 HAVING count(*) > v_per_week ORDER BY 1 LIMIT 1 LOOP
    RAISE EXCEPTION 'No more than % wash% in one week: the week of % has %', v_per_week, CASE WHEN v_per_week = 1 THEN '' ELSE 'es' END, to_char(r.wk, 'FMDD Mon'), r.n;
  END LOOP;
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;

CREATE OR REPLACE FUNCTION public.create_membership_request(
  p_vehicle_id uuid,
  p_weekly_pattern jsonb,
  p_duration_months integer,
  p_time_slot public.time_slot,
  p_start_date date,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL,
  p_custom_dates jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_addr uuid := p_address_id;
  v_pattern jsonb;
  v_quote jsonb;
  v_id uuid;
  v_total integer;
  v_end date;
  v_custom jsonb;
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

  -- Validates the pattern, duration and vehicle rules; raises a customer-readable message if anything is off.
  v_quote := app_private.compute_membership_quote(v_vehicle.vehicle_type, p_weekly_pattern, p_duration_months);

  -- Store the pattern in a canonical, weekday-ordered form with integer weekdays.
  SELECT jsonb_agg(jsonb_build_object('weekday', (e->>'weekday')::int, 'kind', e->>'kind') ORDER BY (e->>'weekday')::int)
    INTO v_pattern FROM jsonb_array_elements(p_weekly_pattern) e;

  -- Can the plan be laid out? Either on the weekdays chosen (days when this vehicle already has a wash are passed over, as at payment), or on
  -- the exact dates the customer picked, which must follow every rule. Checked BEFORE any money is taken.
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);
  IF p_custom_dates IS NULL THEN
    IF (SELECT count(*) FROM app_private.plan_membership_washes(p_vehicle_id, p_start_date, v_end, v_pattern, v_total, p_time_slot, true)) < v_total THEN
      RAISE EXCEPTION 'We cannot fit all % washes on those days: some days already have a wash for this vehicle. Choose other days, or pick exact dates.', v_total;
    END IF;
  ELSE
    v_custom := app_private.check_custom_dates(p_vehicle_id, p_start_date, v_end, v_pattern, v_total, p_time_slot, p_custom_dates);
  END IF;

  BEGIN
    INSERT INTO public.membership_requests (
      customer_profile_id, vehicle_id, address_id, parking_location, frequency_per_week, duration_months,
      weekly_pattern, time_slot, target_completion_time, start_date, customer_notes, system_quote, custom_dates
    ) VALUES (
      v_profile, p_vehicle_id, v_addr, COALESCE(NULLIF(trim(p_parking_location), ''), v_vehicle.parking_location),
      jsonb_array_length(v_pattern), p_duration_months, v_pattern, p_time_slot, p_target_completion_time,
      p_start_date, NULLIF(trim(p_customer_notes), ''), v_quote, v_custom
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a membership request in progress for this vehicle';
  END;

  PERFORM app_private.audit('membership_request', v_id, 'membership_requested',
    jsonb_build_object('frequency_per_week', jsonb_array_length(v_pattern), 'duration_months', p_duration_months));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_capacity(p_day_kind text, p_day_busy integer, p_day_full integer, p_slot_busy integer, p_slot_full integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid := app_private.require_admin();
BEGIN
  IF p_day_kind NOT IN ('weekday', 'weekend') THEN RAISE EXCEPTION 'Choose weekdays or weekends'; END IF;
  IF p_day_busy IS NULL OR p_day_full IS NULL OR p_slot_busy IS NULL OR p_slot_full IS NULL OR LEAST(p_day_busy, p_day_full, p_slot_busy, p_slot_full) < 1 THEN
    RAISE EXCEPTION 'Enter all four numbers (1 or more)';
  END IF;
  IF p_day_full < p_day_busy THEN RAISE EXCEPTION 'The red number for a day cannot be lower than its amber number'; END IF;
  IF p_slot_full < p_slot_busy THEN RAISE EXCEPTION 'The red number for a time window cannot be lower than its amber number'; END IF;
  IF GREATEST(p_day_full, p_slot_full) > 500 THEN RAISE EXCEPTION 'That is more than 500 vehicles'; END IF;
  INSERT INTO public.capacity_rules (day_kind, day_busy, day_full, slot_busy, slot_full) VALUES (p_day_kind, p_day_busy, p_day_full, p_slot_busy, p_slot_full)
  ON CONFLICT (day_kind) DO UPDATE SET day_busy = EXCLUDED.day_busy, day_full = EXCLUDED.day_full, slot_busy = EXCLUDED.slot_busy, slot_full = EXCLUDED.slot_full, updated_at = now();
  PERFORM app_private.audit('capacity', NULL, 'capacity_changed', jsonb_build_object('day_kind', p_day_kind, 'day_busy', p_day_busy, 'day_full', p_day_full, 'slot_busy', p_slot_busy, 'slot_full', p_slot_full));
  RETURN true;
END $$;
