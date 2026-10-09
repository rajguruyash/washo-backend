-- 20261004000032_coupons.sql
-- (The shared database already has a table called coupons that the mobile app uses for its own first-wash offers. It is not touched or read here: these are separate tables.)
-- SAFE / additive. Coupons for a membership: the admin makes a code (for example EXTRA5) worth an extra percentage off, tells people by word of mouth, and the customer types it
-- in on the last step (Review and pay). Nothing about an existing membership, payment or price changes.
--
--   membership_coupons              the codes: percent off (1% to 50%), on or off, optional last day, optional most uses, once per customer or not
--   membership_coupon_redemptions   one row per paid membership that used a coupon (so "used so far" counts what was PAID FOR, never an abandoned checkout)
--   app_private.apply_coupon        puts a coupon onto a price quote as its own line; the percentage is taken off the plan price (the subtotal), on top of the
--                                   frequency and length discounts, which keep their own cap. Raises a message a customer can read when it cannot be used.
--   estimate_monthly_price_with_coupon   what the customer sees on the review step (signed-in customers only)
--   create_monthly_membership_request / start_monthly_membership_checkout   (replaced) take an optional coupon; with none they behave exactly as before, so the
--                                   website that is live today keeps working the moment this is applied
--   admin_list_coupons / admin_save_coupon / admin_set_coupon_active / admin_coupon_uses   the Admin page (needs the Campaigns area: Marketing, Operations, super admin)
-- A coupon is read when the plan is priced and the percentage is frozen in that quote: the customer pays exactly what the review step showed. A payment that has already
-- been taken is never refused because the coupon ran out in the meantime (money is never taken for something that then cannot be done).

CREATE TABLE IF NOT EXISTS public.membership_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  discount_bp integer NOT NULL,
  label text,
  is_active boolean NOT NULL DEFAULT true,
  expires_on date,
  max_uses integer,
  once_per_customer boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_coupons_code_check CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  CONSTRAINT membership_coupons_percent_check CHECK (discount_bp BETWEEN 1 AND 5000),
  CONSTRAINT membership_coupons_label_check CHECK (label IS NULL OR char_length(label) <= 60),
  CONSTRAINT membership_coupons_max_uses_check CHECK (max_uses IS NULL OR max_uses >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_coupons_code ON public.membership_coupons (code);

CREATE TABLE IF NOT EXISTS public.membership_coupon_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coupon_id uuid NOT NULL REFERENCES public.membership_coupons(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  membership_id uuid NOT NULL UNIQUE REFERENCES public.memberships(id) ON DELETE RESTRICT,
  code text NOT NULL,
  discount_bp integer NOT NULL,
  discount_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_membership_coupon_redemptions_coupon ON public.membership_coupon_redemptions (coupon_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_membership_coupon_redemptions_customer ON public.membership_coupon_redemptions (coupon_id, customer_profile_id);

-- Only the functions below touch these tables.
ALTER TABLE public.membership_coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_coupon_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.membership_coupons, public.membership_coupon_redemptions FROM PUBLIC, anon, authenticated;

-- What a customer typed -> the code, or NULL for nothing typed, or an error for something that can never be a code.
CREATE OR REPLACE FUNCTION app_private.clean_coupon_code(p_code text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text := upper(btrim(COALESCE(p_code, '')));
BEGIN
  IF v = '' THEN RETURN NULL; END IF;
  IF v !~ '^[A-Z0-9]{3,20}$' THEN RAISE EXCEPTION 'That coupon code is not valid'; END IF;
  RETURN v;
END $$;

-- A price quote with the coupon on it. The extra percentage is of the plan price (the subtotal), so "extra 5%" is exactly 5% of what the plan costs before discounts.
CREATE OR REPLACE FUNCTION app_private.apply_coupon(p_quote jsonb, p_code text, p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text := app_private.clean_coupon_code(p_code);
  c public.membership_coupons%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_subtotal integer; v_cents integer; v_total integer;
BEGIN
  IF v_code IS NULL THEN RETURN p_quote; END IF;
  SELECT * INTO c FROM public.membership_coupons WHERE code = v_code;
  IF NOT FOUND OR NOT c.is_active THEN RAISE EXCEPTION 'That coupon code is not valid'; END IF;
  IF c.expires_on IS NOT NULL AND v_today > c.expires_on THEN RAISE EXCEPTION 'That coupon has expired'; END IF;
  IF c.max_uses IS NOT NULL AND (SELECT count(*) FROM public.membership_coupon_redemptions r WHERE r.coupon_id = c.id) >= c.max_uses THEN RAISE EXCEPTION 'That coupon has been used up'; END IF;
  IF c.once_per_customer AND p_customer IS NOT NULL AND EXISTS (SELECT 1 FROM public.membership_coupon_redemptions r WHERE r.coupon_id = c.id AND r.customer_profile_id = p_customer) THEN
    RAISE EXCEPTION 'You have already used this coupon';
  END IF;
  v_subtotal := (p_quote->>'subtotal_cents')::integer;
  v_cents := round(v_subtotal::numeric * c.discount_bp / 10000);
  v_total := (p_quote->>'total_discount_cents')::integer + v_cents;
  RETURN p_quote || jsonb_build_object(
    'coupon', jsonb_build_object('id', c.id, 'code', c.code, 'bp', c.discount_bp, 'cents', v_cents),
    'total_discount_cents', v_total,
    'final_cents', v_subtotal - v_total);
END $$;
REVOKE ALL ON FUNCTION app_private.clean_coupon_code(text), app_private.apply_coupon(jsonb, text, uuid) FROM PUBLIC, anon, authenticated;

-- The review step: what this plan costs for the signed-in customer with this coupon (nothing is stored).
CREATE OR REPLACE FUNCTION public.estimate_monthly_price_with_coupon(p_vehicle_type public.vehicle_type, p_body integer, p_deep integer, p_duration_months integer, p_coupon text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profile uuid := public.current_profile_id();
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Sign in to use a coupon' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.apply_coupon(app_private.compute_monthly_quote(p_vehicle_type, p_body, p_deep, p_duration_months), p_coupon, v_profile);
END $$;
REVOKE ALL ON FUNCTION public.estimate_monthly_price_with_coupon(public.vehicle_type, integer, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estimate_monthly_price_with_coupon(public.vehicle_type, integer, integer, integer, text) TO authenticated;

-- A paid membership that carries a coupon in its price records the use (once: membership_id is unique).
CREATE OR REPLACE FUNCTION app_private.record_coupon_redemption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.membership_coupon_redemptions (coupon_id, customer_profile_id, membership_id, code, discount_bp, discount_cents)
  SELECT c.id, NEW.customer_profile_id, NEW.id, c.code, (NEW.pricing_snapshot->'coupon'->>'bp')::integer, (NEW.pricing_snapshot->'coupon'->>'cents')::integer
    FROM public.membership_coupons c WHERE c.id = (NEW.pricing_snapshot->'coupon'->>'id')::uuid
  ON CONFLICT (membership_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.record_coupon_redemption() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS memberships_record_coupon ON public.memberships;
CREATE TRIGGER memberships_record_coupon AFTER INSERT ON public.memberships
  FOR EACH ROW WHEN (NEW.pricing_snapshot ? 'coupon') EXECUTE FUNCTION app_private.record_coupon_redemption();

-- ───────────────────────── the plan functions take an optional coupon ─────────────────────────
-- The old signatures are replaced (a function with a new last argument is a new function); the website that is live today calls them without a coupon, which still works.
DROP FUNCTION IF EXISTS public.start_monthly_membership_checkout(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.create_monthly_membership_request(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.create_monthly_membership_request(
  p_vehicle_id uuid,
  p_body integer,
  p_deep integer,
  p_weekdays integer[],
  p_duration_months integer,
  p_time_slot public.time_slot,
  p_start_date date,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL,
  p_custom_dates jsonb DEFAULT NULL,
  p_coupon text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_addr uuid := p_address_id;
  v_quote jsonb;
  v_id uuid;
  v_total integer;
  v_end date;
  v_custom jsonb;
  v_days smallint[];
  v_n integer := COALESCE(p_body, 0) + COALESCE(p_deep, 0);
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  IF v_addr IS NULL THEN v_addr := v_vehicle.address_id; END IF;
  IF v_addr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = v_addr AND customer_profile_id = v_profile) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;
  IF p_start_date IS NULL OR p_start_date < v_today + app_private.setting('membership_min_lead_days') THEN
    RAISE EXCEPTION 'Your membership can start from % at the earliest', v_today + app_private.setting('membership_min_lead_days');
  END IF;

  -- Validates the counts (4 to 28 a month), the length and the vehicle; raises a message a customer can read.
  v_quote := app_private.compute_monthly_quote(v_vehicle.vehicle_type, p_body, p_deep, p_duration_months);
  -- A coupon the customer typed in: an extra percentage off the plan price, as its own line. Raises a message a customer can read if it cannot be used.
  v_quote := app_private.apply_coupon(v_quote, p_coupon, v_profile);
  v_days := app_private.clean_weekdays(p_weekdays);
  v_total := (v_quote->>'washes_total')::integer;
  v_end := app_private.membership_term_end(p_start_date, p_duration_months);

  IF p_custom_dates IS NULL THEN
    -- every month needs room for every wash: at least 4 days a month for each weekday chosen, so n washes need ceil(n / 4) weekdays
    IF cardinality(v_days) < CEIL(v_n / 4.0)::integer THEN
      RAISE EXCEPTION 'Pick at least % day% of the week so your % washes a month fit', CEIL(v_n / 4.0)::integer, CASE WHEN CEIL(v_n / 4.0) = 1 THEN '' ELSE 's' END, v_n;
    END IF;
    IF (SELECT count(*) FROM app_private.plan_monthly_washes(p_vehicle_id, p_start_date, p_duration_months, p_body, p_deep, v_days)) < v_total THEN
      RAISE EXCEPTION 'We cannot fit all % washes on those days: some days already have a wash for this vehicle. Choose more days, or pick exact dates.', v_total;
    END IF;
  ELSE
    v_custom := app_private.check_custom_dates_counts(p_vehicle_id, p_start_date, v_end, p_body * p_duration_months, p_deep * p_duration_months, CEIL(v_n / 4.0)::integer, p_custom_dates);
  END IF;

  BEGIN
    INSERT INTO public.membership_requests (
      customer_profile_id, vehicle_id, address_id, parking_location, frequency_per_week, duration_months,
      weekly_pattern, time_slot, target_completion_time, start_date, customer_notes, system_quote, custom_dates,
      monthly_body, monthly_deep, preferred_weekdays
    ) VALUES (
      v_profile, p_vehicle_id, v_addr, COALESCE(NULLIF(trim(p_parking_location), ''), v_vehicle.parking_location),
      (v_quote->>'frequency_per_week')::integer, p_duration_months, '[]'::jsonb, p_time_slot, p_target_completion_time,
      p_start_date, NULLIF(trim(p_customer_notes), ''), v_quote, v_custom,
      p_body, p_deep, v_days
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'You already have a membership request in progress for this vehicle';
  END;

  PERFORM app_private.audit('membership_request', v_id, 'membership_requested',
    jsonb_build_object('washes_per_month', v_n, 'body', p_body, 'deep', p_deep, 'duration_months', p_duration_months));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.start_monthly_membership_checkout(
  p_vehicle_id uuid,
  p_body integer,
  p_deep integer,
  p_weekdays integer[],
  p_duration_months integer,
  p_time_slot public.time_slot,
  p_start_date date,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_customer_notes text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL,
  p_custom_dates jsonb DEFAULT NULL,
  p_coupon text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_custom jsonb;
  v_days smallint[];
  v_same uuid;
  v_id uuid;
  v_req public.membership_requests%ROWTYPE;
  v_final bigint;
  v_pay jsonb;
  v_code text;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;

  -- Retrying the very same plan while its payment is still open: hand back that payment instead of making another.
  BEGIN
    v_code := app_private.clean_coupon_code(p_coupon);
    v_days := app_private.clean_weekdays(p_weekdays);
    IF p_custom_dates IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('date', (e->>'date')::date, 'kind', e->>'kind') ORDER BY (e->>'date')::date)
        INTO v_custom FROM jsonb_array_elements(p_custom_dates) e;
    END IF;
    SELECT r.id INTO v_same
      FROM public.membership_requests r JOIN public.payments pay ON pay.id = r.payment_id
      JOIN public.vehicles v ON v.id = r.vehicle_id
     WHERE r.customer_profile_id = v_profile AND r.vehicle_id = p_vehicle_id AND r.status = 'accepted'
       AND pay.status = 'pending' AND pay.expires_at > now()
       AND r.monthly_body = p_body AND r.monthly_deep = p_deep AND r.preferred_weekdays = v_days
       AND r.duration_months = p_duration_months AND r.time_slot = p_time_slot AND r.start_date = p_start_date
       AND r.custom_dates IS NOT DISTINCT FROM v_custom
       AND (r.system_quote->'coupon'->>'code') IS NOT DISTINCT FROM v_code
       AND r.address_id IS NOT DISTINCT FROM COALESCE(p_address_id, v.address_id)
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_same := NULL; -- malformed input is reported by the validation below
  END;
  IF v_same IS NOT NULL THEN
    v_pay := public.accept_membership_quote(v_same);
    RETURN v_pay || jsonb_build_object('request_id', v_same);
  END IF;

  -- A different plan for the same vehicle replaces this customer's unfinished checkout (it must not block a fresh one).
  UPDATE public.payments SET status = 'failed', updated_at = now()
   WHERE status = 'pending' AND id IN (SELECT payment_id FROM public.membership_requests
                                        WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id
                                          AND status IN ('quoted', 'accepted') AND payment_id IS NOT NULL);
  UPDATE public.membership_requests SET status = 'cancelled', updated_at = now()
   WHERE customer_profile_id = v_profile AND vehicle_id = p_vehicle_id AND status IN ('submitted', 'quoted', 'accepted');

  v_id := public.create_monthly_membership_request(p_vehicle_id, p_body, p_deep, p_weekdays, p_duration_months, p_time_slot, p_start_date,
                                                   p_address_id, p_parking_location, p_customer_notes, p_target_completion_time, p_custom_dates, p_coupon);

  SELECT * INTO v_req FROM public.membership_requests WHERE id = v_id FOR UPDATE;
  v_final := (v_req.system_quote->>'final_cents')::bigint;
  UPDATE public.membership_requests
     SET status = 'quoted', adjustment_cents = 0, adjustment_reason = NULL, quoted_amount_cents = v_final::int,
         quoted_breakdown = v_req.system_quote || jsonb_build_object('adjustment', jsonb_build_object('cents', 0, 'reason', NULL), 'final_cents', v_final),
         quote_expires_at = now() + make_interval(mins => app_private.setting('payment_intent_minutes') + 5),
         reviewed_at = now(), updated_at = now()
   WHERE id = v_id;

  PERFORM app_private.audit('membership_request', v_id, 'membership_checkout_started',
    jsonb_build_object('quoted_amount_cents', v_final, 'washes_per_month', v_req.monthly_body + v_req.monthly_deep, 'duration_months', v_req.duration_months));

  v_pay := public.accept_membership_quote(v_id);
  RETURN v_pay || jsonb_build_object('request_id', v_id);
END $$;

-- ───────────────────────── grants ─────────────────────────
REVOKE ALL ON FUNCTION public.create_monthly_membership_request(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_monthly_membership_request(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb, text) TO authenticated;
REVOKE ALL ON FUNCTION public.start_monthly_membership_checkout(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_monthly_membership_checkout(uuid, integer, integer, integer[], integer, public.time_slot, date, uuid, text, text, text, jsonb, text) TO authenticated;

-- ───────────────────────── the Admin page ─────────────────────────
-- One coupon as the page shows it, with how often it was used (paid for) and how much it saved.
CREATE OR REPLACE FUNCTION app_private.coupon_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
           'id', c.id, 'code', c.code, 'discount_bp', c.discount_bp, 'label', c.label, 'is_active', c.is_active, 'expires_on', c.expires_on, 'max_uses', c.max_uses,
           'once_per_customer', c.once_per_customer, 'created_at', c.created_at,
           'uses', COALESCE(u.n, 0), 'saved_cents', COALESCE(u.saved, 0), 'last_used_at', u.last_at,
           'status', CASE WHEN NOT c.is_active THEN 'off'
                          WHEN c.expires_on IS NOT NULL AND c.expires_on < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'expired'
                          WHEN c.max_uses IS NOT NULL AND COALESCE(u.n, 0) >= c.max_uses THEN 'used_up'
                          ELSE 'live' END)
    FROM public.membership_coupons c
    LEFT JOIN LATERAL (SELECT count(*)::integer n, COALESCE(sum(r.discount_cents), 0)::bigint saved, max(r.created_at) last_at FROM public.membership_coupon_redemptions r WHERE r.coupon_id = c.id) u ON true
   WHERE c.id = p_id
$$;
REVOKE ALL ON FUNCTION app_private.coupon_json(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_coupons() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('campaigns', 'view');
  RETURN COALESCE((SELECT jsonb_agg(app_private.coupon_json(c.id) ORDER BY c.is_active DESC, c.created_at DESC) FROM public.membership_coupons c), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.admin_list_coupons() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_coupons() TO authenticated;

-- Make a coupon (p_id NULL) or change one (the code itself never changes: make a new coupon for a new code).
CREATE OR REPLACE FUNCTION public.admin_save_coupon(
  p_id uuid, p_code text, p_discount_bp integer, p_label text, p_expires_on date, p_max_uses integer, p_once_per_customer boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('campaigns', 'manage');
  v_code text := upper(btrim(COALESCE(p_code, '')));
  v_label text := NULLIF(btrim(COALESCE(p_label, '')), '');
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_old jsonb; v_id uuid;
BEGIN
  IF p_discount_bp IS NULL OR p_discount_bp < 1 OR p_discount_bp > 5000 THEN RAISE EXCEPTION 'A coupon takes between 0.01%% and 50%% off'; END IF;
  IF v_label IS NOT NULL AND char_length(v_label) > 60 THEN RAISE EXCEPTION 'Keep the note to 60 characters'; END IF;
  IF p_max_uses IS NOT NULL AND (p_max_uses < 1 OR p_max_uses > 1000000) THEN RAISE EXCEPTION 'The most uses must be 1 or more'; END IF;
  IF p_once_per_customer IS NULL THEN RAISE EXCEPTION 'Say whether a customer may use it once or more than once'; END IF;
  IF p_id IS NULL THEN
    IF v_code !~ '^[A-Z0-9]{3,20}$' THEN RAISE EXCEPTION 'The code is 3 to 20 letters and numbers, with no spaces'; END IF;
    IF p_expires_on IS NOT NULL AND p_expires_on < v_today THEN RAISE EXCEPTION 'The last day cannot be in the past'; END IF;
    BEGIN
      INSERT INTO public.membership_coupons (code, discount_bp, label, expires_on, max_uses, once_per_customer, created_by)
      VALUES (v_code, p_discount_bp, v_label, p_expires_on, p_max_uses, p_once_per_customer, v_me) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'A coupon with that code already exists';
    END;
    PERFORM app_private.audit('coupon', v_id, 'coupon_created', jsonb_build_object('code', v_code, 'discount_bp', p_discount_bp, 'expires_on', p_expires_on, 'max_uses', p_max_uses, 'once_per_customer', p_once_per_customer));
  ELSE
    SELECT app_private.coupon_json(c.id) INTO v_old FROM public.membership_coupons c WHERE c.id = p_id FOR UPDATE;
    IF v_old IS NULL THEN RAISE EXCEPTION 'Coupon not found'; END IF;
    IF v_code <> '' AND v_code <> v_old->>'code' THEN RAISE EXCEPTION 'A coupon''s code cannot be changed. Make a new coupon instead.'; END IF;
    UPDATE public.membership_coupons SET discount_bp = p_discount_bp, label = v_label, expires_on = p_expires_on, max_uses = p_max_uses, once_per_customer = p_once_per_customer, updated_at = now() WHERE id = p_id;
    v_id := p_id;
    PERFORM app_private.audit('coupon', v_id, 'coupon_changed', jsonb_build_object('code', v_old->>'code',
      'from', jsonb_build_object('discount_bp', v_old->'discount_bp', 'expires_on', v_old->'expires_on', 'max_uses', v_old->'max_uses', 'once_per_customer', v_old->'once_per_customer'),
      'to', jsonb_build_object('discount_bp', p_discount_bp, 'expires_on', p_expires_on, 'max_uses', p_max_uses, 'once_per_customer', p_once_per_customer)));
  END IF;
  RETURN app_private.coupon_json(v_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_save_coupon(uuid, text, integer, text, date, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_coupon(uuid, text, integer, text, date, integer, boolean) TO authenticated;

-- Switch a coupon off or on (nothing is ever deleted: the uses stay on record).
CREATE OR REPLACE FUNCTION public.admin_set_coupon_active(p_id uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_code text;
BEGIN
  PERFORM app_private.require_access('campaigns', 'manage');
  IF p_active IS NULL THEN RAISE EXCEPTION 'Say whether the coupon is on or off'; END IF;
  UPDATE public.membership_coupons SET is_active = p_active, updated_at = now() WHERE id = p_id RETURNING code INTO v_code;
  IF v_code IS NULL THEN RAISE EXCEPTION 'Coupon not found'; END IF;
  PERFORM app_private.audit('coupon', p_id, CASE WHEN p_active THEN 'coupon_switched_on' ELSE 'coupon_switched_off' END, jsonb_build_object('code', v_code));
  RETURN app_private.coupon_json(p_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_coupon_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_coupon_active(uuid, boolean) TO authenticated;

-- Who used a coupon (the latest 50): the customer, the plan's reference, what it saved.
CREATE OR REPLACE FUNCTION public.admin_coupon_uses(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('campaigns', 'view');
  IF NOT EXISTS (SELECT 1 FROM public.membership_coupons WHERE id = p_id) THEN RAISE EXCEPTION 'Coupon not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY (x ->> 'at') DESC) FROM (
      SELECT jsonb_build_object('id', r.id, 'at', r.created_at, 'customer_name', p.full_name, 'customer_phone', p.phone, 'reference_code', q.reference_code,
                                'discount_cents', r.discount_cents, 'membership_id', r.membership_id, 'plan_cents', m.final_amount_cents) AS x
        FROM public.membership_coupon_redemptions r
        JOIN public.profiles p ON p.id = r.customer_profile_id
        JOIN public.memberships m ON m.id = r.membership_id
        LEFT JOIN public.membership_requests q ON q.id = m.membership_request_id
       WHERE r.coupon_id = p_id ORDER BY r.created_at DESC LIMIT 50) s), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.admin_coupon_uses(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_coupon_uses(uuid) TO authenticated;
