-- 20261004000020_membership_exact_dates.sql
-- SAFE and re-runnable. A membership can now be laid out on EXACT DATES the customer picks, and every membership is checked against the crowd limits
-- (migration 19) before any money is taken.
--
--   plan_membership_washes()   the one place that decides which dates a weekday plan lands on: the chosen weekdays from the start date, passing over
--                              days where this vehicle already has a wash and days that are fully booked in the chosen window, until every wash has a day.
--   check_custom_dates()       the rules for exact dates, enforced here as well as in the calendar the customer sees:
--                                - exactly as many Body washes and Deep cleans as the plan has for the whole term
--                                - one wash a day, none before the earliest allowed start (today plus the notice setting: not today, not tomorrow)
--                                  and none after the last day of the term
--                                - no more washes in one week (Monday to Sunday) than the plan's washes per week
--                                - never on a day this vehicle already has a wash, or a day that is fully booked in the chosen window
--   create_membership_request / start_membership_checkout   take the exact dates (optional) and run these checks first.
--   preview_membership_dates() what the booking page shows before paying: the dates a plan lands on (or fails to), and how busy each one is.
--   fulfil_membership          lays the washes out through the same planner. If the crowd limit would leave no room, the limit gives way: a membership
--                              that is already paid for is never refused because of it.
--
-- Changes the signatures of create_membership_request and start_membership_checkout (one more, optional, argument): the old versions are dropped so a call
-- cannot be ambiguous. The website sends all arguments.

ALTER TABLE public.membership_requests ADD COLUMN IF NOT EXISTS custom_dates jsonb;

-- the last day of a term that starts on p_start, worked out exactly as fulfil_membership and the table's own rule do
CREATE OR REPLACE FUNCTION app_private.membership_term_end(p_start date, p_months integer) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (((p_start::timestamp AT TIME ZONE 'Asia/Kolkata') + make_interval(months => p_months) - interval '1 day') AT TIME ZONE 'Asia/Kolkata')::date;
$$;

CREATE OR REPLACE FUNCTION app_private.plan_membership_washes(
  p_vehicle_id uuid, p_start date, p_end date, p_pattern jsonb, p_total integer, p_slot public.time_slot, p_respect_capacity boolean
) RETURNS TABLE (wash_date date, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := p_start; n integer := 0; k text;
BEGIN
  WHILE n < p_total AND d <= p_end LOOP
    SELECT e->>'kind' INTO k FROM jsonb_array_elements(p_pattern) e WHERE (e->>'weekday')::integer = extract(dow FROM d)::integer;
    IF k IS NOT NULL
       AND NOT app_private.vehicle_has_live_booking(p_vehicle_id, d)
       AND (NOT p_respect_capacity OR app_private.crowd_state(d, p_slot) <> 'full') THEN
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
  v_text text; r record;
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
  SELECT string_agg(to_char(x.d, 'FMDy, FMDD Mon'), ', ' ORDER BY x.d) INTO v_text
    FROM (SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e WHERE app_private.crowd_state((e->>'date')::date, p_slot) = 'full' ORDER BY 1 LIMIT 4) x;
  IF v_text IS NOT NULL THEN RAISE EXCEPTION 'These days are fully booked in the % window: %. Please pick other days.', p_slot, v_text; END IF;
  RETURN v_norm;
END $$;

-- What the booking page shows before paying. Needs a signed-in customer and one of their vehicles.
CREATE OR REPLACE FUNCTION public.preview_membership_dates(
  p_vehicle_id uuid, p_weekly_pattern jsonb, p_duration_months integer, p_time_slot public.time_slot, p_start_date date
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_quote jsonb; v_total integer; v_end date; v_pattern jsonb; v_fits boolean; v_dates jsonb;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  v_quote := app_private.compute_membership_quote(v_vehicle.vehicle_type, p_weekly_pattern, p_duration_months);   -- also checks the plan itself
  IF p_start_date IS NULL OR p_start_date < (now() AT TIME ZONE 'Asia/Kolkata')::date + app_private.setting('membership_min_lead_days') THEN
    RAISE EXCEPTION 'Your membership can start from % at the earliest', (now() AT TIME ZONE 'Asia/Kolkata')::date + app_private.setting('membership_min_lead_days');
  END IF;
  SELECT jsonb_agg(jsonb_build_object('weekday', (e->>'weekday')::int, 'kind', e->>'kind') ORDER BY (e->>'weekday')::int) INTO v_pattern FROM jsonb_array_elements(p_weekly_pattern) e;
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);
  v_fits := (SELECT count(*) FROM app_private.plan_membership_washes(p_vehicle_id, p_start_date, v_end, v_pattern, v_total, p_time_slot, true)) >= v_total;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', w.wash_date, 'kind', w.kind, 'state', app_private.crowd_state(w.wash_date, p_time_slot)) ORDER BY w.wash_date), '[]'::jsonb)
    INTO v_dates FROM app_private.plan_membership_washes(p_vehicle_id, p_start_date, v_end, v_pattern, v_total, p_time_slot, v_fits) w;
  RETURN jsonb_build_object('total', v_total, 'start_date', p_start_date, 'end_date', v_end, 'fits', v_fits, 'dates', v_dates);
END $$;

DROP FUNCTION IF EXISTS public.create_membership_request(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.start_membership_checkout(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text);

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

  -- Can the plan be laid out? Either on the weekdays chosen (days that are crowded or already have a wash are passed over, as at payment), or on
  -- the exact dates the customer picked, which must follow every rule. Checked BEFORE any money is taken.
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);
  IF p_custom_dates IS NULL THEN
    IF (SELECT count(*) FROM app_private.plan_membership_washes(p_vehicle_id, p_start_date, v_end, v_pattern, v_total, p_time_slot, true)) < v_total THEN
      RAISE EXCEPTION 'We cannot fit all % washes on those days: some days are fully booked or already have a wash. Choose other days or another time window, or pick exact dates.', v_total;
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

CREATE OR REPLACE FUNCTION public.start_membership_checkout(
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
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_pattern jsonb;
  v_custom jsonb;
  v_same uuid;
  v_id uuid;
  v_req public.membership_requests%ROWTYPE;
  v_final bigint;
  v_pay jsonb;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;

  -- Retrying the very same plan while its payment is still open: hand back that payment instead of making another.
  IF jsonb_typeof(p_weekly_pattern) = 'array' AND jsonb_array_length(p_weekly_pattern) > 0 THEN
    BEGIN
      SELECT jsonb_agg(jsonb_build_object('weekday', (e->>'weekday')::int, 'kind', e->>'kind') ORDER BY (e->>'weekday')::int)
        INTO v_pattern FROM jsonb_array_elements(p_weekly_pattern) e;
      IF p_custom_dates IS NOT NULL THEN
        SELECT jsonb_agg(jsonb_build_object('date', (e->>'date')::date, 'kind', e->>'kind') ORDER BY (e->>'date')::date)
          INTO v_custom FROM jsonb_array_elements(p_custom_dates) e;
      END IF;
      SELECT r.id INTO v_same
        FROM public.membership_requests r JOIN public.payments pay ON pay.id = r.payment_id
        JOIN public.vehicles v ON v.id = r.vehicle_id
       WHERE r.customer_profile_id = v_profile AND r.vehicle_id = p_vehicle_id AND r.status = 'accepted'
         AND pay.status = 'pending' AND pay.expires_at > now()
         AND r.weekly_pattern = v_pattern AND r.duration_months = p_duration_months AND r.time_slot = p_time_slot AND r.start_date = p_start_date
         AND r.custom_dates IS NOT DISTINCT FROM v_custom
         AND r.address_id IS NOT DISTINCT FROM COALESCE(p_address_id, v.address_id)
       LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      v_same := NULL; -- malformed input is reported by the validation below
    END;
    IF v_same IS NOT NULL THEN
      v_pay := public.accept_membership_quote(v_same);
      RETURN v_pay || jsonb_build_object('request_id', v_same);
    END IF;
  END IF;

  -- A different plan for the same vehicle replaces this customer's unfinished checkout (it must not block a fresh one).
  UPDATE public.payments SET status = 'failed', updated_at = now()
   WHERE status = 'pending' AND id IN (SELECT payment_id FROM public.membership_requests
                                        WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id
                                          AND status IN ('quoted', 'accepted') AND payment_id IS NOT NULL);
  UPDATE public.membership_requests SET status = 'cancelled', updated_at = now()
   WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id AND status IN ('submitted', 'quoted', 'accepted');

  -- Validates everything (vehicle ownership, address, start date, the mix, the length) and stores the rate-card price.
  v_id := public.create_membership_request(p_vehicle_id, p_weekly_pattern, p_duration_months, p_time_slot, p_start_date,
                                           p_address_id, p_parking_location, p_customer_notes, p_target_completion_time, p_custom_dates);

  SELECT * INTO v_req FROM public.membership_requests WHERE id = v_id FOR UPDATE;
  v_final := (v_req.system_quote->>'final_cents')::bigint;
  UPDATE public.membership_requests
     SET status = 'quoted', adjustment_cents = 0, adjustment_reason = NULL, quoted_amount_cents = v_final::int,
         quoted_breakdown = v_req.system_quote || jsonb_build_object('adjustment', jsonb_build_object('cents', 0, 'reason', NULL), 'final_cents', v_final),
         quote_expires_at = now() + make_interval(mins => app_private.setting('payment_intent_minutes') + 5),
         reviewed_at = now(), updated_at = now()
   WHERE id = v_id;

  PERFORM app_private.audit('membership_request', v_id, 'membership_checkout_started',
    jsonb_build_object('quoted_amount_cents', v_final, 'frequency_per_week', v_req.frequency_per_week, 'duration_months', v_req.duration_months));

  -- Opens the pending payment for exactly the stored price.
  v_pay := public.accept_membership_quote(v_id);
  RETURN v_pay || jsonb_build_object('request_id', v_id);
END $$;

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
  v_end_date date;
  v_respect boolean := true;
  w record;
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
                             'start_date', v_start, 'target_completion_time', v_req.target_completion_time, 'custom', v_req.custom_dates IS NOT NULL),
          true)
  RETURNING id INTO v_schedule;

  -- Lay out exactly v_total washes: on the exact dates the customer picked, or on their chosen weekdays. On weekdays, a date that already has a live wash for this
  -- vehicle, or that is fully booked (Admin -> Capacity), is passed over and the wash goes to the next chosen day, so the customer always gets every wash they
  -- paid for. If the crowded days leave no room, the crowd limit gives way: a paid membership is never refused for it.
  v_end_date := (v_end_at AT TIME ZONE 'Asia/Kolkata')::date;
  IF v_req.custom_dates IS NULL AND (SELECT count(*) FROM app_private.plan_membership_washes(v_vehicle.id, v_start, v_end_date, v_req.weekly_pattern, v_total, v_req.time_slot, true)) < v_total THEN
    v_respect := false;
  END IF;
  FOR w IN
    SELECT x.wash_date, x.kind FROM (
      SELECT (e->>'date')::date AS wash_date, e->>'kind' AS kind FROM jsonb_array_elements(COALESCE(v_req.custom_dates, '[]'::jsonb)) e
      UNION ALL
      SELECT p.wash_date, p.kind FROM app_private.plan_membership_washes(v_vehicle.id, v_start, v_end_date, v_req.weekly_pattern, v_total, v_req.time_slot, v_respect) p
       WHERE v_req.custom_dates IS NULL
    ) x ORDER BY x.wash_date
  LOOP
    IF w.wash_date < v_start OR w.wash_date > v_end_date OR app_private.vehicle_has_live_booking(v_vehicle.id, w.wash_date) THEN RAISE EXCEPTION 'schedule_does_not_fit'; END IF;
    v_kind := w.kind;
    SELECT service_id INTO v_service FROM public.membership_service_options WHERE vehicle_type = v_vehicle.vehicle_type AND wash_kind = v_kind;
    INSERT INTO public.membership_schedule_occurrences (membership_schedule_id, original_date, "current_date", time_slot, status)
    VALUES (v_schedule, w.wash_date, w.wash_date, v_req.time_slot, 'scheduled') RETURNING id INTO v_occ;
    INSERT INTO public.bookings (customer_profile_id, vehicle_id, service_id, membership_id, membership_schedule_occurrence_id, booking_type,
                                 scheduled_date, time_slot, status, notes, address_id, parking_location, target_completion_time, source)
    VALUES (v_req.customer_profile_id, v_vehicle.id, v_service, v_membership, v_occ, 'membership', w.wash_date, v_req.time_slot, 'confirmed',
            'Membership wash', v_req.address_id, v_req.parking_location, v_req.target_completion_time, 'membership_schedule')
    RETURNING id INTO v_booking;
    INSERT INTO public.booking_events (booking_id, event_type, event_metadata)
    VALUES (v_booking, 'booking_created', jsonb_build_object('booking_type', 'membership', 'source', 'membership_schedule', 'membership_id', v_membership));
    v_created := v_created + 1;
  END LOOP;
  IF v_created <> v_total THEN RAISE EXCEPTION 'schedule_does_not_fit'; END IF;

  UPDATE public.membership_requests SET status = 'active', membership_id = v_membership, updated_at = now() WHERE id = v_req.id;

  INSERT INTO public.notifications (profile_id, category, title, body, reference_id) VALUES
    (v_req.customer_profile_id, 'membership_approved', 'Your WASHO membership is active',
     v_total || ' washes are scheduled, starting ' || to_char(v_start, 'Dy DD Mon') || '.', v_membership),
    (v_req.customer_profile_id, 'payment_successful', 'Payment received', 'We received your payment. Thank you!', v_membership);

  PERFORM app_private.audit('membership', v_membership, 'membership_activated',
    jsonb_build_object('request_id', v_req.id, 'payment_id', p_pay.id, 'washes', v_created, 'custom_dates', v_req.custom_dates IS NOT NULL, 'start', v_start));
  RETURN v_membership;
END $$;

REVOKE ALL ON FUNCTION app_private.membership_term_end(date, integer), app_private.plan_membership_washes(uuid, date, date, jsonb, integer, public.time_slot, boolean),
  app_private.check_custom_dates(uuid, date, date, jsonb, integer, public.time_slot, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preview_membership_dates(uuid, jsonb, integer, public.time_slot, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_membership_dates(uuid, jsonb, integer, public.time_slot, date) TO authenticated;
REVOKE ALL ON FUNCTION public.create_membership_request(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_membership_request(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.start_membership_checkout(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_membership_checkout(uuid, jsonb, integer, public.time_slot, date, uuid, text, text, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION app_private.fulfil_membership(public.payments) FROM PUBLIC, anon, authenticated;
