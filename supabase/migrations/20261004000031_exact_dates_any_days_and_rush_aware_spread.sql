-- 20261004000031_exact_dates_any_days_and_rush_aware_spread.sql
-- SAFE / additive and re-runnable. Two changes to a membership chosen as washes in a MONTH (migration 28). No table, no stored row is touched.
--
-- 1. Exact dates: the only rule left is ONE WASH A DAY. The old "no more than N washes in one week" is gone, so a customer who wants washes on days one after
--    another can have them. Everything else is as before: exactly the Body washes and Deep cleans the plan holds, inside the term, not before the earliest allowed
--    start, never on a day this vehicle already has a wash. (app_private.check_custom_dates_counts keeps its arguments, so nothing that calls it changes; p_per_week
--    is simply no longer used. A plan chosen the older way, washes a week, keeps its own rules.)
--
-- 2. The automatic spread now looks at the rush. Each month's candidate days (the customer's weekdays, free of other washes of this vehicle) are cut into as many
--    equal parts as there are washes, one wash to a part, exactly as before; WITHIN its part a wash now goes on the quietest day (the fewest washes already booked
--    for that day, counted against what that day can take), and when days are equally quiet on the one that sat in the middle, which is the day it always got. So
--    with no rush anywhere, the dates are the same as before; when some days are busy, the wash moves to a quieter day of the same part of the month, on a weekday
--    the customer picked. Crowd limits are still only a warning: nothing is ever refused for a rush.

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
    IF app_private.vehicle_has_live_booking(p_vehicle_id, r.d) THEN RAISE EXCEPTION 'This vehicle already has a wash on %', to_char(r.d, 'FMDy, FMDD Mon'); END IF;
  END LOOP;
  RETURN v_norm;
END $$;

-- How full a day is, as a share of what that day can take (a weekend takes more than a weekday): 0 = empty, 1 = at the "full" line. Only used to rank days.
CREATE OR REPLACE FUNCTION app_private.day_load(p_date date) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT app_private.washes_on(p_date)::numeric / NULLIF(r.day_full, 0) FROM public.capacity_rules r WHERE r.day_kind = app_private.capacity_kind(p_date)), 0);
$$;
REVOKE ALL ON FUNCTION app_private.day_load(date) FROM PUBLIC, anon, authenticated;

-- Lays a monthly plan out on dates (same arguments and result as before; see migration 28 for the windows and the Deep spread). For each month's window the
-- candidate days are cut into n equal parts, one wash to a part; inside its part a wash takes the quietest day, and among equally quiet days the one at the
-- position (i + 0.5) * c / n it always had.
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
       AND NOT app_private.vehicle_has_live_booking(p_vehicle_id, g::date);
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
