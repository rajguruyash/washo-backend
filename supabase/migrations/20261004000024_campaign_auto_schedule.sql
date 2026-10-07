-- 20261004000024_campaign_auto_schedule.sql
-- SAFE / re-runnable. A free-wash campaign claim no longer asks the customer for a date or a time window: WASHO picks them.
--
-- pick_campaign_slot(): the earliest day from today to the campaign's last day that
--   * has room under the campaign's own daily limit (when it has one),
--   * where this vehicle has no other wash,
--   * and that is not already red in Admin -> Capacity, if there is any day that is not (a red day is only used when every day is red),
-- and on that day the quietest time window that still starts far enough ahead (the same notice rule as any booking; ties go to the earlier window).
--
-- claim_campaign_wash() keeps its signature so older callers still work, but the date and window they may send are IGNORED: the day and window
-- always come from pick_campaign_slot(), so nobody can choose by calling the API directly. It now also returns scheduled_date and time_slot so
-- the page can say at once when the wash is. Every other rule is unchanged (one per phone, vehicle plate and flat, new customers only, the
-- caps, the offer window). If there is no day left the claim is refused with a plain message.
-- No data is touched.

CREATE OR REPLACE FUNCTION app_private.pick_campaign_slot(p_campaign public.campaigns, p_vehicle uuid, OUT o_date date, OUT o_slot public.time_slot)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_lead integer := app_private.setting('on_demand_min_lead_hours');
  d date; s public.time_slot; best public.time_slot; best_n integer; n integer; v_taken integer;
  fb_date date; fb_slot public.time_slot;
BEGIN
  FOR i IN 0 .. GREATEST(p_campaign.use_by_date - v_today, -1) LOOP
    d := v_today + i;
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
  o_date := fb_date; o_slot := fb_slot;
END $$;
REVOKE ALL ON FUNCTION app_private.pick_campaign_slot(public.campaigns, uuid) FROM PUBLIC, anon, authenticated;

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
