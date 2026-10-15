-- REPAIR (run once, by hand, in the Supabase SQL Editor). Gives an admin's profile back to their EMAIL login.
--
-- What went wrong: the admin's profile carries the admin's mobile number. Asking for a phone code with that number and typing it in made the database move
-- that profile over to the new PHONE login (public.link_profile_by_phone_internal re-points any profile that has the number). The server then refused the
-- phone login ("admins sign in with email"), but the move had already happened: the admin's EMAIL login was left with no profile, so the next email sign-in
-- quietly created a brand-new, empty CUSTOMER profile for it. That is why the admin signs in with email and password and lands in the customer app.
--
-- What this does, all or nothing (a single statement: if anything below is not as expected it stops and changes NOTHING):
--   1. finds the email login and the admin profile (by the admin's mobile number or email),
--   2. if the email login has a stray customer profile, deletes it, but ONLY if it is completely empty (no washes, plans, payments, vehicles, addresses, ...),
--   3. points the admin profile back at the email login.
-- Nothing else changes: the admin's role, access level, history and settings stay as they are. The phone login is left in place with no profile.
--
-- AFTER running this: apply migration 20261004000044_staff_phone_never_linked.sql (and deploy the website) so a phone code can never take a team member's profile again.
-- Until then, do NOT ask for a phone code with the admin's own number.
--
-- It can also CHANGE the number on the admin profile (v_new_phone), which frees the old number to sign in as an ordinary customer. Leave v_new_phone empty to keep the number as it is.
-- Replace the three values on the first lines of PART 2 (and the email and number in PART 1 and PART 3) before running.

-- ───────── PART 1: LOOK (changes nothing). Check the picture matches the story above before running PART 2. ─────────
SELECT p.id AS profile_id, p.role, p.full_name, p.phone AS profile_phone, p.email AS profile_email, p.created_at,
       u.email AS login_email, u.phone AS login_phone,
       (SELECT count(*) FROM public.bookings b WHERE b.customer_profile_id = p.id) AS washes
  FROM public.profiles p JOIN auth.users u ON u.id = p.auth_user_id
 WHERE lower(u.email) = 'owner@example.com'
    OR right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) = '0000000000'
    OR (p.role = 'admin' AND lower(COALESCE(p.email, '')) = 'owner@example.com')
 ORDER BY p.created_at;

-- ───────── PART 2: REPAIR ─────────
DO $repair$
DECLARE
  v_email     text := 'owner@example.com';   -- the admin's email login
  v_old_phone text := '0000000000';          -- the number the admin profile carries now (last 10 digits)
  v_new_phone text := '';                    -- the number it should carry instead (10 digits), or empty to leave it as it is
  v_login  uuid;
  v_admin  uuid;
  v_stray  uuid;
  v_cur    text;
  v_rows   bigint;
BEGIN
  SELECT id INTO v_login FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_login IS NULL THEN RAISE EXCEPTION 'There is no login with the email %', v_email; END IF;

  SELECT p.id, p.phone INTO v_admin, v_cur
    FROM public.profiles p
   WHERE p.role = 'admin'
     AND (right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) IN (v_old_phone, NULLIF(v_new_phone, ''))
          OR lower(COALESCE(p.email, '')) = lower(v_email))
   ORDER BY p.created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'Could not find the admin profile (role admin, with that mobile number or email). Nothing was changed.'; END IF;

  -- a number is never shared between profiles
  IF NULLIF(v_new_phone, '') IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id <> v_admin AND right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) = v_new_phone
  ) THEN
    RAISE EXCEPTION 'Another profile already has the number %. Nothing was changed.', v_new_phone;
  END IF;

  IF (SELECT auth_user_id FROM public.profiles WHERE id = v_admin) <> v_login THEN
    SELECT id INTO v_stray FROM public.profiles WHERE auth_user_id = v_login;
    IF v_stray IS NOT NULL THEN
      IF (SELECT role FROM public.profiles WHERE id = v_stray) <> 'customer' THEN
        RAISE EXCEPTION 'The email login already has a profile that is not a customer one. Nothing was changed.';
      END IF;
      -- the stray customer profile must be completely empty: refuse if anything points at it
      SELECT (SELECT count(*) FROM public.bookings               WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.memberships            WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.membership_requests    WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.payments               WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.refunds                WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.vehicles               WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.customer_addresses     WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.campaign_claims        WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.support_tickets        WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.wash_reviews           WHERE customer_profile_id = v_stray)
           + (SELECT count(*) FROM public.membership_coupon_redemptions WHERE customer_profile_id = v_stray)
        INTO v_rows;
      IF v_rows > 0 THEN RAISE EXCEPTION 'The stray customer profile is not empty (% records point at it). Nothing was changed.', v_rows; END IF;

      PERFORM set_config('washo.allow_profile_merge', 'on', true);   -- the same switch the sign-in merge uses to let a profile go
      DELETE FROM public.profiles WHERE id = v_stray AND role = 'customer';
      PERFORM set_config('washo.allow_profile_merge', 'off', true);
    END IF;
  END IF;

  PERFORM set_config('washo.allow_identity_change', 'on', true);
  UPDATE public.profiles
     SET auth_user_id = v_login,
         email = COALESCE(email, lower(v_email)),
         -- keep the way the number is written on this profile (+91..., 91... or just ten digits)
         phone = CASE WHEN NULLIF(v_new_phone, '') IS NULL THEN phone
                      WHEN v_cur LIKE '+91%' THEN '+91' || v_new_phone
                      WHEN v_cur ~ '^91\d{10}$' THEN '91' || v_new_phone
                      ELSE v_new_phone END,
         updated_at = now()
   WHERE id = v_admin;
  PERFORM set_config('washo.allow_identity_change', 'off', true);

  PERFORM app_private.audit('profile', v_admin, 'admin_login_restored',
    jsonb_build_object('email_login', v_login, 'removed_empty_customer_profile', v_stray IS NOT NULL, 'phone_changed', NULLIF(v_new_phone, '') IS NOT NULL));
  RAISE NOTICE 'Done: the admin profile % is on the email login %. Sign in with email and password.', v_admin, v_login;
END
$repair$;

-- ───────── PART 3: CHECK (changes nothing). The admin should now be on the email login, and there should be no customer profile on it. ─────────
SELECT p.id AS profile_id, p.role, p.full_name, p.phone, u.email AS login_email, u.phone AS login_phone
  FROM public.profiles p JOIN auth.users u ON u.id = p.auth_user_id
 WHERE lower(u.email) = 'owner@example.com';
