-- 20261004000029_membership_renewal_stages.sql
-- SAFE / additive and re-runnable. Renewal emails for memberships that are about to end (or have just ended), in three steps instead of one:
--
--   membership_renewal_reminder    a week before the last day            (ends in 1 to 7 days; this is the one that has always existed)
--   membership_renewal_last_call   the last days                          (ends in 0 to 2 days, and only for someone whose first reminder went out at least 2 days ago)
--   membership_renewal_ended       once it is over                        (ended 1 to 3 days ago, not renewed)
--
-- Each is sent ONCE per membership (email_log remembers), never to someone who has already renewed (another active membership for the same vehicle that
-- runs past this one), never to an archived customer, and never to a customer with no email address. A membership never gets two renewal emails within 24 hours.
-- A plan's last day is the day its washes stop: "ends in 0 days" is the last day itself.
--
-- svc_membership_renewals_due(kind, from_days, to_days, requires_kind, requires_days, limit) lists who is due for a given step. The older
-- svc_membership_reminders_due() is left as it was (the first step only). Only the service role and the website's database role can call either.

CREATE OR REPLACE FUNCTION public.svc_membership_renewals_due(
  p_kind text, p_from_days integer, p_to_days integer, p_requires_kind text DEFAULT NULL, p_requires_days integer DEFAULT 0, p_limit integer DEFAULT 50
)
RETURNS TABLE (
  membership_id uuid, customer_profile_id uuid, full_name text, email text,
  vehicle_model text, vehicle_type text, registration_number text,
  end_date date, ends_in_days integer, frequency_per_week integer, duration_months integer,
  washes_total integer, washes_done integer, washes_per_month integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF p_kind NOT IN ('membership_renewal_reminder', 'membership_renewal_last_call', 'membership_renewal_ended') THEN RAISE EXCEPTION 'Unknown renewal email'; END IF;
  IF p_requires_kind IS NOT NULL AND p_requires_kind NOT IN ('membership_renewal_reminder', 'membership_renewal_last_call') THEN RAISE EXCEPTION 'Unknown renewal email'; END IF;
  RETURN QUERY
  SELECT m.id, m.customer_profile_id, p.full_name, COALESCE(NULLIF(btrim(p.email), ''), u.email)::text,
         v.model, v.vehicle_type::text, v.registration_number,
         (m.end_at AT TIME ZONE 'Asia/Kolkata')::date,
         ((m.end_at AT TIME ZONE 'Asia/Kolkata')::date - v_today)::integer,
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
   WHERE m.status IN ('active', 'expired')
     AND (m.end_at AT TIME ZONE 'Asia/Kolkata')::date - v_today BETWEEN p_from_days AND p_to_days
     AND COALESCE(NULLIF(btrim(p.email), ''), u.email) IS NOT NULL
     -- not already sent (or being sent, or given up on) for this step
     AND NOT EXISTS (SELECT 1 FROM public.email_log l
                      WHERE l.kind = p_kind AND l.ref_id = m.id
                        AND (l.status IN ('sent', 'skipped') OR l.attempts >= 3 OR (l.status = 'sending' AND l.updated_at > now() - interval '15 minutes')))
     -- never two renewal emails for one membership within a day
     AND NOT EXISTS (SELECT 1 FROM public.email_log l
                      WHERE l.ref_id = m.id AND l.kind IN ('membership_renewal_reminder', 'membership_renewal_last_call', 'membership_renewal_ended')
                        AND l.status = 'sent' AND l.sent_at > now() - interval '24 hours')
     -- a later step only follows an earlier one that went out long enough ago
     AND (p_requires_kind IS NULL OR EXISTS (SELECT 1 FROM public.email_log l
                                              WHERE l.kind = p_requires_kind AND l.ref_id = m.id AND l.status = 'sent'
                                                AND l.sent_at <= now() - make_interval(days => GREATEST(p_requires_days, 0))))
     -- already renewed: another active membership for the same vehicle that runs past this one
     AND NOT EXISTS (SELECT 1 FROM public.memberships m2 JOIN public.membership_services ms2 ON ms2.membership_id = m2.id
                      WHERE m2.id <> m.id AND m2.customer_profile_id = m.customer_profile_id AND m2.status = 'active'
                        AND ms2.vehicle_id = mv.vehicle_id AND m2.end_at > m.end_at)
   ORDER BY m.end_at
   LIMIT LEAST(GREATEST(p_limit, 1), 200);
END $$;

REVOKE ALL ON FUNCTION public.svc_membership_renewals_due(text, integer, integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_membership_renewals_due(text, integer, integer, text, integer, integer) TO service_role, washo_api;
