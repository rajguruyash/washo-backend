-- 20261004000005_payment_intents_and_settlement.sql
-- SAFE / additive. The single, database-enforced payment pipeline for on-demand washes and memberships.
--
--   1. create_booking_payment_intent()   customer: validates everything, computes the amount ON THE SERVER,
--                                         stores the validated order as an immutable "intent". Creates NO booking.
--   2. attach_provider_order()            server: records the Razorpay order id for that exact amount.
--   3. settle_payment()                   server: called by the verify route AND the webhook. Checks ownership,
--                                         amount, currency, capture status and idempotency; then builds the
--                                         booking / membership FROM THE STORED INTENT (never from client input).
--
-- Guarantees:
--   * nothing is activated, scheduled or confirmed without a verified, captured payment of the exact amount
--   * calling settle_payment twice (browser verify + webhook) does the work once
--   * if money arrived but the order can no longer be fulfilled, the payment is kept as 'paid/unfulfilled' and a
--     refund request is created automatically; the transaction never silently rolls the payment record back
--   * every rejection and every settlement is written to audit_events

-- ───────────────────────── helpers ─────────────────────────
-- Slot start times (IST). Morning 07:00, Afternoon 12:00, Night 19:00.
CREATE OR REPLACE FUNCTION app_private.slot_start(p_date date, p_slot public.time_slot) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((p_date::timestamp + CASE p_slot WHEN 'morning' THEN interval '7 hours' WHEN 'afternoon' THEN interval '12 hours' ELSE interval '19 hours' END)
          AT TIME ZONE 'Asia/Kolkata');
$$;

-- A vehicle may be washed once a day. True if it already has a live booking on that date.
CREATE OR REPLACE FUNCTION app_private.vehicle_has_live_booking(p_vehicle_id uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.bookings WHERE vehicle_id = p_vehicle_id AND scheduled_date = p_date
                   AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'in_progress'));
$$;

-- ───────────────────────── 1. on-demand payment intent ─────────────────────────
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

-- ───────────────────────── 2. attach the Razorpay order ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.attach_provider_order(p_payment_id uuid, p_provider_order_id text, p_expected_profile_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_pay public.payments%ROWTYPE;
BEGIN
  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF p_expected_profile_id IS NOT NULL AND v_pay.customer_profile_id <> p_expected_profile_id THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;
  IF v_pay.status <> 'pending' THEN RAISE EXCEPTION 'This payment is no longer open'; END IF;
  IF v_pay.provider_order_id IS NOT NULL AND v_pay.provider_order_id <> p_provider_order_id THEN
    RAISE EXCEPTION 'This payment already has an order';
  END IF;
  UPDATE public.payments SET provider_order_id = p_provider_order_id, provider = 'razorpay', updated_at = now() WHERE id = p_payment_id;
END $$;

-- ───────────────────────── fulfilment: on-demand booking ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.fulfil_on_demand(p_pay public.payments) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  i jsonb := p_pay.intent;
  v_vehicle public.vehicles%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_date date := (i->>'scheduled_date')::date;
  v_slot public.time_slot := (i->>'time_slot')::public.time_slot;
  v_booking uuid;
BEGIN
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = (i->>'vehicle_id')::uuid AND customer_profile_id = p_pay.customer_profile_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'vehicle_unavailable'; END IF;
  SELECT * INTO v_service FROM public.services WHERE id = (i->>'service_id')::uuid AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'service_unavailable'; END IF;
  IF v_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'date_passed'; END IF;
  IF app_private.vehicle_has_live_booking(v_vehicle.id, v_date) THEN RAISE EXCEPTION 'vehicle_already_booked'; END IF;

  INSERT INTO public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status,
                               notes, address_id, parking_location, target_completion_time, source, price_cents)
  VALUES (p_pay.customer_profile_id, v_vehicle.id, v_service.id, 'on_demand', v_date, v_slot, 'confirmed',
          COALESCE('Target Completion: ' || NULLIF(i->>'target_completion_time', '') || E'\n' || NULLIF(i->>'parking_location', ''),
                   NULLIF(i->>'parking_location', ''), 'Doorstep on-demand wash'),
          NULLIF(i->>'address_id', '')::uuid, NULLIF(i->>'parking_location', ''), NULLIF(i->>'target_completion_time', ''),
          COALESCE(i->>'source', 'website'), p_pay.amount_cents)
  RETURNING id INTO v_booking;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata) VALUES
    (v_booking, 'booking_created', p_pay.customer_profile_id, jsonb_build_object('booking_type', 'on_demand', 'source', i->>'source', 'payment_id', p_pay.id)),
    (v_booking, 'payment_received', NULL, jsonb_build_object('payment_id', p_pay.id, 'provider', 'razorpay', 'amount_cents', p_pay.amount_cents));

  INSERT INTO public.notifications (profile_id, category, title, body, reference_id) VALUES
    (p_pay.customer_profile_id, 'booking_confirmed', 'Booking confirmed',
     v_service.name || ' on ' || to_char(v_date, 'Dy DD Mon') || ' (' || v_slot || ')', v_booking),
    (p_pay.customer_profile_id, 'payment_successful', 'Payment received', 'We received your payment. Thank you!', v_booking);
  RETURN v_booking;
END $$;

-- ───────────────────────── fulfilment: membership + generated washes ─────────────────────────
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
    IF v_date > v_end_at::date THEN RAISE EXCEPTION 'schedule_does_not_fit'; END IF;
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

-- ───────────────────────── 3. settle_payment ─────────────────────────
-- Expected rejections are RETURNED (not raised) so that their audit rows are committed.
CREATE OR REPLACE FUNCTION app_private.settle_payment(
  p_provider_order_id text,
  p_provider_payment_id text,
  p_amount_cents integer,
  p_currency text,
  p_provider_status text,
  p_expected_profile_id uuid DEFAULT NULL,
  p_source text DEFAULT 'api'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay public.payments%ROWTYPE;
  v_booking uuid;
  v_membership uuid;
  v_err text;
  v_reason text;
BEGIN
  IF p_provider_order_id IS NULL OR p_provider_payment_id IS NULL THEN
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'missing_ids');
  END IF;

  SELECT * INTO v_pay FROM public.payments WHERE provider_order_id = p_provider_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unknown_order'); END IF;

  IF p_expected_profile_id IS NOT NULL AND v_pay.customer_profile_id <> p_expected_profile_id THEN
    PERFORM app_private.audit('payment', v_pay.id, 'payment_rejected', jsonb_build_object('reason', 'ownership', 'source', p_source));
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'not_your_payment');
  END IF;

  IF lower(COALESCE(p_provider_status, '')) <> 'captured' THEN
    PERFORM app_private.audit('payment', v_pay.id, 'payment_not_captured', jsonb_build_object('provider_status', p_provider_status, 'source', p_source));
    RETURN jsonb_build_object('status', 'not_captured');
  END IF;

  IF v_pay.status = 'paid' THEN
    IF v_pay.provider_payment_id = p_provider_payment_id THEN
      RETURN jsonb_build_object('status', CASE WHEN v_pay.fulfilment_status = 'unfulfilled' THEN 'unfulfilled' ELSE 'already_settled' END,
                                'payment_id', v_pay.id, 'booking_id', v_pay.booking_id, 'membership_id', v_pay.membership_id);
    END IF;
    PERFORM app_private.audit('payment', v_pay.id, 'duplicate_capture',
      jsonb_build_object('existing_provider_payment_id', v_pay.provider_payment_id, 'new_provider_payment_id', p_provider_payment_id, 'amount_cents', p_amount_cents, 'source', p_source));
    RETURN jsonb_build_object('status', 'duplicate_payment', 'payment_id', v_pay.id);
  END IF;

  IF p_amount_cents IS DISTINCT FROM v_pay.amount_cents OR upper(COALESCE(p_currency, '')) <> 'INR' THEN
    PERFORM app_private.audit('payment', v_pay.id, 'payment_amount_mismatch',
      jsonb_build_object('expected_cents', v_pay.amount_cents, 'got_cents', p_amount_cents, 'currency', p_currency, 'source', p_source));
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'amount_mismatch');
  END IF;

  IF EXISTS (SELECT 1 FROM public.payments WHERE provider_payment_id = p_provider_payment_id AND id <> v_pay.id) THEN
    PERFORM app_private.audit('payment', v_pay.id, 'payment_rejected', jsonb_build_object('reason', 'provider_payment_reused', 'source', p_source));
    RETURN jsonb_build_object('status', 'rejected', 'reason', 'payment_id_reused');
  END IF;

  -- A payment we had already abandoned (superseded by a newer attempt) can still be captured late.
  IF v_pay.status <> 'pending' OR v_pay.intent IS NULL THEN
    v_reason := CASE WHEN v_pay.intent IS NULL THEN 'legacy_payment_without_intent' ELSE 'payment_superseded' END;
    UPDATE public.payments SET status = 'paid', provider_payment_id = p_provider_payment_id, paid_at = now(), updated_at = now(),
           fulfilment_status = 'unfulfilled', booking_id = NULL, membership_id = NULL WHERE id = v_pay.id;
    INSERT INTO public.refunds (payment_id, customer_profile_id, amount_cents, reason, status)
    VALUES (v_pay.id, v_pay.customer_profile_id, v_pay.amount_cents, 'Order could not be fulfilled: ' || v_reason, 'requested');
    PERFORM app_private.audit('payment', v_pay.id, 'payment_unfulfilled', jsonb_build_object('reason', v_reason, 'source', p_source));
    RETURN jsonb_build_object('status', 'unfulfilled', 'payment_id', v_pay.id, 'reason', v_reason);
  END IF;

  -- Fulfil in a sub-transaction. If anything fails, only the fulfilment is undone; the payment is recorded below.
  BEGIN
    IF v_pay.payment_kind = 'on_demand' THEN
      v_booking := app_private.fulfil_on_demand(v_pay);
    ELSIF v_pay.payment_kind = 'membership' THEN
      v_membership := app_private.fulfil_membership(v_pay);
    ELSE
      RAISE EXCEPTION 'unknown_payment_kind';
    END IF;

    UPDATE public.payments SET status = 'paid', provider_payment_id = p_provider_payment_id, paid_at = now(), updated_at = now(),
           booking_id = v_booking, membership_id = v_membership, fulfilment_status = 'fulfilled'
     WHERE id = v_pay.id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    UPDATE public.payments SET status = 'paid', provider_payment_id = p_provider_payment_id, paid_at = now(), updated_at = now(),
           fulfilment_status = 'unfulfilled', booking_id = NULL, membership_id = NULL WHERE id = v_pay.id;
    INSERT INTO public.refunds (payment_id, customer_profile_id, amount_cents, reason, status)
    VALUES (v_pay.id, v_pay.customer_profile_id, v_pay.amount_cents, 'Order could not be fulfilled: ' || v_err, 'requested');
    PERFORM app_private.audit('payment', v_pay.id, 'payment_unfulfilled', jsonb_build_object('error', v_err, 'source', p_source));
    RETURN jsonb_build_object('status', 'unfulfilled', 'payment_id', v_pay.id, 'reason', v_err);
  END;

  PERFORM app_private.audit('payment', v_pay.id, 'payment_settled',
    jsonb_build_object('kind', v_pay.payment_kind, 'booking_id', v_booking, 'membership_id', v_membership, 'amount_cents', v_pay.amount_cents, 'source', p_source));
  RETURN jsonb_build_object('status', 'fulfilled', 'payment_id', v_pay.id, 'booking_id', v_booking, 'membership_id', v_membership);
END $$;

-- ───────────────────────── customer: poll a payment ─────────────────────────
CREATE OR REPLACE FUNCTION public.my_payment_status(p_payment_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object('payment_id', p.id, 'status', p.status, 'fulfilment_status', p.fulfilment_status,
                            'amount_cents', p.amount_cents, 'booking_id', p.booking_id, 'membership_id', p.membership_id,
                            'provider_order_id', p.provider_order_id)
    FROM public.payments p WHERE p.id = p_payment_id AND p.customer_profile_id = public.current_profile_id();
$$;

-- ───────────────────────── grants ─────────────────────────
REVOKE ALL ON FUNCTION app_private.slot_start(date, public.time_slot) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.vehicle_has_live_booking(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.attach_provider_order(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.fulfil_on_demand(public.payments) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.fulfil_membership(public.payments) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.settle_payment(text, text, integer, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_booking_payment_intent(uuid, uuid, date, public.time_slot, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_payment_status(uuid) FROM PUBLIC, anon;

-- The server (edge functions as service_role, or the Render API as washo_api) may settle and attach.
GRANT EXECUTE ON FUNCTION app_private.slot_start(date, public.time_slot) TO service_role, washo_api;
GRANT EXECUTE ON FUNCTION app_private.attach_provider_order(uuid, text, uuid) TO service_role, washo_api;
GRANT EXECUTE ON FUNCTION app_private.settle_payment(text, text, integer, text, text, uuid, text) TO service_role, washo_api;
-- fulfil_* are only ever reached through settle_payment (SECURITY DEFINER), so nobody needs direct access.
GRANT EXECUTE ON FUNCTION public.create_booking_payment_intent(uuid, uuid, date, public.time_slot, uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_payment_status(uuid) TO authenticated;
