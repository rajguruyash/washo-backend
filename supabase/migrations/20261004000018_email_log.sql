-- 20261004000018_email_log.sql
-- SAFE / additive and re-runnable. Remembers which emails WASHO has sent, so that each goes out ONCE:
--   * free_wash_confirmation     one per free wash (ref = the booking)
--   * membership_renewal_reminder one per membership (ref = the membership), a week before it ends
--
-- The website server sends the mail (Resend) and uses these functions around it: svc_claim_email() takes the right to send (and says no if it was
-- already sent, or is being sent right now), svc_finish_email() records the result. A send that failed is tried again later, up to 3 times.
-- svc_membership_reminders_due() lists the memberships that need a reminder: active, ending within the next days, with an email address, whose
-- customer has not already renewed (another active membership for the same vehicle that ends later) and has not already been reminded.
--
-- Nothing here changes an existing row. The functions can be called by the service role and the website's database role only.

CREATE TABLE IF NOT EXISTS public.email_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  ref_id uuid NOT NULL,
  to_email text NOT NULL,
  status text NOT NULL DEFAULT 'sending',
  attempts integer NOT NULL DEFAULT 1,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_log_kind_check CHECK (kind ~ '^[a-z_]{3,60}$'),
  CONSTRAINT email_log_status_check CHECK (status IN ('sending', 'sent', 'failed', 'skipped'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_log_kind_ref ON public.email_log (kind, ref_id);

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS email_log_admin_read ON public.email_log;
CREATE POLICY email_log_admin_read ON public.email_log FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.email_log FROM anon, authenticated;
GRANT SELECT ON public.email_log TO authenticated; -- RLS: admins only

-- The right to send one email. Returns the log id, or NULL when it must not be sent (already sent, being sent, or given up after 3 tries).
CREATE OR REPLACE FUNCTION public.svc_claim_email(p_kind text, p_ref uuid, p_to text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.email_log (kind, ref_id, to_email) VALUES (p_kind, p_ref, lower(btrim(p_to)))
  ON CONFLICT (kind, ref_id) DO UPDATE
     SET status = 'sending', attempts = public.email_log.attempts + 1, to_email = EXCLUDED.to_email, error = NULL, updated_at = now()
   WHERE public.email_log.attempts < 3
     AND (public.email_log.status = 'failed' OR (public.email_log.status = 'sending' AND public.email_log.updated_at < now() - interval '15 minutes'))
  RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.svc_finish_email(p_id uuid, p_ok boolean, p_error text DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.email_log
     SET status = CASE WHEN p_ok THEN 'sent' ELSE 'failed' END,
         sent_at = CASE WHEN p_ok THEN now() ELSE sent_at END,
         error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 300) END,
         updated_at = now()
   WHERE id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.svc_membership_reminders_due(p_within_days integer DEFAULT 7, p_limit integer DEFAULT 50)
RETURNS TABLE (
  membership_id uuid, customer_profile_id uuid, full_name text, email text,
  vehicle_model text, vehicle_type text, registration_number text,
  end_date date, ends_in_days integer, frequency_per_week integer, duration_months integer,
  washes_total integer, washes_done integer
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, m.customer_profile_id, p.full_name, COALESCE(NULLIF(btrim(p.email), ''), u.email)::text,
         v.model, v.vehicle_type::text, v.registration_number,
         (m.end_at AT TIME ZONE 'Asia/Kolkata')::date,
         ((m.end_at AT TIME ZONE 'Asia/Kolkata')::date - (now() AT TIME ZONE 'Asia/Kolkata')::date)::integer,
         r.frequency_per_week::integer, m.duration_months::integer,
         (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled')::integer,
         (SELECT count(*) FROM public.bookings b WHERE b.membership_id = m.id AND b.status = 'completed')::integer
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

REVOKE ALL ON FUNCTION public.svc_claim_email(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.svc_finish_email(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.svc_membership_reminders_due(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_claim_email(text, uuid, text) TO service_role, washo_api;
GRANT EXECUTE ON FUNCTION public.svc_finish_email(uuid, boolean, text) TO service_role, washo_api;
GRANT EXECUTE ON FUNCTION public.svc_membership_reminders_due(integer, integer) TO service_role, washo_api;
