-- 20261004000028_monthly_membership_plan.sql
-- SAFE / additive and re-runnable. A membership can now be chosen the way customers think about it: HOW MANY washes in a MONTH, of each kind, with a minimum of 4.
--
--   Before: "washes a week" (1 to 7), each on its own weekday, so a month always held a multiple of 4 and every week looked the same.
--   Now:    a monthly count of Body washes and Deep cleans (any mix, 4 to 28 in total: 2 Body + 2 Deep, 4 Body + 1 Deep, ...), the weekdays the customer likes,
--           and the length (1/3/6/12 months). The washes of each month are spread evenly across that month on those weekdays, one a day, never on a day
--           the vehicle already has a wash. The customer may still pick every date by hand (the exact-dates calendar); it must hold exactly the monthly
--           counts times the months.
--
-- What does not change: the rate card and every discount rule (the frequency discount is keyed by the weekly equivalent, washes a month divided by 4 and
-- rounded down: 4-7 = 1 a week, 8-11 = 2, 12 or more = 3 and up, so 12 a month earns exactly what 3 a week always did), the cap, the welcome offer, payment, and
-- every membership already sold (they keep their weekly pattern and everything that reads it). A monthly plan stores its choice in three new columns
-- (monthly_body, monthly_deep, preferred_weekdays); its weekly_pattern is an empty list and frequency_per_week holds the weekly equivalent.
--
--   compute_monthly_quote / estimate_monthly_price     the price, same shape as compute_membership_quote
--   plan_monthly_washes                                 the one place that lays a monthly plan out on dates
--   check_custom_dates_counts                           the exact-dates rules, for counts instead of a weekly pattern
--   preview_monthly_dates                               what the booking page shows before paying
--   create_monthly_membership_request / start_monthly_membership_checkout
--   fulfil_membership                                   (replaced) lays out a monthly plan; a weekly one is exactly as before
--   my_membership_requests / admin_list_membership_requests / svc_membership_reminders_due / worker_queue / admin_export   (replaced) so they can say
--                                                       "N washes a month" instead of a wrong "N a week"

ALTER TABLE public.membership_requests
  ADD COLUMN IF NOT EXISTS monthly_body smallint,
  ADD COLUMN IF NOT EXISTS monthly_deep smallint,
  ADD COLUMN IF NOT EXISTS preferred_weekdays smallint[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_requests_monthly_check' AND conrelid = 'public.membership_requests'::regclass) THEN
    ALTER TABLE public.membership_requests ADD CONSTRAINT membership_requests_monthly_check CHECK (
      (monthly_body IS NULL AND monthly_deep IS NULL AND preferred_weekdays IS NULL)
      OR (monthly_body IS NOT NULL AND monthly_deep IS NOT NULL AND preferred_weekdays IS NOT NULL
          AND monthly_body >= 0 AND monthly_deep >= 0 AND monthly_body + monthly_deep BETWEEN 4 AND 28));
  END IF;
END $$;

-- washes a month -> "washes a week" for the frequency discount and the welcome offer (4-7 = 1, 8-11 = 2, ... capped at 7)
CREATE OR REPLACE FUNCTION app_private.monthly_freq_key(p_washes_per_month integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT LEAST(7, GREATEST(1, p_washes_per_month / 4)) $$;

-- ───────────────────────── the price ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.compute_monthly_quote(p_vehicle_type public.vehicle_type, p_body integer, p_deep integer, p_duration_months integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_n integer;
  v_freq integer;
  v_weeks integer := app_private.setting('weeks_per_month');
  v_cap_bp integer := app_private.setting('max_total_discount_bp');
  v_lines jsonb := '[]'::jsonb;
  v_subtotal bigint := 0;
  v_freq_bp integer;
  v_freq_label text;
  v_dur_bp integer;
  v_freq_cents bigint;
  v_dur_cents bigint;
  v_combined bigint;
  v_cap_cents bigint;
  v_cap_adj bigint := 0;
  v_total_discount bigint;
  v_offer jsonb;
  rec record;
BEGIN
  IF p_body IS NULL OR p_deep IS NULL OR p_body < 0 OR p_deep < 0 THEN RAISE EXCEPTION 'Choose how many washes you want each month'; END IF;
  v_n := p_body + p_deep;
  IF v_n < 4 THEN RAISE EXCEPTION 'Choose at least 4 washes a month (you chose %)', v_n; END IF;
  IF v_n > 28 THEN RAISE EXCEPTION 'A membership has at most 28 washes a month (you chose %)', v_n; END IF;
  IF p_vehicle_type = 'bike' AND p_deep > 0 THEN RAISE EXCEPTION 'Bikes have one wash type'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membership_discount_rules WHERE active AND kind = 'duration' AND key_value = p_duration_months) THEN
    RAISE EXCEPTION 'Membership length must be 1, 3, 6 or 12 months';
  END IF;
  v_freq := app_private.monthly_freq_key(v_n);

  FOR rec IN
    SELECT o.service_id, s.code, s.name, k.kind, k.n AS per_month
      FROM (VALUES ('body', p_body), ('deep', p_deep)) k(kind, n)
      LEFT JOIN public.membership_service_options o ON o.vehicle_type = p_vehicle_type AND o.wash_kind = k.kind
      LEFT JOIN public.services s ON s.id = o.service_id
     WHERE k.n > 0
     ORDER BY k.kind
  LOOP
    IF rec.service_id IS NULL THEN RAISE EXCEPTION 'No % wash is offered for this vehicle', rec.kind; END IF;
    DECLARE
      v_unit integer := app_private.unit_price_cents(rec.service_id, p_vehicle_type);
      v_qty integer := rec.per_month * p_duration_months;
    BEGIN
      IF v_unit IS NULL THEN RAISE EXCEPTION 'No price is set for % on this vehicle', rec.name; END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'service_id', rec.service_id, 'code', rec.code, 'name', rec.name, 'kind', rec.kind,
        'per_month', rec.per_month, 'quantity', v_qty, 'unit_cents', v_unit, 'line_cents', v_unit::bigint * v_qty));
      v_subtotal := v_subtotal + v_unit::bigint * v_qty;
    END;
  END LOOP;

  SELECT discount_bp INTO v_freq_bp FROM public.membership_discount_rules WHERE active AND kind = 'frequency' AND key_value = v_freq;
  SELECT discount_bp INTO v_dur_bp  FROM public.membership_discount_rules WHERE active AND kind = 'duration'  AND key_value = p_duration_months;
  v_freq_bp := COALESCE(v_freq_bp, 0);
  v_dur_bp := COALESCE(v_dur_bp, 0);
  v_freq_label := v_n || ' washes a month';

  -- The welcome offer for a customer whose free-wash campaign wash is done (their rate for this many washes, as a week's worth).
  SELECT jsonb_build_object('claim_id', cl.id, 'campaign_id', k.id, 'name', k.name, 'bp', r.bp)
    INTO v_offer
    FROM public.campaign_claims cl
    JOIN public.campaigns k ON k.id = cl.campaign_id
    CROSS JOIN LATERAL (SELECT CASE WHEN v_freq = 1 THEN k.pack_offer_bp_1 WHEN v_freq = 2 THEN k.pack_offer_bp_2 ELSE k.pack_offer_bp_3plus END AS bp) r
   WHERE cl.customer_profile_id = public.current_profile_id()
     AND cl.status = 'completed' AND cl.offer_membership_id IS NULL AND cl.offer_expires_at > now()
   ORDER BY r.bp DESC LIMIT 1;
  IF v_offer IS NOT NULL AND (v_offer->>'bp')::int > v_freq_bp THEN
    v_freq_bp := (v_offer->>'bp')::int;
    v_freq_label := 'Welcome offer · ' || v_n || ' washes a month';
  ELSE
    v_offer := NULL;
  END IF;

  -- Sequential: frequency off the subtotal, then duration off what remains. Half-up rounding to the paisa. The cap is the same as for a weekly plan.
  v_freq_cents := round(v_subtotal::numeric * v_freq_bp / 10000);
  v_dur_cents  := round((v_subtotal - v_freq_cents)::numeric * v_dur_bp / 10000);
  v_combined   := v_freq_cents + v_dur_cents;
  v_cap_cents  := round(v_subtotal::numeric * v_cap_bp / 10000);
  IF v_combined > v_cap_cents THEN
    v_cap_adj := v_combined - v_cap_cents;
    v_total_discount := v_cap_cents;
  ELSE
    v_total_discount := v_combined;
  END IF;

  RETURN jsonb_build_object(
    'vehicle_type', p_vehicle_type,
    'frequency_per_week', v_freq,
    'washes_per_month', v_n,
    'monthly', jsonb_build_object('body', p_body, 'deep', p_deep),
    'duration_months', p_duration_months,
    'weeks_per_month', v_weeks,
    'washes_total', v_n * p_duration_months,
    'lines', v_lines,
    'subtotal_cents', v_subtotal,
    'frequency_discount', jsonb_build_object('bp', v_freq_bp, 'cents', v_freq_cents, 'label', v_freq_label),
    'duration_discount',  jsonb_build_object('bp', v_dur_bp,  'cents', v_dur_cents,  'label', (SELECT label FROM public.membership_discount_rules WHERE active AND kind='duration' AND key_value=p_duration_months)),
    'cap', jsonb_build_object('max_bp', v_cap_bp, 'applied', v_cap_adj > 0, 'adjustment_cents', v_cap_adj),
    'total_discount_cents', v_total_discount,
    'final_cents', v_subtotal - v_total_discount,
    'rounding', 'half_up_to_paisa'
  ) || CASE WHEN v_offer IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('campaign_offer', v_offer) END;
END $$;

-- Anyone may ask "what would this plan cost?" (the rate card is public). Nothing is stored.
CREATE OR REPLACE FUNCTION public.estimate_monthly_price(p_vehicle_type public.vehicle_type, p_body integer, p_deep integer, p_duration_months integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_private.compute_monthly_quote(p_vehicle_type, p_body, p_deep, p_duration_months);
$$;

-- ───────────────────────── laying a monthly plan out on dates ─────────────────────────
-- The term is cut into month-long windows (the first starts on p_start; each ends the day before the next begins; the last ends on the term's last day, worked out
-- exactly as everywhere else). In each window the washes go on the customer's weekdays (any day if none were given), never on a day this vehicle already has a
-- wash, spread evenly: n washes over c candidate days take the days at positions (i + 0.5) * c / n. Deep cleans are spread evenly among them too. If a window has
-- fewer candidate days than washes, the days that do exist are returned and the caller sees the shortfall.
CREATE OR REPLACE FUNCTION app_private.plan_monthly_washes(
  p_vehicle_id uuid, p_start date, p_months integer, p_body integer, p_deep integer, p_weekdays smallint[]
) RETURNS TABLE (wash_date date, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer := p_body + p_deep;
  m integer; w_start date; w_end date; cand date[]; c integer; i integer;
BEGIN
  FOR m IN 0 .. p_months - 1 LOOP
    w_start := CASE WHEN m = 0 THEN p_start ELSE app_private.membership_term_end(p_start, m) + 1 END;
    w_end := app_private.membership_term_end(p_start, m + 1);
    SELECT COALESCE(array_agg(g::date ORDER BY g), ARRAY[]::date[]) INTO cand
      FROM generate_series(w_start::timestamp, w_end::timestamp, interval '1 day') g
     WHERE (cardinality(COALESCE(p_weekdays, ARRAY[]::smallint[])) = 0 OR extract(dow FROM g)::integer = ANY (p_weekdays::integer[]))
       AND NOT app_private.vehicle_has_live_booking(p_vehicle_id, g::date);
    c := cardinality(cand);
    IF c >= n THEN
      FOR i IN 0 .. n - 1 LOOP
        wash_date := cand[1 + floor((i + 0.5) * c / n)::integer];
        kind := CASE WHEN floor((i + 1) * p_deep::numeric / n) > floor(i * p_deep::numeric / n) THEN 'deep' ELSE 'body' END;
        RETURN NEXT;
      END LOOP;
    ELSE
      FOR i IN 1 .. c LOOP
        wash_date := cand[i];
        kind := 'body';
        RETURN NEXT;
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- The rules for exact dates when the plan is a monthly count: exactly the Body washes and Deep cleans the plan holds for the whole term, one wash a day, none before
-- the earliest allowed start or after the term, no more in one week (Monday to Sunday) than p_per_week, never on a day this vehicle already has a wash.
CREATE OR REPLACE FUNCTION app_private.check_custom_dates_counts(
  p_vehicle_id uuid, p_start date, p_end date, p_want_body integer, p_want_deep integer, p_per_week integer, p_dates jsonb
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_min date := GREATEST(p_start, (now() AT TIME ZONE 'Asia/Kolkata')::date + app_private.setting('membership_min_lead_days'));
  v_norm jsonb; v_n integer; v_body integer; v_deep integer;
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
  IF v_body <> p_want_body OR v_deep <> p_want_deep THEN
    RAISE EXCEPTION 'Choose exactly % Body wash% and % Deep clean% for this plan (you have % and %)', p_want_body, CASE WHEN p_want_body = 1 THEN '' ELSE 'es' END, p_want_deep, CASE WHEN p_want_deep = 1 THEN '' ELSE 's' END, v_body, v_deep;
  END IF;
  IF (SELECT count(DISTINCT e->>'date') FROM jsonb_array_elements(v_norm) e) < v_n THEN RAISE EXCEPTION 'Two washes are on the same day: a vehicle is washed once a day'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_norm) e WHERE (e->>'date')::date < v_min OR (e->>'date')::date > p_end) THEN
    RAISE EXCEPTION 'Every wash must be between % and % (not today or tomorrow)', to_char(v_min, 'FMDy, FMDD Mon YYYY'), to_char(p_end, 'FMDy, FMDD Mon YYYY');
  END IF;
  FOR r IN SELECT date_trunc('week', (e->>'date')::date)::date AS wk, count(*)::integer AS n FROM jsonb_array_elements(v_norm) e GROUP BY 1 HAVING count(*) > p_per_week ORDER BY 1 LIMIT 1 LOOP
    RAISE EXCEPTION 'No more than % wash% in one week: the week of % has %', p_per_week, CASE WHEN p_per_week = 1 THEN '' ELSE 'es' END, to_char(r.wk, 'FMDD Mon'), r.n;
  END LOOP;
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;

-- weekdays as the customer sent them -> a sorted, distinct smallint[] of 0..6 (Sunday = 0), or an error in plain words
CREATE OR REPLACE FUNCTION app_private.clean_weekdays(p_days integer[]) RETURNS smallint[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v smallint[];
BEGIN
  IF p_days IS NULL THEN RETURN ARRAY[]::smallint[]; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_days) d WHERE d IS NULL OR d NOT BETWEEN 0 AND 6) THEN RAISE EXCEPTION 'Each day must be a weekday (0 to 6)'; END IF;
  SELECT COALESCE(array_agg(d::smallint ORDER BY d), ARRAY[]::smallint[]) INTO v FROM (SELECT DISTINCT d FROM unnest(p_days) d) x;
  RETURN v;
END $$;

-- What the booking page shows before paying: where the washes land (or that they do not fit), and how busy each day is.
CREATE OR REPLACE FUNCTION public.preview_monthly_dates(
  p_vehicle_id uuid, p_body integer, p_deep integer, p_weekdays integer[], p_duration_months integer, p_time_slot public.time_slot, p_start_date date
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_quote jsonb; v_total integer; v_end date; v_days smallint[]; v_fits boolean; v_dates jsonb;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  v_quote := app_private.compute_monthly_quote(v_vehicle.vehicle_type, p_body, p_deep, p_duration_months);   -- also checks the plan itself
  IF p_start_date IS NULL OR p_start_date < (now() AT TIME ZONE 'Asia/Kolkata')::date + app_private.setting('membership_min_lead_days') THEN
    RAISE EXCEPTION 'Your membership can start from % at the earliest', (now() AT TIME ZONE 'Asia/Kolkata')::date + app_private.setting('membership_min_lead_days');
  END IF;
  v_days := app_private.clean_weekdays(p_weekdays);
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('date', w.wash_date, 'kind', w.kind, 'state', app_private.crowd_state(w.wash_date, p_time_slot)) ORDER BY w.wash_date), '[]'::jsonb)
    INTO v_dates FROM app_private.plan_monthly_washes(p_vehicle_id, p_start_date, p_duration_months, p_body, p_deep, v_days) w;
  v_fits := jsonb_array_length(v_dates) >= v_total;
  RETURN jsonb_build_object('total', v_total, 'start_date', p_start_date, 'end_date', v_end, 'fits', v_fits, 'dates', v_dates);
END $$;

-- ───────────────────────── starting a monthly membership ─────────────────────────
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
  p_custom_dates jsonb DEFAULT NULL
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
  v_days := app_private.clean_weekdays(p_weekdays);
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);

  IF p_custom_dates IS NULL THEN
    -- every month needs room for every wash: at least 4 days a month for each weekday chosen, so n washes need ceil(n / 4) weekdays
    IF cardinality(v_days) < CEIL(v_n / 4.0)::integer THEN
      RAISE EXCEPTION 'Pick at least % day% of the week so your % washes a month fit', CEIL(v_n / 4.0)::integer, CASE WHEN CEIL(v_n / 4.0) = 1 THEN '' ELSE 's' END, v_n;
    END IF;
    IF (SELECT count(*) FROM app_private.plan_monthly_washes(p_vehicle_id, p_start_date, p_duration_months, p_body, p_deep, v_days)) < v_total THEN
      RAISE EXCEPTION 'We cannot fit all % washes on those days: some days already have a wash for this vehicle. Choose more days, or pick exact dates.', v_total;
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

CREATE OR REPLACE FUNCTION public.start_monthly_membership_checkout(
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
  p_custom_dates jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_custom jsonb;
  v_days smallint[];
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
  BEGIN
    v_days := app_private.clean_weekdays(p_weekdays);
    IF p_custom_dates IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('date', (e->>'date')::date, 'kind', e->>'kind') ORDER BY (e->>'date')::date)
        INTO v_custom FROM jsonb_array_elements(p_custom_dates) e;
    END IF;
    SELECT r.id INTO v_same
      FROM public.membership_requests r JOIN public.payments pay ON pay.id = r.payment_id
      JOIN public.vehicles v ON v.id = r.vehicle_id
     WHERE r.customer_profile_id = v_profile AND r.vehicle_id = p_vehicle_id AND r.status = 'accepted'
       AND pay.status = 'pending' AND pay.expires_at > now()
       AND r.monthly_body = p_body AND r.monthly_deep = p_deep AND r.preferred_weekdays = v_days
       AND r.duration_months = p_duration_months AND r.time_slot = p_time_slot AND r.start_date = p_start_date
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

  -- A different plan for the same vehicle replaces this customer's unfinished checkout (it must not block a fresh one).
  UPDATE public.payments SET status = 'failed', updated_at = now()
   WHERE status = 'pending' AND id IN (SELECT payment_id FROM public.membership_requests
                                        WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id
                                          AND status IN ('quoted', 'accepted') AND payment_id IS NOT NULL);
  UPDATE public.membership_requests SET status = 'cancelled', updated_at = now()
   WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id AND status IN ('submitted', 'quoted', 'accepted');

  v_id := public.create_monthly_membership_request(p_vehicle_id, p_body, p_deep, p_weekdays, p_duration_months, p_time_slot, p_start_date,
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
    jsonb_build_object('quoted_amount_cents', v_final, 'washes_per_month', v_req.monthly_body + v_req.monthly_deep, 'duration_months', v_req.duration_months));

  v_pay := public.accept_membership_quote(v_id);
  RETURN v_pay || jsonb_build_object('request_id', v_id);
END $$;

-- ───────────────────────── grants ─────────────────────────
REVOKE ALL ON FUNCTION app_private.monthly_freq_key(integer), app_private.compute_monthly_quote(public.vehicle_type, integer, integer, integer),
  app_private.plan_monthly_washes(uuid, date, integer, integer, integer, smallint[]),
  app_private.check_custom_dates_counts(uuid, date, date, integer, integer, integer, jsonb), app_private.clean_weekdays(integer[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.estimate_monthly_price(public.vehicle_type, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.estimate_monthly_price(public.vehicle_type, integer, integer, integer) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_monthly_dates(uuid, integer, integer, integer[], integer, public.time_slot, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_monthly_dates(uuid, integer, integer, integer[], integer, public.time_slot, date) TO authenticated;
REVOKE ALL ON FUNCTION public.create_monthly_membership_request(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_monthly_membership_request(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.start_monthly_membership_checkout(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_monthly_membership_checkout(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb) TO authenticated;

-- ───────────────────────── paying for it: laying the washes out ─────────────────────────
-- Migration 20's fulfil_membership(), with a monthly plan handled in four places (how many washes, what each service is worth per month, the schedule stored, and
-- where the washes land). A weekly plan goes through exactly the code it did before.
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
  v_monthly boolean;
  v_per_month integer;
  v_days smallint[];
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
  -- A monthly plan holds monthly_body + monthly_deep washes every month; a weekly one holds washes-a-week x weeks-a-month.
  v_monthly := v_req.monthly_body IS NOT NULL;
  v_per_month := CASE WHEN v_monthly THEN v_req.monthly_body + v_req.monthly_deep ELSE v_req.frequency_per_week * v_weeks END;
  v_total := v_per_month * v_req.duration_months;

  INSERT INTO public.memberships (customer_profile_id, status, duration_months, quantity_per_period, start_at, end_at,
                                  base_amount_cents, discount_amount_cents, final_amount_cents, pricing_snapshot, membership_request_id)
  VALUES (v_req.customer_profile_id, 'active', v_req.duration_months, v_per_month, v_start_at, v_end_at,
          v_base, v_discount, v_req.quoted_amount_cents,
          v_b || jsonb_build_object('request_id', v_req.id, 'payment_id', p_pay.id, 'effective_start_date', v_start, 'requested_start_date', v_req.start_date),
          v_req.id)
  RETURNING id INTO v_membership;

  FOR line IN SELECT * FROM jsonb_array_elements(v_b->'lines') LOOP
    INSERT INTO public.membership_services (membership_id, service_id, vehicle_id, quantity_per_period)
    VALUES (v_membership, (line->>'service_id')::uuid, v_vehicle.id, CASE WHEN v_monthly THEN (line->>'per_month')::integer ELSE (line->>'per_week')::integer * v_weeks END);
  END LOOP;

  INSERT INTO public.membership_schedules (membership_id, schedule_name, timezone_name, schedule_pattern, is_active)
  VALUES (v_membership, 'default', 'Asia/Kolkata',
          jsonb_build_object('weekly_pattern', v_req.weekly_pattern, 'monthly', CASE WHEN v_monthly THEN jsonb_build_object('body', v_req.monthly_body, 'deep', v_req.monthly_deep, 'weekdays', v_req.preferred_weekdays) END, 'time_slot', v_req.time_slot,
                             'start_date', v_start, 'target_completion_time', v_req.target_completion_time, 'custom', v_req.custom_dates IS NOT NULL),
          true)
  RETURNING id INTO v_schedule;

  -- Lay out exactly v_total washes: on the exact dates the customer picked, or on their chosen weekdays. On weekdays, a date that already has a live wash for this
  -- vehicle, or that is fully booked (Admin -> Capacity), is passed over and the wash goes to the next chosen day, so the customer always gets every wash they
  -- paid for. If the crowded days leave no room, the crowd limit gives way: a paid membership is never refused for it.
  v_end_date := (v_end_at AT TIME ZONE 'Asia/Kolkata')::date;
  v_days := COALESCE(v_req.preferred_weekdays, ARRAY[]::smallint[]);
  IF v_monthly THEN
    -- A paid membership is never refused: if the weekdays chosen no longer have room (the vehicle got other washes meanwhile), any day will do.
    IF v_req.custom_dates IS NULL AND (SELECT count(*) FROM app_private.plan_monthly_washes(v_vehicle.id, v_start, v_req.duration_months, v_req.monthly_body, v_req.monthly_deep, v_days)) < v_total THEN
      v_days := ARRAY[]::smallint[];
    END IF;
  ELSIF v_req.custom_dates IS NULL AND (SELECT count(*) FROM app_private.plan_membership_washes(v_vehicle.id, v_start, v_end_date, v_req.weekly_pattern, v_total, v_req.time_slot, true)) < v_total THEN
    v_respect := false;
  END IF;
  FOR w IN
    SELECT x.wash_date, x.kind FROM (
      SELECT (e->>'date')::date AS wash_date, e->>'kind' AS kind FROM jsonb_array_elements(COALESCE(v_req.custom_dates, '[]'::jsonb)) e
      UNION ALL
      SELECT p.wash_date, p.kind FROM app_private.plan_membership_washes(v_vehicle.id, v_start, v_end_date, v_req.weekly_pattern, v_total, v_req.time_slot, v_respect) p
       WHERE v_req.custom_dates IS NULL AND NOT v_monthly
      UNION ALL
      SELECT p.wash_date, p.kind FROM app_private.plan_monthly_washes(v_vehicle.id, v_start, v_req.duration_months, v_req.monthly_body, v_req.monthly_deep, v_days) p
       WHERE v_req.custom_dates IS NULL AND v_monthly
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
    jsonb_build_object('request_id', v_req.id, 'payment_id', p_pay.id, 'washes', v_created, 'custom_dates', v_req.custom_dates IS NOT NULL, 'start', v_start, 'monthly', v_monthly));
  RETURN v_membership;
END $$;
REVOKE ALL ON FUNCTION app_private.fulfil_membership(public.payments) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── what customers and admins read ─────────────────────────
-- The return type changes (four more columns), so the function is dropped and made again.
DROP FUNCTION IF EXISTS public.my_membership_requests();
CREATE FUNCTION public.my_membership_requests()
RETURNS TABLE (
  id uuid, reference_code text, status text, vehicle_id uuid, frequency_per_week smallint, duration_months smallint,
  weekly_pattern jsonb, time_slot public.time_slot, start_date date, customer_notes text,
  quoted_amount_cents integer, quoted_breakdown jsonb, quote_expires_at timestamptz,
  rejection_reason text, payment_id uuid, membership_id uuid, created_at timestamptz,
  washes_per_month integer, monthly_body smallint, monthly_deep smallint, preferred_weekdays smallint[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.reference_code,
         CASE WHEN r.status = 'quoted' AND r.quote_expires_at < now() THEN 'expired' ELSE r.status END,
         r.vehicle_id, r.frequency_per_week, r.duration_months, r.weekly_pattern, r.time_slot, r.start_date, r.customer_notes,
         -- price fields exist only once WASHO has approved a price
         CASE WHEN r.status IN ('quoted', 'accepted', 'active') THEN r.quoted_amount_cents END,
         CASE WHEN r.status IN ('quoted', 'accepted', 'active') THEN r.quoted_breakdown END,
         CASE WHEN r.status = 'quoted' THEN r.quote_expires_at END,
         r.rejection_reason, r.payment_id, r.membership_id, r.created_at,
         (r.monthly_body + r.monthly_deep)::integer, r.monthly_body, r.monthly_deep, r.preferred_weekdays
    FROM public.membership_requests r
   WHERE r.customer_profile_id = public.current_profile_id()
   ORDER BY r.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.my_membership_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_membership_requests() TO authenticated;

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
      'washes_per_month', r.monthly_body + r.monthly_deep, 'monthly_body', r.monthly_body, 'monthly_deep', r.monthly_deep, 'preferred_weekdays', r.preferred_weekdays,
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

-- The specialist's queue: the membership label says "N washes a month" for a monthly plan (migration 9's function, with only that label changed).
CREATE OR REPLACE FUNCTION public.worker_queue(p_days integer DEFAULT 7)
RETURNS TABLE (
  booking_id uuid, reference_code text, status text, bucket text, is_overdue boolean,
  booking_type text, scheduled_date date, time_slot text,
  service_name text, wash_kind text,
  vehicle_type text, vehicle_make text, vehicle_model text, registration_number text, vehicle_color text,
  customer_name text, customer_phone text,
  address_label text, society_name text, building_block text, flat_number text, area_locality text, city text,
  parking_location text, instructions text, target_completion_time text,
  membership_id uuid, membership_reference text, membership_label text, wash_number integer, washes_total integer,
  customer_confirmed_at timestamptz, calls_made integer, last_call_at timestamptz,
  photos_before integer, photos_after integer, started_at timestamptz, completed_at timestamptz,
  change jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 7), 1), 60);
BEGIN
  IF NOT public.is_worker() THEN RAISE EXCEPTION 'Only workers can view the worker queue' USING ERRCODE = '42501'; END IF;

  RETURN QUERY
  WITH mine AS (
    SELECT b.id, true AS holds FROM public.bookings b
      JOIN public.worker_assignments wa ON wa.booking_id = b.id AND wa.worker_profile_id = v_worker AND wa.is_active
  ), released AS (
    SELECT DISTINCT b.id, false AS holds FROM public.bookings b
      JOIN public.worker_assignments wa ON wa.booking_id = b.id AND wa.worker_profile_id = v_worker
       AND NOT wa.is_active AND wa.unassigned_at > now() - interval '14 days'
     WHERE b.status NOT IN ('completed')
       AND NOT EXISTS (SELECT 1 FROM public.worker_assignments x WHERE x.booking_id = b.id AND x.worker_profile_id = v_worker AND x.is_active)
  ), picked AS (
    SELECT * FROM mine UNION ALL SELECT * FROM released
  ), seq AS (   -- "wash 7 of 24" within a membership
    SELECT x.id, row_number() OVER (PARTITION BY x.membership_id ORDER BY x.scheduled_date, x.created_at)::int AS n,
           count(*) OVER (PARTITION BY x.membership_id)::int AS total
      FROM public.bookings x
     WHERE x.membership_id IN (SELECT b.membership_id FROM public.bookings b JOIN picked p ON p.id = b.id WHERE b.membership_id IS NOT NULL)
       AND x.status <> 'cancelled'
  ), base AS (
    SELECT b.*, p.holds,
           CASE
             WHEN NOT p.holds THEN 'changed'
             WHEN b.status = 'completed' THEN 'completed'
             WHEN b.status IN ('cancelled', 'refund_requested', 'refunded', 'no_show') THEN 'changed'
             WHEN b.status = 'in_progress' THEN 'in_progress'
             WHEN b.scheduled_date <= v_today THEN 'today'
             ELSE 'upcoming'
           END AS bk
      FROM public.bookings b JOIN picked p ON p.id = b.id
  )
  SELECT b.id, b.reference_code, b.status::text, b.bk, (b.bk = 'today' AND b.scheduled_date < v_today),
         b.booking_type::text, b.scheduled_date, b.time_slot::text,
         s.name, s.wash_kind,
         v.vehicle_type::text,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.make END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.model END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.registration_number END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.color END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE cp.full_name END,
         CASE WHEN b.bk IN ('today', 'upcoming', 'in_progress') THEN cp.phone END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.label END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.society_name END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.building_block END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.flat_number END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.area_locality END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.city END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE COALESCE(b.parking_location, v.parking_location, a.parking_location) END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE mr.customer_notes END,
         b.target_completion_time,
         b.membership_id, mr.reference_code,
         CASE WHEN b.membership_id IS NULL THEN NULL
              ELSE COALESCE(CASE WHEN mr.monthly_body IS NOT NULL THEN (mr.monthly_body + mr.monthly_deep)::text || ' washes a month · '
                                 ELSE mr.frequency_per_week::text || ' wash' || CASE WHEN mr.frequency_per_week > 1 THEN 'es' ELSE '' END || ' a week · ' END
                            || mr.duration_months::text || ' month' || CASE WHEN mr.duration_months > 1 THEN 's' ELSE '' END,
                            'Membership') END,
         sq.n, sq.total,
         b.customer_confirmed_at,
         (SELECT count(*)::int FROM public.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'worker_called' AND e.actor_profile_id = v_worker),
         (SELECT max(e.created_at) FROM public.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'worker_called' AND e.actor_profile_id = v_worker),
         (SELECT count(*)::int FROM public.booking_photos ph WHERE ph.booking_id = b.id AND ph.phase = 'before'),
         (SELECT count(*)::int FROM public.booking_photos ph WHERE ph.booking_id = b.id AND ph.phase = 'after'),
         (SELECT max(e.created_at) FROM public.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'wash_started'),
         b.completed_at,
         (SELECT CASE
                   WHEN ch.event_type = 'rescheduled' THEN jsonb_build_object('kind', 'rescheduled', 'at', ch.created_at,
                          'from_date', ch.event_metadata->>'old_date', 'from_slot', ch.event_metadata->>'old_slot', 'by', ch.event_metadata->>'by')
                   WHEN ch.event_type IN ('cancelled', 'booking_cancelled') THEN jsonb_build_object('kind', 'cancelled', 'at', ch.created_at,
                          'reason', ch.event_metadata->>'reason')
                   ELSE jsonb_build_object('kind', 'reassigned', 'at', ch.created_at)
                 END
            FROM (SELECT e.* FROM public.booking_events e
                   WHERE e.booking_id = b.id AND e.created_at > now() - interval '14 days'
                     AND (e.event_type IN ('rescheduled', 'cancelled', 'booking_cancelled')
                          OR (NOT b.holds AND e.event_type IN ('worker_assigned', 'membership_worker_assigned')))
                   -- newest first; if several events share a timestamp, a move or cancellation wins over a reassignment
                   -- (the original schema's sync trigger also logs a bare 'rescheduled' event; prefer ours, which carries old/new date and who moved it)
                   ORDER BY e.created_at DESC, (e.event_type IN ('rescheduled', 'cancelled', 'booking_cancelled')) DESC, (e.event_metadata ? 'old_date') DESC LIMIT 1) ch)
    FROM base b
    JOIN public.services s ON s.id = b.service_id
    JOIN public.vehicles v ON v.id = b.vehicle_id
    JOIN public.profiles cp ON cp.id = b.customer_profile_id
    LEFT JOIN public.customer_addresses a ON a.id = COALESCE(b.address_id, v.address_id,
         (SELECT d.id FROM public.customer_addresses d WHERE d.customer_profile_id = b.customer_profile_id AND d.is_default LIMIT 1))
    LEFT JOIN public.memberships m ON m.id = b.membership_id
    LEFT JOIN public.membership_requests mr ON mr.id = m.membership_request_id
    LEFT JOIN seq sq ON sq.id = b.id
   WHERE CASE b.bk
           WHEN 'upcoming'  THEN b.scheduled_date <= v_today + v_days
           WHEN 'completed' THEN b.completed_at > now() - interval '30 days'
           WHEN 'changed'   THEN b.updated_at > now() - interval '30 days'
           ELSE true
         END
   ORDER BY b.scheduled_date, b.time_slot, b.created_at;
END $$;
REVOKE ALL ON FUNCTION public.worker_queue(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_queue(integer) TO authenticated;

-- The renewal reminder knows a monthly plan (one more column, so the function is dropped and made again).
DROP FUNCTION IF EXISTS public.svc_membership_reminders_due(integer, integer);
CREATE FUNCTION public.svc_membership_reminders_due(p_within_days integer DEFAULT 7, p_limit integer DEFAULT 50)
RETURNS TABLE (
  membership_id uuid, customer_profile_id uuid, full_name text, email text,
  vehicle_model text, vehicle_type text, registration_number text,
  end_date date, ends_in_days integer, frequency_per_week integer, duration_months integer,
  washes_total integer, washes_done integer, washes_per_month integer
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.customer_profile_id, p.full_name, COALESCE(NULLIF(btrim(p.email), ''), u.email)::text,
         v.model, v.vehicle_type::text, v.registration_number,
         (m.end_at AT TIME ZONE 'Asia/Kolkata')::date,
         ((m.end_at AT TIME ZONE 'Asia/Kolkata')::date - (now() AT TIME ZONE 'Asia/Kolkata')::date)::integer,
         r.frequency_per_week::integer, m.duration_months::integer,
         (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled')::integer,
         (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status = 'completed')::integer,
         (r.monthly_body + r.monthly_deep)::integer
    FROM public.memberships m
    JOIN public.profiles p ON p.id = m.customer_profile_id AND p.role = 'customer' AND p.archived_at IS NULL
    LEFT JOIN auth.users u ON u.id = p.auth_user_id
    LEFT JOIN public.membership_requests r ON r.membership_id = m.id
    LEFT JOIN LATERAL (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1) mv ON true
    LEFT JOIN public.vehicles v ON v.id = mv.vehicle_id
   WHERE m.status = 'active'
     AND m.end_at > now() AND m.end_at <= now() + make_interval(days => GREATEST(p_within_days, 1))
     AND COALESCE(NULLIF(btrim(p.email), ''), u.email) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.email_log l
                      WHERE l.kind = 'membership_renewal_reminder' AND l.ref_id = m.id
                        AND (l.status IN ('sent', 'skipped') OR l.attempts >= 3 OR (l.status = 'sending' AND l.updated_at > now() - interval '15 minutes')))
     -- already renewed: another active membership for the same vehicle that runs past this one
     AND NOT EXISTS (SELECT 1 FROM public.memberships m2 JOIN public.membership_services ms2 ON ms2.membership_id = m2.id
                      WHERE m2.id <> m.id AND m2.customer_profile_id = m.customer_profile_id AND m2.status = 'active'
                        AND ms2.vehicle_id = mv.vehicle_id AND m2.end_at > m.end_at)
   ORDER BY m.end_at
   LIMIT LEAST(GREATEST(p_limit, 1), 200);
$$;
REVOKE ALL ON FUNCTION public.svc_membership_reminders_due(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_membership_reminders_due(integer, integer) TO service_role, washo_api;

-- The memberships export says washes a MONTH (a weekly plan is its washes a week times the weeks in a month); migration 27's function with only that column changed.
CREATE OR REPLACE FUNCTION public.admin_export(p_kind text, p_from date DEFAULT NULL, p_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid;
  v_cols jsonb;
  v_rows jsonb;
  v_n integer;
  v_truncated boolean := false;
  v_ist text := 'Asia/Kolkata';
  c_cap constant integer := 50000;
BEGIN
  IF p_kind NOT IN ('customers', 'washes', 'memberships', 'payments', 'refunds', 'support', 'activity') THEN RAISE EXCEPTION 'Unknown export'; END IF;
  v_me := app_private.require_access('export_' || p_kind, 'manage');
  IF p_from IS NOT NULL AND p_to IS NOT NULL AND p_from > p_to THEN RAISE EXCEPTION 'The start date is after the end date'; END IF;

  IF p_kind = 'customers' THEN
    v_cols := '["Name","Mobile","Email","Joined (IST)","Signed up from","Washes booked","Active memberships","Deactivated"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(p.full_name, p.phone, p.email, to_char(p.created_at AT TIME ZONE v_ist, 'YYYY-MM-DD HH24:MI'), p.signup_source,
               (SELECT count(*) FROM public.bookings b WHERE b.customer_profile_id = p.id),
               (SELECT count(*) FROM public.memberships m WHERE m.customer_profile_id = p.id AND m.status = 'active'),
               CASE WHEN p.archived_at IS NULL THEN 'no' ELSE 'yes' END) AS r
        FROM public.profiles p
       WHERE p.role = 'customer'
         AND (p_from IS NULL OR (p.created_at AT TIME ZONE v_ist)::date >= p_from) AND (p_to IS NULL OR (p.created_at AT TIME ZONE v_ist)::date <= p_to)
       ORDER BY p.created_at DESC LIMIT c_cap + 1) q;
  ELSIF p_kind = 'washes' THEN
    v_cols := '["Reference","Date","Time slot","Status","Service","Type","Price (Rs)","Vehicle","Registration","Customer","Society","Specialist","Source","Booked on (IST)"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(b.reference_code, b.scheduled_date, b.time_slot::text, b.status::text, s.name, b.booking_type::text, round(b.price_cents / 100.0, 2),
               v.vehicle_type::text, v.registration_number, p.full_name, a.society_name, wp.full_name, b.source, to_char(b.created_at AT TIME ZONE v_ist, 'YYYY-MM-DD HH24:MI')) AS r
        FROM public.bookings b
        JOIN public.services s ON s.id = b.service_id
        JOIN public.vehicles v ON v.id = b.vehicle_id
        JOIN public.profiles p ON p.id = b.customer_profile_id
        LEFT JOIN public.customer_addresses a ON a.id = COALESCE(b.address_id, v.address_id)
        LEFT JOIN public.worker_assignments wa ON wa.booking_id = b.id AND wa.is_active
        LEFT JOIN public.profiles wp ON wp.id = wa.worker_profile_id
       WHERE (p_from IS NULL OR b.scheduled_date >= p_from) AND (p_to IS NULL OR b.scheduled_date <= p_to)
       ORDER BY b.scheduled_date DESC, b.created_at DESC LIMIT c_cap + 1) q;
  ELSIF p_kind = 'memberships' THEN
    v_cols := '["Reference","Customer","Vehicle","Registration","Washes a month","Months","Amount (Rs)","Status","Starts","Ends","Washes","Washes done"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(rq.reference_code, p.full_name, v.vehicle_type::text, v.registration_number, COALESCE(rq.monthly_body + rq.monthly_deep, rq.frequency_per_week * app_private.setting('weeks_per_month')), m.duration_months, round(m.final_amount_cents / 100.0, 2),
               m.status::text, to_char(m.start_at AT TIME ZONE v_ist, 'YYYY-MM-DD'), to_char(m.end_at AT TIME ZONE v_ist, 'YYYY-MM-DD'),
               (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled'),
               (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status = 'completed')) AS r
        FROM public.memberships m
        JOIN public.profiles p ON p.id = m.customer_profile_id
        LEFT JOIN public.membership_requests rq ON rq.id = m.membership_request_id
        LEFT JOIN public.vehicles v ON v.id = COALESCE(rq.vehicle_id, (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1))
       WHERE (p_from IS NULL OR (m.start_at AT TIME ZONE v_ist)::date >= p_from) AND (p_to IS NULL OR (m.start_at AT TIME ZONE v_ist)::date <= p_to)
       ORDER BY m.start_at DESC LIMIT c_cap + 1) q;
  ELSIF p_kind = 'payments' THEN
    v_cols := '["Paid on (IST)","Amount (Rs)","For","Status","Razorpay payment","Razorpay order","Customer","Fulfilment"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(to_char(COALESCE(pay.paid_at, pay.created_at) AT TIME ZONE v_ist, 'YYYY-MM-DD HH24:MI'), round(pay.amount_cents / 100.0, 2), pay.payment_kind, pay.status::text,
               pay.provider_payment_id, pay.provider_order_id, p.full_name, pay.fulfilment_status) AS r
        FROM public.payments pay JOIN public.profiles p ON p.id = pay.customer_profile_id
       WHERE (p_from IS NULL OR (COALESCE(pay.paid_at, pay.created_at) AT TIME ZONE v_ist)::date >= p_from) AND (p_to IS NULL OR (COALESCE(pay.paid_at, pay.created_at) AT TIME ZONE v_ist)::date <= p_to)
       ORDER BY COALESCE(pay.paid_at, pay.created_at) DESC LIMIT c_cap + 1) q;
  ELSIF p_kind = 'refunds' THEN
    v_cols := '["Asked on (IST)","Amount (Rs)","Status","Reason","Razorpay refund","Razorpay payment","Customer","Failure reason"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(to_char(rf.created_at AT TIME ZONE v_ist, 'YYYY-MM-DD HH24:MI'), round(rf.amount_cents / 100.0, 2), rf.status::text, rf.reason, rf.provider_refund_id,
               pay.provider_payment_id, p.full_name, rf.failure_reason) AS r
        FROM public.refunds rf LEFT JOIN public.payments pay ON pay.id = rf.payment_id JOIN public.profiles p ON p.id = rf.customer_profile_id
       WHERE (p_from IS NULL OR (rf.created_at AT TIME ZONE v_ist)::date >= p_from) AND (p_to IS NULL OR (rf.created_at AT TIME ZONE v_ist)::date <= p_to)
       ORDER BY rf.created_at DESC LIMIT c_cap + 1) q;
  ELSIF p_kind = 'support' THEN
    v_cols := '["Reference","Opened (IST)","About","Title","Status","Customer","Wash","Messages"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(t.reference_code, to_char(t.created_at AT TIME ZONE v_ist, 'YYYY-MM-DD HH24:MI'), t.category, t.subject, t.status, p.full_name,
               (SELECT b.reference_code FROM public.bookings b WHERE b.id = t.booking_id), (SELECT count(*) FROM public.support_messages m WHERE m.ticket_id = t.id)) AS r
        FROM public.support_tickets t JOIN public.profiles p ON p.id = t.customer_profile_id
       WHERE (p_from IS NULL OR (t.created_at AT TIME ZONE v_ist)::date >= p_from) AND (p_to IS NULL OR (t.created_at AT TIME ZONE v_ist)::date <= p_to)
       ORDER BY t.created_at DESC LIMIT c_cap + 1) q;
  ELSE
    v_cols := '["When (IST)","What happened","About","Done by","Their role","Details"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(to_char(e.created_at AT TIME ZONE v_ist, 'YYYY-MM-DD HH24:MI:SS'), e.event_type, e.entity_type, a.full_name, a.role::text, e.metadata::text) AS r
        FROM public.audit_events e LEFT JOIN public.profiles a ON a.id = e.actor_profile_id
       WHERE (p_from IS NULL OR (e.created_at AT TIME ZONE v_ist)::date >= p_from) AND (p_to IS NULL OR (e.created_at AT TIME ZONE v_ist)::date <= p_to)
       ORDER BY e.created_at DESC LIMIT c_cap + 1) q;
  END IF;

  v_n := jsonb_array_length(v_rows);
  IF v_n > c_cap THEN
    v_truncated := true;
    v_rows := (SELECT jsonb_agg(e) FROM (SELECT e FROM jsonb_array_elements(v_rows) WITH ORDINALITY t(e, i) ORDER BY i LIMIT c_cap) z);
    v_n := c_cap;
  END IF;
  PERFORM app_private.audit('export', v_me, 'data_exported', jsonb_build_object('kind', p_kind, 'from', p_from, 'to', p_to, 'rows', v_n, 'truncated', v_truncated));
  RETURN jsonb_build_object('columns', v_cols, 'rows', v_rows, 'truncated', v_truncated);
END $$;
REVOKE ALL ON FUNCTION public.admin_export(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_export(text, date, date) TO authenticated;
