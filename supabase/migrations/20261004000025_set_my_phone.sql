-- 20261004000025_set_my_phone.sql
-- SAFE / additive and re-runnable. A customer who signed in with their EMAIL can give a mobile number without confirming it with a code:
-- a specialist rings the customer before every wash, and that is all the number is for.
--
-- set_my_phone(number): sets (or, with NULL, clears) the number on the caller's own profile.
--   * 10 digits, starting 6 to 9 (a +91 or 91 in front is accepted); stored as +91XXXXXXXXXX like every other number.
--   * Refused for someone who signs in WITH a confirmed number: that number is their identity and is not changed from here.
--   * Refused when another WASHO profile already has the number (it belongs to someone's account; they sign in with it).
--   * It is a typed number, not a verified one: it never links or merges accounts by itself (only a number a login has CONFIRMED does that).
--   * It runs as the database owner and raises the same switch the account-merge function does, so the profile phone lock in
--     supabase/cutover/20261005000005 (not applied yet) will let it through when it is applied.
-- The website server also attaches the number, unconfirmed, to the same login at Supabase Auth, so that if the same person later signs in
-- WITH that number they land in this same account instead of a second one. Nothing existing is changed by applying this migration.

CREATE OR REPLACE FUNCTION public.set_my_phone(p_phone text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile uuid := public.current_profile_id();
  v_digits text := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_full text;
BEGIN
  IF v_uid IS NULL OR v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer' AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_uid AND phone IS NOT NULL AND phone <> '' AND phone_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Your mobile number is how you sign in, so it cannot be changed here. Contact WASHO to change it';
  END IF;

  IF p_phone IS NULL THEN
    v_full := NULL;
  ELSE
    IF length(v_digits) = 12 AND left(v_digits, 2) = '91' THEN v_digits := right(v_digits, 10); END IF;
    IF length(v_digits) = 11 AND left(v_digits, 1) = '0' THEN v_digits := right(v_digits, 10); END IF;
    IF v_digits !~ '^[6-9][0-9]{9}$' THEN RAISE EXCEPTION 'Enter a valid 10-digit mobile number'; END IF;
    v_full := '+91' || v_digits;
    IF EXISTS (SELECT 1 FROM public.profiles WHERE id <> v_profile AND right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = v_digits) THEN
      RAISE EXCEPTION 'That number is already registered with WASHO. Sign in with that number instead';
    END IF;
  END IF;

  PERFORM set_config('washo.allow_identity_change', 'on', true);
  UPDATE public.profiles SET phone = v_full, updated_at = now() WHERE id = v_profile;
  PERFORM set_config('washo.allow_identity_change', 'off', true);

  PERFORM app_private.audit('profile', v_profile, CASE WHEN v_full IS NULL THEN 'phone_cleared' ELSE 'phone_added_unverified' END,
    jsonb_build_object('last4', CASE WHEN v_full IS NULL THEN NULL ELSE right(v_digits, 4) END));
  RETURN v_full;
END $$;
REVOKE ALL ON FUNCTION public.set_my_phone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_phone(text) TO authenticated;
