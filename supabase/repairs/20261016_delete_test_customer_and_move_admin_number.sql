-- ONE-OFF CLEAN-UP (run once, by hand, in the Supabase SQL Editor, AFTER migration 20261004000044 is applied).
-- Removes ONE test customer account, and gives its mobile number to the admin profile of the same person.
--
-- What it deletes: the test customer's profile, plus the rows that hang off it and would otherwise stop the profile from going: its plan requests, its payment rows,
-- its vehicle and address (and its notifications). BEFORE deleting, every payment and plan-request row is copied, in full, into the audit log (which can never be edited
-- or deleted), so the record of what existed is kept.
-- What it refuses to delete (it stops and changes NOTHING): an account that has washes, plans (memberships), refunds, free-wash claims, reviews, coupon uses or
-- complaints, or whose email is not the one you name below. A mistake in the number can never delete the wrong person.
-- Afterwards the admin profile carries the number, and the old number is free for a customer sign-in.
--
-- Not done here: the test customer's phone LOGIN (Supabase Dashboard -> Authentication -> Users -> find the number -> Delete user). Do that after this script succeeds.
--
-- Replace 'owner@example.com' (the admin's email login), '1111111111' (the test account's number, 10 digits) and 'test@example.com' (the test account's profile email)
-- in PART 1 and PART 2.

CREATE OR REPLACE FUNCTION pg_temp.what_points_at(p uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT format('washes %s, plans %s, plan requests %s, payments %s, refunds %s, free-wash claims %s, complaints %s, reviews %s, coupon uses %s, vehicles %s, addresses %s',
    (SELECT count(*) FROM public.bookings WHERE customer_profile_id = p), (SELECT count(*) FROM public.memberships WHERE customer_profile_id = p),
    (SELECT count(*) FROM public.membership_requests WHERE customer_profile_id = p), (SELECT count(*) FROM public.payments WHERE customer_profile_id = p),
    (SELECT count(*) FROM public.refunds WHERE customer_profile_id = p), (SELECT count(*) FROM public.campaign_claims WHERE customer_profile_id = p),
    (SELECT count(*) FROM public.support_tickets WHERE customer_profile_id = p), (SELECT count(*) FROM public.wash_reviews WHERE customer_profile_id = p),
    (SELECT count(*) FROM public.membership_coupon_redemptions WHERE customer_profile_id = p), (SELECT count(*) FROM public.vehicles WHERE customer_profile_id = p),
    (SELECT count(*) FROM public.customer_addresses WHERE customer_profile_id = p))
$f$;

-- ───────── PART 1: LOOK (changes nothing) ─────────
SELECT p.id AS profile_id, p.role, p.full_name, p.phone AS profile_phone, p.email AS profile_email,
       u.email AS login_email, u.phone AS login_phone, pg_temp.what_points_at(p.id) AS what_points_at_it
  FROM public.profiles p JOIN auth.users u ON u.id = p.auth_user_id
 WHERE lower(u.email) = 'owner@example.com'
    OR right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) = '1111111111'
 ORDER BY p.role, p.created_at;

-- ───────── PART 2: DELETE THE TEST ACCOUNT AND MOVE THE NUMBER ─────────
DO $clean$
DECLARE
  v_email       text := 'owner@example.com';   -- the admin's email login
  v_test_phone  text := '1111111111';          -- the test account's number (10 digits): it moves to the admin profile
  v_test_email  text := 'test@example.com';    -- the test account's profile email (a safety check: it must match)
  v_login       uuid;
  v_admin       uuid;
  v_admin_phone text;
  v_cust        uuid;
  v_cust_email  text;
  v_n           int;
  v_blockers    bigint;
  v_pay         jsonb;
  v_req         jsonb;
BEGIN
  IF to_regprocedure('public.my_phone_is_staff()') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 20261004000044_staff_phone_never_linked.sql first (it keeps a phone code with the admin''s number from signing anyone in). Nothing was changed.';
  END IF;

  SELECT id INTO v_login FROM auth.users WHERE lower(email) = lower(v_email);
  IF v_login IS NULL THEN RAISE EXCEPTION 'There is no login with the email %. Nothing was changed.', v_email; END IF;
  SELECT p.id, p.phone INTO v_admin, v_admin_phone FROM public.profiles p WHERE p.auth_user_id = v_login AND p.role = 'admin';
  IF v_admin IS NULL THEN RAISE EXCEPTION 'The email login % is not on an admin profile. Run the restore script first. Nothing was changed.', v_email; END IF;

  SELECT count(*) INTO v_n FROM public.profiles WHERE role = 'customer' AND right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = v_test_phone;
  IF v_n <> 1 THEN RAISE EXCEPTION 'Expected exactly one customer profile with the number %, found %. Nothing was changed.', v_test_phone, v_n; END IF;
  SELECT id, email INTO v_cust, v_cust_email FROM public.profiles WHERE role = 'customer' AND right(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), 10) = v_test_phone;
  IF lower(COALESCE(v_cust_email, '')) <> lower(v_test_email) THEN
    RAISE EXCEPTION 'The customer profile with the number % has the email %, not %. Nothing was changed.', v_test_phone, COALESCE(v_cust_email, '(none)'), v_test_email;
  END IF;

  -- only an account made of test leftovers: plan requests, payment rows, a vehicle, an address. Anything else stops it.
  SELECT (SELECT count(*) FROM public.bookings                      WHERE customer_profile_id = v_cust)
       + (SELECT count(*) FROM public.memberships                   WHERE customer_profile_id = v_cust)
       + (SELECT count(*) FROM public.refunds                       WHERE customer_profile_id = v_cust)
       + (SELECT count(*) FROM public.campaign_claims               WHERE customer_profile_id = v_cust)
       + (SELECT count(*) FROM public.wash_reviews                  WHERE customer_profile_id = v_cust)
       + (SELECT count(*) FROM public.membership_coupon_redemptions WHERE customer_profile_id = v_cust)
       + (SELECT count(*) FROM public.support_tickets               WHERE customer_profile_id = v_cust)
    INTO v_blockers;
  IF v_blockers > 0 THEN
    RAISE EXCEPTION 'This account has more than test leftovers (%). Nothing was changed.', pg_temp.what_points_at(v_cust);
  END IF;

  -- keep the record: every payment and plan request, in full, goes into the audit log first
  SELECT COALESCE(jsonb_agg(to_jsonb(p)), '[]'::jsonb) INTO v_pay FROM public.payments p WHERE p.customer_profile_id = v_cust;
  SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_req FROM public.membership_requests r WHERE r.customer_profile_id = v_cust;
  PERFORM app_private.audit('profile', v_cust, 'test_customer_deleted',
    jsonb_build_object('email', v_cust_email, 'phone', v_test_phone, 'deleted_by_admin_profile', v_admin, 'what_it_had', pg_temp.what_points_at(v_cust), 'payments', v_pay, 'membership_requests', v_req));

  -- payments and plan requests point at each other: let go of both ends, then delete
  UPDATE public.membership_requests SET payment_id = NULL WHERE customer_profile_id = v_cust;
  UPDATE public.payments SET membership_request_id = NULL WHERE customer_profile_id = v_cust;
  DELETE FROM public.payments WHERE customer_profile_id = v_cust;
  DELETE FROM public.membership_requests WHERE customer_profile_id = v_cust;

  PERFORM set_config('washo.allow_profile_merge', 'on', true);   -- the switch the sign-in merge uses to let a profile go (its vehicle, address and notifications go with it)
  DELETE FROM public.profiles WHERE id = v_cust AND role = 'customer';
  PERFORM set_config('washo.allow_profile_merge', 'off', true);

  -- the number now belongs to the admin profile, written the way it already writes its number
  PERFORM set_config('washo.allow_identity_change', 'on', true);
  UPDATE public.profiles
     SET phone = CASE WHEN COALESCE(v_admin_phone, '') LIKE '+91%' THEN '+91' || v_test_phone
                      WHEN COALESCE(v_admin_phone, '') ~ '^91\d{10}$' THEN '91' || v_test_phone
                      ELSE v_test_phone END,
         updated_at = now()
   WHERE id = v_admin;
  PERFORM set_config('washo.allow_identity_change', 'off', true);

  PERFORM app_private.audit('profile', v_admin, 'admin_number_changed', jsonb_build_object('now_carries', v_test_phone, 'was', v_admin_phone));
  RAISE NOTICE 'Done: the test account % is gone (its % payment rows and % plan requests are kept in the audit log) and the admin profile % now carries %. Next: Supabase Dashboard -> Authentication -> Users -> delete the phone login for %.',
    v_cust, jsonb_array_length(v_pay), jsonb_array_length(v_req), v_admin, v_test_phone, v_test_phone;
END
$clean$;

-- ───────── PART 3: CHECK (changes nothing) ─────────
SELECT p.id AS profile_id, p.role, p.full_name, p.phone AS profile_phone, p.email AS profile_email, u.email AS login_email, u.phone AS login_phone
  FROM public.profiles p JOIN auth.users u ON u.id = p.auth_user_id
 WHERE lower(u.email) = 'owner@example.com'
    OR right(regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g'), 10) = '1111111111'
 ORDER BY p.role, p.created_at;
