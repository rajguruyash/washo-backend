-- 20261004000013_admin_management.sql
-- SAFE / additive and re-runnable. What the Admin page needs to create, edit and "delete" people, washes, services and prices.
--
-- Nothing here deletes data. "Delete" means ARCHIVE: the row stays (payments, refunds and wash history always point at something),
-- it disappears from the working lists, and it can be restored. The existing admin_delete_* functions (which hard-delete, and exist
-- for the mobile app) are not used by the website.
--
--   profiles.archived_at / customer_addresses.archived_at      NULL = in use
--   admin_update_customer_profile      name + email only (a customer's phone is their sign-in; they verify it themselves)
--   admin_set_profile_archived         archive/restore a customer or specialist, with the safety rules below
--   admin_save_vehicle / admin_set_vehicle_active
--   admin_save_address / admin_set_address_archived
--   admin_create_booking               a wash booked for a customer by WASHO (paid in cash, or complimentary)
--   admin_update_booking_details       address, parking spot, note
--   admin_save_service / admin_set_service_active / admin_set_service_price (versioned) / admin_set_discount / admin_remove_discount /
--   admin_set_pricing_setting
--
-- Rules the database enforces (not just the screens):
--   * a customer with scheduled washes or an active membership cannot be archived
--   * a specialist is archived by returning their upcoming washes to the pool; one with a wash in progress cannot be archived
--   * an archived specialist can never be assigned a wash or made a membership's regular specialist
--   * prices are never edited in place: the old rule is closed and a new one starts, so history stays readable
--   * every change writes an audit event

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.customer_addresses ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE OR REPLACE FUNCTION app_private.require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  RETURN public.current_profile_id();
END $$;
REVOKE ALL ON FUNCTION app_private.require_admin() FROM PUBLIC, anon, authenticated;

-- ───────────────────────── an archived specialist is never given work ─────────────────────────
CREATE OR REPLACE FUNCTION app_private.refuse_archived_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.worker_profile_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'That specialist is archived. Restore them first, or choose someone else.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.refuse_archived_assignment() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.refuse_archived_regular_specialist() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.assigned_worker_profile_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles WHERE id = NEW.assigned_worker_profile_id AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'That specialist is archived. Restore them first, or choose someone else.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.refuse_archived_regular_specialist() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS worker_assignments_not_archived ON public.worker_assignments;
CREATE TRIGGER worker_assignments_not_archived BEFORE INSERT ON public.worker_assignments
  FOR EACH ROW EXECUTE FUNCTION app_private.refuse_archived_assignment();
DROP TRIGGER IF EXISTS memberships_assignee_not_archived ON public.memberships;
CREATE TRIGGER memberships_assignee_not_archived BEFORE INSERT OR UPDATE OF assigned_worker_profile_id ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION app_private.refuse_archived_regular_specialist();

-- ───────────────────────── customers ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_update_customer_profile(p_customer_id uuid, p_full_name text, p_email text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text := trim(COALESCE(p_full_name, ''));
  v_email text := NULLIF(lower(trim(COALESCE(p_email, ''))), '');
BEGIN
  PERFORM app_private.require_admin();
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN RAISE EXCEPTION 'Enter the customer''s full name'; END IF;
  IF v_email IS NOT NULL AND (char_length(v_email) > 160 OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN
    RAISE EXCEPTION 'Enter a valid email address';
  END IF;
  UPDATE public.profiles SET full_name = v_name, email = v_email, updated_at = now() WHERE id = p_customer_id AND role = 'customer';
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  PERFORM app_private.audit('profile', p_customer_id, 'customer_updated', jsonb_build_object('full_name', v_name, 'email', v_email));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_profile_archived(p_profile_id uuid, p_archived boolean, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_admin();
  v_p public.profiles%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_live integer;
  v_members integer;
  v_released integer := 0;
  v_released_members integer := 0;
  b record;
  m record;
BEGIN
  IF p_profile_id = v_me THEN RAISE EXCEPTION 'You cannot archive your own account'; END IF;
  SELECT * INTO v_p FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT FOUND OR v_p.role NOT IN ('customer', 'worker') THEN RAISE EXCEPTION 'Person not found'; END IF;

  IF NOT p_archived THEN
    UPDATE public.profiles SET archived_at = NULL, updated_at = now() WHERE id = p_profile_id;
    PERFORM app_private.audit('profile', p_profile_id, 'profile_restored', jsonb_build_object('role', v_p.role));
    RETURN jsonb_build_object('archived', false, 'auth_user_id', v_p.auth_user_id);
  END IF;
  IF v_p.archived_at IS NOT NULL THEN RETURN jsonb_build_object('archived', true, 'released_washes', 0, 'released_memberships', 0, 'auth_user_id', v_p.auth_user_id); END IF;

  IF v_p.role = 'customer' THEN
    SELECT count(*) INTO v_live FROM public.bookings
     WHERE customer_profile_id = p_profile_id AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress');
    SELECT count(*) INTO v_members FROM public.memberships WHERE customer_profile_id = p_profile_id AND status = 'active';
    IF v_live > 0 OR v_members > 0 THEN
      RAISE EXCEPTION 'This customer still has % scheduled wash(es) and % active membership(s). Cancel them first, then archive.', v_live, v_members;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.worker_assignments wa JOIN public.bookings bk ON bk.id = wa.booking_id
                WHERE wa.worker_profile_id = p_profile_id AND wa.is_active AND bk.status = 'in_progress') THEN
      RAISE EXCEPTION 'This specialist has a wash in progress. Wait until it is finished.';
    END IF;
    -- Regular specialist of memberships: release those washes to the pool (the existing function does the bookkeeping).
    FOR m IN SELECT id FROM public.memberships WHERE assigned_worker_profile_id = p_profile_id AND status = 'active' LOOP
      PERFORM public.admin_assign_membership_worker(m.id, NULL);
      v_released_members := v_released_members + 1;
    END LOOP;
    -- Everything else they were due to do goes back to the pool too.
    FOR b IN
      SELECT bk.id FROM public.worker_assignments wa JOIN public.bookings bk ON bk.id = wa.booking_id
       WHERE wa.worker_profile_id = p_profile_id AND wa.is_active AND bk.scheduled_date >= v_today
         AND bk.status IN ('confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up')
       FOR UPDATE OF bk
    LOOP
      UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = b.id AND is_active;
      UPDATE public.bookings SET status = 'confirmed', customer_confirmed_at = NULL, updated_at = now() WHERE id = b.id;
      INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
      VALUES (b.id, 'admin_booking_updated', v_me, jsonb_build_object('released_from_worker', p_profile_id, 'reason', 'specialist archived'));
      v_released := v_released + 1;
    END LOOP;
  END IF;

  UPDATE public.profiles SET archived_at = now(), updated_at = now() WHERE id = p_profile_id;
  PERFORM app_private.audit('profile', p_profile_id, 'profile_archived',
    jsonb_build_object('role', v_p.role, 'reason', left(COALESCE(p_reason, ''), 200), 'released_washes', v_released, 'released_memberships', v_released_members));
  RETURN jsonb_build_object('archived', true, 'released_washes', v_released, 'released_memberships', v_released_members, 'auth_user_id', v_p.auth_user_id);
END $$;

-- Setting a specialist's password is done by Supabase Auth (the server calls it); this checks who it is for and leaves the audit trail.
CREATE OR REPLACE FUNCTION public.admin_begin_password_reset(p_worker_profile_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_auth uuid;
BEGIN
  PERFORM app_private.require_admin();
  SELECT auth_user_id INTO v_auth FROM public.profiles WHERE id = p_worker_profile_id AND role = 'worker' AND archived_at IS NULL;
  IF v_auth IS NULL THEN RAISE EXCEPTION 'Specialist not found'; END IF;
  PERFORM app_private.audit('profile', p_worker_profile_id, 'worker_password_reset', '{}'::jsonb);
  RETURN v_auth;
END $$;

-- ───────────────────────── a customer's vehicles ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_save_vehicle(
  p_vehicle_id uuid, p_customer_id uuid, p_vehicle_type public.vehicle_type, p_make text, p_model text,
  p_registration_number text, p_color text DEFAULT NULL, p_address_id uuid DEFAULT NULL, p_parking_location text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_model text := trim(COALESCE(p_model, ''));
  v_reg text := upper(regexp_replace(trim(COALESCE(p_registration_number, '')), '\s+', ' ', 'g'));
  v_old public.vehicles%ROWTYPE;
  v_id uuid;
BEGIN
  PERFORM app_private.require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_customer_id AND role = 'customer') THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF char_length(v_model) < 1 OR char_length(v_model) > 60 THEN RAISE EXCEPTION 'Enter the model'; END IF;
  IF char_length(v_reg) < 4 OR char_length(v_reg) > 20 THEN RAISE EXCEPTION 'Enter the registration number'; END IF;
  IF p_address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = p_address_id AND customer_profile_id = p_customer_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;

  BEGIN
    IF p_vehicle_id IS NULL THEN
      INSERT INTO public.vehicles (customer_profile_id, vehicle_type, make, model, registration_number, color, address_id, parking_location)
      VALUES (p_customer_id, p_vehicle_type, COALESCE(trim(p_make), ''), v_model, v_reg, NULLIF(trim(COALESCE(p_color, '')), ''), p_address_id, NULLIF(trim(COALESCE(p_parking_location, '')), ''))
      RETURNING id INTO v_id;
      PERFORM app_private.audit('vehicle', v_id, 'vehicle_created_by_admin', jsonb_build_object('customer_id', p_customer_id, 'registration', v_reg));
    ELSE
      SELECT * INTO v_old FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = p_customer_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
      IF v_old.vehicle_type <> p_vehicle_type AND EXISTS (SELECT 1 FROM public.bookings WHERE vehicle_id = p_vehicle_id) THEN
        RAISE EXCEPTION 'This vehicle has wash history, so its type cannot be changed. Archive it and add a new one.';
      END IF;
      UPDATE public.vehicles
         SET vehicle_type = p_vehicle_type, make = COALESCE(trim(p_make), ''), model = v_model, registration_number = v_reg,
             color = NULLIF(trim(COALESCE(p_color, '')), ''), address_id = p_address_id,
             parking_location = NULLIF(trim(COALESCE(p_parking_location, '')), ''), updated_at = now()
       WHERE id = p_vehicle_id;
      v_id := p_vehicle_id;
      PERFORM app_private.audit('vehicle', v_id, 'vehicle_updated_by_admin', jsonb_build_object('customer_id', p_customer_id, 'registration', v_reg));
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This customer already has a vehicle with that registration number';
  END;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_vehicle_active(p_vehicle_id uuid, p_active boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_v public.vehicles%ROWTYPE;
BEGIN
  PERFORM app_private.require_admin();
  SELECT * INTO v_v FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  IF NOT p_active AND (
       EXISTS (SELECT 1 FROM public.bookings WHERE vehicle_id = p_vehicle_id AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress'))
    OR EXISTS (SELECT 1 FROM public.membership_services ms JOIN public.memberships m ON m.id = ms.membership_id WHERE ms.vehicle_id = p_vehicle_id AND m.status = 'active')
  ) THEN
    RAISE EXCEPTION 'This vehicle has scheduled washes or an active membership. Cancel those first.';
  END IF;
  BEGIN
    UPDATE public.vehicles SET is_active = p_active, updated_at = now() WHERE id = p_vehicle_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'The customer has another vehicle with this registration number, so this one cannot be restored';
  END;
  PERFORM app_private.audit('vehicle', p_vehicle_id, CASE WHEN p_active THEN 'vehicle_restored' ELSE 'vehicle_archived' END, jsonb_build_object('customer_id', v_v.customer_profile_id));
  RETURN true;
END $$;

-- ───────────────────────── a customer's addresses ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_save_address(
  p_address_id uuid, p_customer_id uuid, p_label text, p_society_name text, p_building_block text, p_flat_number text,
  p_parking_location text, p_area_locality text DEFAULT 'Kharadi', p_city text DEFAULT 'Pune', p_pincode text DEFAULT '411014', p_is_default boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_first boolean;
BEGIN
  PERFORM app_private.require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_customer_id AND role = 'customer') THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF char_length(trim(COALESCE(p_society_name, ''))) < 2 THEN RAISE EXCEPTION 'Enter the society or building'; END IF;
  IF char_length(trim(COALESCE(p_building_block, ''))) < 1 THEN RAISE EXCEPTION 'Enter the block or wing'; END IF;
  IF char_length(trim(COALESCE(p_flat_number, ''))) < 1 THEN RAISE EXCEPTION 'Enter the flat number'; END IF;
  IF char_length(trim(COALESCE(p_parking_location, ''))) < 2 THEN RAISE EXCEPTION 'Tell us where the vehicle is parked'; END IF;
  IF COALESCE(p_pincode, '') !~ '^\d{6}$' THEN RAISE EXCEPTION 'Enter a 6-digit pincode'; END IF;

  SELECT NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE customer_profile_id = p_customer_id AND archived_at IS NULL AND id IS DISTINCT FROM p_address_id) INTO v_first;
  IF p_address_id IS NULL THEN
    INSERT INTO public.customer_addresses (customer_profile_id, label, society_name, building_block, flat_number, parking_location, area_locality, city, pincode, is_default)
    VALUES (p_customer_id, COALESCE(NULLIF(trim(p_label), ''), 'Home'), trim(p_society_name), trim(p_building_block), trim(p_flat_number), trim(p_parking_location),
            COALESCE(NULLIF(trim(p_area_locality), ''), 'Kharadi'), COALESCE(NULLIF(trim(p_city), ''), 'Pune'), p_pincode, false)
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.customer_addresses
       SET label = COALESCE(NULLIF(trim(p_label), ''), label), society_name = trim(p_society_name), building_block = trim(p_building_block), flat_number = trim(p_flat_number),
           parking_location = trim(p_parking_location), area_locality = COALESCE(NULLIF(trim(p_area_locality), ''), area_locality),
           city = COALESCE(NULLIF(trim(p_city), ''), city), pincode = p_pincode, updated_at = now()
     WHERE id = p_address_id AND customer_profile_id = p_customer_id AND archived_at IS NULL
     RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Address not found'; END IF;
  END IF;
  IF p_is_default OR v_first THEN
    UPDATE public.customer_addresses SET is_default = false WHERE customer_profile_id = p_customer_id AND is_default AND id <> v_id;
    UPDATE public.customer_addresses SET is_default = true WHERE id = v_id;
  END IF;
  PERFORM app_private.audit('address', v_id, CASE WHEN p_address_id IS NULL THEN 'address_created_by_admin' ELSE 'address_updated_by_admin' END, jsonb_build_object('customer_id', p_customer_id));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_address_archived(p_address_id uuid, p_archived boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_a public.customer_addresses%ROWTYPE;
BEGIN
  PERFORM app_private.require_admin();
  SELECT * INTO v_a FROM public.customer_addresses WHERE id = p_address_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Address not found'; END IF;
  IF p_archived THEN
    IF EXISTS (SELECT 1 FROM public.bookings WHERE address_id = p_address_id AND status IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress')) THEN
      RAISE EXCEPTION 'A scheduled wash uses this address. Change that wash''s address first.';
    END IF;
    UPDATE public.customer_addresses SET archived_at = now(), is_default = false, updated_at = now() WHERE id = p_address_id;
    UPDATE public.vehicles SET address_id = NULL, updated_at = now() WHERE address_id = p_address_id;
  ELSE
    UPDATE public.customer_addresses SET archived_at = NULL, updated_at = now() WHERE id = p_address_id;
  END IF;
  PERFORM app_private.audit('address', p_address_id, CASE WHEN p_archived THEN 'address_archived' ELSE 'address_restored' END, jsonb_build_object('customer_id', v_a.customer_profile_id));
  RETURN true;
END $$;

-- ───────────────────────── washes ─────────────────────────
-- A wash WASHO books for a customer. p_payment:
--   'cash'    the customer paid WASHO directly: a paid offline payment at the rate-card price (a cancellation is refunded by hand)
--   'online'  the customer paid through Razorpay but the booking never got recorded (the browser lost the thread). The admin has checked
--             the Razorpay dashboard and the server has asked Razorpay: p_provider_payment_id / p_provider_amount_cents are what Razorpay
--             reported. The amount must equal the rate-card price, and one Razorpay payment can only be recorded once. A cancellation
--             can then be refunded through Razorpay like any other online payment.
--   'free'    complimentary: price 0, no payment, nothing to refund.
CREATE OR REPLACE FUNCTION public.admin_create_booking(
  p_customer_id uuid, p_vehicle_id uuid, p_service_id uuid, p_scheduled_date date, p_time_slot public.time_slot,
  p_address_id uuid DEFAULT NULL, p_parking_location text DEFAULT NULL, p_payment text DEFAULT 'cash', p_note text DEFAULT NULL,
  p_provider_payment_id text DEFAULT NULL, p_provider_amount_cents integer DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_vehicle public.vehicles%ROWTYPE;
  v_service public.services%ROWTYPE;
  v_addr uuid := p_address_id;
  v_price integer;
  v_parking text;
  v_booking uuid;
  v_pay uuid;
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  IF p_payment NOT IN ('cash', 'online', 'free') THEN RAISE EXCEPTION 'Choose how this wash is paid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_customer_id AND role = 'customer' AND archived_at IS NULL) THEN RAISE EXCEPTION 'Customer not found'; END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id AND customer_profile_id = p_customer_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;
  SELECT * INTO v_service FROM public.services WHERE id = p_service_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service not found'; END IF;
  IF NOT (v_service.vehicle_type = v_vehicle.vehicle_type OR (v_vehicle.vehicle_type = 'suv' AND v_service.vehicle_type = 'car')) THEN
    RAISE EXCEPTION 'This service is not available for that vehicle';
  END IF;
  IF v_addr IS NULL THEN v_addr := v_vehicle.address_id; END IF;
  IF v_addr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = v_addr AND customer_profile_id = p_customer_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;
  IF p_scheduled_date IS NULL OR p_scheduled_date < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN RAISE EXCEPTION 'Choose today or a later date'; END IF;
  IF app_private.vehicle_has_live_booking(p_vehicle_id, p_scheduled_date) THEN RAISE EXCEPTION 'This vehicle already has a wash booked that day'; END IF;

  IF p_payment IN ('cash', 'online') THEN
    v_price := app_private.unit_price_cents(v_service.id, v_vehicle.vehicle_type);
    IF v_price IS NULL OR v_price < 100 THEN RAISE EXCEPTION 'No price is set for this service'; END IF;
  ELSE
    v_price := 0;
  END IF;
  IF p_payment = 'online' THEN
    IF NULLIF(trim(COALESCE(p_provider_payment_id, '')), '') IS NULL THEN RAISE EXCEPTION 'Paste the Razorpay payment id'; END IF;
    IF p_provider_amount_cents IS DISTINCT FROM v_price THEN
      RAISE EXCEPTION 'That Razorpay payment is for ₹% but this wash costs ₹%', trim_scale(COALESCE(p_provider_amount_cents, 0) / 100.0), trim_scale(v_price / 100.0);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments WHERE provider_payment_id = trim(p_provider_payment_id)) THEN
      RAISE EXCEPTION 'That Razorpay payment is already recorded against another booking';
    END IF;
  END IF;
  v_parking := COALESCE(NULLIF(trim(COALESCE(p_parking_location, '')), ''), v_vehicle.parking_location);

  INSERT INTO public.bookings (customer_profile_id, vehicle_id, service_id, booking_type, scheduled_date, time_slot, status, notes, address_id, parking_location, source, price_cents)
  VALUES (p_customer_id, p_vehicle_id, v_service.id, 'on_demand', p_scheduled_date, p_time_slot, 'confirmed',
          COALESCE(v_note, v_parking, 'Booked by WASHO'), v_addr, v_parking, 'admin', v_price)
  RETURNING id INTO v_booking;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (v_booking, 'booking_created', v_admin, jsonb_build_object('booking_type', 'on_demand', 'source', 'admin', 'payment', p_payment));

  IF p_payment IN ('cash', 'online') THEN
    INSERT INTO public.payments (customer_profile_id, booking_id, amount_cents, currency, provider, provider_payment_id, status, paid_at, payment_kind, receipt, fulfilment_status, intent)
    VALUES (p_customer_id, v_booking, v_price, 'INR', CASE WHEN p_payment = 'online' THEN 'razorpay' ELSE 'offline' END,
            CASE WHEN p_payment = 'online' THEN trim(p_provider_payment_id) END, 'paid', now(), 'on_demand', app_private.gen_ref('ADM'), 'fulfilled',
            jsonb_build_object('kind', 'on_demand', 'source', 'admin', 'payment', p_payment))
    RETURNING id INTO v_pay;
    INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
    VALUES (v_booking, 'payment_received', v_admin,
            jsonb_build_object('payment_id', v_pay, 'provider', CASE WHEN p_payment = 'online' THEN 'razorpay' ELSE 'offline' END, 'amount_cents', v_price));
  END IF;

  INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
  VALUES (p_customer_id, 'booking_confirmed', 'Booking confirmed',
          v_service.name || ' on ' || to_char(p_scheduled_date, 'Dy DD Mon') || ' (' || p_time_slot || ')', v_booking);
  PERFORM app_private.audit('booking', v_booking, 'booking_created_by_admin', jsonb_build_object('customer_id', p_customer_id, 'payment', p_payment, 'amount_cents', v_price));
  RETURN jsonb_build_object('booking_id', v_booking, 'price_cents', v_price, 'payment_id', v_pay);
END $$;

CREATE OR REPLACE FUNCTION public.admin_update_booking_details(p_booking_id uuid, p_address_id uuid DEFAULT NULL, p_parking_location text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_b public.bookings%ROWTYPE;
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_b.status NOT IN ('pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RAISE EXCEPTION 'A wash that is % cannot be edited', v_b.status;
  END IF;
  IF p_address_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customer_addresses WHERE id = p_address_id AND customer_profile_id = v_b.customer_profile_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Address not found';
  END IF;
  UPDATE public.bookings
     SET address_id = COALESCE(p_address_id, address_id),
         parking_location = COALESCE(NULLIF(trim(COALESCE(p_parking_location, '')), ''), parking_location),
         notes = COALESCE(v_note, notes), updated_at = now()
   WHERE id = p_booking_id;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'admin_booking_updated', v_admin, jsonb_build_object('address_id', p_address_id, 'parking_location', p_parking_location, 'note', v_note));
  RETURN true;
END $$;

-- ───────────────────────── services and prices ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_save_service(
  p_service_id uuid, p_code text, p_name text, p_vehicle_type public.vehicle_type, p_description text DEFAULT NULL, p_tagline text DEFAULT NULL,
  p_duration_minutes integer DEFAULT NULL, p_includes jsonb DEFAULT '[]'::jsonb, p_sort_order integer DEFAULT 100
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code text := lower(trim(COALESCE(p_code, '')));
  v_name text := trim(COALESCE(p_name, ''));
  v_old public.services%ROWTYPE;
  v_id uuid;
  v_inc jsonb := COALESCE(p_includes, '[]'::jsonb);
BEGIN
  PERFORM app_private.require_admin();
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN RAISE EXCEPTION 'Enter the service name'; END IF;
  IF p_duration_minutes IS NOT NULL AND (p_duration_minutes < 5 OR p_duration_minutes > 600) THEN RAISE EXCEPTION 'Enter a duration between 5 minutes and 10 hours'; END IF;
  IF jsonb_typeof(v_inc) <> 'array' OR jsonb_array_length(v_inc) > 12
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_inc) e WHERE jsonb_typeof(e) <> 'string' OR char_length(e #>> '{}') > 80) THEN
    RAISE EXCEPTION 'What is included must be a list of up to 12 short lines';
  END IF;
  IF p_sort_order IS NULL OR p_sort_order < 0 OR p_sort_order > 10000 THEN RAISE EXCEPTION 'Enter a display order between 0 and 10000'; END IF;

  IF p_service_id IS NULL THEN
    IF v_code !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_code) < 2 OR char_length(v_code) > 40 THEN
      RAISE EXCEPTION 'The code is a short lowercase name like "bike-polish" (letters, numbers and dashes)';
    END IF;
    BEGIN
      INSERT INTO public.services (code, name, vehicle_type, description, tagline, duration_minutes, includes, sort_order, is_active)
      VALUES (v_code, v_name, p_vehicle_type, NULLIF(trim(COALESCE(p_description, '')), ''), NULLIF(trim(COALESCE(p_tagline, '')), ''), p_duration_minutes, v_inc, p_sort_order, true)
      RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'A service with that code already exists';
    END;
    PERFORM app_private.audit('service', v_id, 'service_created', jsonb_build_object('code', v_code, 'name', v_name));
  ELSE
    SELECT * INTO v_old FROM public.services WHERE id = p_service_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Service not found'; END IF;
    IF v_code <> '' AND v_code <> v_old.code THEN RAISE EXCEPTION 'A service''s code cannot be changed'; END IF;
    IF p_vehicle_type <> v_old.vehicle_type THEN RAISE EXCEPTION 'A service''s vehicle type cannot be changed. Retire it and add a new one.'; END IF;
    UPDATE public.services
       SET name = v_name, description = NULLIF(trim(COALESCE(p_description, '')), ''), tagline = NULLIF(trim(COALESCE(p_tagline, '')), ''),
           duration_minutes = p_duration_minutes, includes = v_inc, sort_order = p_sort_order, updated_at = now()
     WHERE id = p_service_id;
    v_id := p_service_id;
    PERFORM app_private.audit('service', v_id, 'service_updated', jsonb_build_object('code', v_old.code, 'name', v_name));
  END IF;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_service_active(p_service_id uuid, p_active boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_s public.services%ROWTYPE;
BEGIN
  PERFORM app_private.require_admin();
  SELECT * INTO v_s FROM public.services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service not found'; END IF;
  IF NOT p_active AND EXISTS (SELECT 1 FROM public.membership_service_options WHERE service_id = p_service_id) THEN
    RAISE EXCEPTION 'This service is what memberships are built from, so it cannot be retired. Change its price instead.';
  END IF;
  UPDATE public.services SET is_active = p_active, updated_at = now() WHERE id = p_service_id;
  PERFORM app_private.audit('service', p_service_id, CASE WHEN p_active THEN 'service_restored' ELSE 'service_retired' END, jsonb_build_object('code', v_s.code));
  RETURN true;
END $$;

-- The price of one wash. The old rule is closed and a new one starts now, so what was charged before stays readable.
CREATE OR REPLACE FUNCTION public.admin_set_service_price(p_service_id uuid, p_vehicle_type public.vehicle_type, p_price_cents integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_s public.services%ROWTYPE;
  v_old public.pricing_rules%ROWTYPE;
  v_version integer;
BEGIN
  PERFORM app_private.require_admin();
  SELECT * INTO v_s FROM public.services WHERE id = p_service_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service not found'; END IF;
  IF NOT (v_s.vehicle_type = p_vehicle_type OR (p_vehicle_type = 'suv' AND v_s.vehicle_type = 'car')) THEN
    RAISE EXCEPTION 'This service is not offered for that vehicle type';
  END IF;
  IF p_price_cents IS NULL OR p_price_cents < 100 OR p_price_cents > 1000000 THEN RAISE EXCEPTION 'Enter a price between ₹1 and ₹10,000'; END IF;

  SELECT * INTO v_old FROM public.pricing_rules
   WHERE service_id = p_service_id AND vehicle_type = p_vehicle_type AND duration_months = 1 AND quantity_tier = 1
     AND active AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
   ORDER BY rule_version DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND v_old.base_amount_cents = p_price_cents THEN
    RETURN jsonb_build_object('changed', false, 'price_cents', p_price_cents);
  END IF;

  IF FOUND THEN
    IF v_old.valid_from >= now() THEN
      -- started in this very transaction: nothing can have used it yet
      UPDATE public.pricing_rules SET base_amount_cents = p_price_cents, updated_at = now() WHERE id = v_old.id;
      PERFORM app_private.audit('service', p_service_id, 'service_price_changed', jsonb_build_object('vehicle_type', p_vehicle_type, 'from_cents', v_old.base_amount_cents, 'to_cents', p_price_cents));
      RETURN jsonb_build_object('changed', true, 'price_cents', p_price_cents);
    END IF;
    UPDATE public.pricing_rules SET valid_to = now(), updated_at = now() WHERE id = v_old.id;
  END IF;

  SELECT COALESCE(max(rule_version), 0) + 1 INTO v_version FROM public.pricing_rules
   WHERE service_id = p_service_id AND vehicle_type = p_vehicle_type AND duration_months = 1 AND quantity_tier = 1;
  INSERT INTO public.pricing_rules (service_id, vehicle_type, duration_months, quantity_tier, base_amount_cents, discount_percent, active, rule_version, valid_from)
  VALUES (p_service_id, p_vehicle_type, 1, 1, p_price_cents, 0, true, v_version, now());
  PERFORM app_private.audit('service', p_service_id, 'service_price_changed',
    jsonb_build_object('vehicle_type', p_vehicle_type, 'from_cents', v_old.base_amount_cents, 'to_cents', p_price_cents, 'rule_version', v_version));
  RETURN jsonb_build_object('changed', true, 'price_cents', p_price_cents);
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_discount(p_kind text, p_key integer, p_discount_bp integer, p_label text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_label text := trim(COALESCE(p_label, ''));
BEGIN
  PERFORM app_private.require_admin();
  IF p_kind NOT IN ('frequency', 'duration') THEN RAISE EXCEPTION 'A discount is either for washes a week or for membership length'; END IF;
  IF p_key IS NULL OR p_key < 1 OR p_key > 12 THEN RAISE EXCEPTION 'Enter a number between 1 and 12'; END IF;
  IF p_kind = 'frequency' AND p_key > 7 THEN RAISE EXCEPTION 'Washes a week is between 1 and 7'; END IF;
  IF p_kind = 'duration' AND p_key NOT IN (1, 3, 6, 12) THEN RAISE EXCEPTION 'Membership length is 1, 3, 6 or 12 months'; END IF;
  IF p_discount_bp IS NULL OR p_discount_bp < 0 OR p_discount_bp > 5000 THEN RAISE EXCEPTION 'A discount is between 0%% and 50%%'; END IF;
  IF char_length(v_label) < 2 OR char_length(v_label) > 60 THEN RAISE EXCEPTION 'Give the discount a short label'; END IF;
  UPDATE public.membership_discount_rules SET active = false WHERE kind = p_kind AND key_value = p_key AND active;
  INSERT INTO public.membership_discount_rules (kind, key_value, discount_bp, label, active) VALUES (p_kind, p_key, p_discount_bp, v_label, true);
  PERFORM app_private.audit('pricing', NULL, 'discount_set', jsonb_build_object('kind', p_kind, 'key', p_key, 'discount_bp', p_discount_bp, 'label', v_label));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.admin_remove_discount(p_kind text, p_key integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_admin();
  UPDATE public.membership_discount_rules SET active = false WHERE kind = p_kind AND key_value = p_key AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Discount not found'; END IF;
  PERFORM app_private.audit('pricing', NULL, 'discount_removed', jsonb_build_object('kind', p_kind, 'key', p_key));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.admin_set_pricing_setting(p_key text, p_value integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old integer;
BEGIN
  PERFORM app_private.require_admin();
  IF p_value IS NULL OR NOT (
       (p_key = 'max_total_discount_bp' AND p_value BETWEEN 0 AND 5000)
    OR (p_key = 'weeks_per_month' AND p_value BETWEEN 1 AND 5)
    OR (p_key = 'quote_validity_days' AND p_value BETWEEN 1 AND 30)
    OR (p_key = 'membership_min_lead_days' AND p_value BETWEEN 0 AND 30)
    OR (p_key = 'on_demand_min_lead_hours' AND p_value BETWEEN 0 AND 72)
    OR (p_key = 'payment_intent_minutes' AND p_value BETWEEN 5 AND 120)
  ) THEN
    RAISE EXCEPTION 'That setting or value is not allowed';
  END IF;
  SELECT value_int INTO v_old FROM public.pricing_settings WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Setting not found'; END IF;
  UPDATE public.pricing_settings SET value_int = p_value, updated_at = now() WHERE key = p_key;
  PERFORM app_private.audit('pricing', NULL, 'pricing_setting_changed', jsonb_build_object('key', p_key, 'from', v_old, 'to', p_value));
  RETURN true;
END $$;

-- ───────────────────────── grants: admins only, checked inside each function ─────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'admin_update_customer_profile(uuid, text, text)',
    'admin_set_profile_archived(uuid, boolean, text)',
    'admin_begin_password_reset(uuid)',
    'admin_save_vehicle(uuid, uuid, public.vehicle_type, text, text, text, text, uuid, text)',
    'admin_set_vehicle_active(uuid, boolean)',
    'admin_save_address(uuid, uuid, text, text, text, text, text, text, text, text, boolean)',
    'admin_set_address_archived(uuid, boolean)',
    'admin_create_booking(uuid, uuid, uuid, date, public.time_slot, uuid, text, text, text, text, integer)',
    'admin_update_booking_details(uuid, uuid, text, text)',
    'admin_save_service(uuid, text, text, public.vehicle_type, text, text, integer, jsonb, integer)',
    'admin_set_service_active(uuid, boolean)',
    'admin_set_service_price(uuid, public.vehicle_type, integer)',
    'admin_set_discount(text, integer, integer, text)',
    'admin_remove_discount(text, integer)',
    'admin_set_pricing_setting(text, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f); -- is_admin() inside
  END LOOP;
END $$;
