-- 20261004000004_membership_request_flow.sql
-- SAFE / additive. The custom membership flow up to (not including) payment:
--
--   customer: create_membership_request  ->  WASHO: admin_review_membership_request (quote | reject)
--   customer: accept_membership_quote (creates a PENDING payment)  or  decline_membership_quote
--
-- Rules enforced here, in the database, for every client (website and mobile):
--   * the customer is never shown a price before WASHO has approved one
--   * a quote is a snapshot that expires (pricing_settings.quote_validity_days)
--   * any WASHO adjustment is a labelled line with a reason; nothing is hidden
--   * accepting a quote creates a pending payment ONLY; no membership exists until payment is verified

-- ───────────────────────── create ─────────────────────────
CREATE OR REPLACE FUNCTION public.create_membership_request(
  p_vehicle_id uuid,
  p_weekly_pattern jsonb,
  p_duration_months integer,
  p_time_slot public.time_slot,
  p_start_date date,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_addr uuid := p_address_id;
  v_pattern jsonb;
  v_quote jsonb;
  v_id uuid;
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

  BEGIN
    INSERT INTO public.membership_requests (
      customer_profile_id, vehicle_id, address_id, parking_location, frequency_per_week, duration_months,
      weekly_pattern, time_slot, target_completion_time, start_date, customer_notes, system_quote
    ) VALUES (
      v_profile, p_vehicle_id, v_addr, COALESCE(NULLIF(trim(p_parking_location), ''), v_vehicle.parking_location),
      jsonb_array_length(v_pattern), p_duration_months, v_pattern, p_time_slot, p_target_completion_time,
      p_start_date, NULLIF(trim(p_customer_notes), ''), v_quote
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a membership request in progress for this vehicle';
  END;

  PERFORM app_private.audit('membership_request', v_id, 'membership_requested',
    jsonb_build_object('frequency_per_week', jsonb_array_length(v_pattern), 'duration_months', p_duration_months));
  RETURN v_id;
END $$;

-- ───────────────────────── read (customer): price hidden until WASHO approves ─────────────────────────
CREATE OR REPLACE FUNCTION public.my_membership_requests()
RETURNS TABLE (
  id uuid, reference_code text, status text, vehicle_id uuid, frequency_per_week smallint, duration_months smallint,
  weekly_pattern jsonb, time_slot public.time_slot, start_date date, customer_notes text,
  quoted_amount_cents integer, quoted_breakdown jsonb, quote_expires_at timestamptz,
  rejection_reason text, payment_id uuid, membership_id uuid, created_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.reference_code,
         CASE WHEN r.status = 'quoted' AND r.quote_expires_at < now() THEN 'expired' ELSE r.status END,
         r.vehicle_id, r.frequency_per_week, r.duration_months, r.weekly_pattern, r.time_slot, r.start_date, r.customer_notes,
         -- price fields exist only once WASHO has approved a price
         CASE WHEN r.status IN ('quoted', 'accepted', 'active') THEN r.quoted_amount_cents END,
         CASE WHEN r.status IN ('quoted', 'accepted', 'active') THEN r.quoted_breakdown END,
         CASE WHEN r.status = 'quoted' THEN r.quote_expires_at END,
         r.rejection_reason, r.payment_id, r.membership_id, r.created_at
    FROM public.membership_requests r
   WHERE r.customer_profile_id = public.current_profile_id()
   ORDER BY r.created_at DESC;
$$;

-- ───────────────────────── admin: review ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_membership_requests(p_status text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', r.id, 'reference_code', r.reference_code, 'status', r.status,
      'customer', jsonb_build_object('profile_id', p.id, 'name', p.full_name, 'phone', p.phone),
      'vehicle', jsonb_build_object('id', v.id, 'type', v.vehicle_type, 'model', v.model, 'registration_number', v.registration_number),
      'address', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('society', a.society_name, 'block', a.building_block, 'flat', a.flat_number, 'parking', COALESCE(r.parking_location, a.parking_location)) END,
      'frequency_per_week', r.frequency_per_week, 'duration_months', r.duration_months, 'weekly_pattern', r.weekly_pattern,
      'time_slot', r.time_slot, 'start_date', r.start_date, 'customer_notes', r.customer_notes,
      'system_quote', r.system_quote, 'adjustment_cents', r.adjustment_cents, 'adjustment_reason', r.adjustment_reason,
      'quoted_amount_cents', r.quoted_amount_cents, 'quote_expires_at', r.quote_expires_at,
      'rejection_reason', r.rejection_reason, 'created_at', r.created_at
    ) ORDER BY (r.status = 'submitted') DESC, r.created_at DESC)
      FROM public.membership_requests r
      JOIN public.profiles p ON p.id = r.customer_profile_id
      JOIN public.vehicles v ON v.id = r.vehicle_id
      LEFT JOIN public.customer_addresses a ON a.id = r.address_id
     WHERE p_status IS NULL OR r.status = p_status), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.admin_review_membership_request(
  p_request_id uuid,
  p_action text,
  p_adjustment_cents integer DEFAULT 0,
  p_adjustment_reason text DEFAULT NULL,
  p_rejection_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req public.membership_requests%ROWTYPE;
  v_vehicle_type public.vehicle_type;
  v_quote jsonb;
  v_final bigint;
  v_breakdown jsonb;
  v_expires timestamptz;
  v_admin uuid := public.current_profile_id();
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;

  SELECT * INTO v_req FROM public.membership_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;

  IF p_action = 'reject' THEN
    IF v_req.status NOT IN ('submitted', 'quoted') THEN RAISE EXCEPTION 'This request can no longer be rejected (%).', v_req.status; END IF;
    IF p_rejection_reason IS NULL OR char_length(trim(p_rejection_reason)) < 3 THEN RAISE EXCEPTION 'Please give the customer a reason'; END IF;
    UPDATE public.membership_requests
       SET status = 'rejected', rejection_reason = trim(p_rejection_reason), reviewed_by_profile_id = v_admin, reviewed_at = now(), updated_at = now()
     WHERE id = p_request_id;
    PERFORM app_private.audit('membership_request', p_request_id, 'membership_rejected', jsonb_build_object('reason', p_rejection_reason));
    RETURN jsonb_build_object('request_id', p_request_id, 'status', 'rejected');
  END IF;

  IF p_action <> 'quote' THEN RAISE EXCEPTION 'Action must be quote or reject'; END IF;
  IF v_req.status NOT IN ('submitted', 'quoted') THEN RAISE EXCEPTION 'This request can no longer be quoted (%).', v_req.status; END IF;

  IF COALESCE(p_adjustment_cents, 0) <> 0 AND (p_adjustment_reason IS NULL OR char_length(trim(p_adjustment_reason)) < 5) THEN
    RAISE EXCEPTION 'An adjustment needs a reason the customer will see';
  END IF;

  -- Re-price from today's rate card (rates or discounts may have changed since the customer asked).
  SELECT vehicle_type INTO v_vehicle_type FROM public.vehicles WHERE id = v_req.vehicle_id;
  v_quote := app_private.compute_membership_quote(v_vehicle_type, v_req.weekly_pattern, v_req.duration_months);

  v_final := (v_quote->>'final_cents')::bigint + COALESCE(p_adjustment_cents, 0);
  IF v_final < 100 THEN RAISE EXCEPTION 'The final price must be at least ₹1'; END IF;

  v_breakdown := v_quote || jsonb_build_object(
    'adjustment', jsonb_build_object('cents', COALESCE(p_adjustment_cents, 0), 'reason', NULLIF(trim(p_adjustment_reason), '')),
    'final_cents', v_final);
  v_expires := now() + make_interval(days => app_private.setting('quote_validity_days'));

  UPDATE public.membership_requests
     SET status = 'quoted', system_quote = v_quote, adjustment_cents = COALESCE(p_adjustment_cents, 0),
         adjustment_reason = NULLIF(trim(p_adjustment_reason), ''), quoted_amount_cents = v_final::int,
         quoted_breakdown = v_breakdown, quote_expires_at = v_expires, reviewed_by_profile_id = v_admin, reviewed_at = now(), updated_at = now()
   WHERE id = p_request_id;

  PERFORM app_private.audit('membership_request', p_request_id, 'membership_quoted',
    jsonb_build_object('system_final_cents', (v_quote->>'final_cents')::bigint, 'adjustment_cents', COALESCE(p_adjustment_cents, 0),
                       'reason', p_adjustment_reason, 'quoted_amount_cents', v_final, 'expires_at', v_expires));
  RETURN jsonb_build_object('request_id', p_request_id, 'status', 'quoted', 'quoted_amount_cents', v_final, 'quote_expires_at', v_expires);
END $$;

-- ───────────────────────── customer: accept / decline ─────────────────────────
-- Accepting creates a PENDING payment and nothing else. The Razorpay order is created by the server for
-- exactly this amount and attached afterwards. No membership exists until settle_payment() verifies the money.
CREATE OR REPLACE FUNCTION public.accept_membership_quote(p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_req public.membership_requests%ROWTYPE;
  v_pay public.payments%ROWTYPE;
  v_minutes integer := app_private.setting('payment_intent_minutes');
BEGIN
  SELECT * INTO v_req FROM public.membership_requests WHERE id = p_request_id AND customer_profile_id = v_profile FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;

  IF v_req.status = 'quoted' AND v_req.quote_expires_at < now() THEN
    UPDATE public.membership_requests SET status = 'expired', updated_at = now() WHERE id = p_request_id;
    RAISE EXCEPTION 'This quote has expired. Please ask WASHO for a new one.';
  END IF;
  IF v_req.status NOT IN ('quoted', 'accepted') THEN
    RAISE EXCEPTION 'This request is not waiting for your approval (%).', v_req.status;
  END IF;

  -- Retrying payment: reuse the open payment while it is fresh.
  IF v_req.status = 'accepted' AND v_req.payment_id IS NOT NULL THEN
    SELECT * INTO v_pay FROM public.payments WHERE id = v_req.payment_id FOR UPDATE;
    IF v_pay.status = 'pending' AND v_pay.expires_at > now() AND v_pay.amount_cents = v_req.quoted_amount_cents THEN
      RETURN jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents, 'currency', 'INR',
                                'receipt', v_pay.receipt, 'provider_order_id', v_pay.provider_order_id, 'expires_at', v_pay.expires_at);
    END IF;
    IF v_pay.status = 'pending' THEN
      UPDATE public.payments SET status = 'failed', updated_at = now() WHERE id = v_pay.id; -- superseded
    END IF;
  END IF;

  INSERT INTO public.payments (customer_profile_id, amount_cents, currency, provider, status, payment_kind,
                               membership_request_id, receipt, expires_at, fulfilment_status, intent)
  VALUES (v_profile, v_req.quoted_amount_cents, 'INR', 'razorpay', 'pending', 'membership',
          p_request_id, v_req.reference_code, now() + make_interval(mins => v_minutes), 'pending',
          jsonb_build_object('kind', 'membership_request', 'request_id', p_request_id))
  RETURNING * INTO v_pay;

  UPDATE public.membership_requests
     SET status = 'accepted', accepted_at = COALESCE(accepted_at, now()), payment_id = v_pay.id, updated_at = now()
   WHERE id = p_request_id;

  PERFORM app_private.audit('membership_request', p_request_id, 'membership_accepted',
    jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents));
  RETURN jsonb_build_object('payment_id', v_pay.id, 'amount_cents', v_pay.amount_cents, 'currency', 'INR',
                            'receipt', v_pay.receipt, 'provider_order_id', NULL, 'expires_at', v_pay.expires_at);
END $$;

CREATE OR REPLACE FUNCTION public.decline_membership_quote(p_request_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profile uuid := public.current_profile_id();
BEGIN
  UPDATE public.membership_requests SET status = 'declined', updated_at = now()
   WHERE id = p_request_id AND customer_profile_id = v_profile AND status = 'quoted';
  IF NOT FOUND THEN RAISE EXCEPTION 'This quote can no longer be declined'; END IF;
  PERFORM app_private.audit('membership_request', p_request_id, 'membership_declined');
END $$;

-- Housekeeping, run by a scheduled job (pg_cron) or the API: quotes nobody accepted in time.
CREATE OR REPLACE FUNCTION app_private.expire_membership_quotes() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.membership_requests SET status = 'expired', updated_at = now()
   WHERE status = 'quoted' AND quote_expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ───────────────────────── grants ─────────────────────────
REVOKE ALL ON FUNCTION public.create_membership_request(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_membership_requests() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_membership_requests(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_review_membership_request(uuid, text, integer, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_membership_quote(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decline_membership_quote(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_private.expire_membership_quotes() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_membership_request(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_membership_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_membership_requests(text) TO authenticated;      -- is_admin() inside
GRANT EXECUTE ON FUNCTION public.admin_review_membership_request(uuid, text, integer, text, text) TO authenticated; -- is_admin() inside
GRANT EXECUTE ON FUNCTION public.accept_membership_quote(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decline_membership_quote(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.expire_membership_quotes() TO service_role, washo_api;
