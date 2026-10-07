-- 20261004000017_membership_last_day_ist.sql
-- SAFE and re-runnable. A membership's washes are laid out on the customer's weekdays from the start date to the LAST DAY of the term. That last day
-- was worked out as `end_at::date`, and end_at is midnight in Pune: cast in a UTC session (Supabase's) that is the evening of the day BEFORE, so the final
-- day of the term could never be used. With a tight plan and one day skipped (the vehicle already has a wash that day) a customer could pay and find
-- the schedule "does not fit". The last day is now read in Pune time, the same way the reschedule function already reads it.
--
-- This is migration 5's fulfil_membership() with that one comparison changed.

CREATE OR REPLACE FUNCTION app_private.fulfil_membership(p_pay public.payments) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.membership_requests%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
  v_b jsonb;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_start date;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_weeks integer := app_private.setting('weeks_per_month');
  v_total integer;
  v_subtotal integer;
  v_total_discount integer;
  v_adj integer;
  v_base integer;
  v_discount integer;
  v_membership uuid;
  v_schedule uuid;
  v_occ uuid;
  v_booking uuid;
  v_created integer := 0;
  v_skipped integer := 0;
  v_date date;
  v_kind text;
  v_service uuid;
  line jsonb;
BEGIN
  SELECT * INTO v_req FROM public.membership_requests
   WHERE id = (p_pay.intent->>'request_id')::uuid AND payment_id = p_pay.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request_not_found'; END IF;
  IF v_req.status <> 'accepted' THEN RAISE EXCEPTION 'request_not_accepted'; END IF;
  IF v_req.customer_profile_id <> p_pay.customer_profile_id THEN RAISE EXCEPTION 'request_owner_mismatch'; END IF;
  IF v_req.quoted_amount_cents IS DISTINCT FROM p_pay.amount_cents THEN RAISE EXCEPTION 'request_amount_mismatch'; END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_req.vehicle_id AND customer_profile_id = v_req.customer_profile_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'vehicle_unavailable'; END IF;

  v_b := v_req.quoted_breakdown;
  v_subtotal := (v_b->>'subtotal_cents')::integer;
  v_total_discount := (v_b->>'total_discount_cents')::integer;
  v_adj := COALESCE((v_b->'adjustment'->>'cents')::integer, 0);
  v_base := v_subtotal + GREATEST(v_adj, 0);          -- a surcharge is part of the base
  v_discount := v_total_discount + GREATEST(-v_adj, 0); -- an extra WASHO discount is part of the discount
  IF v_base - v_discount <> v_req.quoted_amount_cents THEN RAISE EXCEPTION 'breakdown_does_not_add_up'; END IF;

  -- Never start in the past if the customer paid late.
  v_start := GREATEST(v_req.start_date, v_today + app_private.setting('membership_min_lead_days'));
  v_start_at := (v_start::timestamp AT TIME ZONE 'Asia/Kolkata');
  v_end_at := v_start_at + make_interval(months => v_req.duration_months) - interval '1 day'; -- same formula the table trigger enforces
  v_total := v_req.frequency_per_week * v_weeks * v_req.duration_months;

  INSERT INTO public.memberships (customer_profile_id, status, duration_months, quantity_per_period, start_at, end_at,
                                  base_amount_cents, discount_amount_cents, final_amount_cents, pricing_snapshot, membership_request_id)
  VALUES (v_req.customer_profile_id, 'active', v_req.duration_months, v_req.frequency_per_week * v_weeks, v_start_at, v_end_at,
          v_base, v_discount, v_req.quoted_amount_cents,
          v_b || jsonb_build_object('request_id', v_req.id, 'payment_id', p_pay.id, 'effective_start_date', v_start, 'requested_start_date', v_req.start_date),
          v_req.id)
  RETURNING id INTO v_membership;

  FOR line IN SELECT * FROM jsonb_array_elements(v_b->'lines') LOOP
    INSERT INTO public.membership_services (membership_id, service_id, vehicle_id, quantity_per_period)
    VALUES (v_membership, (line->>'service_id')::uuid, v_vehicle.id, (line->>'per_week')::integer * v_weeks);
  END LOOP;

  INSERT INTO public.membership_schedules (membership_id, schedule_name, timezone_name, schedule_pattern, is_active)
  VALUES (v_membership, 'default', 'Asia/Kolkata',
          jsonb_build_object('weekly_pattern', v_req.weekly_pattern, 'time_slot', v_req.time_slot,
                             'start_date', v_start, 'target_completion_time', v_req.target_completion_time),
          true)
  RETURNING id INTO v_schedule;

  -- Lay out exactly v_total washes on the customer's chosen weekdays. A date that already has a live
  -- wash for this vehicle is skipped (the wash moves to the next pattern day), so the customer always gets
  -- every wash they paid for.
  v_date := v_start;
  WHILE v_created < v_total LOOP
    IF v_date > (v_end_at AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'schedule_does_not_fit'; END IF;
    SELECT p->>'kind' INTO v_kind FROM jsonb_array_elements(v_req.weekly_pattern) p
     WHERE (p->>'weekday')::int = extract(dow FROM v_date)::int;
    IF v_kind IS NOT NULL THEN
      IF app_private.vehicle_has_live_booking(v_vehicle.id, v_date) THEN
        v_skipped := v_skipped + 1;
      ELSE
        SELECT service_id INTO v_service FROM public.membership_service_options WHERE vehicle_type = v_vehicle.vehicle_type AND wash_kind = v_kind;
        INSERT INTO public.membership_schedule_occurrences (membership_schedule_id, original_date, "current_date", time_slot, status)
        VALUES (v_schedule, v_date, v_date, v_req.time_slot, 'scheduled') RETURNING id INTO v_occ;
        INSERT INTO public.bookings (customer_profile_id, vehicle_id, service_id, membership_id, membership_schedule_occurrence_id, booking_type,
                                     scheduled_date, time_slot, status, notes, address_id, parking_location, target_completion_time, source)
        VALUES (v_req.customer_profile_id, v_vehicle.id, v_service, v_membership, v_occ, 'membership', v_date, v_req.time_slot, 'confirmed',
                'Membership wash', v_req.address_id, v_req.parking_location, v_req.target_completion_time, 'membership_schedule')
        RETURNING id INTO v_booking;
        INSERT INTO public.booking_events (booking_id, event_type, event_metadata)
        VALUES (v_booking, 'booking_created', jsonb_build_object('booking_type', 'membership', 'source', 'membership_schedule', 'membership_id', v_membership));
        v_created := v_created + 1;
      END IF;
    END IF;
    v_date := v_date + 1;
  END LOOP;

  UPDATE public.membership_requests SET status = 'active', membership_id = v_membership, updated_at = now() WHERE id = v_req.id;

  INSERT INTO public.notifications (profile_id, category, title, body, reference_id) VALUES
    (v_req.customer_profile_id, 'membership_approved', 'Your WASHO membership is active',
     v_total || ' washes are scheduled, starting ' || to_char(v_start, 'Dy DD Mon') || '.', v_membership),
    (v_req.customer_profile_id, 'payment_successful', 'Payment received', 'We received your payment. Thank you!', v_membership);

  PERFORM app_private.audit('membership', v_membership, 'membership_activated',
    jsonb_build_object('request_id', v_req.id, 'payment_id', p_pay.id, 'washes', v_created, 'skipped_dates', v_skipped, 'start', v_start));
  RETURN v_membership;
END $$;
REVOKE ALL ON FUNCTION app_private.fulfil_membership(public.payments) FROM PUBLIC, anon, authenticated;
