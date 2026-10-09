-- 20261004000030_renewal_email_controls.sql
-- SAFE / additive and re-runnable. The admin page controls the renewal emails (migration 29): switch them off or on, switch each of the three steps off or on,
-- say how many days before the end (or after it) each goes out, and set the hours of the day the automatic job may send. Plus a view of who is coming up
-- and what each customer has been sent.
--
--   app_settings 'renewal_emails'        the settings (a row in the table migration 27 made); the defaults are exactly what the emails always did
--   svc_renewal_settings()               what the automatic job reads (service role and the website's database role only)
--   admin_get_renewal_settings()         the same for the Admin page (needs the Memberships area)
--   admin_set_renewal_settings(jsonb)    saves them, checked and audited (needs to MANAGE the Memberships area: Operations and the super admin)
--   admin_renewals_overview()            who ends soon (or just ended) with what each of the three emails did, and the latest emails sent
--   admin_renewal_row(uuid)              one membership in the shape the email needs, for "send it now"
-- The switch for the automatic job does not stop an admin pressing "Send now"; a step that is switched off is never sent, automatically or by hand.

INSERT INTO public.app_settings (key, value) VALUES
  ('renewal_emails', '{"on": true, "week": {"on": true, "days": 7}, "last": {"on": true, "days": 2}, "ended": {"on": true, "days": 3}, "from_hour": 9, "to_hour": 20}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- The settings with every missing part filled in from the defaults, so a half-written row can never break the job.
CREATE OR REPLACE FUNCTION app_private.renewal_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'on', COALESCE((v ->> 'on')::boolean, true),
    'week', jsonb_build_object('on', COALESCE((v #>> '{week,on}')::boolean, true), 'days', COALESCE((v #>> '{week,days}')::integer, 7)),
    'last', jsonb_build_object('on', COALESCE((v #>> '{last,on}')::boolean, true), 'days', COALESCE((v #>> '{last,days}')::integer, 2)),
    'ended', jsonb_build_object('on', COALESCE((v #>> '{ended,on}')::boolean, true), 'days', COALESCE((v #>> '{ended,days}')::integer, 3)),
    'from_hour', COALESCE((v ->> 'from_hour')::integer, 9),
    'to_hour', COALESCE((v ->> 'to_hour')::integer, 20))
  FROM (SELECT (SELECT value FROM public.app_settings WHERE key = 'renewal_emails') AS v) x
$$;
REVOKE ALL ON FUNCTION app_private.renewal_settings() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.svc_renewal_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT app_private.renewal_settings() $$;
REVOKE ALL ON FUNCTION public.svc_renewal_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_renewal_settings() TO service_role, washo_api;

CREATE OR REPLACE FUNCTION public.admin_get_renewal_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('memberships', 'view');
  RETURN app_private.renewal_settings();
END $$;
REVOKE ALL ON FUNCTION public.admin_get_renewal_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_renewal_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_renewal_settings(p_settings jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('memberships', 'manage');
  v_old jsonb := app_private.renewal_settings();
  v_new jsonb;
  s text;
  d integer;
  v_lo integer; v_hi integer;
BEGIN
  IF p_settings IS NULL OR jsonb_typeof(p_settings) <> 'object' THEN RAISE EXCEPTION 'Send the renewal email settings'; END IF;
  IF jsonb_typeof(p_settings -> 'on') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Switch the automatic renewal emails on or off'; END IF;
  FOREACH s IN ARRAY ARRAY['week', 'last', 'ended'] LOOP
    IF jsonb_typeof(p_settings -> s -> 'on') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Switch the "%" email on or off', s; END IF;
    IF jsonb_typeof(p_settings -> s -> 'days') IS DISTINCT FROM 'number' OR (p_settings -> s ->> 'days') !~ '^[0-9]{1,2}$' THEN RAISE EXCEPTION 'Enter a whole number of days for the "%" email', s; END IF;
    d := (p_settings -> s ->> 'days')::integer;
    v_lo := CASE s WHEN 'last' THEN 0 ELSE 1 END;
    v_hi := CASE s WHEN 'week' THEN 14 WHEN 'last' THEN 7 ELSE 14 END;
    IF d NOT BETWEEN v_lo AND v_hi THEN RAISE EXCEPTION 'The "%" email can go out % to % days %', s, v_lo, v_hi, CASE s WHEN 'ended' THEN 'after the membership ended' ELSE 'before its last day' END; END IF;
  END LOOP;
  IF jsonb_typeof(p_settings -> 'from_hour') IS DISTINCT FROM 'number' OR jsonb_typeof(p_settings -> 'to_hour') IS DISTINCT FROM 'number'
     OR (p_settings ->> 'from_hour') !~ '^[0-9]{1,2}$' OR (p_settings ->> 'to_hour') !~ '^[0-9]{1,2}$' THEN
    RAISE EXCEPTION 'Enter the hours as whole numbers (0 to 24)';
  END IF;
  IF (p_settings ->> 'from_hour')::integer NOT BETWEEN 0 AND 23 OR (p_settings ->> 'to_hour')::integer NOT BETWEEN 1 AND 24
     OR (p_settings ->> 'from_hour')::integer >= (p_settings ->> 'to_hour')::integer THEN
    RAISE EXCEPTION 'The sending hours must start before they end (for example 9 to 20)';
  END IF;
  v_new := jsonb_build_object(
    'on', (p_settings ->> 'on')::boolean,
    'week', jsonb_build_object('on', (p_settings #>> '{week,on}')::boolean, 'days', (p_settings #>> '{week,days}')::integer),
    'last', jsonb_build_object('on', (p_settings #>> '{last,on}')::boolean, 'days', (p_settings #>> '{last,days}')::integer),
    'ended', jsonb_build_object('on', (p_settings #>> '{ended,on}')::boolean, 'days', (p_settings #>> '{ended,days}')::integer),
    'from_hour', (p_settings ->> 'from_hour')::integer, 'to_hour', (p_settings ->> 'to_hour')::integer);
  INSERT INTO public.app_settings (key, value, updated_by) VALUES ('renewal_emails', v_new, v_me)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = v_me, updated_at = now();
  PERFORM app_private.audit('setting', v_me, 'renewal_settings_changed', jsonb_build_object('from', v_old, 'to', v_new));
  RETURN v_new;
END $$;
REVOKE ALL ON FUNCTION public.admin_set_renewal_settings(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_renewal_settings(jsonb) TO authenticated;

-- Who ends soon (14 days ahead) or has just ended (7 days back), and what each of the three emails did for them; and the latest emails sent.
CREATE OR REPLACE FUNCTION public.admin_renewals_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  PERFORM app_private.require_access('memberships', 'view');
  RETURN jsonb_build_object(
    'upcoming', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x ->> 'end_date'), (x ->> 'customer_name')) FROM (
        SELECT jsonb_build_object(
                 'membership_id', m.id, 'reference_code', r.reference_code, 'customer_name', p.full_name, 'customer_phone', p.phone,
                 'email', COALESCE(NULLIF(btrim(p.email), ''), u.email), 'vehicle_model', v.model, 'registration_number', v.registration_number,
                 'end_date', (m.end_at AT TIME ZONE 'Asia/Kolkata')::date, 'days_left', ((m.end_at AT TIME ZONE 'Asia/Kolkata')::date - v_today),
                 'plan_washes_a_month', r.monthly_body + r.monthly_deep, 'plan_washes_a_week', r.frequency_per_week, 'duration_months', m.duration_months,
                 'renewed', EXISTS (SELECT 1 FROM public.memberships m2 JOIN public.membership_services ms2 ON ms2.membership_id = m2.id
                                     WHERE m2.id <> m.id AND m2.customer_profile_id = m.customer_profile_id AND m2.status = 'active'
                                       AND ms2.vehicle_id = mv.vehicle_id AND m2.end_at > m.end_at),
                 'steps', jsonb_build_object(
                   'week', (SELECT jsonb_build_object('status', l.status, 'at', COALESCE(l.sent_at, l.updated_at), 'attempts', l.attempts, 'error', l.error)
                              FROM public.email_log l WHERE l.kind = 'membership_renewal_reminder' AND l.ref_id = m.id),
                   'last', (SELECT jsonb_build_object('status', l.status, 'at', COALESCE(l.sent_at, l.updated_at), 'attempts', l.attempts, 'error', l.error)
                              FROM public.email_log l WHERE l.kind = 'membership_renewal_last_call' AND l.ref_id = m.id),
                   'ended', (SELECT jsonb_build_object('status', l.status, 'at', COALESCE(l.sent_at, l.updated_at), 'attempts', l.attempts, 'error', l.error)
                               FROM public.email_log l WHERE l.kind = 'membership_renewal_ended' AND l.ref_id = m.id))) AS x
          FROM public.memberships m
          JOIN public.profiles p ON p.id = m.customer_profile_id AND p.role = 'customer'
          LEFT JOIN auth.users u ON u.id = p.auth_user_id
          LEFT JOIN public.membership_requests r ON r.membership_id = m.id
          LEFT JOIN LATERAL (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1) mv ON true
          LEFT JOIN public.vehicles v ON v.id = mv.vehicle_id
         WHERE m.status IN ('active', 'expired')
           AND (m.end_at AT TIME ZONE 'Asia/Kolkata')::date - v_today BETWEEN -7 AND 14
         LIMIT 150) q), '[]'::jsonb),
    'recent', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x ->> 'at') DESC) FROM (
        SELECT jsonb_build_object(
                 'id', l.id, 'kind', l.kind, 'membership_id', l.ref_id, 'reference_code', r.reference_code, 'customer_name', p.full_name, 'to_email', l.to_email,
                 'status', l.status, 'attempts', l.attempts, 'error', l.error, 'at', COALESCE(l.sent_at, l.updated_at)) AS x
          FROM public.email_log l
          LEFT JOIN public.memberships m ON m.id = l.ref_id
          LEFT JOIN public.membership_requests r ON r.membership_id = m.id
          LEFT JOIN public.profiles p ON p.id = m.customer_profile_id
         WHERE l.kind IN ('membership_renewal_reminder', 'membership_renewal_last_call', 'membership_renewal_ended')
         ORDER BY COALESCE(l.sent_at, l.updated_at) DESC
         LIMIT 30) q), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.admin_renewals_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_renewals_overview() TO authenticated;

-- One membership in the shape the renewal email needs (for "send it now"). Any active or expired membership, whatever the dates.
CREATE OR REPLACE FUNCTION public.admin_renewal_row(p_membership_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_row jsonb;
BEGIN
  PERFORM app_private.require_access('memberships', 'manage');
  SELECT jsonb_build_object(
           'membership_id', m.id, 'full_name', p.full_name, 'email', COALESCE(NULLIF(btrim(p.email), ''), u.email),
           'vehicle_model', v.model, 'registration_number', v.registration_number,
           'end_date', (m.end_at AT TIME ZONE 'Asia/Kolkata')::date, 'ends_in_days', ((m.end_at AT TIME ZONE 'Asia/Kolkata')::date - v_today),
           'frequency_per_week', r.frequency_per_week, 'washes_per_month', r.monthly_body + r.monthly_deep, 'duration_months', m.duration_months,
           'washes_total', (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled'),
           'washes_done', (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status = 'completed'))
    INTO v_row
    FROM public.memberships m
    JOIN public.profiles p ON p.id = m.customer_profile_id AND p.role = 'customer'
    LEFT JOIN auth.users u ON u.id = p.auth_user_id
    LEFT JOIN public.membership_requests r ON r.membership_id = m.id
    LEFT JOIN LATERAL (SELECT ms.vehicle_id FROM public.membership_services ms WHERE ms.membership_id = m.id LIMIT 1) mv ON true
    LEFT JOIN public.vehicles v ON v.id = mv.vehicle_id
   WHERE m.id = p_membership_id AND m.status IN ('active', 'expired');
  IF v_row IS NULL THEN RAISE EXCEPTION 'Membership not found'; END IF;
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.admin_renewal_row(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_renewal_row(uuid) TO authenticated;
