-- 20261004000039_working_days.sql
-- SAFE / additive and re-runnable. WORKING DAYS: the days WASHO washes and the days it does not. Admin -> Working Days turns days of the week on or off (for example
-- Monday to Friday off, Saturday and Sunday on) and turns single dates off (a holiday, bad weather) or on (a weekday WASHO will work after all).
--
-- Until an admin turns something off every day is on, so nothing changes when this is applied. No existing wash is touched: a wash that is already booked on a day that is
-- later turned off stays booked until WASHO moves it (the Working Days page lists them).
--
-- What a closed day stops (customers and specialists; an admin can still book or move a wash onto a closed day, so there is always a way to make an exception, and the
-- Working Days page lets you open that one date instead):
--   * a SINGLE wash on that day (single-wash checkout)             "WASHO does not wash on Monday, 13 Oct. The next day you can book is Saturday, 17 Oct."
--   * a MEMBERSHIP: the weekdays the customer picks must be days WASHO works; the automatic spread skips closed dates; exact dates cannot be a closed date
--   * moving a membership wash to a closed day (customer or specialist)
--   * a FREE-WASH campaign claim: WASHO picks the earliest OPEN day
-- A membership that is already PAID is never refused: if its chosen weekdays no longer have room, the spread falls back to any day, open days first.
--
--   working_weekdays      one row per weekday (0 = Sunday ... 6 = Saturday), is_open
--   working_dates         a date turned off (is_open = false) or turned on (is_open = true) with an optional reason; a date overrides its weekday
--   app_private.is_working_day(date) / next_working_day(date) / require_working_day(date)     the one rule everything asks
--   get_working_days(from, to)              what the booking pages ask: which days are closed (and why) and the next open day. Public information.
--   admin_working_days()                    the settings, the dates, and the washes already booked on closed days
--   admin_set_working_weekdays(open_days)   which weekdays are open (all at once)
--   admin_set_working_dates(from, to, open, reason)   turn a date or a run of dates off or on (up to 92 days at a time)
--   admin_clear_working_date(day)           take a date's override away (the weekday rule applies again)
-- The old require_capacity() (which has not refused anything since migration 22) now refuses a closed day, so single-wash checkout needs no other change.

CREATE TABLE IF NOT EXISTS public.working_weekdays (
  weekday smallint PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday, like extract(dow ...) everywhere else
  is_open boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
INSERT INTO public.working_weekdays (weekday) SELECT g FROM generate_series(0, 6) g ON CONFLICT (weekday) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.working_dates (
  day date PRIMARY KEY,
  is_open boolean NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

-- Nobody reads or writes these tables directly: the booking pages use get_working_days(), admins use the admin_* functions below.
ALTER TABLE public.working_weekdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.working_dates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.working_weekdays, public.working_dates FROM PUBLIC, anon, authenticated;

-- ───────────────────────── the rule ─────────────────────────
-- A date's own row wins; otherwise its weekday; otherwise (an empty table) it is a working day.
CREATE OR REPLACE FUNCTION app_private.is_working_day(p_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT d.is_open FROM public.working_dates d WHERE d.day = p_date),
    (SELECT w.is_open FROM public.working_weekdays w WHERE w.weekday = extract(dow FROM p_date)::smallint),
    true);
$$;

-- The first working day on or after p_from (looking a year ahead), or NULL when there is none.
CREATE OR REPLACE FUNCTION app_private.next_working_day(p_from date) RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := p_from;
BEGIN
  IF p_from IS NULL THEN RETURN NULL; END IF;
  FOR i IN 0 .. 400 LOOP
    IF app_private.is_working_day(d) THEN RETURN d; END IF;
    d := d + 1;
  END LOOP;
  RETURN NULL;
END $$;

-- "WASHO does not wash on Monday, 13 Oct (Diwali). The next day you can book is Saturday, 17 Oct."
CREATE OR REPLACE FUNCTION app_private.closed_day_message(p_date date) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text;
  v_next date;
BEGIN
  SELECT d.reason INTO v_reason FROM public.working_dates d WHERE d.day = p_date AND NOT d.is_open;
  v_next := app_private.next_working_day(GREATEST(p_date, v_today) + 1);
  RETURN 'WASHO does not wash on ' || to_char(p_date, 'FMDay, FMDD Mon') || CASE WHEN v_reason IS NOT NULL THEN ' (' || v_reason || ')' ELSE '' END || '. '
      || CASE WHEN v_next IS NULL THEN 'We are not taking bookings right now.' ELSE 'The next day you can book is ' || to_char(v_next, 'FMDay, FMDD Mon') || '.' END;
END $$;

CREATE OR REPLACE FUNCTION app_private.require_working_day(p_date date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_date IS NOT NULL AND NOT app_private.is_working_day(p_date) THEN RAISE EXCEPTION '%', app_private.closed_day_message(p_date); END IF;
END $$;

-- Weekday numbers as words, Monday first: {1,3} -> "Mondays, Wednesdays".
CREATE OR REPLACE FUNCTION app_private.weekday_words(p_days smallint[]) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg((ARRAY['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'])[d + 1], ', ' ORDER BY (d + 6) % 7)
    FROM unnest(p_days) AS d;
$$;

-- The weekdays a customer picked for a membership must each have at least one working day in the term. Says which do not, and which can be chosen.
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
  RAISE EXCEPTION '%', 'WASHO does not wash on ' || app_private.weekday_words(v_bad) || '. '
    || CASE WHEN v_open IS NULL THEN 'We are not taking memberships right now.' ELSE 'Choose from ' || app_private.weekday_words(v_open) || '.' END;
END $$;

REVOKE ALL ON FUNCTION app_private.is_working_day(date), app_private.next_working_day(date), app_private.closed_day_message(date), app_private.require_working_day(date),
  app_private.weekday_words(smallint[]), app_private.require_open_weekdays(smallint[], date, date) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── single washes and free washes ─────────────────────────
-- Called by single-wash checkout and the free-wash claim. It never refused a busy day (migration 22) and still does not; a closed day it does.
CREATE OR REPLACE FUNCTION app_private.require_capacity(p_date date, p_slot public.time_slot) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_working_day(p_date);   -- a busy day is only a warning; a closed day is closed
END $$;

-- Migration 24's picker, one change: closed days are passed over. When the offer has no open day left the claim says so, with the next open day.
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
    RAISE EXCEPTION '%', 'WASHO has no working day left while this offer is open. ' || app_private.closed_day_message(v_skipped);
  END IF;
  o_date := fb_date; o_slot := fb_slot;
END $$;
REVOKE ALL ON FUNCTION app_private.pick_campaign_slot(public.campaigns, uuid) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── memberships ─────────────────────────
-- A plan laid out on the customer's weekdays (the older "washes a week" plans): closed days are passed over. p_respect_capacity is false only when a PAID plan could not
-- be laid out any other way, and then a closed day may be used rather than leave a paid wash unplaced.
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
       AND (NOT p_respect_capacity OR app_private.is_working_day(d)) THEN
      wash_date := d; kind := k; n := n + 1;
      RETURN NEXT;
    END IF;
    d := d + 1;
  END LOOP;
END $$;

-- A monthly plan laid out on the customer's weekdays: only working days are candidates. The "any day" form (no weekdays: a paid plan whose weekdays no longer have room)
-- uses open days first and closed days only if there are not enough open ones, so a paid plan always gets every wash.
CREATE OR REPLACE FUNCTION app_private.plan_monthly_washes(
  p_vehicle_id uuid, p_start date, p_months integer, p_body integer, p_deep integer, p_weekdays smallint[]
) RETURNS TABLE (wash_date date, kind text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n integer := p_body + p_deep;
  m integer; w_start date; w_end date; cand date[]; loads numeric[]; c integer; i integer; k integer; k0 integer; best integer; lo integer; hi integer;
BEGIN
  FOR m IN 0 .. p_months - 1 LOOP
    w_start := CASE WHEN m = 0 THEN p_start ELSE app_private.membership_term_end(p_start, m) + 1 END;
    w_end := app_private.membership_term_end(p_start, m + 1);
    SELECT COALESCE(array_agg(g::date ORDER BY g), ARRAY[]::date[]) INTO cand
      FROM generate_series(w_start::timestamp, w_end::timestamp, interval '1 day') g
     WHERE (cardinality(COALESCE(p_weekdays, ARRAY[]::smallint[])) = 0 OR extract(dow FROM g)::integer = ANY (p_weekdays::integer[]))
       AND NOT app_private.vehicle_has_live_booking(p_vehicle_id, g::date)
       AND app_private.is_working_day(g::date);
    IF cardinality(cand) < n AND cardinality(COALESCE(p_weekdays, ARRAY[]::smallint[])) = 0 THEN
      SELECT COALESCE(array_agg(g::date ORDER BY g), ARRAY[]::date[]) INTO cand
        FROM generate_series(w_start::timestamp, w_end::timestamp, interval '1 day') g
       WHERE NOT app_private.vehicle_has_live_booking(p_vehicle_id, g::date);
    END IF;
    c := cardinality(cand);
    IF c >= n THEN
      SELECT COALESCE(array_agg(app_private.day_load(d) ORDER BY ord), ARRAY[]::numeric[]) INTO loads FROM unnest(cand) WITH ORDINALITY AS u(d, ord);
      FOR i IN 0 .. n - 1 LOOP
        -- all whole-number arithmetic: k0 = floor((i + 0.5) * c / n); part i holds the days k with i * c / n <= k + 0.5 < (i + 1) * c / n, and the parts tile 0 .. c - 1
        k0 := ((2 * i + 1) * c) / (2 * n);                          -- 0-based index of the day this wash always got
        lo := (2 * i * c + n - 1) / (2 * n);
        hi := (2 * (i + 1) * c + n - 1) / (2 * n) - 1;
        best := k0;
        FOR k IN lo .. hi LOOP
          IF loads[1 + k] < loads[1 + best] OR (loads[1 + k] = loads[1 + best] AND abs(k - k0) < abs(best - k0)) THEN best := k; END IF;
        END LOOP;
        wash_date := cand[1 + best];
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
REVOKE ALL ON FUNCTION app_private.plan_monthly_washes(uuid, date, integer, integer, integer, smallint[]) FROM PUBLIC, anon, authenticated;

-- Exact dates (the older "washes a week" plans): one more rule, a wash cannot be on a closed day.
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
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    PERFORM app_private.require_working_day(r.d);
  END LOOP;
  FOR r IN SELECT date_trunc('week', (e->>'date')::date)::date AS wk, count(*)::integer AS n FROM jsonb_array_elements(v_norm) e GROUP BY 1 HAVING count(*) > v_per_week ORDER BY 1 LIMIT 1 LOOP
    RAISE EXCEPTION 'No more than % wash% in one week: the week of % has %', v_per_week, CASE WHEN v_per_week = 1 THEN '' ELSE 'es' END, to_char(r.wk, 'FMDD Mon'), r.n;
  END LOOP;
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;

-- Exact dates (monthly plans): the same rule.
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
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    PERFORM app_private.require_working_day(r.d);
  END LOOP;
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;
REVOKE ALL ON FUNCTION app_private.check_custom_dates_counts(uuid, date, date, integer, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;

-- Migration 32's create_monthly_membership_request (the one with the optional coupon), with one new check before money is taken: every weekday chosen must be a day WASHO works (it says which are not and which
-- can be chosen), and its "cannot fit" message now also names closed days as a reason.
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
      RAISE EXCEPTION 'We cannot fit all % washes on those days: some days already have a wash for this vehicle, or WASHO is closed on them. Choose more days, or pick exact dates.', v_total;
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

-- ───────────────────────── moving a membership wash ─────────────────────────
-- Migration 21's shared core, one new rule: the new day must be a working day, unless the one moving it is an admin (an admin may always make an exception).
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
  IF NOT public.is_admin() THEN PERFORM app_private.require_working_day(p_new_date); END IF;
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

-- ───────────────────────── what the booking pages ask ─────────────────────────
-- Public information: which weekdays are open, the closed days in a range (with the reason when one was given), and the next open day from today.
CREATE OR REPLACE FUNCTION public.get_working_days(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'Ask for 1 to 401 days at a time'; END IF;
  RETURN jsonb_build_object(
    'weekdays', COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday', w.weekday, 'open', w.is_open) ORDER BY w.weekday) FROM public.working_weekdays w), '[]'::jsonb),
    'closed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', g::date, 'reason', (SELECT d.reason FROM public.working_dates d WHERE d.day = g::date AND NOT d.is_open)) ORDER BY g)
        FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g WHERE NOT app_private.is_working_day(g::date)), '[]'::jsonb),
    'next_open', app_private.next_working_day((now() AT TIME ZONE 'Asia/Kolkata')::date));
END $$;
REVOKE ALL ON FUNCTION public.get_working_days(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_working_days(date, date) TO anon, authenticated, service_role;

-- ───────────────────────── admin ─────────────────────────
-- Everything the Working Days page shows: the weekdays, the dates turned off or on from today (each with how many washes are booked that day), and the washes already booked
-- on closed days in the next 120 days (they stay booked until WASHO moves them).
CREATE OR REPLACE FUNCTION public.admin_working_days() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  PERFORM app_private.require_admin();
  RETURN jsonb_build_object(
    'weekdays', COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday', w.weekday, 'open', w.is_open) ORDER BY w.weekday) FROM public.working_weekdays w), '[]'::jsonb),
    'dates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'open', d.is_open, 'reason', d.reason,
               'washes', (SELECT count(*)::integer FROM public.bookings b WHERE b.scheduled_date = d.day
                           AND b.status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress'))) ORDER BY d.day)
        FROM public.working_dates d WHERE d.day >= v_today), '[]'::jsonb),
    'booked_on_closed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', x.d, 'washes', x.n) ORDER BY x.d)
        FROM (SELECT b.scheduled_date AS d, count(*)::integer AS n FROM public.bookings b
               WHERE b.scheduled_date BETWEEN v_today AND v_today + 120
                 AND b.status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress')
                 AND NOT app_private.is_working_day(b.scheduled_date)
               GROUP BY b.scheduled_date) x), '[]'::jsonb),
    'next_open', app_private.next_working_day(v_today));
END $$;

-- Which weekdays WASHO works, all at once (0 = Sunday ... 6 = Saturday). An empty list closes every weekday.
CREATE OR REPLACE FUNCTION public.admin_set_working_weekdays(p_open_days integer[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid := app_private.require_admin();
BEGIN
  IF p_open_days IS NULL OR EXISTS (SELECT 1 FROM unnest(p_open_days) d WHERE d IS NULL OR d NOT BETWEEN 0 AND 6) THEN
    RAISE EXCEPTION 'Each day must be a weekday (0 to 6)';
  END IF;
  UPDATE public.working_weekdays SET is_open = (weekday::integer = ANY (p_open_days)), updated_at = now(), updated_by = v_admin;
  PERFORM app_private.audit('working_days', NULL, 'working_weekdays_changed', jsonb_build_object('open_days', (SELECT COALESCE(jsonb_agg(w.weekday ORDER BY w.weekday), '[]'::jsonb) FROM public.working_weekdays w WHERE w.is_open)));
  RETURN true;
END $$;

-- Turn a date, or a run of dates, off (closed) or on (a working day even if its weekday is off). Returns how many dates were set.
CREATE OR REPLACE FUNCTION public.admin_set_working_dates(p_from date, p_to date, p_open boolean, p_reason text DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  n integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_open IS NULL THEN RAISE EXCEPTION 'Choose the date and whether WASHO works that day'; END IF;
  IF p_from < v_today THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The last date cannot be before the first'; END IF;
  IF p_to - p_from > 91 THEN RAISE EXCEPTION 'Set up to 92 days at a time'; END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 120 THEN RAISE EXCEPTION 'Please keep the reason under 120 characters'; END IF;
  INSERT INTO public.working_dates (day, is_open, reason, updated_by)
  SELECT g::date, p_open, v_reason, v_admin FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ON CONFLICT (day) DO UPDATE SET is_open = EXCLUDED.is_open, reason = EXCLUDED.reason, updated_at = now(), updated_by = EXCLUDED.updated_by;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM app_private.audit('working_days', NULL, 'working_dates_set', jsonb_build_object('from', p_from, 'to', p_to, 'open', p_open, 'reason', v_reason, 'days', n));
  RETURN n;
END $$;

-- Take a date's own setting away: its weekday decides again.
CREATE OR REPLACE FUNCTION public.admin_clear_working_date(p_day date) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_was boolean;
BEGIN
  PERFORM app_private.require_admin();
  DELETE FROM public.working_dates WHERE day = p_day RETURNING is_open INTO v_was;
  IF NOT FOUND THEN RAISE EXCEPTION 'That date has no setting to remove'; END IF;
  PERFORM app_private.audit('working_days', NULL, 'working_date_cleared', jsonb_build_object('day', p_day, 'was_open', v_was));
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.admin_working_days(), public.admin_set_working_weekdays(integer[]), public.admin_set_working_dates(date, date, boolean, text), public.admin_clear_working_date(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_working_days(), public.admin_set_working_weekdays(integer[]), public.admin_set_working_dates(date, date, boolean, text), public.admin_clear_working_date(date) TO authenticated;  -- require_admin() inside
