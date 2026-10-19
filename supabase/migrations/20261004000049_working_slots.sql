-- 20261004000049_working_slots.sql
-- SAFE / additive and re-runnable. WORKING TIME WINDOWS. Admin -> Working Days could turn whole days off (migrations 39 and 46). Now it can also turn a TIME WINDOW off (Morning, Afternoon
-- or Night), so WASHO can stop taking, say, night washes on Sundays, or the morning of one festival date, without closing the whole day.
--
-- It works the same way as the days, and separately for single washes and memberships (kind):
--   working_slot_weekdays   a window on or off for each day of the week (0 = Sunday ... 6 = Saturday)        e.g. Night off on Sundays
--   working_slot_dates      a window on or off for one date; a date's own row beats its day of the week      e.g. Morning off on 24 Oct
-- Until an admin turns a window off every window is on, so nothing changes when this is applied. No wash, membership or payment row is touched. A wash already booked in a window that is
-- later turned off stays booked until WASHO moves it (the Working Days page lists them).
--
-- What a closed window stops (customers and specialists; an admin can still book or move a wash into it, exactly as with a closed day):
--   * a SINGLE wash in that window                       "WASHO is currently unavailable in the Night window on Sun, 26 Oct. You can book the Morning or Afternoon window that day."
--   * a FREE-WASH campaign claim: WASHO picks a window that is open
--   * a MEMBERSHIP request (the older weekly one too): the window chosen must be open on every weekday picked, and on every exact date picked
--   * moving a membership wash (customer or specialist) into it
-- A day with EVERY window off counts as a closed day (it is shown as closed and the next open day is found past it). A membership that is already PAID is never refused: the automatic
-- spread of its washes chooses days, not windows, so a window turned off for one date later can leave a wash in it: the Working Days page lists those washes so WASHO can move them.
--
--   app_private.is_slot_on(date, window, kind)        the window's own setting (date row, else weekday row, else on); one kind
--   app_private.is_slot_open(date, window, kind)      the day is a working day AND the window is on; kind 'both' = open for both kinds
--   app_private.is_working_day(date, kind)            now also false when every window of that day is off
--   app_private.require_capacity(date, window, kind)  a working day, then an open window, then room in it
--   get_working_days(from, to, kind)                  also lists the closed windows of the days that are open ('closed_slots')
--   admin_working_days()                              each kind also has slot_weekdays, slot_dates and booked_in_closed_slots
--   admin_set_working_slot_weekdays(window, open_days, kind) / admin_set_working_slot_dates(from, to, window, open, reason, kind) / admin_clear_working_slot_date(day, window, kind)

-- ───────────────────────── tables ─────────────────────────
CREATE TABLE IF NOT EXISTS public.working_slot_weekdays (
  kind text NOT NULL CHECK (kind IN ('single', 'membership')),
  slot public.time_slot NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),     -- 0 = Sunday, like extract(dow ...) everywhere else
  is_open boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (kind, slot, weekday)
);
INSERT INTO public.working_slot_weekdays (kind, slot, weekday)
SELECT k, s, d FROM unnest(ARRAY['single', 'membership']) k, unnest(ARRAY['morning', 'afternoon', 'night']::public.time_slot[]) s, generate_series(0, 6) d
ON CONFLICT (kind, slot, weekday) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.working_slot_dates (
  kind text NOT NULL CHECK (kind IN ('single', 'membership')),
  slot public.time_slot NOT NULL,
  day date NOT NULL,
  is_open boolean NOT NULL,
  reason text CHECK (reason IS NULL OR char_length(reason) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (kind, slot, day)
);

-- Nobody reads or writes these tables directly: the booking pages use get_working_days(), admins use the admin_* functions below.
ALTER TABLE public.working_slot_weekdays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.working_slot_dates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.working_slot_weekdays, public.working_slot_dates FROM PUBLIC, anon, authenticated;

-- ───────────────────────── the rule ─────────────────────────
-- One window's own setting for one kind: a date's row wins; otherwise its weekday; otherwise (nothing set) it is on.
CREATE OR REPLACE FUNCTION app_private.is_slot_on(p_date date, p_slot public.time_slot, p_kind text DEFAULT 'single') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_kind = 'both' THEN RETURN app_private.is_slot_on(p_date, p_slot, 'single') AND app_private.is_slot_on(p_date, p_slot, 'membership'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('single', 'membership') THEN RAISE EXCEPTION 'Unknown kind of booking: %', p_kind; END IF;
  RETURN COALESCE(
    (SELECT d.is_open FROM public.working_slot_dates d WHERE d.day = p_date AND d.slot = p_slot AND d.kind = p_kind),
    (SELECT w.is_open FROM public.working_slot_weekdays w WHERE w.weekday = extract(dow FROM p_date)::smallint AND w.slot = p_slot AND w.kind = p_kind),
    true);
END $$;

-- A day is a working day when its date row (else its weekday) says so AND at least one of its windows is on.
CREATE OR REPLACE FUNCTION app_private.is_working_day(p_date date, p_kind text DEFAULT 'single') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_kind = 'both' THEN RETURN app_private.is_working_day(p_date, 'single') AND app_private.is_working_day(p_date, 'membership'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('single', 'membership') THEN RAISE EXCEPTION 'Unknown kind of booking: %', p_kind; END IF;
  RETURN COALESCE(
           (SELECT d.is_open FROM public.working_dates d WHERE d.day = p_date AND d.kind = p_kind),
           (SELECT w.is_open FROM public.working_weekdays w WHERE w.weekday = extract(dow FROM p_date)::smallint AND w.kind = p_kind),
           true)
     AND EXISTS (SELECT 1 FROM unnest(ARRAY['morning', 'afternoon', 'night']::public.time_slot[]) s WHERE app_private.is_slot_on(p_date, s, p_kind));
END $$;

-- The day is a working day and this window is on.
CREATE OR REPLACE FUNCTION app_private.is_slot_open(p_date date, p_slot public.time_slot, p_kind text DEFAULT 'single') RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN app_private.is_working_day(p_date, p_kind) AND app_private.is_slot_on(p_date, p_slot, p_kind);
END $$;

-- "Morning", "Afternoon or Night": the windows of a day that are open, in words (NULL when none).
CREATE OR REPLACE FUNCTION app_private.open_slot_words(p_date date, p_kind text DEFAULT 'single', p_except public.time_slot DEFAULT NULL) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT string_agg(initcap(s::text), ' or ' ORDER BY array_position(ARRAY['morning', 'afternoon', 'night'], s::text))
    FROM unnest(ARRAY['morning', 'afternoon', 'night']::public.time_slot[]) s
   WHERE (p_except IS NULL OR s <> p_except) AND app_private.is_slot_on(p_date, s, p_kind);
$$;

-- "WASHO is currently unavailable in the Night window on Sun, 26 Oct (Diwali). You can book the Morning or Afternoon window that day."
CREATE OR REPLACE FUNCTION app_private.closed_slot_message(p_date date, p_slot public.time_slot, p_kind text DEFAULT 'single') RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_reason text; v_other text := app_private.open_slot_words(p_date, p_kind, p_slot);
BEGIN
  SELECT d.reason INTO v_reason FROM public.working_slot_dates d
   WHERE d.day = p_date AND d.slot = p_slot AND NOT d.is_open AND (p_kind = 'both' OR d.kind = p_kind) AND d.reason IS NOT NULL
   ORDER BY (d.kind = 'single') DESC LIMIT 1;
  RETURN 'WASHO is currently unavailable in the ' || initcap(p_slot::text) || ' window on ' || to_char(p_date, 'FMDy, FMDD Mon') || CASE WHEN v_reason IS NOT NULL THEN ' (' || v_reason || ')' ELSE '' END || '. '
      || CASE WHEN v_other IS NULL THEN 'Please choose another day.' ELSE 'You can book the ' || v_other || ' window that day.' END;
END $$;

-- A day is open and so is the window; raises a message a customer can read.
CREATE OR REPLACE FUNCTION app_private.require_slot_open(p_date date, p_slot public.time_slot, p_kind text DEFAULT 'single') RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_working_day(p_date, p_kind);
  IF p_date IS NOT NULL AND p_slot IS NOT NULL AND NOT app_private.is_slot_on(p_date, p_slot, p_kind) THEN RAISE EXCEPTION '%', app_private.closed_slot_message(p_date, p_slot, p_kind); END IF;
END $$;

-- Single-wash checkout and moving a membership wash: a closed day first, then a closed window, then a full one.
CREATE OR REPLACE FUNCTION app_private.require_capacity(p_date date, p_slot public.time_slot, p_kind text DEFAULT 'single') RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_slot_open(p_date, p_slot, p_kind);
  PERFORM app_private.require_slot_room(p_date, p_slot);
END $$;

REVOKE ALL ON FUNCTION app_private.is_slot_on(date, public.time_slot, text), app_private.is_working_day(date, text), app_private.is_slot_open(date, public.time_slot, text),
  app_private.open_slot_words(date, text, public.time_slot), app_private.closed_slot_message(date, public.time_slot, text), app_private.require_slot_open(date, public.time_slot, text),
  app_private.require_capacity(date, public.time_slot, text) FROM PUBLIC, anon, authenticated;

-- ───────────────────────── a free wash from a campaign ─────────────────────────
-- Migration 42's pick_campaign_slot, with one more reason to pass a window over: it is turned off.
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
    -- the quietest time window that is on, not full and starts far enough ahead
    best := NULL; best_n := NULL;
    FOREACH s IN ARRAY ARRAY['morning', 'afternoon', 'night']::public.time_slot[] LOOP
      IF NOT app_private.is_slot_on(d, s, 'single') THEN CONTINUE; END IF;
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

-- ───────────────────────── memberships ─────────────────────────
-- The weekdays a customer picked must each have a date in the term where the chosen window is open. Says which do not, and which windows would work for all of them.
CREATE OR REPLACE FUNCTION app_private.require_open_slot_weekdays(p_days smallint[], p_slot public.time_slot, p_start date, p_end date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bad smallint[]; v_fit text;
BEGIN
  IF p_days IS NULL OR cardinality(p_days) = 0 OR p_slot IS NULL OR p_start IS NULL OR p_end IS NULL THEN RETURN; END IF;
  SELECT array_agg(d::smallint ORDER BY d) INTO v_bad FROM unnest(p_days) d
   WHERE NOT EXISTS (SELECT 1 FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
                      WHERE extract(dow FROM g)::integer = d AND app_private.is_slot_open(g::date, p_slot, 'membership'));
  IF v_bad IS NULL THEN RETURN; END IF;
  SELECT string_agg(initcap(s::text), ' or ' ORDER BY array_position(ARRAY['morning', 'afternoon', 'night'], s::text)) INTO v_fit
    FROM unnest(ARRAY['morning', 'afternoon', 'night']::public.time_slot[]) s
   WHERE s <> p_slot AND NOT EXISTS (
           SELECT 1 FROM unnest(p_days) d
            WHERE NOT EXISTS (SELECT 1 FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
                               WHERE extract(dow FROM g)::integer = d AND app_private.is_slot_open(g::date, s, 'membership')));
  RAISE EXCEPTION '%', 'WASHO is currently unavailable in the ' || initcap(p_slot::text) || ' window on ' || app_private.weekday_words(v_bad) || '. '
    || CASE WHEN v_fit IS NULL THEN 'Choose other days.' ELSE 'Choose the ' || v_fit || ' window, or other days.' END;
END $$;
REVOKE ALL ON FUNCTION app_private.require_open_slot_weekdays(smallint[], public.time_slot, date, date) FROM PUBLIC, anon, authenticated;

-- Every membership request (the monthly one and the older weekly one) is checked here as it is saved, so the window the customer chose must be on for the weekdays or the exact
-- dates they picked. An admin is never blocked. A request that picks no window rule (nothing turned off for memberships in that window) is not even looked at.
CREATE OR REPLACE FUNCTION app_private.membership_request_slot_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_days smallint[]; v_end date; r record;
BEGIN
  IF NEW.time_slot IS NULL OR NEW.start_date IS NULL OR public.is_admin() THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.working_slot_weekdays w WHERE w.kind = 'membership' AND w.slot = NEW.time_slot AND NOT w.is_open)
     AND NOT EXISTS (SELECT 1 FROM public.working_slot_dates d WHERE d.kind = 'membership' AND d.slot = NEW.time_slot AND NOT d.is_open AND d.day >= NEW.start_date) THEN
    RETURN NEW;
  END IF;
  v_end := app_private.membership_term_end(NEW.start_date, NEW.duration_months);
  IF NEW.custom_dates IS NOT NULL AND jsonb_typeof(NEW.custom_dates) = 'array' THEN
    FOR r IN SELECT (e->>'date')::date AS d FROM jsonb_array_elements(NEW.custom_dates) e ORDER BY 1 LOOP
      PERFORM app_private.require_slot_open(r.d, NEW.time_slot, 'membership');
    END LOOP;
  ELSE
    v_days := COALESCE(NULLIF(NEW.preferred_weekdays, ARRAY[]::smallint[]),
                       (SELECT array_agg((e->>'weekday')::smallint) FROM jsonb_array_elements(COALESCE(NEW.weekly_pattern, '[]'::jsonb)) e));
    PERFORM app_private.require_open_slot_weekdays(v_days, NEW.time_slot, NEW.start_date, v_end);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.membership_request_slot_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS membership_request_slot_check ON public.membership_requests;
CREATE TRIGGER membership_request_slot_check BEFORE INSERT ON public.membership_requests FOR EACH ROW EXECUTE FUNCTION app_private.membership_request_slot_check();

-- ───────────────────────── what the booking pages ask ─────────────────────────
-- Migration 46's answer, plus 'closed_slots': the windows turned off on days that are otherwise open (a whole closed day is in 'closed' already). For kind 'both' (an older page that
-- does not say which kind it is booking) a window counts as closed when it is closed for either kind, so it is never offered a window that would be refused.
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
    'closed_slots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', g::date, 'slot', s,
               'reason', (SELECT d.reason FROM public.working_slot_dates d WHERE d.day = g::date AND d.slot = s AND NOT d.is_open AND (v_kind = 'both' OR d.kind = v_kind) AND d.reason IS NOT NULL ORDER BY (d.kind = 'single') DESC LIMIT 1))
               ORDER BY g, array_position(ARRAY['morning', 'afternoon', 'night'], s::text))
        FROM generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g, unnest(ARRAY['morning', 'afternoon', 'night']::public.time_slot[]) s
       WHERE app_private.is_working_day(g::date, v_kind) AND NOT app_private.is_slot_on(g::date, s, v_kind)), '[]'::jsonb),
    'next_open', app_private.next_working_day((now() AT TIME ZONE 'Asia/Kolkata')::date, v_kind));
END $$;
REVOKE ALL ON FUNCTION public.get_working_days(date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_working_days(date, date, text) TO anon, authenticated, service_role;

-- ───────────────────────── admin ─────────────────────────
-- Migration 46's one-kind part, plus the windows: each window's weekdays, the dates a window was turned off or on from today (with how many washes of the kind are booked in it), and
-- the washes of the kind already booked in a window that is off on an otherwise open day in the next 120 days.
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
    'slot_weekdays', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('slot', s, 'weekday', g.d,
               'open', COALESCE((SELECT w.is_open FROM public.working_slot_weekdays w WHERE w.kind = p_kind AND w.slot = s AND w.weekday = g.d), true))
               ORDER BY array_position(ARRAY['morning', 'afternoon', 'night'], s::text), g.d)
        FROM unnest(ARRAY['morning', 'afternoon', 'night']::public.time_slot[]) s, generate_series(0, 6) AS g(d)), '[]'::jsonb),
    'slot_dates', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('day', d.day, 'slot', d.slot, 'open', d.is_open, 'reason', d.reason,
               'washes', (SELECT count(*)::integer FROM public.bookings b WHERE b.scheduled_date = d.day AND b.time_slot = d.slot
                           AND (b.membership_schedule_occurrence_id IS NOT NULL) = (p_kind = 'membership')
                           AND b.status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress')))
               ORDER BY d.day, array_position(ARRAY['morning', 'afternoon', 'night'], d.slot::text))
        FROM public.working_slot_dates d WHERE d.day >= v_today AND d.kind = p_kind), '[]'::jsonb),
    'booked_in_closed_slots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', x.d, 'slot', x.s, 'washes', x.n) ORDER BY x.d, array_position(ARRAY['morning', 'afternoon', 'night'], x.s::text))
        FROM (SELECT b.scheduled_date AS d, b.time_slot AS s, count(*)::integer AS n FROM public.bookings b
               WHERE b.scheduled_date BETWEEN v_today AND v_today + 120
                 AND (b.membership_schedule_occurrence_id IS NOT NULL) = (p_kind = 'membership')
                 AND b.status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress')
                 AND app_private.is_working_day(b.scheduled_date, p_kind)
                 AND NOT app_private.is_slot_on(b.scheduled_date, b.time_slot, p_kind)
               GROUP BY b.scheduled_date, b.time_slot) x), '[]'::jsonb),
    'next_open', app_private.next_working_day(v_today, p_kind));
END $$;
REVOKE ALL ON FUNCTION app_private.working_days_json(text) FROM PUBLIC, anon, authenticated;

-- Which weekdays one window is on, for a kind, all at once (0 = Sunday ... 6 = Saturday). An empty list turns the window off every day. Without a kind it sets both.
CREATE OR REPLACE FUNCTION public.admin_set_working_slot_weekdays(p_slot public.time_slot, p_open_days integer[], p_kind text DEFAULT 'both') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_admin uuid := app_private.require_admin(); v_kinds text[] := app_private.working_kinds(p_kind);
BEGIN
  IF p_slot IS NULL THEN RAISE EXCEPTION 'Choose the time window'; END IF;
  IF p_open_days IS NULL OR EXISTS (SELECT 1 FROM unnest(p_open_days) d WHERE d IS NULL OR d NOT BETWEEN 0 AND 6) THEN
    RAISE EXCEPTION 'Each day must be a weekday (0 to 6)';
  END IF;
  INSERT INTO public.working_slot_weekdays (kind, slot, weekday, is_open, updated_by)
  SELECT k, p_slot, d::smallint, (d = ANY (p_open_days)), v_admin FROM unnest(v_kinds) k, generate_series(0, 6) d
  ON CONFLICT (kind, slot, weekday) DO UPDATE SET is_open = EXCLUDED.is_open, updated_at = now(), updated_by = EXCLUDED.updated_by;
  PERFORM app_private.audit('working_days', NULL, 'working_slot_weekdays_changed', jsonb_build_object('kinds', to_jsonb(v_kinds), 'slot', p_slot, 'open_days', (SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb) FROM unnest(p_open_days) d)));
  RETURN true;
END $$;

-- Turn one window off (closed) or on (even if its weekday is off) for a date or a run of dates, for a kind. Returns how many dates were set.
CREATE OR REPLACE FUNCTION public.admin_set_working_slot_dates(p_from date, p_to date, p_slot public.time_slot, p_open boolean, p_reason text DEFAULT NULL, p_kind text DEFAULT 'both') RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_kinds text[] := app_private.working_kinds(p_kind);
  n integer;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_slot IS NULL OR p_open IS NULL THEN RAISE EXCEPTION 'Choose the date, the time window and whether WASHO works then'; END IF;
  IF p_from < v_today THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  IF p_to < p_from THEN RAISE EXCEPTION 'The last date cannot be before the first'; END IF;
  IF p_to - p_from > 91 THEN RAISE EXCEPTION 'Set up to 92 days at a time'; END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 120 THEN RAISE EXCEPTION 'Please keep the reason under 120 characters'; END IF;
  INSERT INTO public.working_slot_dates (kind, slot, day, is_open, reason, updated_by)
  SELECT k, p_slot, g::date, p_open, v_reason, v_admin FROM unnest(v_kinds) AS k, generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ON CONFLICT (kind, slot, day) DO UPDATE SET is_open = EXCLUDED.is_open, reason = EXCLUDED.reason, updated_at = now(), updated_by = EXCLUDED.updated_by;
  n := p_to - p_from + 1;
  PERFORM app_private.audit('working_days', NULL, 'working_slot_dates_set', jsonb_build_object('kinds', to_jsonb(v_kinds), 'slot', p_slot, 'from', p_from, 'to', p_to, 'open', p_open, 'reason', v_reason, 'days', n));
  RETURN n;
END $$;

-- Take a date's own setting for one window away, for a kind: its weekday decides again.
CREATE OR REPLACE FUNCTION public.admin_clear_working_slot_date(p_day date, p_slot public.time_slot, p_kind text DEFAULT 'both') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_kinds text[] := app_private.working_kinds(p_kind); v_was boolean; n integer;
BEGIN
  PERFORM app_private.require_admin();
  WITH gone AS (DELETE FROM public.working_slot_dates WHERE day = p_day AND slot = p_slot AND kind = ANY (v_kinds) RETURNING is_open)
  SELECT count(*)::integer, bool_or(is_open) INTO n, v_was FROM gone;
  IF n = 0 THEN RAISE EXCEPTION 'That date has no setting for this time window to remove'; END IF;
  PERFORM app_private.audit('working_days', NULL, 'working_slot_date_cleared', jsonb_build_object('kinds', to_jsonb(v_kinds), 'slot', p_slot, 'day', p_day, 'was_open', v_was));
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.admin_set_working_slot_weekdays(public.time_slot, integer[], text), public.admin_set_working_slot_dates(date, date, public.time_slot, boolean, text, text),
  public.admin_clear_working_slot_date(date, public.time_slot, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_working_slot_weekdays(public.time_slot, integer[], text), public.admin_set_working_slot_dates(date, date, public.time_slot, boolean, text, text),
  public.admin_clear_working_slot_date(date, public.time_slot, text) TO authenticated;  -- require_admin() inside
