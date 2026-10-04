-- 20261004000001_security_safe_fixes.sql
-- SAFE: closes real vulnerabilities without changing any function signature the mobile app calls.
--
--   * default privileges: new functions are no longer callable by anon/authenticated
--   * audit_events: append-only audit trail used by every privileged action from here on
--   * admin_set_user_role: was callable by anyone -> now admin-only and audited
--   * is_admin(): role-based only (the two hardcoded emails are promoted to real admin roles first)
--   * link_profile_by_phone / handle_new_customer_profile: no more account takeover by claiming a phone
--   * activate_paid_*: no longer callable by customers; ownership checked; fixes the payment_received bug
--   * booking_events CHECK: adds the event types the live functions already try to write
--   * coupons: no anonymous read of coupon codes
--
-- Nothing here deletes data.

-- ───────────────────────── Private schema + default privileges ─────────────────────────
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA app_private TO service_role;

-- From now on, a function someone creates is NOT executable by clients until it is granted on purpose.
-- PostgreSQL gives PUBLIC execute on every new function through a GLOBAL default that a schema-scoped
-- REVOKE cannot remove, so the PUBLIC revoke must be global. (Applies to functions created by the role
-- running migrations; every function below that clients need is granted explicitly.)
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_private REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- ───────────────────────── Audit trail ─────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_profile_id uuid,
  actor_auth_user_id uuid,
  entity_type text NOT NULL,
  entity_id uuid,
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON public.audit_events (entity_type, entity_id, created_at);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_events_admin_read ON public.audit_events;
CREATE POLICY audit_events_admin_read ON public.audit_events FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.audit_events FROM anon, authenticated;
GRANT SELECT ON public.audit_events TO authenticated;

DROP TRIGGER IF EXISTS audit_events_append_only ON public.audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON public.audit_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_historical_delete();

CREATE OR REPLACE FUNCTION app_private.audit(p_entity_type text, p_entity_id uuid, p_event_type text, p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.audit_events (actor_profile_id, actor_auth_user_id, entity_type, entity_id, event_type, metadata)
  VALUES (public.current_profile_id(), auth.uid(), p_entity_type, p_entity_id, p_event_type, COALESCE(p_metadata, '{}'::jsonb));
$$;
REVOKE ALL ON FUNCTION app_private.audit(text, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.audit(text, uuid, text, jsonb) TO service_role;

-- ───────────────────────── Admin role: real roles, no hardcoded emails ─────────────────────────
-- is_admin() used to also return true for two hardcoded email addresses. Give those accounts a real
-- admin role first, so removing the email check cannot lock the owner out.
DO $$
BEGIN
  PERFORM set_config('washo.allow_role_change', 'on', true);
  UPDATE public.profiles p
     SET role = 'admin', updated_at = now()
   WHERE p.role <> 'admin'
     AND p.auth_user_id IN (
       SELECT id FROM auth.users WHERE lower(email) IN ('rajguruyash29@gmail.com', 'admin@washo.in')
     );
END $$;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE (p.auth_user_id = auth.uid() OR p.id = auth.uid()) AND p.role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_set_user_role(p_user_email text, p_role public.profile_role)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_auth_id uuid;
  v_old public.profile_role;
  v_profile_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_auth_id FROM auth.users WHERE lower(email) = lower(trim(p_user_email));
  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found', p_user_email;
  END IF;

  SELECT id, role INTO v_profile_id, v_old FROM public.profiles WHERE auth_user_id = v_auth_id;
  IF v_profile_id IS NULL THEN
    RAISE EXCEPTION 'No profile for that user';
  END IF;

  PERFORM set_config('washo.allow_role_change', 'on', true);
  UPDATE public.profiles SET role = p_role, updated_at = now() WHERE id = v_profile_id;

  PERFORM app_private.audit('profile', v_profile_id, 'role_changed',
    jsonb_build_object('from', v_old, 'to', p_role, 'email', lower(trim(p_user_email))));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_user_role(text, public.profile_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(text, public.profile_role) TO authenticated;

-- ───────────────────────── Phone linking: no account takeover ─────────────────────────
-- Profiles may be merged only when the NEW login proves ownership of the phone (OTP-verified), and
-- never because a user typed a number into their signup metadata.

-- profiles_no_delete used to forbid every delete, which made merging impossible. Allow it only
-- while the merge function has flipped a transaction-local switch.
CREATE OR REPLACE FUNCTION app_private.prevent_profile_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('washo.allow_profile_merge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Historical records cannot be deleted';
END $$;
DROP TRIGGER IF EXISTS profiles_no_delete ON public.profiles;
CREATE TRIGGER profiles_no_delete BEFORE DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION app_private.prevent_profile_delete();

-- Move the old, unguarded function out of the public schema and keep it internal.
-- (Skipped on a re-run: once the internal copy exists, public.link_profile_by_phone is the new safe wrapper.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'link_profile_by_phone'
                AND pg_get_function_identity_arguments(p.oid) = 'p_auth_user_id uuid, p_phone text')
     AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'app_private' AND p.proname = 'link_profile_by_phone_internal') THEN
    ALTER FUNCTION public.link_profile_by_phone(uuid, text) SET SCHEMA app_private;
    ALTER FUNCTION app_private.link_profile_by_phone(uuid, text) RENAME TO link_profile_by_phone_internal;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_private.link_profile_by_phone_internal(p_auth_user_id uuid, p_phone text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_clean_phone text;
  v_existing_profile_id uuid;
  v_current_profile_id uuid;
BEGIN
  IF p_phone IS NULL OR p_phone = '' THEN RETURN NULL; END IF;
  v_clean_phone := right(regexp_replace(p_phone, '\D', '', 'g'), 10);
  IF length(v_clean_phone) < 10 THEN RETURN NULL; END IF;

  SELECT id INTO v_current_profile_id FROM public.profiles WHERE auth_user_id = p_auth_user_id;

  SELECT id INTO v_existing_profile_id
    FROM public.profiles
   WHERE right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = v_clean_phone
     AND (v_current_profile_id IS NULL OR id <> v_current_profile_id)
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_existing_profile_id IS NULL THEN RETURN v_current_profile_id; END IF;

  PERFORM set_config('washo.allow_identity_change', 'on', true);
  PERFORM set_config('washo.allow_profile_merge', 'on', true);

  IF v_current_profile_id IS NOT NULL THEN
    UPDATE public.vehicles SET customer_profile_id = v_existing_profile_id WHERE customer_profile_id = v_current_profile_id;
    UPDATE public.customer_addresses SET customer_profile_id = v_existing_profile_id WHERE customer_profile_id = v_current_profile_id;
    UPDATE public.bookings SET customer_profile_id = v_existing_profile_id WHERE customer_profile_id = v_current_profile_id;
    UPDATE public.memberships SET customer_profile_id = v_existing_profile_id WHERE customer_profile_id = v_current_profile_id;
    UPDATE public.notifications SET profile_id = v_existing_profile_id WHERE profile_id = v_current_profile_id;
    DELETE FROM public.profiles WHERE id = v_current_profile_id;
  END IF;

  UPDATE public.profiles
     SET auth_user_id = p_auth_user_id, phone = COALESCE(phone, p_phone), updated_at = now()
   WHERE id = v_existing_profile_id;

  PERFORM set_config('washo.allow_identity_change', 'off', true);
  PERFORM set_config('washo.allow_profile_merge', 'off', true);

  PERFORM app_private.audit('profile', v_existing_profile_id, 'profile_linked_by_phone',
    jsonb_build_object('auth_user_id', p_auth_user_id, 'merged_profile_id', v_current_profile_id));
  RETURN v_existing_profile_id;
END;
$$;
REVOKE ALL ON FUNCTION app_private.link_profile_by_phone_internal(uuid, text) FROM PUBLIC, anon, authenticated;

-- Client-facing wrapper (the mobile app calls public.link_profile_by_phone): it may only link the
-- CALLER's own, already-verified phone.
CREATE OR REPLACE FUNCTION public.link_profile_by_phone(p_auth_user_id uuid, p_phone text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_verified text;
BEGIN
  IF v_uid IS NULL OR p_auth_user_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT phone INTO v_verified FROM auth.users WHERE id = v_uid AND phone_confirmed_at IS NOT NULL;
  IF v_verified IS NULL
     OR right(regexp_replace(v_verified, '\D', '', 'g'), 10) <> right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 10) THEN
    RAISE EXCEPTION 'This phone number is not verified for your account' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.link_profile_by_phone_internal(v_uid, v_verified);
END;
$$;
REVOKE ALL ON FUNCTION public.link_profile_by_phone(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_profile_by_phone(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.handle_new_customer_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_linked uuid;
BEGIN
  -- Only a phone the auth provider has VERIFIED can link to an existing profile.
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' AND NEW.phone_confirmed_at IS NOT NULL THEN
    v_linked := app_private.link_profile_by_phone_internal(NEW.id, NEW.phone);
    IF v_linked IS NOT NULL THEN RETURN NEW; END IF;
  END IF;

  INSERT INTO public.profiles (auth_user_id, role, full_name, phone)
  VALUES (NEW.id, 'customer', NEW.raw_user_meta_data ->> 'full_name',
          COALESCE(NEW.phone, NEW.raw_user_meta_data ->> 'phone'))
  ON CONFLICT (auth_user_id) DO UPDATE SET phone = COALESCE(EXCLUDED.phone, public.profiles.phone);
  RETURN NEW;
END;
$$;

-- A phone that gets confirmed AFTER the user row exists (OTP verify as a separate step) links too.
CREATE OR REPLACE FUNCTION app_private.link_on_phone_confirmed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.phone IS NOT NULL AND NEW.phone_confirmed_at IS NOT NULL
     AND (OLD.phone_confirmed_at IS NULL OR OLD.phone IS DISTINCT FROM NEW.phone) THEN
    PERFORM app_private.link_profile_by_phone_internal(NEW.id, NEW.phone);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.link_on_phone_confirmed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS on_auth_user_phone_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_phone_confirmed AFTER UPDATE OF phone, phone_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app_private.link_on_phone_confirmed();

-- ───────────────────────── booking_events: event types the live code already writes ─────────────────────────
ALTER TABLE public.booking_events DROP CONSTRAINT IF EXISTS booking_events_event_type_check;
ALTER TABLE public.booking_events ADD CONSTRAINT booking_events_event_type_check CHECK (event_type = ANY (ARRAY[
  'booking_created', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'wash_started', 'wash_completed',
  'rescheduled', 'cancelled', 'refund_requested', 'refunded', 'admin_booking_updated', 'admin_status_change',
  'membership_activated', 'credit_rollover',
  -- previously written by live functions but rejected by the old CHECK:
  'booking_cancelled', 'payment_received',
  -- new
  'payment_unfulfilled', 'membership_scheduled',
  -- worker workflow (website + mobile)
  'customer_confirmed', 'worker_issue', 'worker_note', 'membership_worker_assigned'
]));

-- ───────────────────────── activate_paid_*: service-only, ownership-checked ─────────────────────────
CREATE OR REPLACE FUNCTION public.activate_paid_on_demand_booking(p_payment_id uuid, p_provider_payment_id text, p_booking_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay public.payments%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
BEGIN
  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_pay.status = 'paid' THEN RETURN true; END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = p_booking_id;
  IF NOT FOUND OR v_booking.customer_profile_id <> v_pay.customer_profile_id OR v_booking.booking_type <> 'on_demand' THEN
    RAISE EXCEPTION 'This payment does not belong to that booking';
  END IF;

  UPDATE public.payments
     SET status = 'paid', provider_payment_id = p_provider_payment_id, booking_id = p_booking_id,
         paid_at = now(), updated_at = now()
   WHERE id = p_payment_id;
  UPDATE public.bookings SET status = 'confirmed', updated_at = now()
   WHERE id = p_booking_id AND status IN ('pending', 'confirmed');
  INSERT INTO public.booking_events (booking_id, event_type, event_metadata)
  VALUES (p_booking_id, 'payment_received',
          jsonb_build_object('payment_id', p_payment_id, 'provider', 'razorpay', 'provider_payment_id', p_provider_payment_id));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_paid_membership(p_payment_id uuid, p_provider_payment_id text, p_membership_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pay public.payments%ROWTYPE;
  v_mem public.memberships%ROWTYPE;
BEGIN
  SELECT * INTO v_pay FROM public.payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_pay.status = 'paid' THEN RETURN true; END IF;

  SELECT * INTO v_mem FROM public.memberships WHERE id = p_membership_id;
  IF NOT FOUND OR v_mem.customer_profile_id <> v_pay.customer_profile_id THEN
    RAISE EXCEPTION 'This payment does not belong to that membership';
  END IF;

  UPDATE public.payments
     SET status = 'paid', provider_payment_id = p_provider_payment_id, membership_id = p_membership_id,
         paid_at = now(), updated_at = now()
   WHERE id = p_payment_id;
  UPDATE public.memberships SET status = 'active', updated_at = now() WHERE id = p_membership_id;
  RETURN true;
END;
$$;
-- The edge functions call these with the service role. Customers must not.
REVOKE ALL ON FUNCTION public.activate_paid_on_demand_booking(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.activate_paid_membership(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_paid_on_demand_booking(uuid, text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_paid_membership(uuid, text, uuid) TO service_role;

-- ───────────────────────── Coupons: no anonymous listing ─────────────────────────
-- The apps validate coupons through the validate_coupon() function; nothing reads the table directly.
DROP POLICY IF EXISTS "Anyone can view active coupons" ON public.coupons;
REVOKE ALL ON public.coupons FROM anon;
