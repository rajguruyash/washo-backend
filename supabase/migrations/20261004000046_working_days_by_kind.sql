-- 20261004000046_working_days_by_kind.sql
-- SAFE / re-runnable. WORKING DAYS, SEPARATELY FOR MEMBERSHIPS AND SINGLE WASHES. Until now one list of days (migration 39) applied to everything. Now Admin -> Working Days keeps two:
--
--   single washes   a single wash booked on its own, and a free wash claimed from a campaign (WASHO picks the earliest open day)
--   memberships     the weekdays a customer picks for a membership, the automatic spread of its washes, exact dates, and moving a membership wash
--
-- So memberships can be weekends only while single washes stay open every day (or the other way round). Each kind has its own days of the week and its own specific dates (a festival
-- can close single washes and leave memberships alone). Nothing changes when this is applied: every existing setting is copied to both kinds, so both behave exactly as before until an
-- admin changes one. No wash, membership or payment row is touched; a wash already booked on a day that is closed for its kind stays booked until WASHO moves it.
--
--   working_weekdays / working_dates     each row now has a kind ('single' or 'membership'); the primary keys include it
--   app_private.is_working_day(date, kind) / next_working_day / closed_day_message / require_working_day / require_capacity     take the kind ('single' by default; 'both' = open only if
--                                        open for both kinds, which is what an older page that does not say which kind it is booking is told, so it is never offered a day that would be refused)
--   the membership rules (weekdays picked, the automatic spread, exact dates, moving a membership wash) now ask for 'membership'; single-wash checkout and the free-wash claim ask for 'single'
--   get_working_days(from, to, kind)     what the booking pages ask (kind omitted = 'both')
--   admin_working_days()                 now has 'single' and 'membership' parts (the old top-level fields are the single-wash ones, so an older Admin page keeps working)
--   admin_set_working_weekdays(days, kind) / admin_set_working_dates(from, to, open, reason, kind) / admin_clear_working_date(day, kind)     kind omitted = both kinds, as before

-- ───────────────────────── tables: a kind on every row ─────────────────────────
ALTER TABLE public.working_weekdays ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'single';
ALTER TABLE public.working_dates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'single';
ALTER TABLE public.working_weekdays DROP CONSTRAINT IF EXISTS working_weekdays_kind_check;
ALTER TABLE public.working_weekdays ADD CONSTRAINT working_weekdays_kind_check CHECK (kind IN ('single', 'membership'));
ALTER TABLE public.working_dates DROP CONSTRAINT IF EXISTS working_dates_kind_check;
ALTER TABLE public.working_dates ADD CONSTRAINT working_dates_kind_check CHECK (kind IN ('single', 'membership'));

DO $$
DECLARE v_name text;
BEGIN
  SELECT conname INTO v_name FROM pg_constraint WHERE conrelid = 'public.working_weekdays'::regclass AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (weekday)';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.working_weekdays DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.working_weekdays ADD PRIMARY KEY (kind, weekday);
  END IF;
  SELECT conname INTO v_name FROM pg_constraint WHERE conrelid = 'public.working_dates'::regclass AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (day)';
  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.working_dates DROP CONSTRAINT %I', v_name);
    ALTER TABLE public.working_dates ADD PRIMARY KEY (kind, day);
  END IF;
END $$;

-- What is set today becomes the setting for both kinds (the old rows were 'single' by default), so nothing changes until an admin changes one.
INSERT INTO public.working_weekdays (kind, weekday, is_open, updated_at, updated_by)
SELECT 'membership', weekday, is_open, updated_at, updated_by FROM public.working_weekdays WHERE kind = 'single'
ON CONFLICT (kind, weekday) DO NOTHING;
INSERT INTO public.working_dates (kind, day, is_open, reason, created_at, updated_at, updated_by)
SELECT 'membership', day, is_open, reason, created_at, updated_at, updated_by FROM public.working_dates WHERE kind = 'single'
ON CONFLICT (kind, day) DO NOTHING;

-- ───────────────────────── the rule, by kind ─────────────────────────
DROP FUNCTION IF EXISTS app_private.is_working_day(date);
DROP FUNCTION IF EXISTS app_private.next_working_day(date);
DROP FUNCTION IF EXISTS app_private.closed_day_message(date);
DROP FUNCTION IF EXISTS app_private.require_working_day(date);
DROP FUNCTION IF EXISTS app_private.require_capacity(date, public.time_slot);

-- A date's own row wins; otherwise its weekday; otherwise (nothing set) it is a working day. 'both' = open for single washes AND for memberships.
CREATE OR REPLACE FUNCTION app_private.is_working_day(p_date date, p_kind text DEFAULT 'single') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_kind = 'both' THEN RETURN app_private.is_working_day(p_date, 'single') AND app_private.is_working_day(p_date, 'membership'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('single', 'membership') THEN RAISE EXCEPTION 'Unknown kind of booking: %', p_kind; END IF;
  RETURN COALESCE(
    (SELECT d.is_open FROM public.working_dates d WHERE d.day = p_date AND d.kind = p_kind),
    (SELECT w.is_open FROM public.working_weekdays w WHERE w.weekday = extract(dow FROM p_date)::smallint AND w.kind = p_kind),
    true);
END $$;

CREATE OR REPLACE FUNCTION app_private.next_working_day(p_from date, p_kind text DEFAULT 'single') RETURNS date
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := p_from;
BEGIN
  IF p_from IS NULL THEN RETURN NULL; END IF;
  FOR i IN 0 .. 400 LOOP
    IF app_private.is_working_day(d, p_kind) THEN RETURN d; END IF;
    d := d + 1;
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION app_private.closed_day_message(p_date date, p_kind text DEFAULT 'single') RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text;
  v_next date;
BEGIN
  SELECT d.reason INTO v_reason FROM public.working_dates d
   WHERE d.day = p_date AND NOT d.is_open AND (p_kind = 'both' OR d.kind = p_kind) AND d.reason IS NOT NULL
   ORDER BY (d.kind = 'single') DESC LIMIT 1;
  v_next := app_private.next_working_day(GREATEST(p_date, v_today) + 1, p_kind);
  RETURN 'WASHO is currently unavailable on ' || to_char(p_date, 'FMDay, FMDD Mon') || CASE WHEN v_reason IS NOT NULL THEN ' (' || v_reason || ')' ELSE '' END || '. '
      || CASE WHEN v_next IS NULL THEN 'We are not taking bookings right now.' ELSE 'The next day you can book is ' || to_char(v_next, 'FMDay, FMDD Mon') || '.' END;
END $$;

CREATE OR REPLACE FUNCTION app_private.require_working_day(p_date date, p_kind text DEFAULT 'single') RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_date IS NOT NULL AND NOT app_private.is_working_day(p_date, p_kind) THEN RAISE EXCEPTION '%', app_private.closed_day_message(p_date, p_kind); END IF;
END $$;

-- Single-wash checkout and the free-wash claim ask for 'single' (the default); moving a membership wash asks for 'membership'. A closed day first, then a full window.
CREATE OR REPLACE FUNCTION app_private.require_capacity(p_date date, p_slot public.time_slot, p_kind text DEFAULT 'single') RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_working_day(p_date, p_kind);
  PERFORM app_private.require_slot_room(p_date, p_slot);
END $$;

REVOKE ALL ON FUNCTION app_private.is_working_day(date, text), app_private.next_working_day(date, text), app_private.closed_day_message(date, text), app_private.require_working_day(date, text),
  app_private.require_capacity(date, public.time_slot, text) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── memberships ask for the membership days ─────────────────────────
-- The functions below are the ones in force (migrations 39, 40 and 42), word for word, with one change each: the working-day question is asked for 'membership'.

CREATE OR REPLACE FUNCTION app_private.require_open_weekdays(p_days smallint[], p_start date, p_end date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bad smallint[]; v_open smallint[];
BEGIN
  IF p_days IS NULL OR cardinality(p_days) = 0 THEN RETURN; END IF;
  SELECT array_agg(d::smallint ORDER BY d) INTO v_bad FROM unnest(p_days) d
   WHERE NOT EXISTS (SELECT 1 FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
                      WHERE extract(dow FROM g)::integer = d AND app_private.is_working_day(g::date, 'membership'));
  IF v_bad IS NULL THEN RETURN; END IF;
  SELECT array_agg(d::smallint ORDER BY d) INTO v_open FROM generate_series(0, 6) d
   WHERE EXISTS (SELECT 1 FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
                  WHERE extract(dow FROM g)::integer = d AND app_private.is_working_day(g::date, 'membership'));
  RAISE EXCEPTION '%', 'WASHO is currently unavailable on ' || app_private.weekday_words(v_bad) || '. '
    || CASE WHEN v_open IS NULL THEN 'We are not taking memberships right now.' ELSE 'Choose from ' || app_private.weekday_words(v_open) || '.' END;
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
       AND NOT app_private.vehicle_has_live_booking(p_vehicle_id, d)
       AND (NOT p_respect_capacity OR app_private.is_working_day(d, 'membership')) THEN
      wash_date := d; kind := k; n := n + 1;
      RETURN NEXT;
    END IF;
    d := d + 1;
  END LOOP;
END $$;

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
       AND app_private.is_working_day(g::date, 'membership');
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
    PERFORM app_private.require_working_day(r.d, 'membership');
  END LOOP;
  FOR r IN SELECT date_trunc('week', (e->>'date')::date)::date AS wk, count(*)::integer AS n FROM jsonb_array_elements(v_norm) e GROUP BY 1 HAVING count(*) > v_per_week ORDER BY 1 LIMIT 1 LOOP
    RAISE EXCEPTION 'No more than % wash% in one week: the week of % has %', v_per_week, CASE WHEN v_per_week = 1 THEN '' ELSE 'es' END, to_char(r.wk, 'FMDD Mon'), r.n;
  END LOOP;
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;

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
    PERFORM app_private.require_working_day(r.d, 'membership');
  END LOOP;
  FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(v_norm) e ORDER BY 1 LOOP
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;

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
  IF NOT public.is_admin() THEN PERFORM app_private.require_capacity(p_new_date, p_new_slot, 'membership'); END IF;   -- a working day, and room in that time window
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

REVOKE ALL ON FUNCTION app_private.require_open_weekdays(smallint[], date, date), app_private.plan_membership_washes(uuid, date, date, jsonb, integer, public.time_slot, boolean),
  app_private.plan_monthly_washes(uuid, date, integer, integer, integer, smallint[]), app_private.check_custom_dates(uuid, date, date, jsonb, integer, public.time_slot, jsonb),
  app_private.check_custom_dates_counts(uuid, date, date, integer, integer, integer, jsonb),
  app_private.reschedule_wash(uuid, date, public.time_slot, uuid, uuid, date, text) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── what the booking pages ask ─────────────────────────
-- Public information: which weekdays are open, the closed days in a range (with the reason when one was given), and the next open day from today, for one kind. A page that does not say
-- which kind (an older one) gets the days open for BOTH, so it never offers a day the server would refuse.
DROP FUNCTION IF EXISTS public.get_working_days(date, date);
CREATE OR REPLACE FUNCTION public.get_working_days(p_from date, p_to date, p_kind text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_kind text := COALESCE(NULLIF(btrim(p_kind), ''), 'both');
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 400 THEN RAISE EXCEPTION 'Ask for 1 to 401 days at a time'; END IF;
  IF v_kind NOT IN ('single', 'membership', 'both') THEN RAISE EXCEPTION 'Ask for single, membership or both'; END IF;
  RETURN jsonb_build_object(
    'kind', v_kind,
    'weekdays', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('weekday', g.d, 'open', CASE WHEN v_kind = 'both' THEN
                COALESCE((SELECT w.is_open FROM public.working_weekdays w WHERE w.weekday = g.d AND w.kind = 'single'), true) AND COALESCE((SELECT w.is_open FROM public.working_weekdays w WHERE w.weekday = g.d AND w.kind = 'membership'), true)
              ELSE COALESCE((SELECT w.is_open FROM public.working_weekdays w WHERE w.weekday = g.d AND w.kind = v_kind), true) END) ORDER BY g.d)
        FROM generate_series(0, 6) AS g(d)), '[]'::jsonb),
    'closed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', g::date, 'reason', (SELECT d.reason FROM public.working_dates d WHERE d.day = g::date AND NOT d.is_open AND (v_kind = 'both' OR d.kind = v_kind) AND d.reason IS NOT NULL ORDER BY (d.kind = 'single') DESC LIMIT 1)) ORDER BY g)
        FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g WHERE NOT app_private.is_working_day(g::date, v_kind)), '[]'::jsonb),
    'next_open', app_private.next_working_day((now() AT TIME ZONE 'Asia/Kolkata')::date, v_kind));
END $$;
REVOKE ALL ON FUNCTION public.get_working_days(date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_working_days(date, date, text) TO anon, authenticated, service_role;

-- ───────────────────────── admin ─────────────────────────
-- One kind's part of the Working Days page: its weekdays, the dates turned off or on from today (each with how many washes of that kind are booked that day), and the washes of that
-- kind already booked on days closed for it in the next 120 days (they stay booked until WASHO moves them).
CREATE OR REPLACE FUNCTION app_private.working_days_json(p_kind text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  RETURN jsonb_build_object(
    'weekdays', COALESCE((SELECT jsonb_agg(jsonb_build_object('weekday', w.weekday, 'open', w.is_open) ORDER BY w.weekday) FROM public.working_weekdays w WHERE w.kind = p_kind), '[]'::jsonb),
    'dates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'open', d.is_open, 'reason', d.reason,
               'washes', (SELECT count(*)::integer FROM public.bookings b WHERE b.scheduled_date = d.day
                           AND (b.membership_schedule_occurrence_id IS NOT NULL) = (p_kind = 'membership')
                           AND b.status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress'))) ORDER BY d.day)
        FROM public.working_dates d WHERE d.day >= v_today AND d.kind = p_kind), '[]'::jsonb),
    'booked_on_closed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', x.d, 'washes', x.n) ORDER BY x.d)
        FROM (SELECT b.scheduled_date AS d, count(*)::integer AS n FROM public.bookings b
               WHERE b.scheduled_date BETWEEN v_today AND v_today + 120
                 AND (b.membership_schedule_occurrence_id IS NOT NULL) = (p_kind = 'membership')
                 AND b.status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress')
                 AND NOT app_private.is_working_day(b.scheduled_date, p_kind)
               GROUP BY b.scheduled_date) x), '[]'::jsonb),
    'next_open', app_private.next_working_day(v_today, p_kind));
END $$;
REVOKE ALL ON FUNCTION app_private.working_days_json(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_working_days() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_single jsonb;
BEGIN
  PERFORM app_private.require_admin();
  v_single := app_private.working_days_json('single');
  -- the top-level fields are the single-wash ones (what an older Admin page reads); the page now reads 'single' and 'membership'
  RETURN v_single || jsonb_build_object('single', v_single, 'membership', app_private.working_days_json('membership'));
END $$;

-- 'single', 'membership' or 'both' (the default) -> the kinds to change.
CREATE OR REPLACE FUNCTION app_private.working_kinds(p_kind text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_kind IS NULL OR btrim(p_kind) = '' OR p_kind = 'both' THEN RETURN ARRAY['single', 'membership']; END IF;
  IF p_kind NOT IN ('single', 'membership') THEN RAISE EXCEPTION 'Choose single washes, memberships or both'; END IF;
  RETURN ARRAY[p_kind];
END $$;
REVOKE ALL ON FUNCTION app_private.working_kinds(text) FROM PUBLIC, anon, authenticated;

-- Which weekdays WASHO works for a kind, all at once (0 = Sunday ... 6 = Saturday). An empty list closes every weekday. Without a kind it sets both, as before.
DROP FUNCTION IF EXISTS public.admin_set_working_weekdays(integer[]);
CREATE OR REPLACE FUNCTION public.admin_set_working_weekdays(p_open_days integer[], p_kind text DEFAULT 'both') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid := app_private.require_admin(); v_kinds text[] := app_private.working_kinds(p_kind);
BEGIN
  IF p_open_days IS NULL OR EXISTS (SELECT 1 FROM unnest(p_open_days) d WHERE d IS NULL OR d NOT BETWEEN 0 AND 6) THEN
    RAISE EXCEPTION 'Each day must be a weekday (0 to 6)';
  END IF;
  UPDATE public.working_weekdays SET is_open = (weekday::integer = ANY (p_open_days)), updated_at = now(), updated_by = v_admin WHERE kind = ANY (v_kinds);
  PERFORM app_private.audit('working_days', NULL, 'working_weekdays_changed', jsonb_build_object('kinds', to_jsonb(v_kinds), 'open_days', (SELECT COALESCE(jsonb_agg(w.weekday ORDER BY w.weekday), '[]'::jsonb) FROM public.working_weekdays w WHERE w.is_open AND w.kind = v_kinds[1])));
  RETURN true;
END $$;

-- Turn a date, or a run of dates, off (closed) or on (a working day even if its weekday is off), for a kind. Returns how many dates were set.
DROP FUNCTION IF EXISTS public.admin_set_working_dates(date, date, boolean, text);
CREATE OR REPLACE FUNCTION public.admin_set_working_dates(p_from date, p_to date, p_open boolean, p_reason text DEFAULT NULL, p_kind text DEFAULT 'both') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_kinds text[] := app_private.working_kinds(p_kind);
  n integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_open IS NULL THEN RAISE EXCEPTION 'Choose the date and whether WASHO works that day'; END IF;
  IF p_from < v_today THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The last date cannot be before the first'; END IF;
  IF p_to - p_from > 91 THEN RAISE EXCEPTION 'Set up to 92 days at a time'; END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 120 THEN RAISE EXCEPTION 'Please keep the reason under 120 characters'; END IF;
  INSERT INTO public.working_dates (kind, day, is_open, reason, updated_by)
  SELECT k, g::date, p_open, v_reason, v_admin FROM unnest(v_kinds) AS k, generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ON CONFLICT (kind, day) DO UPDATE SET is_open = EXCLUDED.is_open, reason = EXCLUDED.reason, updated_at = now(), updated_by = EXCLUDED.updated_by;
  n := p_to - p_from + 1;
  PERFORM app_private.audit('working_days', NULL, 'working_dates_set', jsonb_build_object('kinds', to_jsonb(v_kinds), 'from', p_from, 'to', p_to, 'open', p_open, 'reason', v_reason, 'days', n));
  RETURN n;
END $$;

-- Take a date's own setting away for a kind: its weekday decides again.
DROP FUNCTION IF EXISTS public.admin_clear_working_date(date);
CREATE OR REPLACE FUNCTION public.admin_clear_working_date(p_day date, p_kind text DEFAULT 'both') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_kinds text[] := app_private.working_kinds(p_kind); v_was boolean; n integer;
BEGIN
  PERFORM app_private.require_admin();
  WITH gone AS (DELETE FROM public.working_dates WHERE day = p_day AND kind = ANY (v_kinds) RETURNING is_open)
  SELECT count(*)::integer, bool_or(is_open) INTO n, v_was FROM gone;
  IF n = 0 THEN RAISE EXCEPTION 'That date has no setting to remove'; END IF;
  PERFORM app_private.audit('working_days', NULL, 'working_date_cleared', jsonb_build_object('kinds', to_jsonb(v_kinds), 'day', p_day, 'was_open', v_was));
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.admin_working_days(), public.admin_set_working_weekdays(integer[], text), public.admin_set_working_dates(date, date, boolean, text, text), public.admin_clear_working_date(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_working_days(), public.admin_set_working_weekdays(integer[], text), public.admin_set_working_dates(date, date, boolean, text, text), public.admin_clear_working_date(date, text) TO authenticated;  -- require_admin() inside
