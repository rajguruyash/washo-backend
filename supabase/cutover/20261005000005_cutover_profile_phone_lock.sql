-- 20261005000005_cutover_profile_phone_lock.sql
-- *** CUTOVER: apply once the apps no longer let customers type their own phone number into their profile. ***
--
-- profiles.phone is the key used to merge accounts. If customers could write any number into it they could
-- squat on someone else's. From now on a signed-in customer can only change it to the phone number their
-- login has VERIFIED. Admins and server-side code (no JWT, or the merge function's own switch) are unaffected.

CREATE OR REPLACE FUNCTION app_private.protect_profile_phone() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_verified text;
BEGIN
  IF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;                                  -- server-side / GoTrue / migrations
  IF current_setting('washo.allow_identity_change', true) = 'on' THEN RETURN NEW; END IF; -- the profile-merge function
  IF public.is_admin() THEN RETURN NEW; END IF;

  SELECT phone INTO v_verified FROM auth.users WHERE id = auth.uid() AND phone_confirmed_at IS NOT NULL;
  IF v_verified IS NOT NULL
     AND right(regexp_replace(v_verified, '\D', '', 'g'), 10) = right(regexp_replace(COALESCE(NEW.phone, ''), '\D', '', 'g'), 10) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Your phone number can only be changed by verifying it with a one-time code' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION app_private.protect_profile_phone() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_protect_phone ON public.profiles;
CREATE TRIGGER profiles_protect_phone BEFORE UPDATE OF phone ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION app_private.protect_profile_phone();
