-- 20261004000050_traffic.sql
-- SAFE / additive and re-runnable. TRAFFIC: who signed in to WASHO today, and who is using it right now (Admin -> Dashboard tiles and the Traffic tab).
--
--   sign_in_events                one row each time somebody signs in (a customer by mobile number, email or Google; a specialist; an admin): who, as what, how, from the website or the app, when
--   user_activity_days            one row per person per day (Pune time) they used WASHO: when they were first and last seen that day, and from where. "Active now" = seen in the last 5 minutes
--   record_sign_in(method, source)   the website, for the person who has just signed in. Their own row only: it takes no person, so nobody can write for somebody else
--   record_activity(source)          the website, on a signed-in person's requests (at most once a minute for each person): they were just seen
--   admin_traffic_summary()          the dashboard's numbers: active now, active today, signed in today (Activity access, which today is the super admin)
--   admin_traffic(day, days)         the Traffic tab: the people on the site now, who was active and who signed in on a chosen day, and the last days as a series
-- Nothing existing is touched: no customer, wash, payment or notification row changes. Visitors who have not signed in are not counted (nothing is recorded about them).
-- Nobody can read the two tables directly; only the functions below, and the admin ones check the admin's role.

CREATE TABLE IF NOT EXISTS public.sign_in_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role text NOT NULL,
  method text NOT NULL CHECK (method IN ('phone', 'email', 'signup', 'google', 'admin_email')),
  source text NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'app')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sign_in_events_at_idx ON public.sign_in_events (created_at DESC);
CREATE INDEX IF NOT EXISTS sign_in_events_profile_idx ON public.sign_in_events (profile_id, created_at DESC);
ALTER TABLE public.sign_in_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sign_in_events FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.user_activity_days (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day date NOT NULL,
  source text NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'app')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, day)
);
CREATE INDEX IF NOT EXISTS user_activity_days_seen_idx ON public.user_activity_days (last_seen_at DESC);
ALTER TABLE public.user_activity_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_activity_days FROM PUBLIC, anon, authenticated;

-- ───────────────────────── recording (the signed-in person, their own row only) ─────────────────────────
CREATE OR REPLACE FUNCTION public.record_sign_in(p_method text, p_source text DEFAULT 'website') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := public.current_profile_id();
  v_role text;
  v_method text := lower(btrim(COALESCE(p_method, '')));
  v_source text := CASE WHEN lower(btrim(COALESCE(p_source, ''))) = 'app' THEN 'app' ELSE 'website' END;
BEGIN
  IF v_me IS NULL THEN RETURN false; END IF;
  IF v_method NOT IN ('phone', 'email', 'signup', 'google', 'admin_email') THEN RAISE EXCEPTION 'Unknown sign-in method'; END IF;
  SELECT role::text INTO v_role FROM public.profiles WHERE id = v_me AND archived_at IS NULL;
  IF v_role IS NULL THEN RETURN false; END IF;
  INSERT INTO public.sign_in_events (profile_id, role, method, source) VALUES (v_me, v_role, v_method, v_source);
  -- signing in is also being seen
  INSERT INTO public.user_activity_days (profile_id, day, source) VALUES (v_me, (now() AT TIME ZONE 'Asia/Kolkata')::date, v_source)
  ON CONFLICT (profile_id, day) DO UPDATE SET last_seen_at = now(), source = EXCLUDED.source;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.record_sign_in(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_sign_in(text, text) TO authenticated; -- the caller's own profile is read inside

CREATE OR REPLACE FUNCTION public.record_activity(p_source text DEFAULT 'website') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := public.current_profile_id();
  v_source text := CASE WHEN lower(btrim(COALESCE(p_source, ''))) = 'app' THEN 'app' ELSE 'website' END;
BEGIN
  -- called on a signed-in person's requests: never an error, just nothing when there is nobody to record
  IF v_me IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_me AND archived_at IS NULL) THEN RETURN false; END IF;
  INSERT INTO public.user_activity_days (profile_id, day, source) VALUES (v_me, (now() AT TIME ZONE 'Asia/Kolkata')::date, v_source)
  ON CONFLICT (profile_id, day) DO UPDATE SET last_seen_at = now(), source = EXCLUDED.source;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.record_activity(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_activity(text) TO authenticated; -- the caller's own profile is read inside

-- ───────────────────────── reading (admins with Activity access) ─────────────────────────
-- The numbers behind the dashboard tiles, split by who: customers, specialists (role "worker") and admins. "Now" means seen in the last 5 minutes. A day is a Pune day.
CREATE OR REPLACE FUNCTION app_private.traffic_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_from timestamptz := v_today::timestamp AT TIME ZONE 'Asia/Kolkata';
  v_to timestamptz := (v_today + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
BEGIN
  RETURN jsonb_build_object(
    'window_minutes', 5,
    'today', v_today,
    'active_now', (
      SELECT jsonb_build_object('customers', count(*) FILTER (WHERE p.role = 'customer'), 'workers', count(*) FILTER (WHERE p.role = 'worker'), 'admins', count(*) FILTER (WHERE p.role = 'admin'))
        FROM (SELECT DISTINCT a.profile_id FROM public.user_activity_days a WHERE a.last_seen_at > now() - interval '5 minutes') x
        JOIN public.profiles p ON p.id = x.profile_id WHERE p.archived_at IS NULL),
    'active_today', (
      SELECT jsonb_build_object('customers', count(*) FILTER (WHERE p.role = 'customer'), 'workers', count(*) FILTER (WHERE p.role = 'worker'), 'admins', count(*) FILTER (WHERE p.role = 'admin'))
        FROM public.user_activity_days a JOIN public.profiles p ON p.id = a.profile_id WHERE a.day = v_today AND p.archived_at IS NULL),
    'signed_in_today', (
      SELECT jsonb_build_object(
               'customers', count(DISTINCT e.profile_id) FILTER (WHERE e.role = 'customer'),
               'workers', count(DISTINCT e.profile_id) FILTER (WHERE e.role = 'worker'),
               'admins', count(DISTINCT e.profile_id) FILTER (WHERE e.role = 'admin'),
               'sign_ins', count(*))
        FROM public.sign_in_events e JOIN public.profiles p ON p.id = e.profile_id WHERE e.created_at >= v_from AND e.created_at < v_to AND p.archived_at IS NULL)
  );
END $$;
REVOKE ALL ON FUNCTION app_private.traffic_summary() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_traffic_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('activity', 'view');
  RETURN app_private.traffic_summary();
END $$;
REVOKE ALL ON FUNCTION public.admin_traffic_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_traffic_summary() TO authenticated; -- the role check is inside

-- The Traffic tab: `live` (on the site in the last 5 minutes), `people` (everyone seen on the chosen day) and `sign_ins` (each sign-in that day), newest first, and `days`, the last p_days
-- days (at most 60) as a series. A day in the future is today; a day more than a year back is a year back.
CREATE OR REPLACE FUNCTION public.admin_traffic(p_day date DEFAULT NULL, p_days integer DEFAULT 14) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_day date := GREATEST(LEAST(COALESCE(p_day, (now() AT TIME ZONE 'Asia/Kolkata')::date), (now() AT TIME ZONE 'Asia/Kolkata')::date), (now() AT TIME ZONE 'Asia/Kolkata')::date - 365);
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 14), 1), 60);
  v_from timestamptz;
  v_to timestamptz;
BEGIN
  PERFORM app_private.require_access('activity', 'view');
  v_from := v_day::timestamp AT TIME ZONE 'Asia/Kolkata';
  v_to := (v_day + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  RETURN jsonb_build_object(
    'today', v_today,
    'day', v_day,
    'summary', app_private.traffic_summary(),
    'live', (
      SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'last_seen_at') DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('profile_id', p.id, 'name', COALESCE(NULLIF(btrim(p.full_name), ''), '(no name yet)'), 'role', p.role::text, 'phone', p.phone, 'email', p.email,
                                  'last_seen_at', a.last_seen_at, 'source', a.source) AS x
          FROM public.user_activity_days a JOIN public.profiles p ON p.id = a.profile_id
         WHERE a.last_seen_at > now() - interval '5 minutes' AND p.archived_at IS NULL
         ORDER BY a.last_seen_at DESC LIMIT 200) q),
    'people', (
      SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'last_seen_at') DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('profile_id', p.id, 'name', COALESCE(NULLIF(btrim(p.full_name), ''), '(no name yet)'), 'role', p.role::text, 'phone', p.phone, 'email', p.email,
                                  'first_seen_at', a.first_seen_at, 'last_seen_at', a.last_seen_at, 'source', a.source,
                                  'sign_ins', (SELECT count(*) FROM public.sign_in_events e WHERE e.profile_id = p.id AND e.created_at >= v_from AND e.created_at < v_to)) AS x
          FROM public.user_activity_days a JOIN public.profiles p ON p.id = a.profile_id
         WHERE a.day = v_day AND p.archived_at IS NULL
         ORDER BY a.last_seen_at DESC LIMIT 500) q),
    'sign_ins', (
      SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'at') DESC), '[]'::jsonb) FROM (
        SELECT jsonb_build_object('profile_id', p.id, 'name', COALESCE(NULLIF(btrim(p.full_name), ''), '(no name yet)'), 'role', e.role, 'phone', p.phone, 'email', p.email,
                                  'method', e.method, 'source', e.source, 'at', e.created_at) AS x
          FROM public.sign_in_events e JOIN public.profiles p ON p.id = e.profile_id
         WHERE e.created_at >= v_from AND e.created_at < v_to
         ORDER BY e.created_at DESC LIMIT 500) q),
    'days', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'date', d.d,
               'customers_active', (SELECT count(*) FROM public.user_activity_days a JOIN public.profiles p ON p.id = a.profile_id WHERE a.day = d.d AND p.role = 'customer'),
               'customers_signed_in', (SELECT count(DISTINCT e.profile_id) FROM public.sign_in_events e
                                        WHERE e.role = 'customer' AND e.created_at >= d.d::timestamp AT TIME ZONE 'Asia/Kolkata' AND e.created_at < (d.d + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'),
               'team_active', (SELECT count(*) FROM public.user_activity_days a JOIN public.profiles p ON p.id = a.profile_id WHERE a.day = d.d AND p.role <> 'customer')
             ) ORDER BY d.d), '[]'::jsonb)
        FROM (SELECT g::date AS d FROM generate_series(v_today - (v_days - 1), v_today, interval '1 day') g) d)
  );
END $$;
REVOKE ALL ON FUNCTION public.admin_traffic(date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_traffic(date, integer) TO authenticated; -- the role check is inside
