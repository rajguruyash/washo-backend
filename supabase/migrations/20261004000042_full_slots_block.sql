-- 20261004000042_full_slots_block.sql
-- SAFE / re-runnable. A time window that is FULL cannot be booked any more. Until now a window past the red number in Admin -> Capacity was only shown red and could still be
-- booked (migration 22). Now, for everything a CUSTOMER or a SPECIALIST picks, a full window is refused, and the booking pages show it greyed out in red ("Full") and say so.
-- A window is full when it has reached its own red number, or the whole day has reached the day's red number (then every window of that day is full). Amber (busy) still only warns.
--
--   * a single wash:           app_private.require_capacity() refuses a full window (and, from migration 39, a day WASHO is unavailable)
--   * a free-wash claim:       pick_campaign_slot() chooses the quietest window that is NOT full, passes over days with none, and says so if every day is full
--   * a membership's exact dates:   each date picked must have room in the plan's time window (create_monthly_membership_request, and the older create_membership_request)
--   * moving a membership wash (customer or specialist):   the new day's window must have room (the shared core app_private.reschedule_wash)
-- An admin is never blocked (booking a wash for a customer, or moving one), exactly as with closed days, and the automatic spread of a plan still only prefers quieter days:
-- a plan that is already paid is never refused. Nothing existing is changed or moved; no table or row is touched.

-- The room check on its own: raises when this time window on this day is full.
CREATE OR REPLACE FUNCTION app_private.require_slot_room(p_date date, p_slot public.time_slot) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_date IS NOT NULL AND p_slot IS NOT NULL AND app_private.crowd_state(p_date, p_slot) = 'full' THEN
    RAISE EXCEPTION '% is fully booked in the % window. Please choose another day or time.', to_char(p_date, 'FMDy, FMDD Mon'), p_slot;
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_private.require_slot_room(date, public.time_slot) FROM PUBLIC, anon, authenticated;

-- Called by single-wash checkout (and the moving of a wash below): a closed day first, then a full window.
CREATE OR REPLACE FUNCTION app_private.require_capacity(p_date date, p_slot public.time_slot) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_working_day(p_date);
  PERFORM app_private.require_slot_room(p_date, p_slot);
END $$;

CREATE OR REPLACE FUNCTION app_private.pick_campaign_slot(p_campaign public.campaigns, p_vehicle uuid, OUT o_date date, OUT o_slot public.time_slot)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_lead integer := app_private.setting('on_demand_min_lead_hours');
  d date; s public.time_slot; best public.time_slot; best_n integer; n integer; v_taken integer;
  v_closed date; v_full boolean := false;
BEGIN
  FOR i IN 0 .. GREATEST(p_campaign.use_by_date - v_today, -1) LOOP
    d := v_today + i;
    IF NOT app_private.is_working_day(d) THEN v_closed := COALESCE(v_closed, d); CONTINUE; END IF;
    IF app_private.vehicle_has_live_booking(p_vehicle, d) THEN CONTINUE; END IF;
    IF p_campaign.daily_cap IS NOT NULL THEN
      SELECT count(*) INTO v_taken FROM public.campaign_claims cl JOIN public.bookings b ON b.id = cl.booking_id
       WHERE cl.campaign_id = p_campaign.id AND cl.status <> 'released' AND b.scheduled_date = d;
      IF v_taken >= p_campaign.daily_cap THEN CONTINUE; END IF;
    END IF;
    -- the quietest time window that is not full and starts far enough ahead
    best := NULL; best_n := NULL;
    FOREACH s IN ARRAY ARRAY['morning', 'afternoon', 'night']::public.time_slot[] LOOP
      IF app_private.slot_start(d, s) < now() + make_interval(hours => v_lead) THEN CONTINUE; END IF;
      IF app_private.crowd_state(d, s) = 'full' THEN v_full := true; CONTINUE; END IF;
      n := app_private.washes_on(d, s);
      IF best IS NULL OR n < best_n THEN best := s; best_n := n; END IF;
    END LOOP;
    IF best IS NULL THEN CONTINUE; END IF;
    o_date := d; o_slot := best; RETURN;
  END LOOP;
  IF v_full THEN RAISE EXCEPTION 'Every day this offer is open is fully booked. Please try again later, or contact WASHO.'; END IF;
  IF v_closed IS NOT NULL THEN RAISE EXCEPTION '%', 'WASHO has no available day left while this offer is open. ' || app_private.closed_day_message(v_closed); END IF;
  o_date := NULL; o_slot := NULL;
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
  r record;
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
    -- the exact dates are the customer's own pick: none of them may be in a time window that is full
    FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_custom) e ORDER BY 1 LOOP
      PERFORM app_private.require_slot_room(r.d, p_time_slot);
    END LOOP;
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

-- The older "washes a week" request function (migration 22's), with the same one check for exact dates.
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
  r record;
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
    -- the exact dates are the customer's own pick: none of them may be in a time window that is full
    FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_custom) e ORDER BY 1 LOOP
      PERFORM app_private.require_slot_room(r.d, p_time_slot);
    END LOOP;
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

-- Migration 39's shared core, one line different: the new day must be a working day AND have room in that time window, unless the one moving it is an admin.
CREATE OR REPLACE FUNCTION app_private.reschedule_wash(
  p_occurrence_id uuid, p_new_date date, p_new_slot public.time_slot,
  p_actor uuid,            -- profile making the change
  p_customer uuid,         -- non-null: the caller must own the membership (customer path); null: staff path
  p_min_date date,         -- earliest date allowed for this caller
  p_reason text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o public.membership_schedule_occurrences%ROWTYPE;
  v_membership public.memberships%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_worker uuid;
BEGIN
  SELECT * INTO o FROM public.membership_schedule_occurrences WHERE id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wash not found'; END IF;

  SELECT m.* INTO v_membership
    FROM public.membership_schedules ms JOIN public.memberships m ON m.id = ms.membership_id
   WHERE ms.id = o.membership_schedule_id;
  IF p_customer IS NOT NULL AND v_membership.customer_profile_id <> p_customer THEN RAISE EXCEPTION 'Wash not found'; END IF;
  IF v_membership.status <> 'active' THEN RAISE EXCEPTION 'This membership is not active'; END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE membership_schedule_occurrence_id = p_occurrence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wash not found'; END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'rescheduled') THEN
    RAISE EXCEPTION 'This wash is % and cannot be rescheduled', v_booking.status;
  END IF;

  IF p_new_date IS NULL OR p_new_date < p_min_date THEN
    RAISE EXCEPTION 'Washes need at least 1 day of preparation. The earliest date is %', p_min_date;
  END IF;
  IF p_new_date < o.original_date THEN
    RAISE EXCEPTION 'A wash cannot be moved earlier than its original date (%)', o.original_date;
  END IF;
  IF p_new_date > (v_membership.end_at AT TIME ZONE 'Asia/Kolkata')::date THEN
    RAISE EXCEPTION 'Please choose a date within your membership, which ends on %', (v_membership.end_at AT TIME ZONE 'Asia/Kolkata')::date;
  END IF;
  IF p_new_date = o."current_date" AND p_new_slot = o.time_slot THEN
    RAISE EXCEPTION 'That is already the date and time of this wash';
  END IF;
  IF NOT public.is_admin() THEN PERFORM app_private.require_capacity(p_new_date, p_new_slot); END IF;   -- a working day, and room in that time window
  IF EXISTS (SELECT 1 FROM public.bookings
              WHERE vehicle_id = v_booking.vehicle_id AND scheduled_date = p_new_date AND id <> v_booking.id
                AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress')) THEN
    RAISE EXCEPTION 'This vehicle already has a wash on that date';
  END IF;

  -- The two validation triggers require booking and occurrence to agree at every step, so move them in an
  -- order where they always do: (1) the date (the occurrence trigger carries the booking along), then
  -- (2) the slot on the occurrence, then (3) the same slot on the booking.
  IF p_new_date <> o."current_date" THEN
    UPDATE public.membership_schedule_occurrences
       SET "current_date" = p_new_date, status = 'rescheduled', updated_at = now() WHERE id = p_occurrence_id;
  END IF;
  IF p_new_slot <> o.time_slot THEN
    UPDATE public.membership_schedule_occurrences
       SET time_slot = p_new_slot, status = 'rescheduled', updated_at = now() WHERE id = p_occurrence_id;
  END IF;

  UPDATE public.bookings
     SET time_slot = p_new_slot, status = 'confirmed', customer_confirmed_at = NULL, updated_at = now(),
         notes = COALESCE(notes, '') || E'\nRescheduled from ' || v_booking.scheduled_date::text || ' to ' || p_new_date::text
   WHERE id = v_booking.id;

  -- Whoever held the old date no longer does.
  UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = v_booking.id AND is_active;

  -- A membership with a regular specialist keeps that specialist on its washes.
  SELECT p.id INTO v_worker FROM public.profiles p WHERE p.id = v_membership.assigned_worker_profile_id AND p.role = 'worker';
  IF v_worker IS NOT NULL THEN
    INSERT INTO public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) VALUES (v_booking.id, v_worker, true, now());
    UPDATE public.bookings SET status = 'worker_assigned' WHERE id = v_booking.id;
  END IF;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (v_booking.id, 'rescheduled', p_actor,
          jsonb_build_object('old_date', v_booking.scheduled_date, 'old_slot', v_booking.time_slot,
                             'new_date', p_new_date, 'new_slot', p_new_slot,
                             'by', CASE WHEN p_customer IS NOT NULL THEN 'customer'
                                        WHEN EXISTS (SELECT 1 FROM public.profiles a WHERE a.id = p_actor AND a.role = 'worker') THEN 'worker'
                                        ELSE 'admin' END,
                             'reason', NULLIF(trim(p_reason), ''),
                             'worker_profile_id', v_worker));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION app_private.reschedule_wash(uuid, date, public.time_slot, uuid, uuid, date, text) FROM PUBLIC, anon, authenticated;
