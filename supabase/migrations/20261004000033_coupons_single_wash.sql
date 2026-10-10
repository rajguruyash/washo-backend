-- 20261004000033_coupons_single_wash.sql
-- SAFE / additive. Coupons (migration 32) can now be for memberships, for single washes, or for both, and a single wash can be paid for with one.
--
--   membership_coupons.applies_to           'membership' | 'single' | 'both'   (coupons made before this keep working on memberships only)
--   membership_coupon_redemptions           a use is now a membership OR a single wash (booking_id)
--   app_private.check_coupon                one place that decides "can this customer use this code for this?" (on, not expired, not used up, not used before by them,
--                                           and meant for this kind of purchase); apply_coupon (memberships) now asks it
--   app_private.coupon_for_single           the same, put on a single wash's price
--   estimate_single_wash_with_coupon        what the single-wash review step shows (signed-in customers only)
--   create_booking_payment_intent_with_coupon   the single-wash checkout with a coupon. It CALLS the existing create_booking_payment_intent (left exactly as it is: the mobile
--                                           app may use it) and then takes the coupon off that payment's amount, so every other check and the settlement are unchanged
--   a trigger on payments                   records the use when the single wash is PAID for (never for an abandoned checkout), exactly as migration 32 does for memberships
--   admin_save_coupon (replaced)            takes "works on" (an old call without it makes a memberships coupon)
--   coupon_json / admin_coupon_uses         say what a coupon works on and whether each use was a membership or a single wash
-- The coupon is frozen in the payment when the checkout starts, so the customer pays exactly what the review step showed, and a payment already taken is never refused.

ALTER TABLE public.membership_coupons ADD COLUMN IF NOT EXISTS applies_to text NOT NULL DEFAULT 'membership';
ALTER TABLE public.membership_coupons DROP CONSTRAINT IF EXISTS membership_coupons_applies_check;
ALTER TABLE public.membership_coupons ADD CONSTRAINT membership_coupons_applies_check CHECK (applies_to IN ('membership', 'single', 'both'));

ALTER TABLE public.membership_coupon_redemptions ALTER COLUMN membership_id DROP NOT NULL;
ALTER TABLE public.membership_coupon_redemptions ADD COLUMN IF NOT EXISTS booking_id uuid UNIQUE REFERENCES public.bookings(id) ON DELETE RESTRICT;
ALTER TABLE public.membership_coupon_redemptions DROP CONSTRAINT IF EXISTS membership_coupon_redemptions_one_target_check;
ALTER TABLE public.membership_coupon_redemptions ADD CONSTRAINT membership_coupon_redemptions_one_target_check CHECK ((membership_id IS NOT NULL) <> (booking_id IS NOT NULL));

-- Can this customer use this code for this kind of purchase ('membership' or 'single')? Returns the coupon, or raises a message a customer can read.
CREATE OR REPLACE FUNCTION app_private.check_coupon(p_code text, p_customer uuid, p_for text) RETURNS public.membership_coupons
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text := app_private.clean_coupon_code(p_code);
  c public.membership_coupons%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF v_code IS NULL THEN RAISE EXCEPTION 'Enter a coupon code'; END IF;
  SELECT * INTO c FROM public.membership_coupons WHERE code = v_code;
  IF NOT FOUND OR NOT c.is_active THEN RAISE EXCEPTION 'That coupon code is not valid'; END IF;
  IF c.applies_to <> 'both' AND c.applies_to <> p_for THEN
    RAISE EXCEPTION '%', CASE WHEN p_for = 'membership' THEN 'That coupon is for single washes only' ELSE 'That coupon is for memberships only' END;
  END IF;
  IF c.expires_on IS NOT NULL AND v_today > c.expires_on THEN RAISE EXCEPTION 'That coupon has expired'; END IF;
  IF c.max_uses IS NOT NULL AND (SELECT count(*) FROM public.membership_coupon_redemptions r WHERE r.coupon_id = c.id) >= c.max_uses THEN RAISE EXCEPTION 'That coupon has been used up'; END IF;
  IF c.once_per_customer AND p_customer IS NOT NULL AND EXISTS (SELECT 1 FROM public.membership_coupon_redemptions r WHERE r.coupon_id = c.id AND r.customer_profile_id = p_customer) THEN
    RAISE EXCEPTION 'You have already used this coupon';
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION app_private.check_coupon(text, uuid, text) FROM PUBLIC, anon, authenticated;

-- Memberships: the same as migration 32, now through check_coupon.
CREATE OR REPLACE FUNCTION app_private.apply_coupon(p_quote jsonb, p_code text, p_customer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.membership_coupons%ROWTYPE;
  v_subtotal integer; v_cents integer; v_total integer;
BEGIN
  IF app_private.clean_coupon_code(p_code) IS NULL THEN RETURN p_quote; END IF;
  c := app_private.check_coupon(p_code, p_customer, 'membership');
  v_subtotal := (p_quote->>'subtotal_cents')::integer;
  v_cents := round(v_subtotal::numeric * c.discount_bp / 10000);
  v_total := (p_quote->>'total_discount_cents')::integer + v_cents;
  RETURN p_quote || jsonb_build_object(
    'coupon', jsonb_build_object('id', c.id, 'code', c.code, 'bp', c.discount_bp, 'cents', v_cents),
    'total_discount_cents', v_total,
    'final_cents', v_subtotal - v_total);
END $$;

-- A single wash's price with a coupon on it: { coupon: {id, code, bp, cents}, final_cents }.
CREATE OR REPLACE FUNCTION app_private.coupon_for_single(p_code text, p_customer uuid, p_price_cents integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.membership_coupons%ROWTYPE;
  v_cents integer;
BEGIN
  c := app_private.check_coupon(p_code, p_customer, 'single');
  v_cents := round(p_price_cents::numeric * c.discount_bp / 10000);
  IF p_price_cents - v_cents < 100 THEN RAISE EXCEPTION 'That coupon would take the price below Rs 1'; END IF;
  RETURN jsonb_build_object('coupon', jsonb_build_object('id', c.id, 'code', c.code, 'bp', c.discount_bp, 'cents', v_cents), 'final_cents', p_price_cents - v_cents);
END $$;
REVOKE ALL ON FUNCTION app_private.apply_coupon(jsonb, text, uuid), app_private.coupon_for_single(text, uuid, integer) FROM PUBLIC, anon, authenticated;

-- The single-wash review step: the rate-card price, and with the coupon if one is typed (nothing is stored).
CREATE OR REPLACE FUNCTION public.estimate_single_wash_with_coupon(p_vehicle_id uuid, p_service_id uuid, p_coupon text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_vehicle public.vehicles%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_price integer;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Sign in to use a coupon' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = v_profile AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  SELECT * INTO v_service FROM public.services WHERE id = p_service_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service not found'; END IF;
  IF NOT (v_service.vehicle_type = v_vehicle.vehicle_type OR (v_vehicle.vehicle_type = 'suv' AND v_service.vehicle_type = 'car')) THEN
    RAISE EXCEPTION 'This service is not available for your vehicle';
  END IF;
  v_price := app_private.unit_price_cents(v_service.id, v_vehicle.vehicle_type);
  IF v_price IS NULL OR v_price < 100 THEN RAISE EXCEPTION 'No price is set for this service'; END IF;
  IF app_private.clean_coupon_code(p_coupon) IS NULL THEN RETURN jsonb_build_object('list_cents', v_price, 'final_cents', v_price); END IF;
  RETURN jsonb_build_object('list_cents', v_price) || app_private.coupon_for_single(p_coupon, v_profile, v_price);
END $$;
REVOKE ALL ON FUNCTION public.estimate_single_wash_with_coupon(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.estimate_single_wash_with_coupon(uuid, uuid, text) TO authenticated;

-- The single-wash checkout with a coupon. With no coupon this is exactly create_booking_payment_intent.
CREATE OR REPLACE FUNCTION public.create_booking_payment_intent_with_coupon(
  p_vehicle_id uuid,
  p_service_id uuid,
  p_scheduled_date date,
  p_time_slot public.time_slot,
  p_address_id uuid DEFAULT NULL,
  p_parking_location text DEFAULT NULL,
  p_target_completion_time text DEFAULT NULL,
  p_source text DEFAULT 'website',
  p_coupon text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_intent jsonb;
  v_pay public.payments%ROWTYPE;
  v_c jsonb;
  v_list integer;
BEGIN
  v_intent := public.create_booking_payment_intent(p_vehicle_id, p_service_id, p_scheduled_date, p_time_slot, p_address_id, p_parking_location, p_target_completion_time, p_source);
  IF app_private.clean_coupon_code(p_coupon) IS NULL THEN RETURN v_intent; END IF;
  SELECT * INTO v_pay FROM public.payments WHERE id = (v_intent->>'payment_id')::uuid AND customer_profile_id = v_profile FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  v_list := v_pay.amount_cents;
  v_c := app_private.coupon_for_single(p_coupon, v_profile, v_list);   -- raises, and so undoes the payment above, when the coupon cannot be used
  UPDATE public.payments
     SET amount_cents = (v_c->>'final_cents')::integer, updated_at = now(),
         intent = intent || jsonb_build_object('coupon', v_c->'coupon', 'list_price_cents', v_list)
   WHERE id = v_pay.id;
  RETURN v_intent || jsonb_build_object('amount_cents', (v_c->>'final_cents')::integer, 'list_price_cents', v_list, 'coupon', v_c->'coupon');
END $$;
REVOKE ALL ON FUNCTION public.create_booking_payment_intent_with_coupon(uuid, uuid, date, public.time_slot, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_booking_payment_intent_with_coupon(uuid, uuid, date, public.time_slot, uuid, text, text, text, text) TO authenticated;

-- A single wash that is PAID for and carries a coupon records the use (once: booking_id is unique).
CREATE OR REPLACE FUNCTION app_private.record_single_coupon_redemption() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.membership_coupon_redemptions (coupon_id, customer_profile_id, booking_id, code, discount_bp, discount_cents)
  SELECT c.id, NEW.customer_profile_id, NEW.booking_id, c.code, (NEW.intent->'coupon'->>'bp')::integer, (NEW.intent->'coupon'->>'cents')::integer
    FROM public.membership_coupons c WHERE c.id = (NEW.intent->'coupon'->>'id')::uuid
  ON CONFLICT (booking_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.record_single_coupon_redemption() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS payments_record_coupon ON public.payments;
CREATE TRIGGER payments_record_coupon AFTER UPDATE ON public.payments
  FOR EACH ROW WHEN (NEW.payment_kind = 'on_demand' AND NEW.booking_id IS NOT NULL AND OLD.booking_id IS DISTINCT FROM NEW.booking_id AND NEW.intent ? 'coupon')
  EXECUTE FUNCTION app_private.record_single_coupon_redemption();

-- ───────────────────────── the Admin page ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.coupon_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
           'id', c.id, 'code', c.code, 'discount_bp', c.discount_bp, 'label', c.label, 'is_active', c.is_active, 'expires_on', c.expires_on, 'max_uses', c.max_uses,
           'once_per_customer', c.once_per_customer, 'applies_to', c.applies_to, 'created_at', c.created_at,
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

-- Make a coupon (p_id NULL) or change one. The code never changes; "works on" can.
DROP FUNCTION IF EXISTS public.admin_save_coupon(uuid, text, integer, text, date, integer, boolean);
CREATE OR REPLACE FUNCTION public.admin_save_coupon(
  p_id uuid, p_code text, p_discount_bp integer, p_label text, p_expires_on date, p_max_uses integer, p_once_per_customer boolean, p_applies_to text DEFAULT 'membership'
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
  IF p_applies_to IS NULL OR p_applies_to NOT IN ('membership', 'single', 'both') THEN RAISE EXCEPTION 'Say what the coupon works on: memberships, single washes or both'; END IF;
  IF p_id IS NULL THEN
    IF v_code !~ '^[A-Z0-9]{3,20}$' THEN RAISE EXCEPTION 'The code is 3 to 20 letters and numbers, with no spaces'; END IF;
    IF p_expires_on IS NOT NULL AND p_expires_on < v_today THEN RAISE EXCEPTION 'The last day cannot be in the past'; END IF;
    BEGIN
      INSERT INTO public.membership_coupons (code, discount_bp, label, expires_on, max_uses, once_per_customer, applies_to, created_by)
      VALUES (v_code, p_discount_bp, v_label, p_expires_on, p_max_uses, p_once_per_customer, p_applies_to, v_me) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'A coupon with that code already exists';
    END;
    PERFORM app_private.audit('coupon', v_id, 'coupon_created', jsonb_build_object('code', v_code, 'discount_bp', p_discount_bp, 'expires_on', p_expires_on, 'max_uses', p_max_uses, 'once_per_customer', p_once_per_customer, 'applies_to', p_applies_to));
  ELSE
    SELECT app_private.coupon_json(c.id) INTO v_old FROM public.membership_coupons c WHERE c.id = p_id FOR UPDATE;
    IF v_old IS NULL THEN RAISE EXCEPTION 'Coupon not found'; END IF;
    IF v_code <> '' AND v_code <> v_old->>'code' THEN RAISE EXCEPTION 'A coupon''s code cannot be changed. Make a new coupon instead.'; END IF;
    UPDATE public.membership_coupons SET discount_bp = p_discount_bp, label = v_label, expires_on = p_expires_on, max_uses = p_max_uses, once_per_customer = p_once_per_customer, applies_to = p_applies_to, updated_at = now() WHERE id = p_id;
    v_id := p_id;
    PERFORM app_private.audit('coupon', v_id, 'coupon_changed', jsonb_build_object('code', v_old->>'code',
      'from', jsonb_build_object('discount_bp', v_old->'discount_bp', 'expires_on', v_old->'expires_on', 'max_uses', v_old->'max_uses', 'once_per_customer', v_old->'once_per_customer', 'applies_to', v_old->'applies_to'),
      'to', jsonb_build_object('discount_bp', p_discount_bp, 'expires_on', p_expires_on, 'max_uses', p_max_uses, 'once_per_customer', p_once_per_customer, 'applies_to', p_applies_to)));
  END IF;
  RETURN app_private.coupon_json(v_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_save_coupon(uuid, text, integer, text, date, integer, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_coupon(uuid, text, integer, text, date, integer, boolean, text) TO authenticated;

-- Who used a coupon (the latest 50): a membership or a single wash, the customer, what it saved.
CREATE OR REPLACE FUNCTION public.admin_coupon_uses(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('campaigns', 'view');
  IF NOT EXISTS (SELECT 1 FROM public.membership_coupons WHERE id = p_id) THEN RAISE EXCEPTION 'Coupon not found'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(x ORDER BY (x ->> 'at') DESC) FROM (
      SELECT jsonb_build_object('id', r.id, 'at', r.created_at, 'customer_name', p.full_name, 'customer_phone', p.phone,
                                'kind', CASE WHEN r.booking_id IS NOT NULL THEN 'single' ELSE 'membership' END,
                                'reference_code', COALESCE(q.reference_code, s.name),
                                'discount_cents', r.discount_cents, 'membership_id', r.membership_id, 'booking_id', r.booking_id,
                                'plan_cents', COALESCE(m.final_amount_cents, b.price_cents)) AS x
        FROM public.membership_coupon_redemptions r
        JOIN public.profiles p ON p.id = r.customer_profile_id
        LEFT JOIN public.memberships m ON m.id = r.membership_id
        LEFT JOIN public.membership_requests q ON q.id = m.membership_request_id
        LEFT JOIN public.bookings b ON b.id = r.booking_id
        LEFT JOIN public.services s ON s.id = b.service_id
       WHERE r.coupon_id = p_id ORDER BY r.created_at DESC LIMIT 50) z), '[]'::jsonb);
END $$;
