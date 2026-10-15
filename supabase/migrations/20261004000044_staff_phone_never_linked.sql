-- 20261004000044_staff_phone_never_linked.sql
-- SAFE / re-runnable. A TEAM MEMBER'S PROFILE IS NEVER TAKEN OVER BY A PHONE SIGN-IN.
--
-- The bug: a profile carries its owner's mobile number, and a phone sign-in joins "the profile that already has this number" (link_profile_by_phone_internal, called
-- by the sign-up trigger, the phone-confirmed trigger and ensure_my_profile). That was meant for customers (an old customer record picked up by the number). It did
-- not look at the role, so an admin or specialist who asked for a phone code with THEIR OWN number had their profile moved over to that phone login. The website then
-- refused the phone login ("admins sign in with email"), but the move had already happened: their EMAIL login was left with no profile, and the next email sign-in
-- quietly made a new, empty customer profile for it. They signed in with the right password and landed in the customer app.
--
--   link_profile_by_phone_internal   (replaced) only ever joins a CUSTOMER profile. Admin and specialist profiles are never moved, merged or deleted by a phone login
--   handle_new_customer_profile      (replaced) a new phone login whose number belongs to a team member does not copy that number onto its own new customer profile
--   my_phone_is_staff()              (new) true when the signed-in login's confirmed number belongs to an admin or specialist; the website asks it right after a code is
--                                    accepted, signs that login out again and says "use your email and password"
-- Nothing existing is touched: no profile, role, wash or payment row changes when this is applied. To put right a profile that was ALREADY moved, run
-- supabase/repairs/20261015_restore_admin_email_login.sql (once, by hand).

CREATE OR REPLACE FUNCTION app_private.link_profile_by_phone_internal(p_auth_user_id uuid, p_phone text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_clean_phone text;
  v_existing_profile_id uuid;
  v_current_profile_id uuid;
BEGIN
  IF p_phone IS NULL OR p_phone = '' THEN RETURN NULL; END IF;
  v_clean_phone := right(regexp_replace(p_phone, '\D', '', 'g'), 10);
  IF length(v_clean_phone) < 10 THEN RETURN NULL; END IF;

  SELECT id INTO v_current_profile_id FROM public.profiles WHERE auth_user_id = p_auth_user_id;

  -- Only a CUSTOMER profile can be picked up by its number. A team member (admin, specialist) signs in with email and password; a phone code must never move their profile.
  SELECT id INTO v_existing_profile_id
    FROM public.profiles
   WHERE right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = v_clean_phone
     AND role = 'customer'
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

CREATE OR REPLACE FUNCTION public.handle_new_customer_profile() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_linked uuid;
  v_phone text := COALESCE(NEW.phone, NEW.raw_user_meta_data ->> 'phone');
BEGIN
  -- Only a phone the auth provider has VERIFIED can link to an existing profile.
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' AND NEW.phone_confirmed_at IS NOT NULL THEN
    v_linked := app_private.link_profile_by_phone_internal(NEW.id, NEW.phone);
    IF v_linked IS NOT NULL THEN RETURN NEW; END IF;
  END IF;

  -- a number that belongs to a team member is not copied onto a new customer profile (a number is never shared between profiles)
  IF v_phone IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.role IN ('admin', 'worker')
       AND right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(v_phone, '\D', '', 'g'), 10)
  ) THEN
    v_phone := NULL;
  END IF;

  INSERT INTO public.profiles (auth_user_id, role, full_name, phone)
  VALUES (NEW.id, 'customer', NEW.raw_user_meta_data ->> 'full_name', v_phone)
  ON CONFLICT (auth_user_id) DO UPDATE SET phone = COALESCE(EXCLUDED.phone, public.profiles.phone);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.my_phone_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM auth.users u
      JOIN public.profiles p ON p.role IN ('admin', 'worker')
       AND right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(u.phone, '\D', '', 'g'), 10)
     WHERE u.id = auth.uid() AND u.phone IS NOT NULL AND u.phone <> ''
       AND p.auth_user_id <> u.id
  )
$$;
REVOKE ALL ON FUNCTION public.my_phone_is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_phone_is_staff() TO authenticated;
