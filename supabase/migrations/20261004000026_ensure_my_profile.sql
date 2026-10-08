-- 20261004000026_ensure_my_profile.sql
-- SAFE / additive and re-runnable. A person who signs in and has NO profile gets one.
--
-- A customer profile is created by a database trigger at the moment an auth account is created. An account made before that trigger existed, or
-- one the trigger missed, can sign in but has no profile, and the website answers "Your account is not set up yet". Production has a few of
-- these (an email address that signed up in September, for one). ensure_my_profile() repairs exactly that: for the CALLER's own login, and only
-- when it has no profile, it does what the trigger does:
--   * a login whose mobile number is confirmed joins the profile that already has that number, if there is one (the usual phone linking);
--   * otherwise a new customer profile is made from the login (name from its details, its number if it has one and no other profile already has it, email).
-- It never touches a login that already has a profile, never makes staff, and cannot be asked about anyone else. Nothing existing is changed
-- by applying this migration.

CREATE OR REPLACE FUNCTION public.ensure_my_profile() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  u auth.users%ROWTYPE;
  v_id uuid;
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;
  SELECT id INTO v_id FROM public.profiles WHERE auth_user_id = v_uid;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT * INTO u FROM auth.users WHERE id = v_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501'; END IF;

  IF u.phone IS NOT NULL AND u.phone <> '' AND u.phone_confirmed_at IS NOT NULL THEN
    v_id := app_private.link_profile_by_phone_internal(u.id, u.phone);
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;

  -- the number the login carries (or gave when it signed up), unless another profile already has it: a number is never shared between profiles
  v_phone := NULLIF(COALESCE(u.phone, u.raw_user_meta_data ->> 'phone'), '');
  IF v_phone IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles WHERE right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = right(regexp_replace(v_phone, '\D', '', 'g'), 10)) THEN
    v_phone := NULL;
  END IF;

  INSERT INTO public.profiles (auth_user_id, role, full_name, phone)
  VALUES (u.id, 'customer', NULLIF(u.raw_user_meta_data ->> 'full_name', ''), v_phone)
  ON CONFLICT (auth_user_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM public.profiles WHERE auth_user_id = v_uid; RETURN v_id; END IF;

  UPDATE public.profiles SET email = u.email WHERE id = v_id AND email IS NULL AND u.email IS NOT NULL;
  PERFORM app_private.audit('profile', v_id, 'profile_created_on_sign_in', jsonb_build_object('had_phone', u.phone IS NOT NULL, 'had_email', u.email IS NOT NULL));
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.ensure_my_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_my_profile() TO authenticated;
