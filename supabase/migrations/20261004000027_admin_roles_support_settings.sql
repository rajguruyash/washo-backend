-- 20261004000027_admin_roles_support_settings.sql
-- SAFE / additive and re-runnable. The back-office a real business needs around the money:
--
--   admin roles           WHO may do WHAT. Five roles (super_admin, operations, finance, marketing, support) and a table of areas each may
--                         view or manage (admin_role_areas, DATA, so it can be changed without a deploy). profiles.role stays 'admin' for all
--                         of them (the mobile app only knows customer/worker/admin); the finer role lives in admin_access.
--                         The owner (rajguruyash29@gmail.com) is seeded as super_admin. Every admin who already exists and is not the owner
--                         becomes 'operations' (the safest role that still lets them work).
--   support / complaints  a customer raises a complaint (optionally about a wash), WASHO answers in a thread; statuses open / in progress /
--                         resolved / closed. Customers only ever see their own; admins with the support role see all.
--   app settings          maintenance mode (+ the message customers see) and the size of a refund that only the super admin may approve.
--   activity log          a readable view of audit_events (who changed what, when) for the super admin.
--   dashboard numbers     new customers, paid orders, money collected / refunded, failed or unconfirmed payments, open complaints.
--   data export           admin_export(kind, from, to): customers, washes, memberships, payments, refunds, complaints, activity. Each export needs its
--                         own permission, is capped, and writes an audit event.
--   safe refunds          the four refund functions now also require the 'payments' permission, and a refund at or above the threshold needs
--                         the super admin. (Direct calls to the database are held to this too, not only the website.)
--
-- Rules the database enforces (not just the screens): see app_private.require_access(). Nothing here deletes data; people are deactivated, never removed.

-- ───────────────────────── roles ─────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_access (
  profile_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  access text NOT NULL CHECK (access IN ('super_admin', 'operations', 'finance', 'marketing', 'support')),
  granted_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.admin_role_areas (
  access text NOT NULL CHECK (access IN ('super_admin', 'operations', 'finance', 'marketing', 'support')),
  area text NOT NULL,
  level text NOT NULL CHECK (level IN ('view', 'manage')),
  PRIMARY KEY (access, area)
);
ALTER TABLE public.admin_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_role_areas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_access, public.admin_role_areas FROM PUBLIC, anon, authenticated;

-- What each role may do. 'manage' includes 'view'. Areas: overview requests bookings memberships people services campaigns capacity payments
-- history support activity settings team, and one export_* area per kind of export.
INSERT INTO public.admin_role_areas (access, area, level)
SELECT 'super_admin', a, 'manage' FROM unnest(ARRAY[
  'overview','requests','bookings','memberships','people','services','campaigns','capacity','payments','history','support','activity','settings','team',
  'export_customers','export_washes','export_memberships','export_payments','export_refunds','export_support','export_activity']) a
ON CONFLICT DO NOTHING;
INSERT INTO public.admin_role_areas (access, area, level) VALUES
  -- Operations: people, washes, content (services, campaigns, capacity). Not refunds, settings or admin accounts.
  ('operations','overview','view'), ('operations','requests','manage'), ('operations','bookings','manage'), ('operations','memberships','manage'),
  ('operations','people','manage'), ('operations','services','manage'), ('operations','campaigns','manage'), ('operations','capacity','manage'),
  ('operations','history','view'),
  ('operations','export_customers','manage'), ('operations','export_washes','manage'), ('operations','export_memberships','manage'),
  -- Finance: payments, refunds, reports. Cannot edit content or block people.
  ('finance','overview','view'), ('finance','bookings','view'), ('finance','memberships','view'), ('finance','payments','manage'), ('finance','history','view'),
  ('finance','export_memberships','manage'), ('finance','export_payments','manage'), ('finance','export_refunds','manage'),
  -- Marketing: campaigns only. No payments, no customer data export.
  ('marketing','overview','view'), ('marketing','campaigns','manage'),
  -- Support: look at people and washes, answer complaints. No refunds, nothing is deleted.
  ('support','overview','view'), ('support','bookings','view'), ('support','memberships','view'), ('support','people','view'), ('support','support','manage'),
  ('support','export_support','manage')
ON CONFLICT DO NOTHING;

-- The owner is the super admin; any other admin that already exists keeps working as 'operations'.
INSERT INTO public.admin_access (profile_id, access)
SELECT p.id, CASE WHEN lower(u.email) = 'rajguruyash29@gmail.com' THEN 'super_admin' ELSE 'operations' END
  FROM public.profiles p JOIN auth.users u ON u.id = p.auth_user_id
 WHERE p.role = 'admin'
ON CONFLICT (profile_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.my_access() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT aa.access FROM public.admin_access aa WHERE aa.profile_id = public.current_profile_id() AND public.is_admin()
$$;
REVOKE ALL ON FUNCTION app_private.my_access() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.can(p_area text, p_level text DEFAULT 'view') RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_role_areas ra
     WHERE ra.access = app_private.my_access() AND ra.area = p_area AND (ra.level = 'manage' OR p_level = 'view')
  )
$$;
REVOKE ALL ON FUNCTION app_private.can(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.require_access(p_area text, p_level text DEFAULT 'view') RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF NOT app_private.can(p_area, p_level) THEN RAISE EXCEPTION 'Unauthorized: your admin role cannot do this' USING ERRCODE = '42501'; END IF;
  RETURN public.current_profile_id();
END $$;
REVOKE ALL ON FUNCTION app_private.require_access(text, text) FROM PUBLIC, anon, authenticated;

-- What the signed-in admin may do: { access, areas: { area: 'view' | 'manage' } }, or NULL for anyone who is not an admin with a role.
CREATE OR REPLACE FUNCTION public.my_admin_access() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN app_private.my_access() IS NULL THEN NULL ELSE jsonb_build_object(
    'access', app_private.my_access(),
    'areas', (SELECT COALESCE(jsonb_object_agg(ra.area, ra.level), '{}'::jsonb) FROM public.admin_role_areas ra WHERE ra.access = app_private.my_access())
  ) END
$$;
REVOKE ALL ON FUNCTION public.my_admin_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_admin_access() TO authenticated;

-- ───────────────────────── the team ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_team() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('team', 'view');
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', p.id, 'full_name', p.full_name, 'email', u.email, 'access', aa.access, 'archived', p.archived_at IS NOT NULL,
             'created_at', p.created_at, 'last_sign_in_at', u.last_sign_in_at) ORDER BY (aa.access = 'super_admin') DESC NULLS LAST, p.created_at), '[]'::jsonb)
      FROM public.profiles p
      LEFT JOIN public.admin_access aa ON aa.profile_id = p.id
      LEFT JOIN auth.users u ON u.id = p.auth_user_id
     WHERE p.role = 'admin');
END $$;
REVOKE ALL ON FUNCTION public.admin_team() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_team() TO authenticated;

-- Changes another admin's role. The super admin cannot be changed (or made, here), and nobody changes their own.
CREATE OR REPLACE FUNCTION public.admin_set_access(p_profile_id uuid, p_access text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('team', 'manage');
  v_p public.profiles%ROWTYPE;
  v_old text;
BEGIN
  IF p_access NOT IN ('operations', 'finance', 'marketing', 'support') THEN RAISE EXCEPTION 'Choose a role: Operations, Finance, Marketing or Support'; END IF;
  IF p_profile_id = v_me THEN RAISE EXCEPTION 'You cannot change your own role'; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = p_profile_id AND role = 'admin' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Admin not found'; END IF;
  SELECT access INTO v_old FROM public.admin_access WHERE profile_id = p_profile_id;
  IF v_old = 'super_admin' THEN RAISE EXCEPTION 'The super admin''s role cannot be changed'; END IF;
  INSERT INTO public.admin_access (profile_id, access, granted_by) VALUES (p_profile_id, p_access, v_me)
  ON CONFLICT (profile_id) DO UPDATE SET access = EXCLUDED.access, granted_by = v_me, updated_at = now();
  PERFORM app_private.audit('profile', p_profile_id, 'admin_role_changed', jsonb_build_object('from', v_old, 'to', p_access));
  RETURN jsonb_build_object('profile_id', p_profile_id, 'access', p_access);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_access(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_access(uuid, text) TO authenticated;

-- Makes a brand-new login (the website has just created it with an email and password) an admin account. Only a login with no history of any kind
-- and created in the last few minutes can be promoted: an existing customer can never be turned into an admin this way.
CREATE OR REPLACE FUNCTION public.admin_promote_to_admin(p_auth_user_id uuid, p_full_name text, p_access text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('team', 'manage');
  v_p public.profiles%ROWTYPE;
  v_name text := trim(COALESCE(p_full_name, ''));
BEGIN
  IF p_access NOT IN ('operations', 'finance', 'marketing', 'support') THEN RAISE EXCEPTION 'Choose a role: Operations, Finance, Marketing or Support'; END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN RAISE EXCEPTION 'Enter their full name'; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE auth_user_id = p_auth_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Person not found'; END IF;
  IF v_p.role <> 'customer' THEN RAISE EXCEPTION 'That login already belongs to a % account', v_p.role; END IF;
  IF v_p.created_at < now() - interval '15 minutes'
     OR EXISTS (SELECT 1 FROM public.bookings WHERE customer_profile_id = v_p.id)
     OR EXISTS (SELECT 1 FROM public.memberships WHERE customer_profile_id = v_p.id)
     OR EXISTS (SELECT 1 FROM public.payments WHERE customer_profile_id = v_p.id)
     OR EXISTS (SELECT 1 FROM public.vehicles WHERE customer_profile_id = v_p.id) THEN
    RAISE EXCEPTION 'That email already belongs to a customer, so it cannot be made an admin account. Use a different email.';
  END IF;
  PERFORM set_config('washo.allow_role_change', 'on', true);
  UPDATE public.profiles SET role = 'admin', full_name = v_name, updated_at = now() WHERE id = v_p.id;
  INSERT INTO public.admin_access (profile_id, access, granted_by) VALUES (v_p.id, p_access, v_me)
  ON CONFLICT (profile_id) DO UPDATE SET access = EXCLUDED.access, granted_by = v_me, updated_at = now();
  PERFORM app_private.audit('profile', v_p.id, 'admin_account_created', jsonb_build_object('access', p_access, 'full_name', v_name));
  RETURN jsonb_build_object('profile_id', v_p.id, 'access', p_access);
END $$;
REVOKE ALL ON FUNCTION public.admin_promote_to_admin(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_promote_to_admin(uuid, text, text) TO authenticated;

-- Switches an admin account off (or back on). The website also locks the login at Supabase. Not for yourself, not for the super admin.
CREATE OR REPLACE FUNCTION public.admin_set_admin_active(p_profile_id uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('team', 'manage');
  v_p public.profiles%ROWTYPE;
BEGIN
  IF p_profile_id = v_me THEN RAISE EXCEPTION 'You cannot switch off your own account'; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = p_profile_id AND role = 'admin' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Admin not found'; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_access WHERE profile_id = p_profile_id AND access = 'super_admin') THEN RAISE EXCEPTION 'The super admin cannot be switched off'; END IF;
  UPDATE public.profiles SET archived_at = CASE WHEN p_active THEN NULL ELSE COALESCE(archived_at, now()) END, updated_at = now() WHERE id = p_profile_id;
  PERFORM app_private.audit('profile', p_profile_id, CASE WHEN p_active THEN 'admin_account_restored' ELSE 'admin_account_switched_off' END, '{}'::jsonb);
  RETURN jsonb_build_object('profile_id', p_profile_id, 'active', p_active, 'auth_user_id', v_p.auth_user_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_admin_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_admin_active(uuid, boolean) TO authenticated;

-- ───────────────────────── app settings ─────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_settings FROM PUBLIC, anon, authenticated;
INSERT INTO public.app_settings (key, value) VALUES
  ('maintenance_mode', 'false'::jsonb),
  ('maintenance_message', to_jsonb('We are making WASHO better. Booking and payments are paused for a little while. Please check back soon.'::text)),
  ('big_refund_threshold_cents', '100000'::jsonb) -- Rs 1,000: a refund this size or more needs the super admin
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.big_refund_threshold() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::integer FROM public.app_settings WHERE key = 'big_refund_threshold_cents'), 100000)
$$;
REVOKE ALL ON FUNCTION app_private.big_refund_threshold() FROM PUBLIC, anon, authenticated;

-- What anyone (even a visitor) may know: is the site paused for maintenance, and what to tell them.
CREATE OR REPLACE FUNCTION public.get_public_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'maintenance_mode', COALESCE((SELECT value = 'true'::jsonb FROM public.app_settings WHERE key = 'maintenance_mode'), false),
    'maintenance_message', COALESCE((SELECT value #>> '{}' FROM public.app_settings WHERE key = 'maintenance_message'), ''))
$$;
REVOKE ALL ON FUNCTION public.get_public_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_settings() TO anon, authenticated, washo_api;

CREATE OR REPLACE FUNCTION public.admin_get_settings() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('settings', 'view');
  RETURN (SELECT COALESCE(jsonb_object_agg(s.key, s.value), '{}'::jsonb) FROM public.app_settings s);
END $$;
REVOKE ALL ON FUNCTION public.admin_get_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_setting(p_key text, p_value jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('settings', 'manage');
  v_old jsonb;
  v_new jsonb := p_value;
BEGIN
  IF p_key = 'maintenance_mode' THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN RAISE EXCEPTION 'Maintenance mode is on or off'; END IF;
  ELSIF p_key = 'maintenance_message' THEN
    IF jsonb_typeof(p_value) <> 'string' OR char_length(trim(p_value #>> '{}')) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Write a message of 3 to 200 characters'; END IF;
    v_new := to_jsonb(trim(p_value #>> '{}'));
  ELSIF p_key = 'big_refund_threshold_cents' THEN
    IF jsonb_typeof(p_value) <> 'number' OR (p_value #>> '{}') !~ '^[0-9]{1,8}$' THEN RAISE EXCEPTION 'Enter a whole number of rupees (0 or more)'; END IF;
  ELSE
    RAISE EXCEPTION 'Unknown setting';
  END IF;
  SELECT value INTO v_old FROM public.app_settings WHERE key = p_key;
  INSERT INTO public.app_settings (key, value, updated_by) VALUES (p_key, v_new, v_me)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = v_me, updated_at = now();
  PERFORM app_private.audit('setting', v_me, 'setting_changed', jsonb_build_object('key', p_key, 'from', v_old, 'to', v_new));
  RETURN jsonb_build_object('key', p_key, 'value', v_new);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_setting(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_setting(text, jsonb) TO authenticated;

-- ───────────────────────── safe refunds ─────────────────────────
-- The refund functions (migration 12) with two additions: the caller needs the 'payments' permission, and a refund at or above the threshold
-- needs the super admin. Everything else is exactly as it was.
CREATE OR REPLACE FUNCTION app_private.require_refund_rights(p_amount_cents integer) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('payments', 'manage');
  IF p_amount_cents >= app_private.big_refund_threshold() AND NOT app_private.can('settings', 'manage') THEN
    RAISE EXCEPTION 'Unauthorized: a refund of Rs % or more needs the super admin', (app_private.big_refund_threshold() / 100) USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_private.require_refund_rights(integer) FROM PUBLIC, anon, authenticated;

-- What the Needs-attention page needs to know: how big is "big", and may THIS admin approve one.
CREATE OR REPLACE FUNCTION public.admin_refund_policy() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('payments', 'view');
  RETURN jsonb_build_object('threshold_cents', app_private.big_refund_threshold(), 'can_approve_big', app_private.can('settings', 'manage'));
END $$;
REVOKE ALL ON FUNCTION public.admin_refund_policy() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_refund_policy() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_begin_refund(p_refund_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r public.refunds%ROWTYPE;
  v_pay public.payments%ROWTYPE;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_r FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  PERFORM app_private.require_refund_rights(v_r.amount_cents);
  IF v_r.status IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_r.status; END IF;
  IF v_r.status = 'approved' AND v_r.approved_at IS NOT NULL AND v_r.approved_at > now() - interval '2 minutes' THEN
    RAISE EXCEPTION 'This refund is already being paid out. Check again in a minute.';
  END IF;
  SELECT * INTO v_pay FROM public.payments WHERE id = v_r.payment_id;
  IF v_pay.provider IS DISTINCT FROM 'razorpay' OR v_pay.provider_payment_id IS NULL OR v_pay.status NOT IN ('paid', 'partially_refunded') THEN
    RAISE EXCEPTION 'This payment has no captured Razorpay payment to refund. Record the refund by hand instead.';
  END IF;

  UPDATE public.refunds SET status = 'approved', approved_at = now(), failure_reason = NULL, updated_at = now() WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_approved', jsonb_build_object('from', v_r.status, 'amount_cents', v_r.amount_cents));
  RETURN jsonb_build_object(
    'refund_id', v_r.id, 'amount_cents', v_r.amount_cents, 'currency', v_pay.currency,
    'provider_payment_id', v_pay.provider_payment_id, 'booking_id', v_r.booking_id
  );
END $$;
REVOKE ALL ON FUNCTION public.admin_begin_refund(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_begin_refund(uuid) TO authenticated; -- is_admin() and the role inside

CREATE OR REPLACE FUNCTION public.admin_finish_refund(p_refund_id uuid, p_provider_refund_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r public.refunds%ROWTYPE;
  v_pay public.payments%ROWTYPE;
  v_done integer;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF p_provider_refund_id IS NULL OR char_length(trim(p_provider_refund_id)) < 4 THEN
    RAISE EXCEPTION 'Enter the Razorpay refund id so the payout can be traced';
  END IF;
  SELECT * INTO v_r FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  PERFORM app_private.require_refund_rights(v_r.amount_cents);
  IF v_r.status = 'processed' AND v_r.provider_refund_id = trim(p_provider_refund_id) THEN RETURN true; END IF; -- idempotent
  IF v_r.status IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_r.status; END IF;

  UPDATE public.refunds
     SET status = 'processed', provider_refund_id = trim(p_provider_refund_id), failure_reason = NULL, updated_at = now()
   WHERE id = p_refund_id;

  SELECT * INTO v_pay FROM public.payments WHERE id = v_r.payment_id FOR UPDATE;
  SELECT COALESCE(sum(amount_cents), 0) INTO v_done FROM public.refunds WHERE payment_id = v_r.payment_id AND status = 'processed';
  UPDATE public.payments
     SET status = CASE WHEN v_done >= v_pay.amount_cents THEN 'refunded'::public.payment_status ELSE 'partially_refunded'::public.payment_status END,
         updated_at = now()
   WHERE id = v_r.payment_id AND status IN ('paid', 'partially_refunded');

  IF v_r.booking_id IS NOT NULL THEN
    INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
    VALUES (v_r.booking_id, 'refunded', public.current_profile_id(),
            jsonb_build_object('refund_id', v_r.id, 'amount_cents', v_r.amount_cents, 'provider_refund_id', trim(p_provider_refund_id)));
  END IF;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_processed', jsonb_build_object('provider_refund_id', trim(p_provider_refund_id), 'amount_cents', v_r.amount_cents));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_finish_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_finish_refund(uuid, text) TO authenticated; -- is_admin() and the role inside

CREATE OR REPLACE FUNCTION public.admin_fail_refund(p_refund_id uuid, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.refund_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  PERFORM app_private.require_access('payments', 'manage');
  SELECT status INTO v_old FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_old IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_old; END IF;
  UPDATE public.refunds
     SET status = 'failed', failure_reason = left(COALESCE(NULLIF(trim(p_reason), ''), 'Razorpay did not accept the refund'), 300), updated_at = now()
   WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_failed', jsonb_build_object('from', v_old, 'reason', left(COALESCE(p_reason, ''), 300)));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_fail_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_fail_refund(uuid, text) TO authenticated; -- is_admin() and the role inside

CREATE OR REPLACE FUNCTION public.admin_resolve_refund(p_refund_id uuid, p_status public.refund_status, p_provider_refund_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.refund_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  PERFORM app_private.require_access('payments', 'manage');
  IF p_status NOT IN ('approved', 'processed', 'failed') THEN RAISE EXCEPTION 'A refund can be marked approved, processed or failed'; END IF;
  IF p_status = 'processed' THEN RETURN public.admin_finish_refund(p_refund_id, p_provider_refund_id); END IF;
  SELECT status INTO v_old FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_old IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_old; END IF;
  UPDATE public.refunds SET status = p_status, provider_refund_id = COALESCE(NULLIF(trim(p_provider_refund_id), ''), provider_refund_id), updated_at = now() WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_' || p_status::text, jsonb_build_object('from', v_old, 'provider_refund_id', p_provider_refund_id));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_resolve_refund(uuid, public.refund_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund(uuid, public.refund_status, text) TO authenticated; -- is_admin() and the role inside

-- ───────────────────────── support / complaints ─────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.support_ticket_seq;
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_code text NOT NULL UNIQUE DEFAULT ('SUP-' || lpad(nextval('public.support_ticket_seq')::text, 5, '0')),
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id),
  booking_id uuid REFERENCES public.bookings(id),
  category text NOT NULL CHECK (category IN ('payment', 'booking', 'specialist', 'refund', 'membership', 'other')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES public.profiles(id)
);
CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON public.support_tickets (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_customer_idx ON public.support_tickets (customer_profile_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  author_profile_id uuid NOT NULL REFERENCES public.profiles(id),
  from_admin boolean NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON public.support_messages (ticket_id, created_at);
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.support_tickets, public.support_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.support_ticket_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.require_customer() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me uuid := public.current_profile_id();
BEGIN
  IF v_me IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_me AND role = 'customer' AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Unauthorized: customer access required' USING ERRCODE = '42501';
  END IF;
  RETURN v_me;
END $$;
REVOKE ALL ON FUNCTION app_private.require_customer() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_support_ticket(p_category text, p_subject text, p_message text, p_booking_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_customer();
  v_subject text := trim(COALESCE(p_subject, ''));
  v_body text := trim(COALESCE(p_message, ''));
  v_id uuid;
  v_code text;
BEGIN
  IF p_category NOT IN ('payment', 'booking', 'specialist', 'refund', 'membership', 'other') THEN RAISE EXCEPTION 'Choose what this is about'; END IF;
  IF char_length(v_subject) < 3 OR char_length(v_subject) > 120 THEN RAISE EXCEPTION 'Give it a short title (3 to 120 characters)'; END IF;
  IF char_length(v_body) < 5 OR char_length(v_body) > 2000 THEN RAISE EXCEPTION 'Tell us what happened (5 to 2000 characters)'; END IF;
  IF p_booking_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id AND customer_profile_id = v_me) THEN
    RAISE EXCEPTION 'That wash is not yours';
  END IF;
  IF (SELECT count(*) FROM public.support_tickets WHERE customer_profile_id = v_me AND status IN ('open', 'in_progress')) >= 5 THEN
    RAISE EXCEPTION 'You already have 5 open complaints. We will get to them; add to one of those instead';
  END IF;
  INSERT INTO public.support_tickets (customer_profile_id, booking_id, category, subject) VALUES (v_me, p_booking_id, p_category, v_subject)
  RETURNING id, reference_code INTO v_id, v_code;
  INSERT INTO public.support_messages (ticket_id, author_profile_id, from_admin, body) VALUES (v_id, v_me, false, v_body);
  PERFORM app_private.audit('support_ticket', v_id, 'support_ticket_opened', jsonb_build_object('category', p_category, 'reference_code', v_code));
  RETURN jsonb_build_object('id', v_id, 'reference_code', v_code);
END $$;
REVOKE ALL ON FUNCTION public.create_support_ticket(text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(text, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_support_tickets() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me uuid := app_private.require_customer();
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', t.id, 'reference_code', t.reference_code, 'category', t.category, 'subject', t.subject, 'status', t.status,
             'created_at', t.created_at, 'updated_at', t.updated_at,
             'last_from_admin', (SELECT m.from_admin FROM public.support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1)) ORDER BY t.updated_at DESC), '[]'::jsonb)
      FROM public.support_tickets t WHERE t.customer_profile_id = v_me);
END $$;
REVOKE ALL ON FUNCTION public.my_support_tickets() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_support_tickets() TO authenticated;

CREATE OR REPLACE FUNCTION public.my_support_ticket(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_customer();
  v_t public.support_tickets%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_id AND customer_profile_id = v_me;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  RETURN jsonb_build_object(
    'ticket', jsonb_build_object('id', v_t.id, 'reference_code', v_t.reference_code, 'category', v_t.category, 'subject', v_t.subject, 'status', v_t.status,
                                 'created_at', v_t.created_at, 'booking_id', v_t.booking_id,
                                 'booking_reference', (SELECT b.reference_code FROM public.bookings b WHERE b.id = v_t.booking_id)),
    'messages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'from_admin', m.from_admin, 'body', m.body, 'created_at', m.created_at) ORDER BY m.created_at), '[]'::jsonb)
                   FROM public.support_messages m WHERE m.ticket_id = v_t.id));
END $$;
REVOKE ALL ON FUNCTION public.my_support_ticket(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_support_ticket(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reply_to_my_ticket(p_id uuid, p_message text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_customer();
  v_t public.support_tickets%ROWTYPE;
  v_body text := trim(COALESCE(p_message, ''));
BEGIN
  IF char_length(v_body) < 1 OR char_length(v_body) > 2000 THEN RAISE EXCEPTION 'Write your message (up to 2000 characters)'; END IF;
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_id AND customer_profile_id = v_me FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  IF v_t.status = 'closed' THEN RAISE EXCEPTION 'This complaint is closed. Please start a new one'; END IF;
  INSERT INTO public.support_messages (ticket_id, author_profile_id, from_admin, body) VALUES (p_id, v_me, false, v_body);
  UPDATE public.support_tickets SET status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END, updated_at = now() WHERE id = p_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reply_to_my_ticket(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reply_to_my_ticket(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_support_list(p_status text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('support', 'view');
  RETURN (
    SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'updated_at') DESC), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
               'id', t.id, 'reference_code', t.reference_code, 'category', t.category, 'subject', t.subject, 'status', t.status,
               'created_at', t.created_at, 'updated_at', t.updated_at, 'customer_name', p.full_name, 'customer_phone', p.phone,
               'booking_reference', (SELECT b.reference_code FROM public.bookings b WHERE b.id = t.booking_id),
               'messages', (SELECT count(*)::int FROM public.support_messages m WHERE m.ticket_id = t.id),
               'last_from_admin', (SELECT m.from_admin FROM public.support_messages m WHERE m.ticket_id = t.id ORDER BY m.created_at DESC LIMIT 1)) AS x
        FROM public.support_tickets t JOIN public.profiles p ON p.id = t.customer_profile_id
       WHERE p_status IS NULL OR p_status = 'all' OR t.status = p_status
       ORDER BY t.updated_at DESC LIMIT 200) q);
END $$;
REVOKE ALL ON FUNCTION public.admin_support_list(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_list(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_support_get(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t public.support_tickets%ROWTYPE;
BEGIN
  PERFORM app_private.require_access('support', 'view');
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  RETURN jsonb_build_object(
    'ticket', jsonb_build_object('id', v_t.id, 'reference_code', v_t.reference_code, 'category', v_t.category, 'subject', v_t.subject, 'status', v_t.status,
                                 'created_at', v_t.created_at, 'booking_id', v_t.booking_id,
                                 'booking_reference', (SELECT b.reference_code FROM public.bookings b WHERE b.id = v_t.booking_id),
                                 'customer_id', v_t.customer_profile_id,
                                 'customer_name', (SELECT full_name FROM public.profiles WHERE id = v_t.customer_profile_id),
                                 'customer_phone', (SELECT phone FROM public.profiles WHERE id = v_t.customer_profile_id)),
    'messages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'from_admin', m.from_admin, 'body', m.body, 'created_at', m.created_at,
                                                              'author', (SELECT full_name FROM public.profiles WHERE id = m.author_profile_id)) ORDER BY m.created_at), '[]'::jsonb)
                   FROM public.support_messages m WHERE m.ticket_id = v_t.id));
END $$;
REVOKE ALL ON FUNCTION public.admin_support_get(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_get(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_support_reply(p_id uuid, p_message text, p_status text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('support', 'manage');
  v_t public.support_tickets%ROWTYPE;
  v_body text := trim(COALESCE(p_message, ''));
  v_status text;
BEGIN
  IF char_length(v_body) < 1 OR char_length(v_body) > 2000 THEN RAISE EXCEPTION 'Write your reply (up to 2000 characters)'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'in_progress', 'resolved', 'closed') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  IF v_t.status = 'closed' THEN RAISE EXCEPTION 'This complaint is closed'; END IF;
  v_status := COALESCE(p_status, CASE WHEN v_t.status = 'open' THEN 'in_progress' ELSE v_t.status END);
  INSERT INTO public.support_messages (ticket_id, author_profile_id, from_admin, body) VALUES (p_id, v_me, true, v_body);
  UPDATE public.support_tickets
     SET status = v_status, updated_at = now(),
         resolved_at = CASE WHEN v_status IN ('resolved', 'closed') THEN now() ELSE NULL END,
         resolved_by = CASE WHEN v_status IN ('resolved', 'closed') THEN v_me ELSE NULL END
   WHERE id = p_id;
  PERFORM app_private.audit('support_ticket', p_id, 'support_replied', jsonb_build_object('status', v_status, 'reference_code', v_t.reference_code));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_support_reply(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_reply(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_support_set_status(p_id uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('support', 'manage');
  v_old text;
BEGIN
  IF p_status NOT IN ('open', 'in_progress', 'resolved', 'closed') THEN RAISE EXCEPTION 'Unknown status'; END IF;
  SELECT status INTO v_old FROM public.support_tickets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  UPDATE public.support_tickets
     SET status = p_status, updated_at = now(),
         resolved_at = CASE WHEN p_status IN ('resolved', 'closed') THEN now() ELSE NULL END,
         resolved_by = CASE WHEN p_status IN ('resolved', 'closed') THEN v_me ELSE NULL END
   WHERE id = p_id;
  PERFORM app_private.audit('support_ticket', p_id, 'support_status_changed', jsonb_build_object('from', v_old, 'to', p_status));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_support_set_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_set_status(uuid, text) TO authenticated;

-- ───────────────────────── activity log ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_activity(p_limit integer DEFAULT 100, p_before timestamptz DEFAULT NULL, p_search text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  PERFORM app_private.require_access('activity', 'view');
  RETURN (
    SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'created_at') DESC), '[]'::jsonb) FROM (
      SELECT jsonb_build_object('id', e.id, 'created_at', e.created_at, 'event_type', e.event_type, 'entity_type', e.entity_type, 'entity_id', e.entity_id,
                                'actor_name', a.full_name, 'actor_role', a.role::text, 'metadata', e.metadata) AS x
        FROM public.audit_events e LEFT JOIN public.profiles a ON a.id = e.actor_profile_id
       WHERE (p_before IS NULL OR e.created_at < p_before)
         AND (NULLIF(trim(p_search), '') IS NULL OR e.event_type ILIKE '%' || trim(p_search) || '%' OR e.entity_type ILIKE '%' || trim(p_search) || '%'
              OR a.full_name ILIKE '%' || trim(p_search) || '%' OR e.metadata::text ILIKE '%' || trim(p_search) || '%')
       ORDER BY e.created_at DESC LIMIT v_limit) q);
END $$;
REVOKE ALL ON FUNCTION public.admin_activity(integer, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_activity(integer, timestamptz, text) TO authenticated;

-- Lets the website record an admin signing in (it has no other way to write an audit event).
CREATE OR REPLACE FUNCTION public.admin_log_event(p_event text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF p_event NOT IN ('admin_signed_in') THEN RAISE EXCEPTION 'Unknown event'; END IF;
  PERFORM app_private.audit('profile', public.current_profile_id(), p_event, '{}'::jsonb);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_log_event(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_log_event(text) TO authenticated;

-- ───────────────────────── dashboard numbers ─────────────────────────
-- Everything is by Pune calendar day. Money is only returned to a role that may see payments; others get null there.
CREATE OR REPLACE FUNCTION public.admin_dashboard() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_money boolean;
  v_support boolean;
  v_out jsonb;
BEGIN
  PERFORM app_private.require_access('overview', 'view');
  v_money := app_private.can('payments', 'view');
  v_support := app_private.can('support', 'view');
  WITH paid AS (
    SELECT (pay.paid_at AT TIME ZONE 'Asia/Kolkata')::date AS d, pay.amount_cents
      FROM public.payments pay WHERE pay.paid_at IS NOT NULL AND pay.status IN ('paid', 'partially_refunded', 'refunded')
  ), refunded AS (
    SELECT (r.updated_at AT TIME ZONE 'Asia/Kolkata')::date AS d, r.amount_cents FROM public.refunds r WHERE r.status = 'processed'
  ), joined AS (
    SELECT (p.created_at AT TIME ZONE 'Asia/Kolkata')::date AS d FROM public.profiles p WHERE p.role = 'customer'
  ), days AS (
    SELECT g::date AS d FROM generate_series(v_today - 13, v_today, interval '1 day') g
  ), series AS (
    SELECT jsonb_agg(jsonb_build_object(
             'date', days.d,
             'new_customers', (SELECT count(*)::int FROM joined j WHERE j.d = days.d),
             'paid_orders', (SELECT count(*)::int FROM paid x WHERE x.d = days.d),
             'collected_cents', CASE WHEN v_money THEN (SELECT COALESCE(sum(x.amount_cents), 0)::bigint FROM paid x WHERE x.d = days.d) END
           ) ORDER BY days.d) AS s FROM days
  )
  SELECT jsonb_build_object(
    'today', v_today,
    'new_customers', jsonb_build_object(
      'today', (SELECT count(*)::int FROM joined WHERE d = v_today),
      'last_7_days', (SELECT count(*)::int FROM joined WHERE d > v_today - 7),
      'last_30_days', (SELECT count(*)::int FROM joined WHERE d > v_today - 30)),
    'orders', jsonb_build_object(
      'paid_today', (SELECT count(*)::int FROM paid WHERE d = v_today),
      'paid_last_7_days', (SELECT count(*)::int FROM paid WHERE d > v_today - 7),
      'free_washes_today', (SELECT count(*)::int FROM public.campaign_claims c WHERE (c.claimed_at AT TIME ZONE 'Asia/Kolkata')::date = v_today)),
    'money', CASE WHEN v_money THEN jsonb_build_object(
      'collected_today_cents', (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM paid WHERE d = v_today),
      'refunded_today_cents', (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM refunded WHERE d = v_today),
      'collected_7_days_cents', (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM paid WHERE d > v_today - 7),
      'collected_30_days_cents', (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM paid WHERE d > v_today - 30),
      'refunded_30_days_cents', (SELECT COALESCE(sum(amount_cents), 0)::bigint FROM refunded WHERE d > v_today - 30)) END,
    'payment_problems', CASE WHEN v_money THEN jsonb_build_object(
      'failed_today', (SELECT count(*)::int FROM public.payments WHERE status = 'failed' AND (updated_at AT TIME ZONE 'Asia/Kolkata')::date = v_today),
      'unfulfilled', (SELECT count(*)::int FROM public.payments WHERE fulfilment_status = 'unfulfilled'),
      'unconfirmed_checkouts', (SELECT count(*)::int FROM public.payments WHERE status = 'pending' AND provider_order_id IS NOT NULL
                                  AND created_at < now() - interval '3 minutes' AND created_at > now() - interval '7 days')) END,
    'open_complaints', CASE WHEN v_support THEN (SELECT count(*)::int FROM public.support_tickets WHERE status IN ('open', 'in_progress')) END,
    'series', (SELECT s FROM series)
  ) INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_dashboard() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard() TO authenticated;

-- ───────────────────────── data export ─────────────────────────
-- { columns: [...], rows: [[...], ...], truncated: bool }. One permission per kind (export_<kind>), capped at 50,000 rows, and every export is audited.
-- Only 'customers' carries phone numbers and emails; the money exports carry names but no contact details.
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
    v_cols := '["Reference","Customer","Vehicle","Registration","Washes per week","Months","Amount (Rs)","Status","Starts","Ends","Washes","Washes done"]'::jsonb;
    SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_rows FROM (
      SELECT jsonb_build_array(rq.reference_code, p.full_name, v.vehicle_type::text, v.registration_number, rq.frequency_per_week, m.duration_months, round(m.final_amount_cents / 100.0, 2),
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
